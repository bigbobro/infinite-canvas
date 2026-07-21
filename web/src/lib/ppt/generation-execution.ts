import { applyCanvasAgentOps } from "@/lib/canvas/canvas-agent-ops";
import { applyGenerationPlanPptOps, type GenerationPlan, type GenerationPlanRequest, type GenerationPlanRun } from "@/lib/ppt/generation-plan";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData, CanvasNodeMetadata, PptGenerationRequestStatus, PptGenerationRequestTrace, PptGenerationRunStatus, PptGenerationRunSummary } from "@/types/canvas";

export type PptGenerationRequestEvent =
    | { type: "persisted"; at: string }
    | { type: "submitting"; at: string }
    | { type: "task_created"; at: string; taskId: string; expiresAt?: number }
    | { type: "running"; at: string }
    | { type: "submission_unknown"; at: string; error?: string }
    | { type: "succeeded"; at: string; resultIdentity: string }
    | { type: "materializing"; at: string }
    | { type: "completed"; at: string; resultIdentity?: string }
    | { type: "recoverable_error"; at: string; error: string }
    | { type: "failed"; at: string; error: string; billingRisk?: boolean }
    | { type: "abandoned"; at: string };

const allowedFrom: Record<PptGenerationRequestEvent["type"], readonly PptGenerationRequestStatus[]> = {
    persisted: ["draft", "persisted"],
    submitting: ["persisted", "submitting"],
    task_created: ["submitting", "submitted", "running", "recoverable_error"],
    running: ["submitted", "running", "recoverable_error"],
    submission_unknown: ["submitting", "submission_unknown"],
    succeeded: ["submitting", "submitted", "running", "succeeded", "materializing", "recoverable_error"],
    materializing: ["succeeded", "materializing", "recoverable_error"],
    completed: ["materializing", "completed"],
    recoverable_error: ["submitting", "submitted", "running", "succeeded", "materializing", "recoverable_error"],
    failed: ["draft", "persisted", "submitting", "submitted", "running", "succeeded", "materializing", "recoverable_error", "failed"],
    abandoned: ["draft", "persisted", "submitting", "submitted", "running", "submission_unknown", "succeeded", "materializing", "recoverable_error", "abandoned"],
};

const RECENT_EVENT_LIMIT = 12;
const activeRequestExecutions = new Map<string, Promise<void>>();
const activeNotificationDeliveries = new Map<string, Promise<void>>();
const projectOperationQueues = new Map<string, Promise<void>>();

export class PptGenerationPreSubmitError extends Error {
    override name = "PptGenerationPreSubmitError";
}

export function reducePptGenerationRequest(trace: PptGenerationRequestTrace, event: PptGenerationRequestEvent): PptGenerationRequestTrace {
    if (!allowedFrom[event.type].includes(trace.status)) throw new Error(`请求 ${trace.requestId} 不能从 ${trace.status} 进入 ${event.type}`);
    const nextTaskId = event.type === "task_created" ? event.taskId : trace.remoteTaskId;
    const nextResultIdentity = event.type === "succeeded" ? event.resultIdentity : event.type === "completed" ? event.resultIdentity || trace.resultIdentity : trace.resultIdentity;
    if (trace.remoteTaskId && nextTaskId && trace.remoteTaskId !== nextTaskId) throw new Error(`请求 ${trace.requestId} 的远端 task ID 不可改写`);
    if (trace.resultIdentity && nextResultIdentity && trace.resultIdentity !== nextResultIdentity) throw new Error(`请求 ${trace.requestId} 的结果身份不可改写`);

    const statusByEvent: Record<PptGenerationRequestEvent["type"], PptGenerationRequestStatus> = {
        persisted: "persisted",
        submitting: "submitting",
        task_created: "submitted",
        running: "running",
        submission_unknown: "submission_unknown",
        succeeded: "succeeded",
        materializing: "materializing",
        completed: "completed",
        recoverable_error: "recoverable_error",
        failed: "failed",
        abandoned: "abandoned",
    };
    const nextStatus = statusByEvent[event.type];
    const eventError = event.type === "submission_unknown" || event.type === "recoverable_error" || event.type === "failed" ? event.error : undefined;
    const billingRisk = trace.billingRisk || (event.type === "failed" && event.billingRisk);
    return {
        ...trace,
        status: nextStatus,
        updatedAt: event.at,
        ...(event.type === "task_created" ? { remoteTaskId: event.taskId, remoteTaskExpiresAt: event.expiresAt ?? trace.remoteTaskExpiresAt } : {}),
        ...(nextResultIdentity ? { resultIdentity: nextResultIdentity } : {}),
        ...(billingRisk ? { billingRisk: true } : {}),
        ...(eventError ? { error: eventError } : { error: undefined }),
        recentEvents: [...(trace.recentEvents || []), { status: nextStatus, at: event.at, ...(eventError ? { error: eventError } : {}) }].slice(-RECENT_EVENT_LIMIT),
    };
}

