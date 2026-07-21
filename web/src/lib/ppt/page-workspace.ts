import { buildNodeGenerationInputs, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { PPT_PAGE_PROMPT } from "@/lib/ppt/deck-builder";
import { hasPptRepeatBillingRisk } from "@/lib/ppt/generation-ledger";
import { assertPptPageCandidateCanBeConfirmed } from "@/lib/ppt/page-confirmation";
import type { CanvasProject, CanvasProjectPptPage } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata, type PptGenerationRequestTrace, type PptGenerationRunSummary } from "@/types/canvas";

/** 其余生成输入项：与 buildNodeGenerationInputs 同源，附带 pptRole 用于非视觉方向的上游输入展示。 */
export type PptPageUpstreamInput = NodeGenerationInput & { pptRole?: CanvasNodeMetadata["pptRole"] };

export type PptPageWorkspaceTake = {
    takeId: string;
    index: number;
    anchorNode?: CanvasNodeData;
    configNode?: CanvasNodeData;
    prompt: string;
    canEditPrompt: boolean;
    candidates: CanvasNodeData[];
    /** 当前 take 首次认领的全部图片输出（含批量 root、成功、失败与 loading）。 */
    ownedOutputNodeIds: string[];
    /** 全部历史失败图片；纯分组 batch root 不计数。 */
    failedOutputNodeIds: string[];
    generationRuns: PptGenerationRunSummary[];
    generationRequests: PptGenerationRequestTrace[];
    /** 最近一次请求可能已计费但无法取回时，新付费动作仍需再次确认。 */
    requiresRepeatBillingConfirmation: boolean;
    unresolvedGeneration: boolean;
    /** 传给共享删除命令的完整集合：owned outputs + 本 take 的 anchor/config。 */
    deleteNodeIds: string[];
    generating: boolean;
    issues: string[];
    /** 排版要求：专用 metadata.pptLayoutPrompt；旧工程按 PPT 模式回退。 */
    layoutPrompt: string;
    /** 配置合成器开关与后备模板；PPT 显式传 layoutPrompt 时以显式值作为合成模板。 */
    composerContent?: string;
    /** 除锚点提示词外，实际会被拼进生成 prompt 的其余上游输入（同源 buildNodeGenerationInputs，禁止另写遍历）。 */
    upstreamInputs: PptPageUpstreamInput[];
};

export type PptPageWorkspace = {
    page: CanvasProjectPptPage;
    takes: PptPageWorkspaceTake[];
    confirmedNode?: CanvasNodeData;
    /** 通过 Compiler 快照血缘门禁的最终候选稿 ID。 */
    resolvedConfirmedNodeId?: string;
    confirmationIssues: string[];
};

