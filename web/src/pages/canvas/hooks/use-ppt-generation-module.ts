import { createElement, useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from "react";
import { App } from "antd";
import { useNavigate, type NavigateFunction } from "react-router-dom";

import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { createPptGenerationModule, PptGenerationPreSubmitError, type PptGenerationModule, type PptGenerationModuleDependencies } from "@/lib/ppt/generation-execution";
import { assertPptGenerationProviderIdentity, type GenerationPlan } from "@/lib/ppt/generation-plan";
import { imageGenerationProviderAdapter } from "@/services/api/image-generation-adapter";
import { ImageRequestRejectedError } from "@/services/api/image";
import { ImageTaskDeliveryUnavailableError, ImageTaskRemoteFailedError, ImageTaskUnavailableError } from "@/services/api/maolao-image";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { flushCanvasStore, readPersistedCanvasProject, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasConnection, CanvasNodeData, PptGenerationProviderIdentity, PptGenerationRunStatus } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

type Params = {
    projectId: string;
    projectLoaded: boolean;
    effectiveConfig: AiConfig;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (open: boolean) => void;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
};

type ActiveCanvasSink = Pick<Params, "nodesRef" | "connectionsRef" | "setNodes" | "setConnections">;
const durableMutationQueues = new Map<string, Promise<void>>();
const activeCanvasSinks = new Map<string, ActiveCanvasSink>();

export function usePptGenerationModule({ projectId, projectLoaded, effectiveConfig, isAiConfigReady, openConfigDialog, nodesRef, connectionsRef, setNodes, setConnections }: Params): PptGenerationModule {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const configRef = useRef(effectiveConfig);
    const readyRef = useRef(isAiConfigReady);
    const openConfigRef = useRef(openConfigDialog);
    configRef.current = effectiveConfig;
    readyRef.current = isAiConfigReady;
    openConfigRef.current = openConfigDialog;
    useEffect(() => {
        if (!projectLoaded) return;
        const sink = { nodesRef, connectionsRef, setNodes, setConnections };
        activeCanvasSinks.set(projectId, sink);
        return () => {
            if (activeCanvasSinks.get(projectId) === sink) activeCanvasSinks.delete(projectId);
        };
    }, [connectionsRef, nodesRef, projectId, projectLoaded, setConnections, setNodes]);

    const durableCanvas = useMemo<PptGenerationModuleDependencies["durableCanvas"]>(
        () => ({
            mutate: (mutator) => {
                return queueDurableMutation(projectId, async () => {
                    const store = useCanvasStore.getState();
                    const stored = store.projects.find((project) => project.id === projectId);
                    if (!stored) throw new Error("画布工程不存在");
                    const sink = activeCanvasSinks.get(projectId);
                    const activeNodes = sink?.nodesRef.current;
                    const activeConnections = sink?.connectionsRef.current;
                    const before = sink ? { ...stored, nodes: mergeDurableGenerationNodes(activeNodes!, stored.nodes), connections: mergeDurableGenerationConnections(activeConnections!, activeNodes!, stored.nodes, stored.connections) } : stored;
                    const next = mutator(before);
                    const nextNodes = sink ? applyNodeProjectDiff(activeNodes!, activeNodes!, next.nodes) : next.nodes;
                    const nextConnections = sink ? applyConnectionProjectDiff(activeConnections!, activeConnections!, next.connections) : next.connections;
                    if (sink) {
                        sink.nodesRef.current = nextNodes;
                        sink.connectionsRef.current = nextConnections;
                        sink.setNodes((current) => {
                            if (activeCanvasSinks.get(projectId) !== sink) return current;
                            return applyNodeProjectDiff(current, activeNodes!, next.nodes);
                        });
                        sink.setConnections((current) => {
                            if (activeCanvasSinks.get(projectId) !== sink) return current;
                            return applyConnectionProjectDiff(current, activeConnections!, next.connections);
                        });
                    }
                    store.updateProject(projectId, { nodes: nextNodes, connections: nextConnections, ...(next.ppt ? { ppt: next.ppt } : {}) });
                    await flushCanvasStore();
                    const persisted = await readPersistedCanvasProject(projectId);
                    if (!persisted) throw new Error("画布工程落盘后读回失败");
                    return persisted;
                });
            },
            read: () =>
                queueDurableMutation(projectId, async () => {
                    await flushCanvasStore();
                    return readPersistedCanvasProject(projectId);
                }),
        }),
        [connectionsRef, nodesRef, projectId, setConnections, setNodes],
    );

    const coreModule = useMemo(
        () =>
            createPptGenerationModule({
                projectId,
                durableCanvas,
                provider: {
                    submit: async ({ project, request, onEvent }) => {
                        let config: AiConfig;
                        let references: ReferenceImage[];
                        try {
                            config = requestConfig(configRef.current, request.providerIdentity, request.settings);
                            references = request.referenceSnapshots
                                ? await Promise.all(
                                      request.referenceSnapshots.map(async (reference) => ({
                                          ...reference,
                                          dataUrl: assertReferenceDataUrl(await imageToDataUrl(reference), reference.name),
                                      })),
                                  )
                                : await resolveReferences(
                                      project.nodes,
                                      request.inputRefs.map((input) => input.nodeId),
                                  );
                        } catch (error) {
                            throw new PptGenerationPreSubmitError(error instanceof Error ? error.message : "生成输入准备失败");
                        }
                        return imageGenerationProviderAdapter.submit({
                            config,
                            prompt: request.prompt,
                            references,
                            onEvent: (event) => onEvent(event.type === "task_created" ? { type: "task_created", taskId: event.taskId, expiresAt: event.expiresAt } : { type: "running" }),
                        });
                    },
                    resume: ({ trace, onEvent }) =>
                        imageGenerationProviderAdapter.resume({
                            config: requestConfig(configRef.current, trace.providerIdentity),
                            remoteTaskId: trace.remoteTaskId!,
                            onEvent: (event) => onEvent(event.type === "task_created" ? { type: "task_created", taskId: event.taskId, expiresAt: event.expiresAt } : { type: "running" }),
                        }),
                    classifyError: (error, trace) => {
                        if (error instanceof ImageTaskDeliveryUnavailableError || error instanceof ImageTaskRemoteFailedError || error instanceof ImageTaskUnavailableError) return "failed";
                        if (trace.remoteTaskId) return "recoverable_error";
                        if (error instanceof ImageRequestRejectedError) return "failed";
                        return "submission_unknown";
                    },
                    hasBillingRisk: (error) => error instanceof ImageTaskDeliveryUnavailableError,
                },
                materialize: async (result) => imageMetadata(await uploadImage(result.dataUrl)),
                notify: ({ runId, pageId, takeId, status }) => notifyRun(message, navigate, projectId, runId, pageId, takeId, status),
            }),
        [durableCanvas, message, navigate, projectId],
    );

    const module = useMemo<PptGenerationModule>(
        () => ({
            start: async (plan: GenerationPlan) => {
                const missingModel = plan.runs.flatMap((run) => run.requests).find((request) => !readyRef.current(configRef.current, request.model));
                if (missingModel) {
                    openConfigRef.current(true);
                    throw new Error(`模型 ${missingModel.model} 尚未配置`);
                }
                return coreModule.start(await freezeGenerationPlanReferences(plan));
            },
            startCandidateEdit: async (plan: GenerationPlan) => {
                const missingModel = plan.runs.flatMap((run) => run.requests).find((request) => !readyRef.current(configRef.current, request.model));
                if (missingModel) {
                    openConfigRef.current(true);
                    throw new Error(`模型 ${missingModel.model} 尚未配置`);
                }
                return coreModule.startCandidateEdit(await freezeGenerationPlanReferences(plan));
            },
            recover: coreModule.recover,
        }),
        [coreModule],
    );

    useEffect(() => {
        if (!projectLoaded) return;
        void module
            .recover({ type: "reconcileProject" })
            .then((result) => result.settled.catch((error) => message.error(error instanceof Error ? error.message : "PPT 生成状态保存失败")))
            .catch((error) => message.error(error instanceof Error ? error.message : "PPT 生成任务恢复失败"));
    }, [message, module, projectLoaded]);

    return module;
}

function requestConfig(config: AiConfig, providerIdentity: PptGenerationProviderIdentity | undefined, settings?: { size: string; quality: string; background?: string }): AiConfig {
    assertPptGenerationProviderIdentity(config, providerIdentity);
    return {
        ...config,
        model: `${providerIdentity.channelId}::${providerIdentity.model}`,
        count: "1",
        ...(settings ? { size: settings.size, quality: settings.quality, background: settings.background || "" } : {}),
    };
}

async function resolveReferences(nodes: CanvasNodeData[], inputNodeIds: string[]): Promise<ReferenceImage[]> {
    return Promise.all(
        inputNodeIds.map(async (nodeId) => {
            const node = nodes.find((item) => item.id === nodeId);
            if (!node?.metadata?.content) throw new Error(`参考图片 ${nodeId} 已丢失`);
            const reference: ReferenceImage = {
                id: node.id,
                name: `${node.title || node.id}.png`,
                type: node.metadata.mimeType || "image/png",
                dataUrl: node.metadata.content,
                storageKey: node.metadata.storageKey,
            };
            return { ...reference, dataUrl: assertReferenceDataUrl(await imageToDataUrl(reference), reference.name) };
        }),
    );
}

export async function freezeGenerationPlanReferences(plan: GenerationPlan, resolveReference: (reference: ReferenceImage) => Promise<string> = imageToDataUrl): Promise<GenerationPlan> {
    const cache = new Map<string, Promise<string>>();
    const freezeReference = (reference: ReferenceImage) => {
        const key = reference.storageKey || reference.dataUrl;
        const existing = cache.get(key);
        if (existing) return existing.then((dataUrl) => ({ ...reference, dataUrl }));
        const frozen = resolveReference(reference).then((dataUrl) => assertReferenceDataUrl(dataUrl, reference.name));
        cache.set(key, frozen);
        return frozen.then((dataUrl) => ({ ...reference, dataUrl }));
    };
    return {
        ...plan,
        runs: await Promise.all(
            plan.runs.map(async (run) => ({
                ...run,
                requests: await Promise.all(
                    run.requests.map(async (request) => ({
                        ...request,
                        ...(request.referenceSnapshots ? { referenceSnapshots: await Promise.all(request.referenceSnapshots.map(freezeReference)) } : {}),
                    })),
                ),
            })),
        ),
    };
}

function assertReferenceDataUrl(dataUrl: string, name: string) {
    if (!/^data:image\/[^;,]+(?:;[^,]+)*,.+$/s.test(dataUrl.trim())) throw new Error(`参考图片 ${name || "（未命名）"} 无法读取`);
    return dataUrl;
}

function mergeDurableGenerationNodes(current: CanvasNodeData[], durable: CanvasNodeData[]) {
    const durableById = new Map(durable.map((node) => [node.id, node]));
    const merged = current.flatMap((node) => {
        const durableNode = durableById.get(node.id);
        if (!durableNode) return isPptGenerationOwnedNode(node) ? [] : [node];
        if (!durableNode.metadata?.pptGenerationRun && !durableNode.metadata?.pptGenerationRequest) return [node];
        const keepHydratedContent = Boolean(node.metadata?.content && node.metadata.storageKey && node.metadata.storageKey === durableNode.metadata.storageKey);
        const preservePrimary = Boolean(node.metadata?.pptGenerationRun && !node.metadata?.pptGenerationRequest && node.metadata.primaryImageId);
        const primaryProjection = preservePrimary
            ? {
                  primaryImageId: node.metadata?.primaryImageId,
                  content: node.metadata?.content,
                  storageKey: node.metadata?.storageKey,
                  naturalWidth: node.metadata?.naturalWidth,
                  naturalHeight: node.metadata?.naturalHeight,
                  bytes: node.metadata?.bytes,
                  mimeType: node.metadata?.mimeType,
              }
            : {};
        return [
            {
                ...node,
                metadata: {
                    ...node.metadata,
                    ...durableNode.metadata,
                    ...(keepHydratedContent ? { content: node.metadata?.content } : {}),
                    ...primaryProjection,
                    ...(node.metadata?.imageBatchExpanded !== undefined ? { imageBatchExpanded: node.metadata.imageBatchExpanded } : {}),
                    ...(node.metadata?.freeResize !== undefined ? { freeResize: node.metadata.freeResize } : {}),
                },
            },
        ];
    });
    const currentIds = new Set(current.map((node) => node.id));
    return [...merged, ...durable.filter((node) => !currentIds.has(node.id) && isPptGenerationOwnedNode(node))];
}

function mergeDurableGenerationConnections(current: CanvasConnection[], currentNodes: CanvasNodeData[], durableNodes: CanvasNodeData[], durable: CanvasConnection[]) {
    const ledgerNodeIds = new Set([...currentNodes, ...durableNodes].filter(isPptGenerationOwnedNode).map((node) => node.id));
    const durableById = new Map(durable.map((connection) => [connection.id, connection]));
    const merged = current.flatMap((connection) => {
        if (!ledgerNodeIds.has(connection.fromNodeId) && !ledgerNodeIds.has(connection.toNodeId)) return [connection];
        const durableConnection = durableById.get(connection.id);
        return durableConnection ? [durableConnection] : [];
    });
    const currentIds = new Set(current.map((connection) => connection.id));
    return [...merged, ...durable.filter((connection) => !currentIds.has(connection.id) && (ledgerNodeIds.has(connection.fromNodeId) || ledgerNodeIds.has(connection.toNodeId)))];
}

function isPptGenerationOwnedNode(node: CanvasNodeData) {
    return Boolean(node.metadata?.pptGenerationRun || node.metadata?.pptGenerationRequest || (node.metadata?.pptPageId && node.metadata?.pptTakeId));
}

function applyNodeProjectDiff(current: CanvasNodeData[], before: CanvasNodeData[], after: CanvasNodeData[]) {
    const beforeById = new Map(before.map((node) => [node.id, node]));
    const afterById = new Map(after.map((node) => [node.id, node]));
    const removedIds = new Set(before.filter((node) => !afterById.has(node.id)).map((node) => node.id));
    const merged = current
        .filter((node) => !removedIds.has(node.id))
        .map((node) => {
            const previous = beforeById.get(node.id);
            const next = afterById.get(node.id);
            if (!previous || !next || previous === next) return node;
            const patch = changedFields(previous, next, "metadata");
            const metadataPatch = changedFields(previous.metadata || {}, next.metadata || {});
            return { ...node, ...patch, metadata: { ...node.metadata, ...metadataPatch } };
        });
    const currentIds = new Set(merged.map((node) => node.id));
    return [...merged, ...after.filter((node) => !beforeById.has(node.id) && !currentIds.has(node.id))];
}

function applyConnectionProjectDiff(current: CanvasConnection[], before: CanvasConnection[], after: CanvasConnection[]) {
    const beforeIds = new Set(before.map((connection) => connection.id));
    const afterIds = new Set(after.map((connection) => connection.id));
    return [...current.filter((connection) => !beforeIds.has(connection.id) || afterIds.has(connection.id)), ...after.filter((connection) => !beforeIds.has(connection.id) && !current.some((currentConnection) => currentConnection.id === connection.id))];
}

function changedFields<T extends object>(before: T, after: T, excluded?: keyof T) {
    return Object.fromEntries(Object.entries(after).filter(([key, value]) => key !== excluded && before[key as keyof T] !== value)) as Partial<T>;
}

function queueDurableMutation<T>(projectId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = durableMutationQueues.get(projectId) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(mutation);
    const tail = pending.then(
        () => undefined,
        () => undefined,
    );
    durableMutationQueues.set(projectId, tail);
    void tail.then(() => {
        if (durableMutationQueues.get(projectId) === tail) durableMutationQueues.delete(projectId);
    });
    return pending;
}

export function buildPptGenerationNotificationHref({ projectId, pageId, takeId, runId, status }: { projectId: string; pageId: string; takeId: string; runId: string; status: PptGenerationRunStatus }) {
    const search = new URLSearchParams({ pptPage: pageId, pptTake: takeId, pptRun: runId, pptStatus: status });
    return `/canvas/${projectId}?${search.toString()}`;
}

function notifyRun(
    message: { open: (config: { key?: string; type: "success" | "warning" | "error" | "info"; content: ReactNode; duration?: number }) => unknown },
    navigate: NavigateFunction,
    projectId: string,
    runId: string,
    pageId: string,
    takeId: string,
    status: PptGenerationRunStatus,
) {
    const pageIndex = useCanvasStore
        .getState()
        .projects.find((project) => project.id === projectId)
        ?.ppt?.pages.find((page) => page.pageId === pageId)?.index;
    const label = pageIndex ? `第 ${pageIndex} 页` : "PPT 页面";
    const result =
        status === "completed"
            ? { type: "success" as const, text: "生成完成" }
            : status === "partial"
              ? { type: "warning" as const, text: "部分生成完成" }
              : status === "needs_attention"
                ? { type: "warning" as const, text: "生成需要处理" }
                : status === "failed"
                  ? { type: "error" as const, text: "生成失败" }
                  : { type: "info" as const, text: "已标记放弃" };
    message.open({
        key: `ppt-run-${runId}-${status}`,
        type: result.type,
        duration: 6,
        content: createElement(
            "button",
            {
                type: "button",
                className: "bg-transparent text-left",
                onClick: () => navigate(buildPptGenerationNotificationHref({ projectId, pageId, takeId, runId, status })),
            },
            `${label}${result.text} · 点击查看`,
        ),
    });
}