export function derivePptGenerationRunStatus(requests: readonly PptGenerationRequestTrace[]): PptGenerationRunStatus {
    if (!requests.length || requests.every((request) => request.status === "draft" || request.status === "persisted")) return "preparing";
    if (requests.some((request) => request.status === "submission_unknown" || request.status === "recoverable_error")) return "needs_attention";
    if (requests.every((request) => request.status === "completed")) return "completed";
    if (requests.every((request) => request.status === "abandoned")) return "abandoned";
    const terminal = requests.every((request) => request.status === "completed" || request.status === "failed" || request.status === "abandoned");
    if (terminal) return requests.some((request) => request.status === "completed") ? "partial" : "failed";
    return "running";
}

export function syncPptGenerationRun(run: PptGenerationRunSummary, requests: readonly PptGenerationRequestTrace[], at = new Date().toISOString()): PptGenerationRunSummary {
    const ownedRequests = requests.filter((request) => request.runId === run.runId && run.requestIds.includes(request.requestId));
    const ownsEverySlotExactlyOnce =
        run.plannedCount === run.requestIds.length &&
        ownedRequests.length === run.requestIds.length &&
        new Set(run.requestIds).size === run.requestIds.length &&
        new Set(ownedRequests.map((request) => request.slotIndex)).size === run.plannedCount &&
        ownedRequests.every((request) => request.batchId === run.batchId && request.pageId === run.pageId && request.takeId === run.takeId && request.slotIndex >= 0 && request.slotIndex < run.plannedCount) &&
        run.requestIds.every((requestId) => ownedRequests.filter((request) => request.requestId === requestId).length === 1);
    const status = ownsEverySlotExactlyOnce ? derivePptGenerationRunStatus(ownedRequests) : "needs_attention";
    return status === run.status ? run : { ...run, status, updatedAt: at };
}

export type PptGenerationRemoteEvent = { type: "task_created"; taskId: string; expiresAt?: number } | { type: "running" };

export type PptGenerationProviderResult = {
    dataUrl: string;
    resultIdentity: string;
    remoteTaskId?: string;
};

export type PptGenerationModuleDependencies = {
    projectId: string;
    durableCanvas: {
        mutate: (mutator: (project: CanvasProject) => CanvasProject) => Promise<CanvasProject>;
        read: () => Promise<CanvasProject | null>;
    };
    provider: {
        submit: (input: { project: CanvasProject; run: GenerationPlanRun; request: GenerationPlanRequest; onEvent: (event: PptGenerationRemoteEvent) => Promise<void> }) => Promise<PptGenerationProviderResult>;
        resume: (input: { project: CanvasProject; trace: PptGenerationRequestTrace; onEvent: (event: PptGenerationRemoteEvent) => Promise<void> }) => Promise<PptGenerationProviderResult>;
        classifyError?: (error: unknown, trace: PptGenerationRequestTrace) => "submission_unknown" | "recoverable_error" | "failed";
        hasBillingRisk?: (error: unknown, trace: PptGenerationRequestTrace) => boolean;
    };
    materialize: (result: PptGenerationProviderResult) => Promise<CanvasNodeMetadata>;
    notify?: (event: { runId: string; pageId: string; takeId: string; status: PptGenerationRunStatus }) => void | Promise<void>;
};

export type GenerationStartResult = {
    batchId: string;
    runIds: string[];
    requestIds: string[];
    settled: Promise<GenerationSettledResult>;
};

export type GenerationSettledResult = {
    completedRequestIds: string[];
    attentionRequestIds: string[];
};

export type GenerationRecoveryCommand = { type: "reconcileProject" } | { type: "retrieveExisting"; requestId: string } | { type: "abandonUnknown"; requestId: string };

export type GenerationRecoveryResult = {
    resumedRequestIds: string[];
    unknownRequestIds: string[];
    abandonedRequestIds: string[];
    settled: Promise<GenerationSettledResult>;
};

export type PptGenerationModule = {
    start: (plan: GenerationPlan) => Promise<GenerationStartResult>;
    recover: (command: GenerationRecoveryCommand) => Promise<GenerationRecoveryResult>;
};

