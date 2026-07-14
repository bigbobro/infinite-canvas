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
    return findLatestSuccessImageNode(project, page.configNodeId);
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

function findLatestSuccessImageNode(project: CanvasProject, configNodeId: string): CanvasNodeData | null {
    const downstreamIds = new Set<string>();
    const queue = [configNodeId];
    while (queue.length) {
        const currentId = queue.shift()!;
        for (const connection of project.connections) {
            if (connection.fromNodeId !== currentId || downstreamIds.has(connection.toNodeId)) continue;
            downstreamIds.add(connection.toNodeId);
            queue.push(connection.toNodeId);
        }
    }

    const candidates = project.nodes.filter((node) => downstreamIds.has(node.id) && node.type === CanvasNodeType.Image && node.metadata?.status === "success");
    return candidates.length ? candidates[candidates.length - 1] : null;
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
