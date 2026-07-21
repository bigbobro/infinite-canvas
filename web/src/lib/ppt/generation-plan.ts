import { nanoid } from "nanoid";

import { buildNodeGenerationInputs } from "@/components/canvas/canvas-node-generation";
import { getNodeSpec } from "@/constant/canvas";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { getGenerationCount, resolveGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { PPT_PAGE_PROMPT } from "@/lib/ppt/deck-builder";
import { buildPptPageWorkspace, type PptPageWorkspace, type PptPageWorkspaceTake } from "@/lib/ppt/page-workspace";
import { compilePptPromptSnapshot, type PptCompilationTarget } from "@/lib/ppt/prompt-compiler";
import type { CanvasProject, CanvasProjectPpt, CanvasProjectPptCompilationSnapshot, CanvasProjectPptPageSpec, CanvasProjectPptTake } from "@/stores/canvas/use-canvas-store";
import { modelOptionName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type Position, type PptCandidateEditSnapshot, type PptGenerationProviderIdentity } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

export type GenerationIntent =
    | { kind: "startBatch"; anchorFirst: boolean }
    | { kind: "generateRest" }
    | { kind: "generateSingle"; takeId: string; promptDraft?: string }
    | { kind: "generateOneCandidate"; takeId: string }
    | {
          kind: "deriveAndGenerate";
          pageId: string;
          reservedTakeId: string;
          reservedConfigNodeId: string;
          reservedAnchorNodeId: string;
          configMetadata: CanvasNodeMetadata;
          anchorContent: string;
          inheritedInputNodeIds: string[];
          pageSpec?: CanvasProjectPptPageSpec;
          positions?: { anchor?: Position; config?: Position };
      };

export type GenerationRequestType = "textToImage" | "imageToImage";

export type GenerationInputRef = { nodeId: string; type: "image" };

export type GenerationRequestSettings = {
    size: string;
    quality: string;
    background?: string;
};

export type GenerationPlanRequest = {
    requestId: string;
    requestNodeId: string;
    slotIndex: number;
    requestType: GenerationRequestType;
    model: string;
    providerIdentity: PptGenerationProviderIdentity;
    compilationSnapshotId?: string;
    candidateEdit?: PptCandidateEditSnapshot;
    prompt: string;
    inputRefs: GenerationInputRef[];
    /** 仅存活于本次冻结计划内；用于标注改图等已经生成本地参考快照的请求。 */
    referenceSnapshots?: ReferenceImage[];
    settings: GenerationRequestSettings;
};

export function resolvePptGenerationProviderIdentity(config: AiConfig, value: string): PptGenerationProviderIdentity {
    const model = modelOptionName(value).trim();
    const channel = resolveModelChannel(config, value);
    if (!model) throw new Error("生图模型未配置");
    return {
        channelId: channel.id,
        baseUrl: normalizeProviderBaseUrl(channel.baseUrl),
        apiFormat: channel.apiFormat,
        model,
    };
}

export function assertPptGenerationProviderIdentity(config: AiConfig, expected: PptGenerationProviderIdentity | undefined): asserts expected is PptGenerationProviderIdentity {
    if (!expected) throw new Error("原任务缺少已冻结的渠道身份，系统不会改用其他渠道续查");
    const channel = config.channels.find((item) => item.id === expected.channelId);
    if (!channel || !channel.models.some((item) => item.name === expected.model)) {
        throw new Error("原任务的渠道或模型已不存在；请恢复原配置后重新获取，系统不会改用其他渠道");
    }
    const current: PptGenerationProviderIdentity = { channelId: channel.id, baseUrl: normalizeProviderBaseUrl(channel.baseUrl), apiFormat: channel.apiFormat, model: expected.model };
    if (!sameProviderIdentity(current, expected)) throw new Error("原任务的渠道地址、协议或模型已变更；请恢复原配置后重新获取，系统不会改用其他渠道");
}

export type GenerationPlanRun = {
    runId: string;
    pageId: string;
    takeId: string;
    pageIndex: number;
    baseNodeId: string;
    rootNodeId: string;
    plannedCount: number;
    requests: GenerationPlanRequest[];
};

export type GenerationStructureOp = Exclude<CanvasAgentOp, { type: "run_generation" }>;

export type GenerationPlanPptOp =
    | { type: "setFlags"; flags: { skipAnchor?: boolean; anchorConfirmed?: boolean } }
    | { type: "appendTake"; pageId: string; take: CanvasProjectPptTake }
    | { type: "setPageSpec"; pageSpec: CanvasProjectPptPageSpec }
    | { type: "appendCompilationSnapshot"; snapshot: CanvasProjectPptCompilationSnapshot };

export type GenerationPlan = {
    readonly kind: "pageGeneration" | "candidateEdit";
    readonly batchId: string;
    readonly createdAt: string;
    readonly runs: readonly GenerationPlanRun[];
    readonly structureOps: readonly GenerationStructureOp[];
    readonly pptOps: readonly GenerationPlanPptOp[];
    readonly pageCount: number;
    readonly callCount: number;
    readonly callBreakdown: { textToImage: number; imageToImage: number };
    readonly excludedPages: readonly { pageIndex: number; reason: string }[];
    readonly compilation?: CanvasProjectPptCompilationSnapshot;
};

type ExistingTarget = { kind: "existing"; pageId: string; pageIndex: number; take?: PptPageWorkspaceTake; plannedCount?: 1 };
type PendingTarget = {
    kind: "pending";
    pageId: string;
    takeId: string;
    pageIndex: number;
    configNode: CanvasNodeData;
    anchorNode: CanvasNodeData;
    connections: CanvasConnection[];
};

type ValidTarget = {
    pageId: string;
    takeId: string;
    pageIndex: number;
    anchorNode: CanvasNodeData;
    configNode: CanvasNodeData;
    plannedCount?: 1;
    extraNodes?: CanvasNodeData[];
    extraConnections?: CanvasConnection[];
};

export function createGenerationPlan(intent: GenerationIntent, { project, effectiveConfig }: { project: CanvasProject; effectiveConfig: AiConfig }): GenerationPlan {
    const batchId = nanoid();
    const createdAt = new Date().toISOString();
    if (!project.ppt) return emptyPlan(batchId, createdAt);

    const workspaces = [...project.ppt.pages].sort((left, right) => left.index - right.index).map((page) => buildPptPageWorkspace(project, page));
    const anchorUpdates: GenerationStructureOp[] = [];
    const anchorConnections: GenerationStructureOp[] = [];
    const pendingOps: GenerationStructureOp[] = [];
    const pptOps: GenerationPlanPptOp[] = [];
    const excludedPages: Array<{ pageIndex: number; reason: string }> = [];
    const targets: Array<ExistingTarget | PendingTarget> = [];

    if (intent.kind === "startBatch") {
        const selected = intent.anchorFirst ? workspaces.slice(0, 1) : workspaces.filter(isPageUntouched);
        targets.push(...selected.map((workspace): ExistingTarget => ({ kind: "existing", pageId: workspace.page.pageId, pageIndex: workspace.page.index, take: workspace.takes.at(-1) })));
        pptOps.push({ type: "setFlags", flags: { skipAnchor: !intent.anchorFirst, ...(intent.anchorFirst ? { anchorConfirmed: false } : {}) } });
    }

    if (intent.kind === "generateRest") {
        const firstWorkspace = workspaces[0];
        const hasStyleNode = project.nodes.some((node) => node.metadata?.pptRole === "style");
        const skipAnchor = project.ppt.skipAnchor ?? !hasStyleNode;
        const selected = workspaces.filter((workspace) => (skipAnchor || workspace.page.pageId !== firstWorkspace?.page.pageId) && isPageUntouched(workspace));
        targets.push(...selected.map((workspace): ExistingTarget => ({ kind: "existing", pageId: workspace.page.pageId, pageIndex: workspace.page.index, take: workspace.takes.at(-1) })));
        // anchorConfirmed 只是流程摘要；每个后来修复/新建的目标仍需幂等确保首页参考图连线。
        const anchorNodeId = !skipAnchor ? firstWorkspace?.resolvedConfirmedNodeId : undefined;
        if (anchorNodeId) {
            for (const target of targets) {
                if (target.kind === "existing" && target.take?.configNode?.type === CanvasNodeType.Config) anchorConnections.push({ type: "connect_nodes", id: nanoid(), fromNodeId: anchorNodeId, toNodeId: target.take.configNode.id });
            }
            if (anchorConnections.length) pptOps.push({ type: "setFlags", flags: { anchorConfirmed: true } });
        }
    }

    if (intent.kind === "generateSingle" || intent.kind === "generateOneCandidate") {
        const workspace = workspaces.find((item) => item.takes.some((take) => take.takeId === intent.takeId));
        const take = workspace?.takes.find((item) => item.takeId === intent.takeId);
        if (!workspace) excludedPages.push({ pageIndex: 0, reason: "方案不存在" });
        else if (intent.kind === "generateOneCandidate" && !take?.candidates.length) excludedPages.push({ pageIndex: workspace.page.index, reason: "当前方案还没有候选稿" });
        else targets.push({ kind: "existing", pageId: workspace.page.pageId, pageIndex: workspace.page.index, take, ...(intent.kind === "generateOneCandidate" ? { plannedCount: 1 } : {}) });
        if (intent.kind === "generateSingle" && take?.anchorNode && intent.promptDraft !== undefined && intent.promptDraft !== take.prompt) {
            anchorUpdates.push({ type: "update_node", id: take.anchorNode.id, metadata: { content: intent.promptDraft, status: "success" } });
        }
    }

    if (intent.kind === "deriveAndGenerate") {
        const page = workspaces.find((workspace) => workspace.page.pageId === intent.pageId)?.page;
        if (!page) {
            excludedPages.push({ pageIndex: 0, reason: "页面不存在" });
        } else {
            const takeId = intent.reservedTakeId;
            const anchorNode = pendingNode(intent.reservedAnchorNodeId, CanvasNodeType.Text, `第${page.index}页大纲`, intent.positions?.anchor, {
                content: intent.anchorContent,
                status: "success",
                pptPageId: page.pageId,
                pptTakeId: takeId,
                pptPageIndex: page.index,
                pptRole: "outline",
            });
            const configNode = pendingNode(intent.reservedConfigNodeId, CanvasNodeType.Config, `第${page.index}页生成配置`, intent.positions?.config, { ...intent.configMetadata, pptPageId: page.pageId, pptTakeId: takeId });
            const connections = [pendingConnection(intent.reservedAnchorNodeId, intent.reservedConfigNodeId), ...intent.inheritedInputNodeIds.map((nodeId) => pendingConnection(nodeId, intent.reservedConfigNodeId))];
            pendingOps.push(
                { type: "add_node", id: anchorNode.id, nodeType: anchorNode.type, title: anchorNode.title, position: anchorNode.position, metadata: anchorNode.metadata },
                { type: "add_node", id: configNode.id, nodeType: configNode.type, title: configNode.title, position: configNode.position, metadata: configNode.metadata },
                ...connections.map((connection): GenerationStructureOp => ({ type: "connect_nodes", id: connection.id, fromNodeId: connection.fromNodeId, toNodeId: connection.toNodeId })),
            );
            targets.push({ kind: "pending", pageId: page.pageId, takeId, pageIndex: page.index, anchorNode, configNode, connections });
            pptOps.push({ type: "appendTake", pageId: page.pageId, take: { takeId, anchorNodeId: intent.reservedAnchorNodeId, configNodeId: intent.reservedConfigNodeId } });
            if (intent.pageSpec) pptOps.push({ type: "setPageSpec", pageSpec: intent.pageSpec });
        }
    }

    const validTargets: ValidTarget[] = [];
    for (const target of targets) {
        if (target.kind === "existing") {
            if (!target.take?.anchorNode || target.take.anchorNode.type !== CanvasNodeType.Text) {
                excludedPages.push({ pageIndex: target.pageIndex, reason: "缺少方案提示词" });
                continue;
            }
            if (!target.take?.configNode || target.take.configNode.type !== CanvasNodeType.Config) {
                excludedPages.push({ pageIndex: target.pageIndex, reason: "缺少生成配置" });
                continue;
            }
            if (!project.connections.some((connection) => connection.fromNodeId === target.take!.anchorNode!.id && connection.toNodeId === target.take!.configNode!.id)) {
                excludedPages.push({ pageIndex: target.pageIndex, reason: "方案提示词与生成配置的连接缺失" });
                continue;
            }
            validTargets.push({ pageId: target.pageId, takeId: target.take.takeId, pageIndex: target.pageIndex, anchorNode: target.take.anchorNode, configNode: target.take.configNode, plannedCount: target.plannedCount });
        } else {
            validTargets.push({
                pageId: target.pageId,
                takeId: target.takeId,
                pageIndex: target.pageIndex,
                anchorNode: target.anchorNode,
                configNode: target.configNode,
                extraNodes: [target.anchorNode, target.configNode],
                extraConnections: target.connections,
            });
        }
    }

    const plannedConnections = anchorConnections.flatMap((op): CanvasConnection[] =>
        op.type === "connect_nodes" && !project.connections.some((connection) => connection.fromNodeId === op.fromNodeId && connection.toNodeId === op.toNodeId) ? [{ id: op.id || nanoid(), fromNodeId: op.fromNodeId, toNodeId: op.toNodeId }] : [],
    );
    const structureOps: GenerationStructureOp[] = [...anchorUpdates, ...anchorConnections, ...pendingOps];
    const targetContexts = validTargets.map((target) => {
        const nodes = target.extraNodes ? [...project.nodes.filter((node) => !target.extraNodes!.some((extra) => extra.id === node.id)), ...target.extraNodes] : project.nodes;
        const connections = [...project.connections, ...plannedConnections, ...(target.extraConnections || [])];
        const nodeById = new Map(nodes.map((node) => [node.id, node]));
        const inputs = buildNodeGenerationInputs(target.configNode.id, nodes, connections);
        const styleTexts = inputs.filter((input) => input.type === "text" && nodeById.get(input.nodeId)?.metadata?.pptRole === "style").map((input) => input.text || "");
        const extraTexts = inputs.filter((input) => input.type === "text" && input.nodeId !== target.anchorNode.id && nodeById.get(input.nodeId)?.metadata?.pptRole !== "style").map((input) => input.text || "");
        const promptDraft = intent.kind === "generateSingle" && intent.takeId === target.takeId ? intent.promptDraft : undefined;
        const layoutPrompt = generationPrompt(project, target.configNode);
        const override = target.configNode.metadata?.pptCompiledPromptOverride?.trim() || undefined;
        return {
            target,
            inputs,
            compilationTarget: {
                pageId: target.pageId,
                takeId: target.takeId,
                semanticText: promptDraft ?? String(target.anchorNode.metadata?.content || ""),
                layoutIntent: [layoutPrompt].filter(Boolean),
                layoutConfirmed: !layoutPrompt || layoutPrompt === PPT_PAGE_PROMPT || target.configNode.metadata?.pptLayoutPromptReviewed === layoutPrompt,
                styleTexts,
                extraTexts,
                override,
                overrideConfirmed: Boolean(override && target.configNode.metadata?.pptCompiledPromptReviewedOverride === override),
            },
        };
    });
    const compilation = targetContexts.length
        ? compilePptPromptSnapshot({
              snapshotId: nanoid(),
              compiledAt: createdAt,
              deckBrief: project.ppt.deckBrief,
              pageSpecs: project.ppt.pageSpecs,
              targets: targetContexts.map((item) => item.compilationTarget),
          })
        : undefined;
    if (compilation) pptOps.push({ type: "appendCompilationSnapshot", snapshot: compilation });
    const compiledPromptByTarget = new Map(compilation?.prompts.map((prompt) => [`${prompt.pageId}:${prompt.takeId}`, prompt]));
    const runs = targetContexts.map<GenerationPlanRun>(({ target, inputs }) => {
        const compiledPrompt = compiledPromptByTarget.get(`${target.pageId}:${target.takeId}`);
        const effectivePrompt = compiledPrompt?.finalPrompt.trim() || "";
        const config = resolveGenerationConfig(effectiveConfig, target.configNode, "image");
        const referenceImages = inputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
        const requestType: GenerationRequestType = referenceImages.length ? "imageToImage" : "textToImage";
        const inputRefs = referenceImages.map<GenerationInputRef>((image) => ({ nodeId: image.id, type: "image" }));
        const plannedCount = target.plannedCount ?? getGenerationCount(config.count);
        const runId = nanoid();
        const rootNodeId = nanoid();
        const requestNodeIds = plannedCount === 1 ? [rootNodeId] : Array.from({ length: plannedCount }, () => nanoid());
        const requests = requestNodeIds.map<GenerationPlanRequest>((requestNodeId, slotIndex) => ({
            requestId: nanoid(),
            requestNodeId,
            slotIndex,
            requestType,
            model: config.model,
            providerIdentity: resolvePptGenerationProviderIdentity(effectiveConfig, config.model),
            compilationSnapshotId: compilation?.snapshotId,
            prompt: effectivePrompt,
            inputRefs,
            referenceSnapshots: referenceImages,
            settings: { size: config.size, quality: config.quality, ...(config.background ? { background: config.background } : {}) },
        }));
        const run: GenerationPlanRun = {
            runId,
            pageId: target.pageId,
            takeId: target.takeId,
            pageIndex: target.pageIndex,
            baseNodeId: target.configNode.id,
            rootNodeId,
            plannedCount,
            requests,
        };
        structureOps.push(...buildRunStructureOps(run, target.configNode, requestType, effectivePrompt, config));
        return run;
    });
    const callBreakdown = runs.flatMap((run) => run.requests).reduce((total, request) => ({ ...total, [request.requestType]: total[request.requestType] + 1 }), { textToImage: 0, imageToImage: 0 });

    return {
        kind: "pageGeneration",
        batchId,
        createdAt,
        runs,
        structureOps,
        pptOps,
        pageCount: runs.length,
        callCount: callBreakdown.textToImage + callBreakdown.imageToImage,
        callBreakdown,
        excludedPages,
        compilation,
    };
}

export function createPptCandidateEditPlan({
    project,
    effectiveConfig,
    pageId,
    takeId,
    sourceNodeId,
    candidateEdit,
    reference,
}: {
    project: CanvasProject;
    effectiveConfig: AiConfig;
    pageId: string;
    takeId: string;
    sourceNodeId: string;
    candidateEdit: PptCandidateEditSnapshot;
    reference: ReferenceImage;
}): GenerationPlan {
    const page = project.ppt?.pages.find((item) => item.pageId === pageId);
    const take = page && buildPptPageWorkspace(project, page).takes.find((item) => item.takeId === takeId);
    const sourceNode = take?.candidates.find((candidate) => candidate.id === sourceNodeId);
    if (!page || !sourceNode || sourceNode.metadata?.isBatchRoot) throw new Error("修改基图不是当前 PPT 方案的成功候选");
    if (!isPptCandidateEditSnapshot(candidateEdit, sourceNodeId)) throw new Error("候选修改快照与基图不一致或内容无效");

    const batchId = nanoid();
    const createdAt = new Date().toISOString();
    const config = resolveGenerationConfig(effectiveConfig, sourceNode, "image");
    const runId = nanoid();
    const rootNodeId = nanoid();
    const request: GenerationPlanRequest = {
        requestId: nanoid(),
        requestNodeId: rootNodeId,
        slotIndex: 0,
        requestType: "imageToImage",
        model: config.model,
        providerIdentity: resolvePptGenerationProviderIdentity(effectiveConfig, config.model),
        candidateEdit,
        prompt: candidateEdit.finalPrompt,
        inputRefs: [{ nodeId: sourceNode.id, type: "image" }],
        referenceSnapshots: [reference],
        settings: { size: config.size, quality: config.quality, ...(config.background ? { background: config.background } : {}) },
    };
    const run: GenerationPlanRun = { runId, pageId, takeId, pageIndex: page.index, baseNodeId: sourceNode.id, rootNodeId, plannedCount: 1, requests: [request] };
    return {
        kind: "candidateEdit",
        batchId,
        createdAt,
        runs: [run],
        structureOps: buildRunStructureOps(run, sourceNode, "imageToImage", candidateEdit.finalPrompt, config),
        pptOps: [],
        pageCount: 1,
        callCount: 1,
        callBreakdown: { textToImage: 0, imageToImage: 1 },
        excludedPages: [],
    };
}

export function isPptCandidateEditSnapshot(snapshot: PptCandidateEditSnapshot | undefined, sourceNodeId: string): snapshot is PptCandidateEditSnapshot {
    if (
        !snapshot ||
        typeof snapshot.baseNodeId !== "string" ||
        snapshot.baseNodeId !== sourceNodeId ||
        typeof snapshot.globalInstruction !== "string" ||
        !Array.isArray(snapshot.annotations) ||
        typeof snapshot.finalPrompt !== "string" ||
        !snapshot.finalPrompt.trim()
    )
        return false;
    if (!snapshot.globalInstruction.trim() && !snapshot.annotations.length) return false;
    if (snapshot.globalInstruction.trim() && !snapshot.finalPrompt.includes(snapshot.globalInstruction.trim())) return false;
    return snapshot.annotations.every(
        (annotation, index) =>
            annotation !== null &&
            typeof annotation === "object" &&
            Number.isInteger(annotation.index) &&
            annotation.index === index + 1 &&
            Number.isFinite(annotation.x) &&
            annotation.x >= 0 &&
            annotation.x <= 1 &&
            Number.isFinite(annotation.y) &&
            annotation.y >= 0 &&
            annotation.y <= 1 &&
            typeof annotation.instruction === "string" &&
            Boolean(annotation.instruction.trim()) &&
            snapshot.finalPrompt.includes(annotation.instruction.trim()),
    );
}

export function applyGenerationPlanPptOps(ppt: CanvasProjectPpt, ops: readonly GenerationPlanPptOp[]): CanvasProjectPpt {
    return ops.reduce<CanvasProjectPpt>((current, op) => {
        if (op.type === "setFlags") return { ...current, ...op.flags };
        if (op.type === "appendCompilationSnapshot") {
            const existing = current.compilationSnapshots.find((snapshot) => snapshot.snapshotId === op.snapshot.snapshotId);
            if (existing) {
                if (!sameCompilationSnapshot(existing, op.snapshot)) throw new Error(`编译快照 ${op.snapshot.snapshotId} 的内容与已落盘记录不一致`);
                return current;
            }
            return { ...current, compilationSnapshots: [...current.compilationSnapshots, structuredClone(op.snapshot)] };
        }
        if (op.type === "setPageSpec") {
            const existing = current.pageSpecs.find((pageSpec) => pageSpec.pageId === op.pageSpec.pageId);
            if (existing && samePageSpec(existing, op.pageSpec)) return current;
            if (existing && existing.version >= op.pageSpec.version) throw new Error(`第 ${current.pages.find((page) => page.pageId === op.pageSpec.pageId)?.index ?? "-"} 页规格已变更，请重新确认生成计划`);
            return { ...current, pageSpecs: [...current.pageSpecs.filter((pageSpec) => pageSpec.pageId !== op.pageSpec.pageId), structuredClone(op.pageSpec)] };
        }
        return {
            ...current,
            pages: current.pages.map((page) => {
                if (page.pageId !== op.pageId || page.takes.some((take) => take.takeId === op.take.takeId)) return page;
                return { ...page, takes: [...page.takes, op.take] };
            }),
        };
    }, ppt);
}

export function assertGenerationPlanCompilation(plan: GenerationPlan, expectedKind: GenerationPlan["kind"] = plan.kind) {
    if (!plan.compilation) {
        if (expectedKind !== "candidateEdit" && plan.runs.length) throw new Error("PPT 页面生成计划缺少 Compiler 快照");
        if (plan.runs.some((run) => run.requests.some((request) => request.compilationSnapshotId))) throw new Error("PPT 生成计划的 Compiler 快照已丢失");
        return;
    }
    if (expectedKind !== "pageGeneration") throw new Error("候选图编辑计划不应包含 Compiler 快照");
    const rebuilt = compilePptPromptSnapshot({
        snapshotId: plan.compilation.snapshotId,
        compiledAt: plan.compilation.createdAt,
        deckBrief: plan.compilation.deckBrief,
        pageSpecs: plan.compilation.pageSpecs,
        targets: plan.compilation.targets,
    });
    if (!sameCompilationSnapshot(rebuilt, plan.compilation)) throw new Error("Compiler 快照不是由当前编译输入确定性生成");
    const compiledPromptByTarget = new Map(plan.compilation.prompts.map((prompt) => [`${prompt.pageId}:${prompt.takeId}`, prompt]));
    for (const run of plan.runs) {
        for (const request of run.requests) {
            if (!request.compilationSnapshotId || request.compilationSnapshotId !== plan.compilation.snapshotId) throw new Error(`请求槽 ${request.requestId} 的编译快照绑定不一致`);
            const compiledPrompt = compiledPromptByTarget.get(`${run.pageId}:${run.takeId}`);
            if (!compiledPrompt || compiledPrompt.finalPrompt !== request.prompt) throw new Error(`请求槽 ${request.requestId} 的实际提示词与编译快照不一致`);
        }
    }
}

export function assertGenerationPlanCurrentTargets(project: CanvasProject, plan: GenerationPlan) {
    if (!plan.compilation) return;
    const expected = new Map(plan.compilation.targets.map((target) => [`${target.pageId}:${target.takeId}`, target]));
    for (const run of plan.runs) {
        const page = project.ppt?.pages.find((item) => item.pageId === run.pageId);
        if (!page) throw new Error(`页面 ${run.pageId} 的 Compiler 输入已变更`);
        const workspace = buildPptPageWorkspace(project, page);
        const take = workspace.takes.find((item) => item.takeId === run.takeId);
        if (!take?.anchorNode || !take.configNode) throw new Error(`页面 ${run.pageId} 的 Compiler 输入节点已变更`);
        const inputs = buildNodeGenerationInputs(take.configNode.id, project.nodes, project.connections);
        const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
        const layoutPrompt = generationPrompt(project, take.configNode);
        const override = take.configNode.metadata?.pptCompiledPromptOverride?.trim() || undefined;
        const current: PptCompilationTarget = {
            pageId: run.pageId,
            takeId: run.takeId,
            semanticText: String(take.anchorNode.metadata?.content || ""),
            layoutIntent: [layoutPrompt].filter(Boolean),
            layoutConfirmed: !layoutPrompt || layoutPrompt === PPT_PAGE_PROMPT || take.configNode.metadata?.pptLayoutPromptReviewed === layoutPrompt,
            styleTexts: inputs.filter((input) => input.type === "text" && nodeById.get(input.nodeId)?.metadata?.pptRole === "style").map((input) => input.text || ""),
            extraTexts: inputs.filter((input) => input.type === "text" && input.nodeId !== take.anchorNode!.id && nodeById.get(input.nodeId)?.metadata?.pptRole !== "style").map((input) => input.text || ""),
            override,
            overrideConfirmed: Boolean(override && take.configNode.metadata?.pptCompiledPromptReviewedOverride === override),
        };
        if (JSON.stringify(current) !== JSON.stringify(expected.get(`${run.pageId}:${run.takeId}`))) throw new Error(`页面 ${run.pageId} 的 Compiler 输入已变更，请重新确认生成计划`);
    }
}

function buildRunStructureOps(run: GenerationPlanRun, configNode: CanvasNodeData, requestType: GenerationRequestType, prompt: string, config: AiConfig): GenerationStructureOp[] {
    const imageSpec = getNodeSpec(CanvasNodeType.Image);
    const rootPosition = {
        x: configNode.position.x + configNode.width + 96,
        y: configNode.position.y + configNode.height / 2 - imageSpec.height / 2,
    };
    const rootMetadata: CanvasNodeMetadata = {
        prompt,
        status: "idle",
        generationType: requestType === "imageToImage" ? "edit" : "generation",
        model: config.model,
        size: config.size,
        quality: config.quality,
        ...(config.background ? { background: config.background } : {}),
        count: run.plannedCount,
        isBatchRoot: run.plannedCount > 1,
        batchChildIds: run.plannedCount > 1 ? run.requests.map((request) => request.requestNodeId) : undefined,
        batchUsesReferenceImages: requestType === "imageToImage",
        imageBatchExpanded: run.plannedCount > 1 ? true : undefined,
        pptPageId: run.pageId,
        pptTakeId: run.takeId,
        pptPageIndex: run.pageIndex,
    };
    const rootOp: GenerationStructureOp = {
        type: "add_node",
        id: run.rootNodeId,
        nodeType: CanvasNodeType.Image,
        title: prompt.slice(0, 32) || "Generated Image",
        position: rootPosition,
        width: imageSpec.width,
        height: imageSpec.height,
        metadata: rootMetadata,
    };
    const requestOps =
        run.plannedCount > 1
            ? run.requests.map<GenerationStructureOp>((request) => ({
                  type: "add_node",
                  id: request.requestNodeId,
                  nodeType: CanvasNodeType.Image,
                  title: prompt.slice(0, 32) || "Generated Image",
                  position: {
                      x: rootPosition.x + imageSpec.width + 120 + (request.slotIndex % 2) * (imageSpec.width + 36),
                      y: rootPosition.y + Math.floor(request.slotIndex / 2) * (imageSpec.height + 36),
                  },
                  width: imageSpec.width,
                  height: imageSpec.height,
                  metadata: { ...rootMetadata, count: 1, isBatchRoot: undefined, batchChildIds: undefined, imageBatchExpanded: undefined, batchRootId: run.rootNodeId },
              }))
            : [];
    const connectionOps: GenerationStructureOp[] = [
        { type: "connect_nodes", id: nanoid(), fromNodeId: run.baseNodeId, toNodeId: run.rootNodeId },
        ...run.requests.flatMap<GenerationStructureOp>((request) => (request.requestNodeId === run.rootNodeId ? [] : [{ type: "connect_nodes", id: nanoid(), fromNodeId: run.rootNodeId, toNodeId: request.requestNodeId }])),
    ];
    return [rootOp, ...requestOps, ...connectionOps];
}

function isPageUntouched(workspace: PptPageWorkspace) {
    return !workspace.takes.some((take) => take.candidates.length || take.generating || take.unresolvedGeneration);
}

function generationPrompt(project: CanvasProject, configNode: CanvasNodeData) {
    return (configNode.metadata?.pptLayoutPrompt ?? "").trim() || (project.ppt?.mode === "extract" ? "" : PPT_PAGE_PROMPT);
}

function pendingNode(id: string, type: CanvasNodeData["type"], title: string, position: Position | undefined, metadata: CanvasNodeMetadata): CanvasNodeData {
    const spec = getNodeSpec(type);
    return { id, type, title, position: position || { x: 0, y: 0 }, width: spec.width, height: spec.height, metadata };
}

function pendingConnection(fromNodeId: string, toNodeId: string): CanvasConnection {
    return { id: nanoid(), fromNodeId, toNodeId };
}

function emptyPlan(batchId: string, createdAt: string): GenerationPlan {
    return { kind: "pageGeneration", batchId, createdAt, runs: [], structureOps: [], pptOps: [], pageCount: 0, callCount: 0, callBreakdown: { textToImage: 0, imageToImage: 0 }, excludedPages: [] };
}

function normalizeProviderBaseUrl(value: string) {
    return value.trim().replace(/\/+$/, "");
}

function sameProviderIdentity(left: PptGenerationProviderIdentity, right: PptGenerationProviderIdentity) {
    return left.channelId === right.channelId && left.baseUrl === right.baseUrl && left.apiFormat === right.apiFormat && left.model === right.model;
}

function sameCompilationSnapshot(left: CanvasProjectPptCompilationSnapshot, right: CanvasProjectPptCompilationSnapshot) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function samePageSpec(left: CanvasProjectPptPageSpec, right: CanvasProjectPptPageSpec) {
    return JSON.stringify(left) === JSON.stringify(right);
}