export function createPptGenerationModule(dependencies: PptGenerationModuleDependencies): PptGenerationModule {
    const readProject = async () => {
        const project = await dependencies.durableCanvas.read();
        if (!project || project.id !== dependencies.projectId) throw new Error("无法读回已落盘的画布工程");
        return project;
    };

    const mutateRequest = async (requestId: string, event: PptGenerationRequestEvent, metadata?: CanvasNodeMetadata) => {
        return dependencies.durableCanvas.mutate((project) => {
            let found = false;
            let runId = "";
            let nodes = project.nodes.map((node): CanvasNodeData => {
                const trace = node.metadata?.pptGenerationRequest;
                if (trace?.requestId !== requestId) return node;
                found = true;
                runId = trace.runId;
                const nextTrace = reducePptGenerationRequest(trace, event);
                const active = ["submitting", "submitted", "running", "succeeded", "materializing"].includes(nextTrace.status);
                const failed = ["submission_unknown", "recoverable_error", "failed"].includes(nextTrace.status);
                return {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        ...metadata,
                        pptGenerationRequest: nextTrace,
                        status: nextTrace.status === "completed" ? "success" : nextTrace.status === "abandoned" ? "idle" : active ? "loading" : failed ? "error" : node.metadata?.status,
                        errorDetails: nextTrace.error,
                        ...(["completed", "submission_unknown", "failed", "abandoned"].includes(nextTrace.status) ? { imageTask: undefined } : {}),
                    },
                };
            });
            if (!found) throw new Error(`找不到 PPT 请求槽 ${requestId}`);
            nodes = syncRunInNodes(nodes, runId, event.at);
            return { ...project, nodes };
        });
    };

    const onRemoteEvent = async (requestId: string, event: PptGenerationRemoteEvent) => {
        const at = new Date().toISOString();
        if (event.type === "task_created") {
            await mutateRequest(requestId, { type: "task_created", at, taskId: event.taskId, expiresAt: event.expiresAt }, { imageTask: { taskId: event.taskId, model: findRequestTrace(await readProject(), requestId).model, expiresAt: event.expiresAt } });
            return;
        }
        const trace = findRequestTrace(await readProject(), requestId);
        if (trace.status === "submitted" || trace.status === "recoverable_error") await mutateRequest(requestId, { type: "running", at });
    };

    const deliverNotification = async (runId: string) => {
        const currentRun = allRunSummaries(await readProject()).find((run) => run.runId === runId);
        if (!currentRun || !isNotifiableRunStatus(currentRun.status) || currentRun.notifiedTerminalStatus === currentRun.status) return;
        const deliveryKey = `${dependencies.projectId}:${runId}:${currentRun.status}`;
        const activeDelivery = activeNotificationDeliveries.get(deliveryKey);
        if (activeDelivery) return activeDelivery;
        const delivery = (async () => {
            let claimed: PptGenerationRunSummary | undefined;
            await dependencies.durableCanvas.mutate((project) => {
                const at = new Date().toISOString();
                const nodes = project.nodes.map((node) => {
                    const run = node.metadata?.pptGenerationRun;
                    if (run?.runId !== runId || run.status !== currentRun.status || run.notifiedTerminalStatus === run.status) return node;
                    claimed = { ...run, notifiedTerminalStatus: run.status, notifiedAt: at };
                    return { ...node, metadata: { ...node.metadata, pptGenerationRun: claimed } };
                });
                return claimed ? { ...project, nodes } : project;
            });
            if (claimed) await dependencies.notify?.({ runId: claimed.runId, pageId: claimed.pageId, takeId: claimed.takeId, status: claimed.status });
        })().finally(() => activeNotificationDeliveries.delete(deliveryKey));
        activeNotificationDeliveries.set(deliveryKey, delivery);
        return delivery;
    };

    const tryDeliverNotification = async (runId: string) => {
        try {
            await deliverNotification(runId);
        } catch {
            // at-most-once 通知先持久化 claim；显示失败不回滚生成事实或重复补发。
        }
    };

    const finishResult = async (trace: PptGenerationRequestTrace, result: PptGenerationProviderResult) => {
        const remoteTaskId = result.remoteTaskId;
        if (remoteTaskId && !trace.remoteTaskId) await onRemoteEvent(trace.requestId, { type: "task_created", taskId: remoteTaskId });
        await mutateRequest(trace.requestId, { type: "succeeded", at: new Date().toISOString(), resultIdentity: result.resultIdentity });
        await mutateRequest(trace.requestId, { type: "materializing", at: new Date().toISOString() });
        let metadata: CanvasNodeMetadata;
        try {
            metadata = await dependencies.materialize(result);
        } catch (error) {
            await mutateRequest(trace.requestId, { type: "recoverable_error", at: new Date().toISOString(), error: errorMessage(error, "图片保存失败") });
            await tryDeliverNotification(trace.runId);
            return;
        }
        const project = await mutateRequest(trace.requestId, { type: "completed", at: new Date().toISOString(), resultIdentity: result.resultIdentity }, metadata);
        const completedTrace = findRequestTrace(project, trace.requestId);
        // Request 已 durable completed，后续的 root 投影或通知失败不得把它回退为可恢复错误。
        // reconcileProject 会补齐这两项派生状态。
        try {
            await fillRunRoot(project, completedTrace, metadata, dependencies.durableCanvas);
        } catch {
            // 保留 completed 事实，下次打开工程时修复 root。
        }
        await tryDeliverNotification(completedTrace.runId);
    };

    const handleProviderError = async (requestId: string, error: unknown) => {
        const trace = findRequestTrace(await readProject(), requestId);
        if (["completed", "submission_unknown", "failed", "abandoned"].includes(trace.status) || (trace.status === "recoverable_error" && !trace.remoteTaskId)) {
            await tryDeliverNotification(trace.runId);
            return;
        }
        const classification = error instanceof PptGenerationPreSubmitError ? "failed" : dependencies.provider.classifyError?.(error, trace) || (trace.remoteTaskId ? "recoverable_error" : "submission_unknown");
        const at = new Date().toISOString();
        const message = errorMessage(error, "图片生成失败");
        if (classification === "failed") await mutateRequest(requestId, { type: "failed", at, error: message, billingRisk: dependencies.provider.hasBillingRisk?.(error, trace) });
        else if (classification === "recoverable_error") await mutateRequest(requestId, { type: "recoverable_error", at, error: message });
        else await mutateRequest(requestId, { type: "submission_unknown", at, error: `提交结果未知：${message}` });
        await tryDeliverNotification(trace.runId);
    };

    const handleResultPersistenceError = async (requestId: string, error: unknown) => {
        const trace = findRequestTrace(await readProject(), requestId);
        if (["completed", "failed", "abandoned"].includes(trace.status)) {
            await tryDeliverNotification(trace.runId);
            return;
        }
        await mutateRequest(requestId, { type: "recoverable_error", at: new Date().toISOString(), error: `远端结果已返回，但本地保存失败：${errorMessage(error, "保存失败")}` });
        await tryDeliverNotification(trace.runId);
    };

    const runOnce = (requestId: string, execute: () => Promise<void>) => {
        const executionKey = `${dependencies.projectId}:${requestId}`;
        const active = activeRequestExecutions.get(executionKey);
        if (active) return active;
        const task = execute().finally(() => activeRequestExecutions.delete(executionKey));
        activeRequestExecutions.set(executionKey, task);
        return task;
    };

    const executeFresh = (run: GenerationPlanRun, request: GenerationPlanRequest) =>
        runOnce(request.requestId, async () => {
            let result: PptGenerationProviderResult;
            try {
                const project = await readProject();
                const trace = findRequestTrace(project, request.requestId);
                if (trace.status !== "submitting") throw new Error(`请求 ${request.requestId} 未取得 durable submitting 锁`);
                result = await dependencies.provider.submit({ project, run, request, onEvent: (event) => onRemoteEvent(request.requestId, event) });
            } catch (error) {
                await handleProviderError(request.requestId, error);
                return;
            }
            try {
                await finishResult(findRequestTrace(await readProject(), request.requestId), result);
            } catch (error) {
                await handleResultPersistenceError(request.requestId, error);
            }
        });

    const executeRecovery = (trace: PptGenerationRequestTrace) =>
        runOnce(trace.requestId, async () => {
            let result: PptGenerationProviderResult;
            try {
                if (!trace.remoteTaskId) throw new Error("请求没有可恢复的远端 task ID");
                const project = await readProject();
                result = await dependencies.provider.resume({ project, trace: findRequestTrace(project, trace.requestId), onEvent: (event) => onRemoteEvent(trace.requestId, event) });
            } catch (error) {
                await handleProviderError(trace.requestId, error);
                return;
            }
            try {
                await finishResult(findRequestTrace(await readProject(), trace.requestId), result);
            } catch (error) {
                await handleResultPersistenceError(trace.requestId, error);
            }
        });

    const settle = (tasks: Array<{ requestId: string; task: Promise<void> }>): Promise<GenerationSettledResult> =>
        Promise.allSettled(tasks.map((item) => item.task)).then(async () => {
            const project = await readProject();
            const traces = allRequestTraces(project).filter((trace) => tasks.some((item) => item.requestId === trace.requestId));
            return {
                completedRequestIds: traces.filter((trace) => trace.status === "completed").map((trace) => trace.requestId),
                attentionRequestIds: traces.filter((trace) => trace.status !== "completed").map((trace) => trace.requestId),
            };
        });

    const startPlan = async (plan: GenerationPlan): Promise<GenerationStartResult> => {
        if (!plan.runs.length) throw new Error("生成计划没有可执行页面");
        const existing = allRequestTraces(await readProject());
        if (plan.runs.some((run) => run.requests.some((request) => existing.some((trace) => trace.requestId === request.requestId)))) throw new Error("该生成计划已经启动，不能重复提交");
        try {
            await preparePlan(plan, dependencies.durableCanvas);
            assertPlanDurable(await readProject(), plan, "draft");
            await transitionPlanRequests(plan, dependencies.durableCanvas, "persisted");
            assertPlanDurable(await readProject(), plan, "persisted");
            await transitionPlanRequests(plan, dependencies.durableCanvas, "submitting");
            assertPlanDurable(await readProject(), plan, "submitting");
        } catch (error) {
            try {
                await failUnlaunchedPlan(plan, error, dependencies.durableCanvas);
            } catch {
                // 若持久层本身不可写，刷新时会按 durable 状态保守恢复；此路径仍保证尚未执行 POST。
            }
            throw error;
        }
        const tasks = plan.runs.flatMap((run) => run.requests.map((request) => ({ requestId: request.requestId, task: executeFresh(run, request) })));
        return {
            batchId: plan.batchId,
            runIds: plan.runs.map((run) => run.runId),
            requestIds: tasks.map((item) => item.requestId),
            settled: settle(tasks),
        };
    };

    return {
        start(plan) {
            return queueProjectOperation(dependencies.projectId, () => startPlan(plan));
        },

        recover(command) {
            return queueProjectOperation(dependencies.projectId, async () => {
                const abandonedRequestIds: string[] = [];
                if (command.type === "abandonUnknown") {
                    const trace = findRequestTrace(await readProject(), command.requestId);
                    await mutateRequest(trace.requestId, { type: "abandoned", at: new Date().toISOString() });
                    await tryDeliverNotification(trace.runId);
                    abandonedRequestIds.push(trace.requestId);
                }
                if (command.type === "reconcileProject") {
                    const traces = allRequestTraces(await readProject());
                    const neverSubmitted = traces.filter((trace) => trace.status === "draft" || trace.status === "persisted");
                    for (const trace of neverSubmitted) await mutateRequest(trace.requestId, { type: "abandoned", at: new Date().toISOString() });
                    const submitting = traces.filter((trace) => trace.status === "submitting" && !trace.remoteTaskId && !activeRequestExecutions.has(`${dependencies.projectId}:${trace.requestId}`));
                    for (const trace of submitting) {
                        await mutateRequest(trace.requestId, { type: "submission_unknown", at: new Date().toISOString(), error: "页面刷新时未能确认该请求是否已提交，已停止自动重提。" });
                        await tryDeliverNotification(trace.runId);
                    }
                    const strandedResults = traces.filter((trace) => !trace.remoteTaskId && (trace.status === "succeeded" || trace.status === "materializing") && !activeRequestExecutions.has(`${dependencies.projectId}:${trace.requestId}`));
                    for (const trace of strandedResults) {
                        await mutateRequest(trace.requestId, { type: "recoverable_error", at: new Date().toISOString(), error: "远端已返回结果，但本地未完成保存且该渠道没有可重新获取的 task ID。" });
                        await tryDeliverNotification(trace.runId);
                    }
                    try {
                        await repairCompletedRunRoots(dependencies.durableCanvas);
                    } catch {
                        // root 是 completed Request 的派生投影，修复失败不阻断远端任务续查。
                    }
                    const pendingRunIds = allRunSummaries(await readProject())
                        .filter((run) => isNotifiableRunStatus(run.status) && run.notifiedTerminalStatus !== run.status)
                        .map((run) => run.runId);
                    for (const runId of pendingRunIds) await tryDeliverNotification(runId);
                }
                const project = await readProject();
                if (command.type === "retrieveExisting" && !findRequestTrace(project, command.requestId).remoteTaskId) throw new Error("该请求没有可重新获取的远端 task ID");
                const candidates =
                    command.type === "retrieveExisting"
                        ? [findRequestTrace(project, command.requestId)]
                        : command.type === "reconcileProject"
                          ? allRequestTraces(project).filter((trace) => trace.remoteTaskId && ["submitted", "running", "succeeded", "materializing", "recoverable_error"].includes(trace.status))
                          : [];
                const tasks = candidates.map((trace) => ({ requestId: trace.requestId, task: executeRecovery(trace) }));
                const latest = allRequestTraces(await readProject());
                return {
                    resumedRequestIds: tasks.map((item) => item.requestId),
                    unknownRequestIds: latest.filter((trace) => trace.status === "submission_unknown").map((trace) => trace.requestId),
                    abandonedRequestIds,
                    settled: settle(tasks),
                };
            });
        },
    };
}

