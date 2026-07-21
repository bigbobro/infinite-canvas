import saveAs from "file-saver";

import { createImagePptxBlob, findMixedImagePptxPages, readImagePptxDimensions } from "@/lib/ppt/image-pptx-export";
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
    pptxIssues: string[];
    width?: number;
    height?: number;
};

export type PptDeckInspection = {
    pages: PptDeckInspectionPage[];
    ready: boolean;
    pptxReady: boolean;
};

export type PptDeckExportProgress = {
    current: number;
    total: number;
    message: string;
};

type ResolvedInspectionPage = PptDeckInspectionPage & { blob?: Blob };
type ExportOptions = { onProgress?: (progress: PptDeckExportProgress) => void };
export type PptDeckExportDependencies = {
    getImageBlob: typeof getImageBlob;
    resolveImageUrl: typeof resolveImageUrl;
    readImageDimensions: typeof readImagePptxDimensions;
};

const DEFAULT_EXPORT_DEPENDENCIES: PptDeckExportDependencies = { getImageBlob, resolveImageUrl, readImageDimensions: readImagePptxDimensions };

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

export async function inspectPptDeckExport(project: CanvasProject, dependencies = DEFAULT_EXPORT_DEPENDENCIES): Promise<PptDeckInspection> {
    const pages = await resolveInspectionPages(project, { inspectPptx: true }, dependencies);
    const ready = pages.length > 0 && pages.every((page) => !page.issues.length);
    return {
        pages: pages.map(({ page, node, previewUrl, issues, pptxIssues, width, height }) => ({ page, node, previewUrl, issues, pptxIssues, width, height })),
        ready,
        pptxReady: ready && pages.every((page) => !page.pptxIssues.length),
    };
}

export async function exportPptDeckImages(project: CanvasProject, options: ExportOptions = {}) {
    const pages = await resolveInspectionPages(project, { onProgress: options.onProgress });
    assertExportReady(pages, false);

    const files = pages.map(({ page, blob }) => ({
        name: `${String(page.index).padStart(2, "0")}_${safeFileName(page.title, `第${page.index}页`)}.${fileExtension(blob!.type)}`,
        data: blob!,
    }));
    options.onProgress?.({ current: pages.length, total: pages.length, message: "正在打包页面图片…" });
    const zip = await createZip(files);
    saveAs(zip, `${safeFileName(project.title || "PPT")}.zip`);
}

export async function exportPptDeckPptx(project: CanvasProject, options: ExportOptions = {}) {
    const pages = await resolveInspectionPages(project, { inspectPptx: true, onProgress: options.onProgress });
    assertExportReady(pages, true);
    const blob = await createImagePptxBlob(
        pages.map(({ page, blob: image, width, height }) => ({ pageNumber: page.index, blob: image!, width: width!, height: height! })),
        {
            onProgress: ({ completed, total }) => options.onProgress?.({ current: completed, total, message: `正在生成 PPT ${completed}/${total}` }),
        },
    );
    options.onProgress?.({ current: pages.length, total: pages.length, message: "正在写入 PPT 文件…" });
    saveAs(blob, `${safeFileName(project.title || "PPT")}.pptx`);
}

async function resolveInspectionPages(project: CanvasProject, { inspectPptx = false, onProgress }: ExportOptions & { inspectPptx?: boolean } = {}, dependencies = DEFAULT_EXPORT_DEPENDENCIES): Promise<ResolvedInspectionPage[]> {
    const pages = [...(project.ppt?.pages || [])].sort((a, b) => a.index - b.index);
    const resolved = pages.map<ResolvedInspectionPage>((page) => {
        const workspace = buildPptPageWorkspace(project, page);
        return { page, node: workspace.confirmedNode, issues: [...workspace.confirmationIssues], pptxIssues: [] };
    });

    // 先完成全 deck 的确认/血缘预检；任一已确认页损坏时，不先读其他页 Blob 造成部分导出副作用。
    if (resolved.some((item) => item.page.confirmedNodeId && item.issues.length)) {
        resolved.forEach((_, index) => onProgress?.({ current: index + 1, total: pages.length, message: `正在检查页面 ${index + 1}/${pages.length}` }));
        return resolved;
    }

    for (let index = 0; index < pages.length; index += 1) {
        const result = resolved[index];
        const { page, node, issues } = result;
        const storageKey = node?.metadata?.storageKey;

        if (storageKey && !issues.length) {
            try {
                const blob = await dependencies.getImageBlob(storageKey);
                if (!(blob instanceof Blob)) result.issues.push("已确认的图片本地文件不存在");
                else {
                    await blob.slice(0, 1).arrayBuffer();
                    result.blob = blob;
                    result.previewUrl = await dependencies.resolveImageUrl(storageKey);
                    if (inspectPptx) {
                        try {
                            const size = await dependencies.readImageDimensions(page.index, blob);
                            result.width = size.width;
                            result.height = size.height;
                        } catch (error) {
                            result.pptxIssues.push(error instanceof Error ? error.message : "图片无法解码");
                        }
                    }
                }
            } catch {
                result.issues.push("已确认的图片本地文件读取失败");
            }
        }
        onProgress?.({ current: index + 1, total: pages.length, message: `正在读取页面 ${index + 1}/${pages.length}` });
    }

    if (inspectPptx && resolved.length && resolved.every((item) => !item.issues.length && item.width && item.height)) {
        const mixedPageNumbers = findMixedImagePptxPages(resolved.map(({ page, blob, width, height }) => ({ pageNumber: page.index, blob: blob!, width: width!, height: height! })));
        for (const item of resolved) {
            if (mixedPageNumbers.includes(item.page.index)) item.pptxIssues.push(`图片比例与第 ${resolved[0].page.index} 页不一致，无法无损铺满幻灯片`);
        }
    }

    return resolved;
}

function assertExportReady(pages: ResolvedInspectionPage[], includePptxIssues: boolean) {
    if (!pages.length) throw new Error("当前工程没有可导出的 PPT 页面");
    const invalidPages = pages.map((item) => ({ ...item, exportIssues: includePptxIssues ? [...item.issues, ...item.pptxIssues] : item.issues })).filter((item) => item.exportIssues.length);
    if (invalidPages.length) throw new Error(`PPT 无法导出：${invalidPages.map(({ page, exportIssues }) => `第${page.index}页：${exportIssues.join("、")}`).join("；")}`);
}

function safeFileName(value: string, fallback = "PPT") {
    const safe = value
        .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
        .trim()
        .replace(/[. ]+$/g, "")
        .slice(0, 120);
    return safe && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(safe) ? safe : fallback;
}

function fileExtension(mimeType: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    return "png";
}