export function buildPptPageWorkspace(project: CanvasProject, page: CanvasProjectPptPage): PptPageWorkspace {
    const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
    const downstreamById = new Map<string, string[]>();
    const addDownstream = (fromNodeId: string, toNodeId: string) => {
        const downstream = downstreamById.get(fromNodeId);
        if (downstream) {
            if (!downstream.includes(toNodeId)) downstream.push(toNodeId);
        } else downstreamById.set(fromNodeId, [toNodeId]);
    };
    project.connections.forEach((connection) => addDownstream(connection.fromNodeId, connection.toNodeId));
    project.nodes.forEach((node) => {
        node.metadata?.batchChildIds?.forEach((childId) => addDownstream(node.id, childId));
        if (node.metadata?.batchRootId) addDownstream(node.metadata.batchRootId, node.id);
    });

    const pageTakeList = page.takes;
    const takeBoundaryIds = new Set((project.ppt?.pages || [page]).flatMap((projectPage) => projectPage.takes.flatMap((take) => [take.anchorNodeId, take.configNodeId])));
    const seenOutputNodeIds = new Set<string>();
    const takes = pageTakeList.map<PptPageWorkspaceTake>((take, takeIndex) => {
        const anchorNode = nodeById.get(take.anchorNodeId);
        const configNode = nodeById.get(take.configNodeId);
        const blockedIds = new Set(takeBoundaryIds);
        blockedIds.delete(take.configNodeId);
        const reachableIds = collectReachableIds(take.configNodeId, page.pageId, take.takeId, nodeById, downstreamById, blockedIds);
        const ownedOutputs = project.nodes.filter((node) => (reachableIds.has(node.id) || belongsToTakeLedger(node, page.pageId, take.takeId)) && node.type === CanvasNodeType.Image && !seenOutputNodeIds.has(node.id));
        ownedOutputs.forEach((node) => seenOutputNodeIds.add(node.id));
        const candidates = ownedOutputs.filter((node) => node.metadata?.status === "success" && !isBatchGroup(node));
        const ownedOutputNodeIds = ownedOutputs.map((node) => node.id);
        const failedOutputNodeIds = ownedOutputs.filter((node) => node.metadata?.status === "error" && !isBatchGroup(node)).map((node) => node.id);
        const generationRequests = ownedOutputs.map((node) => node.metadata?.pptGenerationRequest).filter((trace): trace is PptGenerationRequestTrace => Boolean(trace));
        const generationRuns = ownedOutputs.map((node) => node.metadata?.pptGenerationRun).filter((run): run is PptGenerationRunSummary => Boolean(run));
        const latestRun = generationRuns.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
        const latestRequests = latestRun ? generationRequests.filter((request) => request.runId === latestRun.runId) : [];
        const requiresRepeatBillingConfirmation = hasPptRepeatBillingRisk(latestRequests);
        const unresolvedGeneration =
            generationRequests.some((request) => !["completed", "failed", "abandoned"].includes(request.status)) || generationRuns.some((run) => run.status === "preparing" || run.status === "running" || run.status === "needs_attention");
        const deleteNodeIds = [...new Set([...ownedOutputNodeIds, take.anchorNodeId, take.configNodeId])];
        const generating =
            latestRequests.some((request) => ["draft", "persisted", "submitting", "submitted", "running", "succeeded", "materializing"].includes(request.status)) ||
            (!latestRun && (configNode?.metadata?.status === "loading" || ownedOutputs.some((node) => node.metadata?.status === "loading")));
        const prompt = anchorNode?.type === CanvasNodeType.Text && typeof anchorNode.metadata?.content === "string" ? anchorNode.metadata.content : "";
        const composerContent = configNode?.metadata?.composerContent?.trim() ? configNode.metadata.composerContent : undefined;
        const upstreamInputs: PptPageUpstreamInput[] = configNode
            ? buildNodeGenerationInputs(configNode.id, project.nodes, project.connections)
                  .filter((input) => input.nodeId !== take.anchorNodeId)
                  .map((input) => ({ ...input, pptRole: nodeById.get(input.nodeId)?.metadata?.pptRole }))
            : [];

        // #7：技术分支归并为面向用户的两类，不出现「节点」字样，同一问题不重复表述。
        const issues: string[] = [];
        if (!anchorNode || anchorNode.type !== CanvasNodeType.Text) issues.push(`第 ${page.index} 页方案 ${takeIndex + 1} 的提示词丢失或异常，请重新创建方案`);
        if (!configNode || configNode.type !== CanvasNodeType.Config) issues.push(`第 ${page.index} 页方案 ${takeIndex + 1} 的生成配置丢失或异常，请重新创建方案`);
        if (anchorNode && configNode && !project.connections.some((connection) => connection.fromNodeId === anchorNode.id && connection.toNodeId === configNode.id)) issues.push(`第 ${page.index} 页方案 ${takeIndex + 1} 的提示词连接缺失，请重新创建方案`);
        const runLedgerIncomplete =
            latestRun &&
            (new Set(latestRun.requestIds).size !== latestRun.requestIds.length ||
                latestRequests.length !== latestRun.requestIds.length ||
                latestRun.requestIds.some((requestId) => latestRequests.filter((request) => request.requestId === requestId).length !== 1));
        if (runLedgerIncomplete) issues.push("最近一次生成台账不完整，请复制诊断后处理");
        const attentionRequests = generationRequests.filter((request) => request.status === "submission_unknown" || request.status === "recoverable_error");
        if (attentionRequests.some((request) => request.status === "submission_unknown" || !request.remoteTaskId)) issues.push("上一次请求的提交或保存结果未知，请先处理");
        else if (attentionRequests.length) issues.push(attentionRequests.at(-1)?.error || "上一次生成可重新获取");
        const latestFailedRequests = latestRequests.filter((request) => request.status === "failed");
        if (latestRun?.status === "partial") issues.push(`最近一次生成部分失败（${latestFailedRequests.length}/${latestRun.plannedCount}）`);
        else if (latestRun?.status === "failed") issues.push(latestFailedRequests.at(-1)?.error || "最近一次生成失败");
        else if (!latestRun && failedOutputNodeIds.length) issues.push(`存在失败产物（${failedOutputNodeIds.length}）`);
        if (!latestRun && configNode?.metadata?.status === "error") {
            const errorDetails = configNode.metadata.errorDetails || "方案生成失败";
            issues.push(candidates.length ? `最近一次生成失败：${errorDetails}` : errorDetails);
        }

        return {
            takeId: take.takeId,
            index: takeIndex,
            anchorNode,
            configNode,
            prompt,
            canEditPrompt: Boolean(anchorNode?.type === CanvasNodeType.Text && candidates.length === 0 && !generating && !unresolvedGeneration),
            candidates,
            ownedOutputNodeIds,
            failedOutputNodeIds,
            generationRuns,
            generationRequests,
            requiresRepeatBillingConfirmation,
            unresolvedGeneration,
            deleteNodeIds,
            generating,
            issues,
            // 排版要求只读专用字段；metadata.prompt 不是 PPT Compiler 的展示/编辑来源。
            layoutPrompt: (configNode?.metadata?.pptLayoutPrompt ?? "").trim() || (project.ppt?.mode === "extract" ? "" : PPT_PAGE_PROMPT),
            composerContent,
            upstreamInputs,
        };
    });

    const storedConfirmedNode = page.confirmedNodeId ? nodeById.get(page.confirmedNodeId) : undefined;
    const candidateIds = new Set(takes.flatMap((take) => take.candidates.map((node) => node.id)));
    // 把节点损坏和血缘损坏归并成稳定的用户语言，技术细节只在确认写入时报出。
    const confirmationIssues: string[] = [];
    if (!page.confirmedNodeId) confirmationIssues.push("尚未确认最终版");
    else if (!storedConfirmedNode || !candidateIds.has(storedConfirmedNode.id)) confirmationIssues.push("已确认的最终版已失效，请重新确认");
    else {
        try {
            assertPptPageCandidateCanBeConfirmed(project, page, storedConfirmedNode.id);
        } catch {
            confirmationIssues.push("已确认的最终版缺少可追溯的编译快照，请重新生成后确认");
        }
    }

    const confirmedNode = confirmationIssues.length ? undefined : storedConfirmedNode;
    const resolvedConfirmedNodeId = confirmedNode?.id;

    return { page, takes, confirmedNode, resolvedConfirmedNodeId, confirmationIssues };
}

function isBatchGroup(node: CanvasNodeData) {
    return Boolean(node.metadata?.batchChildIds?.length);
}

function belongsToTakeLedger(node: CanvasNodeData, pageId: string, takeId: string) {
    const request = node.metadata?.pptGenerationRequest;
    const run = node.metadata?.pptGenerationRun;
    return (request?.pageId === pageId && request.takeId === takeId) || (run?.pageId === pageId && run.takeId === takeId);
}

function collectReachableIds(pageConfigNodeId: string, pageId: string, takeId: string, nodeById: Map<string, CanvasNodeData>, downstreamById: Map<string, string[]>, blockedIds: Set<string>) {
    const reachableIds = new Set<string>();
    const queue = [pageConfigNodeId];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        for (const targetId of downstreamById.get(queue[cursor]) || []) {
            if (reachableIds.has(targetId) || blockedIds.has(targetId)) continue;
            const target = nodeById.get(targetId);
            if (target?.metadata?.pptPageId && target.metadata.pptPageId !== pageId) continue;
            if (target?.metadata?.pptTakeId && target.metadata.pptTakeId !== takeId) continue;
            reachableIds.add(targetId);
            queue.push(targetId);
        }
    }
    return reachableIds;
}