async function preparePlan(plan: GenerationPlan, durableCanvas: PptGenerationModuleDependencies["durableCanvas"]) {
    await durableCanvas.mutate((project) => {
        if (!project.ppt) throw new Error("当前工程不是 PPT 工作台工程");
        const unresolved = allRequestTraces(project).filter((trace) => !["completed", "failed", "abandoned"].includes(trace.status));
        const unresolvedRuns = allRunSummaries(project).filter((run) => run.status === "preparing" || run.status === "running" || run.status === "needs_attention");
        const conflict = plan.runs.find((run) => unresolved.some((trace) => trace.pageId === run.pageId && trace.takeId === run.takeId) || unresolvedRuns.some((summary) => summary.pageId === run.pageId && summary.takeId === run.takeId));
        if (conflict) throw new Error(`页面 ${conflict.pageId} 的方案 ${conflict.takeId} 仍有未完成请求，请先恢复或标记放弃`);
        const next = applyCanvasAgentOps({ projectId: project.id, title: project.title, nodes: project.nodes, connections: project.connections, selectedNodeIds: [], viewport: project.viewport }, [...plan.structureOps]);
        const runByRootId = new Map(plan.runs.map((run) => [run.rootNodeId, initialRunSummary(plan, run)]));
        const requestByNodeId = new Map(plan.runs.flatMap((run) => run.requests.map((request) => [request.requestNodeId, initialRequestTrace(plan, run, request)] as const)));
        const nodes = next.nodes.map((node) => {
            const run = runByRootId.get(node.id);
            const request = requestByNodeId.get(node.id);
            if (!run && !request) return node;
            return { ...node, metadata: { ...node.metadata, ...(run ? { pptGenerationRun: run } : {}), ...(request ? { pptGenerationRequest: request } : {}) } };
        });
        return { ...project, nodes, connections: next.connections, ppt: applyGenerationPlanPptOps(project.ppt, plan.pptOps) };
    });
}

