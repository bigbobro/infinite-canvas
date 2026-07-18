import { saveAs } from "file-saver";

import { buildPptPageWorkspace } from "@/lib/ppt/page-workspace";
import { createZip } from "@/lib/zip";
import { getImageBlob, resolveImageUrl } from "@/services/image-storage";
import type { CanvasProject, CanvasProjectPptPage } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";

export type PptDeckInspectionPage = {
    page: CanvasProjectPptPage;
    node?: CanvasNodeData;
    previewUrl?: string;
    issues: string[];
};

export type PptDeckInspection = {
    pages: PptDeckInspectionPage[];
    ready: boolean;
};

type ResolvedInspectionPage = PptDeckInspectionPage & { blob?: Blob };

export function resolvePageImageNode(project: CanvasProject, page: CanvasProjectPptPage): CanvasNodeData | null {
    const workspace = buildPptPageWorkspace(project, page);
    if (workspace.confirmedNode) return workspace.confirmedNode;
    const candidates = workspace.takes.flatMap((take) => take.candidates);
    return candidates.length ? candidates[candidates.length - 1] : null;
}

/**
 * 按线路（take）分组收集某页全部候选图片节点：每个 take 一组，组内保持 `project.nodes` 数组序
 * （design §6：按 take 分组 + 组内数组序，不引入 metadata.seq）。跨组去重——一张图若在多个 take
 * 的下游都可达，只算进先出现（takes 数组序更靠前）的那一组。
 */
export function collectPageCandidateGroups(project: CanvasProject, page: CanvasProjectPptPage): CanvasNodeData[][] {
    return buildPptPageWorkspace(project, page)
        .takes.map((take) => take.candidates)
        .filter((candidates) => candidates.length);
}

/** 收集某页全部线路（take）的候选图片节点，取并集去重、摊平为单个数组（保持既有调用方兼容）。 */
export function collectPageCandidates(project: CanvasProject, page: CanvasProjectPptPage): CanvasNodeData[] {
    return collectPageCandidateGroups(project, page).flat();
}

export async function inspectPptDeckExport(project: CanvasProject): Promise<PptDeckInspection> {
    const pages = await resolveInspectionPages(project);
    return {
        pages: pages.map(({ page, node, previewUrl, issues }) => ({ page, node, previewUrl, issues })),
        ready: pages.length > 0 && pages.every((page) => !page.issues.length),
    };
}

export async function exportPptDeckImages(project: CanvasProject) {
    const pages = await resolveInspectionPages(project);
    if (!pages.length) throw new Error("当前工程没有可导出的 PPT 页面");
    const invalidPages = pages.filter((page) => page.issues.length);
    if (invalidPages.length) {
        throw new Error(`PPT 无法导出：${invalidPages.map(({ page, issues }) => `第${page.index}页：${issues.join("、")}`).join("；")}`);
    }

    const files = pages.map(({ page, blob }) => ({
        name: `${String(page.index).padStart(2, "0")}_${safeFileName(page.title)}.${fileExtension(blob!.type)}`,
        data: blob!,
    }));
    const zip = await createZip(files);
    saveAs(zip, `${safeFileName(project.title || "PPT")}.zip`);
}

async function resolveInspectionPages(project: CanvasProject): Promise<ResolvedInspectionPage[]> {
    const pages = [...(project.ppt?.pages || [])].sort((a, b) => a.index - b.index);
    return Promise.all(
        pages.map(async (page) => {
            const workspace = buildPptPageWorkspace(project, page);
            const node = workspace.confirmedNode;
            const issues = [...workspace.confirmationIssues];

            const storageKey = node?.metadata?.storageKey;
            if (!storageKey || issues.length) return { page, node, issues };
            try {
                const blob = await getImageBlob(storageKey);
                if (!(blob instanceof Blob)) return { page, node, issues: ["已确认的图片本地文件不存在"] };
                const previewUrl = await resolveImageUrl(storageKey);
                return { page, node, previewUrl, issues, blob };
            } catch {
                return { page, node, issues: ["已确认的图片本地文件读取失败"] };
            }
        }),
    );
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
