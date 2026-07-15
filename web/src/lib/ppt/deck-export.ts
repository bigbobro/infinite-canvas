import { saveAs } from "file-saver";

import { createZip } from "@/lib/zip";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasProject, CanvasProjectPptPage } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function resolvePageImageNode(project: CanvasProject, page: CanvasProjectPptPage): CanvasNodeData | null {
    const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
    if (page.confirmedNodeId) {
        const confirmed = nodeById.get(page.confirmedNodeId);
        if (confirmed) return confirmed;
    }
    const candidates = collectPageCandidates(project, page);
    return candidates.length ? candidates[candidates.length - 1] : null;
}

/**
 * 收集某页 config 节点下游全部成功生成的候选图片节点。
 *
 * 剪枝规则（design §3.2）：BFS 遍历时，若遇到带 `pptPageIndex` 且不等于当前页 index 的节点，
 * 立即停止（不收集、不入队）——用于斩断首页锚定连线（第 1 页图 → 第 2…N 页 config）导致的串页。
 * `pptPageIndex` 只打在 outline/config 节点上，生成的图节点没有该字段，因此不会被误剪。
 *
 * 收集条件：Image 节点 + status === "success" + 不带 batchRootId（排除 batch 子节点，只留根节点，
 * 根节点由 setBatchPrimary 持有当前挑中的那张）。
 */
export function collectPageCandidates(project: CanvasProject, page: CanvasProjectPptPage): CanvasNodeData[] {
    const downstreamIds = new Set<string>();
    const queue = [page.configNodeId];
    while (queue.length) {
        const currentId = queue.shift()!;
        for (const connection of project.connections) {
            if (connection.fromNodeId !== currentId || downstreamIds.has(connection.toNodeId)) continue;
            const target = project.nodes.find((node) => node.id === connection.toNodeId);
            if (target?.metadata?.pptPageIndex != null && target.metadata.pptPageIndex !== page.index) continue;
            downstreamIds.add(connection.toNodeId);
            queue.push(connection.toNodeId);
        }
    }

    return project.nodes.filter((node) => downstreamIds.has(node.id) && node.type === CanvasNodeType.Image && node.metadata?.status === "success" && !node.metadata?.batchRootId);
}

export async function exportPptDeckImages(project: CanvasProject) {
    const pages = [...(project.ppt?.pages || [])].sort((a, b) => a.index - b.index);
    if (!pages.length) throw new Error("当前工程没有可导出的 PPT 页面");

    const files: { name: string; data: BlobPart }[] = [];
    for (const page of pages) {
        const storageKey = resolvePageImageNode(project, page)?.metadata?.storageKey;
        if (!storageKey) continue;
        const blob = await getImageBlob(storageKey);
        if (!blob) continue;
        files.push({ name: `${String(page.index).padStart(2, "0")}_${safeFileName(page.title)}.${fileExtension(blob.type)}`, data: blob });
    }
    if (!files.length) throw new Error("没有已生成的页面图片可以导出");

    const zip = await createZip(files);
    saveAs(zip, `${safeFileName(project.title || "PPT")}.zip`);
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    return "png";
}