async function transitionPlanRequests(plan: GenerationPlan, durableCanvas: PptGenerationModuleDependencies["durableCanvas"], type: "persisted" | "submitting") {
    await durableCanvas.mutate((project) => {
        const at = new Date().toISOString();
        let nodes = project.nodes.map((node): CanvasNodeData => {
            const trace = node.metadata?.pptGenerationRequest;
            if (!trace || !plan.runs.some((run) => run.requests.some((request) => request.requestId === trace.requestId))) return node;
            return { ...node, metadata: { ...node.metadata, pptGenerationRequest: reducePptGenerationRequest(trace, { type, at }), status: type === "submitting" ? "loading" : node.metadata?.status } };
        });
        plan.runs.forEach((run) => {
            nodes = syncRunInNodes(nodes, run.runId, at);
        });
        return { ...project, nodes };
    });
}

function assertPlanDurable(project: CanvasProject, plan: GenerationPlan, status: "draft" | "persisted" | "submitting") {
    for (const run of plan.runs) {
        const page = project.ppt?.pages.find((item) => item.pageId === run.pageId);
        const take = page?.takes.find((item) => item.takeId === run.takeId);
        if (!take) throw new Error(`页面 ${run.pageId} 的方案 ${run.takeId} 未持久化`);
        const anchorNode = project.nodes.find((node) => node.id === take.anchorNodeId);
        const configNode = project.nodes.find((node) => node.id === take.configNodeId);
        if (!anchorNode || !configNode) throw new Error(`页面 ${run.pageId} 的方案 ${run.takeId} 引用未持久化`);
        if (anchorNode.type !== "text" || configNode.type !== "config") throw new Error(`页面 ${run.pageId} 的方案 ${run.takeId} 引用类型异常`);
        if (anchorNode.metadata?.pptPageId !== run.pageId || anchorNode.metadata.pptTakeId !== run.takeId || configNode.metadata?.pptPageId !== run.pageId || configNode.metadata.pptTakeId !== run.takeId)
            throw new Error(`页面 ${run.pageId} 的方案 ${run.takeId} 稳定身份不一致`);
        if (!project.connections.some((connection) => connection.fromNodeId === take.anchorNodeId && connection.toNodeId === take.configNodeId)) throw new Error(`页面 ${run.pageId} 的方案 ${run.takeId} 提示词连接未持久化`);
        const root = project.nodes.find((node) => node.id === run.rootNodeId);
        const summary = root?.metadata?.pptGenerationRun;
        if (
            summary?.runId !== run.runId ||
            summary.batchId !== plan.batchId ||
            summary.pageId !== run.pageId ||
            summary.takeId !== run.takeId ||
            summary.plannedCount !== run.plannedCount ||
            summary.requestIds.length !== run.requests.length ||
            run.requests.some((request) => !summary.requestIds.includes(request.requestId))
        )
            throw new Error(`运行 ${run.runId} 未完整持久化`);
        if (!project.connections.some((connection) => connection.fromNodeId === run.baseNodeId && connection.toNodeId === run.rootNodeId)) throw new Error(`运行 ${run.runId} 的根连接未持久化`);
        for (const request of run.requests) {
            const node = project.nodes.find((item) => item.id === request.requestNodeId);
            const trace = node?.metadata?.pptGenerationRequest;
            if (
                !trace ||
                trace.requestId !== request.requestId ||
                trace.runId !== run.runId ||
                trace.batchId !== plan.batchId ||
                trace.pageId !== run.pageId ||
                trace.takeId !== run.takeId ||
                trace.slotIndex !== request.slotIndex ||
                !sameProviderIdentity(trace.providerIdentity, request.providerIdentity) ||
                trace.status !== status
            )
                throw new Error(`请求槽 ${request.requestId} 的 ${status} 状态未完整持久化`);
            if (request.requestNodeId !== run.rootNodeId && !project.connections.some((connection) => connection.fromNodeId === run.rootNodeId && connection.toNodeId === request.requestNodeId))
                throw new Error(`请求槽 ${request.requestId} 的连接未持久化`);
            if (request.inputRefs.some((input) => !project.nodes.some((item) => item.id === input.nodeId))) throw new Error(`请求槽 ${request.requestId} 的输入引用未持久化`);
        }
    }
}

