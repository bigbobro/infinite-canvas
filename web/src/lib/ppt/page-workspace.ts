import { pageTakes, type CanvasProject, type CanvasProjectPptPage } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

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
        const candidates = project.nodes.filter(
            (node) =>
                reachableIds.has(node.id) &&
                node.type === CanvasNodeType.Image &&
                node.metadata?.status === "success" &&
                !node.metadata?.batchRootId &&
                !seenCandidates.has(node.id),
        );
        candidates.forEach((node) => seenCandidates.add(node.id));
        const generating = configNode?.metadata?.status === "loading" || project.nodes.some((node) => reachableIds.has(node.id) && node.metadata?.status === "loading");
        const prompt = anchorNode?.type === CanvasNodeType.Text && typeof anchorNode.metadata?.content === "string" ? anchorNode.metadata.content : "";

        const issues: string[] = [];
        if (!anchorNode) issues.push("方案分支提示词节点不存在");
        else if (anchorNode.type !== CanvasNodeType.Text) issues.push("方案分支提示词节点类型异常");
        if (!configNode) issues.push("方案分支配置节点不存在");
        else if (configNode.type !== CanvasNodeType.Config) issues.push("方案分支配置节点类型异常");
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
        };
    });

    const confirmedNode = page.confirmedNodeId ? nodeById.get(page.confirmedNodeId) : undefined;
    const candidateIds = new Set(takes.flatMap((take) => take.candidates.map((node) => node.id)));
    const confirmationIssues: string[] = [];
    if (!page.confirmedNodeId) confirmationIssues.push("尚未确认最终版本");
    else if (!confirmedNode) confirmationIssues.push("已确认的版本节点不存在");
    else {
        if (confirmedNode.type !== CanvasNodeType.Image) confirmationIssues.push("已确认的版本不是图片");
        if (confirmedNode.metadata?.status !== "success") confirmationIssues.push("已确认的图片未生成成功");
        if (!confirmedNode.metadata?.storageKey) confirmationIssues.push("已确认的图片缺少本地存储标识");
        if (!candidateIds.has(confirmedNode.id)) confirmationIssues.push("已确认的版本不属于当前页");
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
