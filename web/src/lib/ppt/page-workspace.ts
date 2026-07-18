import { buildNodeGenerationInputs, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { PPT_PAGE_PROMPT } from "@/lib/ppt/deck-builder";
import { pageTakes, type CanvasProject, type CanvasProjectPptPage } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

/** 其余生成输入项：与 buildNodeGenerationInputs 同源，附带 pptRole 用于「风格基调」等展示标签（#16 所见即所生成）。 */
export type PptPageUpstreamInput = NodeGenerationInput & { pptRole?: CanvasNodeMetadata["pptRole"] };

export type PptPageWorkspaceTake = {
    key: string;
    index: number;
    anchorNode?: CanvasNodeData;
    configNode?: CanvasNodeData;
    prompt: string;
    canEditPrompt: boolean;
    candidates: CanvasNodeData[];
    generating: boolean;
    issues: string[];
    /** 版式指令：配置节点自身 metadata.prompt（不含上游拼接内容），供折叠展示。 */
    layoutPrompt: string;
    /** 组装提示词内容（非空时生成以此为准，见 canvas-guidelines「Config 节点的 prompt 回写」）。 */
    composerContent?: string;
    /** 除锚点提示词外，实际会被拼进生成 prompt 的其余上游输入（同源 buildNodeGenerationInputs，禁止另写遍历）。 */
    upstreamInputs: PptPageUpstreamInput[];
};

export type PptPageWorkspace = {
    page: CanvasProjectPptPage;
    takes: PptPageWorkspaceTake[];
    confirmedNode?: CanvasNodeData;
    confirmationIssues: string[];
};

export function buildPptPageWorkspace(project: CanvasProject, page: CanvasProjectPptPage): PptPageWorkspace {
    const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
    const downstreamById = new Map<string, string[]>();
    project.connections.forEach((connection) => {
        const downstream = downstreamById.get(connection.fromNodeId);
        if (downstream) downstream.push(connection.toNodeId);
        else downstreamById.set(connection.fromNodeId, [connection.toNodeId]);
    });

    const seenCandidates = new Set<string>();
    const takes = pageTakes(page).map<PptPageWorkspaceTake>((take, takeIndex) => {
        const anchorNode = nodeById.get(take.anchorNodeId);
        const configNode = nodeById.get(take.configNodeId);
        const reachableIds = collectReachableIds(take.configNodeId, page.index, nodeById, downstreamById);
        const candidates = project.nodes.filter((node) => reachableIds.has(node.id) && node.type === CanvasNodeType.Image && node.metadata?.status === "success" && !node.metadata?.batchRootId && !seenCandidates.has(node.id));
        candidates.forEach((node) => seenCandidates.add(node.id));
        const generating = configNode?.metadata?.status === "loading" || project.nodes.some((node) => reachableIds.has(node.id) && node.metadata?.status === "loading");
        const prompt = anchorNode?.type === CanvasNodeType.Text && typeof anchorNode.metadata?.content === "string" ? anchorNode.metadata.content : "";
        const composerContent = configNode?.metadata?.composerContent?.trim() ? configNode.metadata.composerContent : undefined;
        const upstreamInputs: PptPageUpstreamInput[] = configNode
            ? buildNodeGenerationInputs(configNode.id, project.nodes, project.connections)
                  .filter((input) => input.nodeId !== take.anchorNodeId)
                  .map((input) => ({ ...input, pptRole: nodeById.get(input.nodeId)?.metadata?.pptRole }))
            : [];

        // #7：技术分支归并为面向用户的两类，不出现「节点」字样，同一问题不重复表述。
        const issues: string[] = [];
        if (!anchorNode || anchorNode.type !== CanvasNodeType.Text) issues.push("方案分支提示词丢失或异常，请重新创建分支");
        if (!configNode || configNode.type !== CanvasNodeType.Config) issues.push("方案分支配置丢失或异常，请重新创建分支");
        if (configNode?.metadata?.status === "error") {
            const errorDetails = configNode.metadata.errorDetails || "方案分支生成失败";
            issues.push(candidates.length ? `最近一次生成失败：${errorDetails}` : errorDetails);
        }

        return {
            key: take.configNodeId,
            index: takeIndex,
            anchorNode,
            configNode,
            prompt,
            canEditPrompt: Boolean(anchorNode?.type === CanvasNodeType.Text && candidates.length === 0 && !generating),
            candidates,
            generating,
            issues,
            // 排版要求读专用字段:metadata.prompt 每轮生成会被拼装全文回写(污染),不可作展示/编辑来源。
            // 旧工程无此字段时回退到与生成路径一致的默认(outline=常量,extract=空)。
            layoutPrompt: (configNode?.metadata?.pptLayoutPrompt ?? "").trim() || (project.ppt?.mode === "extract" ? "" : PPT_PAGE_PROMPT),
            composerContent,
            upstreamInputs,
        };
    });

    const confirmedNode = page.confirmedNodeId ? nodeById.get(page.confirmedNodeId) : undefined;
    const candidateIds = new Set(takes.flatMap((take) => take.candidates.map((node) => node.id)));
    // #7：确认状态只归并为两类用户语言问题，避免「节点不存在/类型异常/不属于本页」等技术分支重复表述。
    const confirmationIssues: string[] = [];
    if (!page.confirmedNodeId) confirmationIssues.push("尚未确认最终版本");
    else if (!confirmedNode || confirmedNode.type !== CanvasNodeType.Image || confirmedNode.metadata?.status !== "success" || !confirmedNode.metadata?.storageKey || !candidateIds.has(confirmedNode.id)) {
        confirmationIssues.push("已确认的版本已失效，请重新确认");
    }

    return { page, takes, confirmedNode, confirmationIssues };
}

function collectReachableIds(pageConfigNodeId: string, pageIndex: number, nodeById: Map<string, CanvasNodeData>, downstreamById: Map<string, string[]>) {
    const reachableIds = new Set<string>();
    const queue = [pageConfigNodeId];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        for (const targetId of downstreamById.get(queue[cursor]) || []) {
            if (reachableIds.has(targetId)) continue;
            const target = nodeById.get(targetId);
            if (target?.metadata?.pptPageIndex != null && target.metadata.pptPageIndex !== pageIndex) continue;
            reachableIds.add(targetId);
            queue.push(targetId);
        }
    }
    return reachableIds;
}