async function failUnlaunchedPlan(plan: GenerationPlan, error: unknown, durableCanvas: PptGenerationModuleDependencies["durableCanvas"]) {
    const requestIds = new Set(plan.runs.flatMap((run) => run.requests.map((request) => request.requestId)));
    await durableCanvas.mutate((project) => {
        const at = new Date().toISOString();
        const message = `请求提交前保存失败：${errorMessage(error, "保存失败")}`;
        let nodes = project.nodes.map((node): CanvasNodeData => {
            const trace = node.metadata?.pptGenerationRequest;
            if (!trace || !requestIds.has(trace.requestId) || ["completed", "failed", "abandoned"].includes(trace.status)) return node;
            const nextTrace = reducePptGenerationRequest(trace, { type: "failed", at, error: message });
            return { ...node, metadata: { ...node.metadata, pptGenerationRequest: nextTrace, status: "error", errorDetails: message, imageTask: undefined } };
        });
        plan.runs.forEach((run) => {
            nodes = syncRunInNodes(nodes, run.runId, at);
        });
        return { ...project, nodes };
    });
}

function initialRunSummary(plan: GenerationPlan, run: GenerationPlanRun): PptGenerationRunSummary {
    return {
        runId: run.runId,
        batchId: plan.batchId,
        pageId: run.pageId,
        takeId: run.takeId,
        requestIds: run.requests.map((request) => request.requestId),
        plannedCount: run.plannedCount,
        status: "preparing",
        createdAt: plan.createdAt,
        updatedAt: plan.createdAt,
    };
}

function initialRequestTrace(plan: GenerationPlan, run: GenerationPlanRun, request: GenerationPlanRequest): PptGenerationRequestTrace {
    return {
        requestId: request.requestId,
        runId: run.runId,
        batchId: plan.batchId,
        pageId: run.pageId,
        takeId: run.takeId,
        slotIndex: request.slotIndex,
        requestType: request.requestType,
        model: request.model,
        providerIdentity: request.providerIdentity,
        status: "draft",
        createdAt: plan.createdAt,
        updatedAt: plan.createdAt,
        recentEvents: [{ status: "draft", at: plan.createdAt }],
    };
}

function allRequestTraces(project: CanvasProject) {
    return project.nodes.map((node) => node.metadata?.pptGenerationRequest).filter((trace): trace is PptGenerationRequestTrace => Boolean(trace));
}

function allRunSummaries(project: CanvasProject) {
    return project.nodes.map((node) => node.metadata?.pptGenerationRun).filter((run): run is PptGenerationRunSummary => Boolean(run));
}

function findRequestTrace(project: CanvasProject, requestId: string) {
    const trace = allRequestTraces(project).find((item) => item.requestId === requestId);
    if (!trace) throw new Error(`找不到 PPT 请求 ${requestId}`);
    return trace;
}

function syncRunInNodes(nodes: CanvasProject["nodes"], runId: string, at: string): CanvasProject["nodes"] {
    const requests = nodes.map((node) => node.metadata?.pptGenerationRequest).filter((trace): trace is PptGenerationRequestTrace => Boolean(trace));
    return nodes.map((node) => {
        const run = node.metadata?.pptGenerationRun;
        if (run?.runId !== runId) return node;
        const nextRun = syncPptGenerationRun(run, requests, at);
        const rootStatus: CanvasNodeMetadata["status"] =
            nextRun.status === "preparing" || nextRun.status === "running" ? "loading" : nextRun.status === "needs_attention" || nextRun.status === "failed" ? "error" : nextRun.status === "completed" || nextRun.status === "partial" ? "success" : "idle";
        const errorDetails = nextRun.status === "needs_attention" ? "生成需要处理" : nextRun.status === "failed" ? "生成失败" : undefined;
        return { ...node, metadata: { ...node.metadata, pptGenerationRun: nextRun, status: rootStatus, errorDetails } };
    });
}

async function fillRunRoot(project: CanvasProject, trace: PptGenerationRequestTrace, metadata: CanvasNodeMetadata, durableCanvas: PptGenerationModuleDependencies["durableCanvas"]) {
    const requestNode = project.nodes.find((node) => node.metadata?.pptGenerationRequest?.requestId === trace.requestId);
    const root = project.nodes.find((node) => node.metadata?.pptGenerationRun?.runId === trace.runId);
    if (!requestNode || !root || requestNode.id === root.id || root.metadata?.primaryImageId) return;
    await durableCanvas.mutate((latest) => ({
        ...latest,
        nodes: latest.nodes.map((node) => (node.id === root.id && !node.metadata?.primaryImageId ? { ...node, metadata: { ...node.metadata, ...completedImageMetadata(metadata), primaryImageId: requestNode.id } } : node)),
    }));
}

async function repairCompletedRunRoots(durableCanvas: PptGenerationModuleDependencies["durableCanvas"]) {
    await durableCanvas.mutate((project) => {
        let changed = false;
        const nodes = project.nodes.map((node) => {
            const run = node.metadata?.pptGenerationRun;
            if (!run || run.plannedCount <= 1 || node.metadata?.primaryImageId) return node;
            const requestNode = project.nodes
                .filter((candidate) => {
                    const request = candidate.metadata?.pptGenerationRequest;
                    return request?.runId === run.runId && request.status === "completed";
                })
                .sort((left, right) => (left.metadata?.pptGenerationRequest?.slotIndex || 0) - (right.metadata?.pptGenerationRequest?.slotIndex || 0))[0];
            if (!requestNode?.metadata?.storageKey) return node;
            changed = true;
            return { ...node, metadata: { ...node.metadata, ...completedImageMetadata(requestNode.metadata), primaryImageId: requestNode.id } };
        });
        return changed ? { ...project, nodes } : project;
    });
}

function completedImageMetadata(metadata: CanvasNodeMetadata): CanvasNodeMetadata {
    return {
        content: metadata.content,
        storageKey: metadata.storageKey,
        naturalWidth: metadata.naturalWidth,
        naturalHeight: metadata.naturalHeight,
        bytes: metadata.bytes,
        mimeType: metadata.mimeType,
    };
}

function sameProviderIdentity(left: PptGenerationRequestTrace["providerIdentity"], right: PptGenerationRequestTrace["providerIdentity"]) {
    return Boolean(left && right && left.channelId === right.channelId && left.baseUrl === right.baseUrl && left.apiFormat === right.apiFormat && left.model === right.model);
}

function queueProjectOperation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = projectOperationQueues.get(projectId) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const tail = pending.then(
        () => undefined,
        () => undefined,
    );
    projectOperationQueues.set(projectId, tail);
    void tail.then(() => {
        if (projectOperationQueues.get(projectId) === tail) projectOperationQueues.delete(projectId);
    });
    return pending;
}

function isNotifiableRunStatus(status: PptGenerationRunStatus) {
    return status === "needs_attention" || status === "completed" || status === "partial" || status === "failed" || status === "abandoned";
}

function errorMessage(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback;
}
