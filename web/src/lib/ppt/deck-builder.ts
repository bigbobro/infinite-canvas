import { nanoid } from "nanoid";

import { getNodeSpec } from "@/constant/canvas";
import { buildPptCompilerModel } from "@/lib/ppt/prompt-compiler";
import type { UploadedImage } from "@/services/image-storage";
import type { CanvasProject, CanvasProjectPptPage } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type PptDeckPageInput = {
    title: string;
    outline: string;
    visualHint: string;
    sourceRange?: { startLine: number; endLine: number };
};

export type BuildPptDeckParams = {
    title: string;
    sourceMaterial: string;
    requirements: string;
    style: { description: string };
    pages: PptDeckPageInput[];
    uploadedRefs: UploadedImage[];
    mode?: "outline" | "extract";
};

const COLUMN_GAP = 96;
const ROW_GAP = 48;
// [二开] 顶栏高 64px，视口整体下移 96px 留出呼吸空间，避免首排节点顶边顶进标题栏（07-17-ppt-ux-fixes #5b）。
const INITIAL_VIEWPORT_Y = 96;

export function buildPptDeckProject(params: BuildPptDeckParams): Partial<CanvasProject> {
    const { title, sourceMaterial, requirements, style, pages, uploadedRefs, mode = "outline" } = params;
    const styleDescription = style.description.trim();

    const styleSpec = getNodeSpec(CanvasNodeType.Text);
    const imageSpec = getNodeSpec(CanvasNodeType.Image);
    const outlineSpec = getNodeSpec(CanvasNodeType.Text);
    const configSpec = getNodeSpec(CanvasNodeType.Config);
    const sourceSpec = getNodeSpec(CanvasNodeType.Text);

    const nodes: CanvasNodeData[] = [];
    const connections: CanvasConnection[] = [];

    if (mode === "extract") {
        nodes.push({
            id: nanoid(),
            type: CanvasNodeType.Text,
            title: "PPT 原始规格稿",
            position: { x: -(sourceSpec.width + COLUMN_GAP), y: 0 },
            width: sourceSpec.width,
            height: sourceSpec.height,
            metadata: { ...sourceSpec.metadata, content: sourceMaterial, status: "success", pptRole: "source" },
        });
    }

    const styleNodeIds: string[] = [];
    let styleY = 0;
    if (styleDescription) {
        const id = nanoid();
        nodes.push({
            id,
            type: CanvasNodeType.Text,
            title: "PPT 风格说明",
            position: { x: 0, y: styleY },
            width: styleSpec.width,
            height: styleSpec.height,
            metadata: { ...styleSpec.metadata, content: styleDescription, status: "success", pptRole: "style" },
        });
        styleNodeIds.push(id);
        styleY += styleSpec.height + ROW_GAP;
    }
    uploadedRefs.forEach((ref, index) => {
        const id = nanoid();
        nodes.push({
            id,
            type: CanvasNodeType.Image,
            title: `风格参考图${index + 1}`,
            position: { x: 0, y: styleY },
            width: imageSpec.width,
            height: imageSpec.height,
            metadata: { content: ref.url, storageKey: ref.storageKey, status: "success", naturalWidth: ref.width, naturalHeight: ref.height, bytes: ref.bytes, mimeType: ref.mimeType, pptRole: "style" },
        });
        styleNodeIds.push(id);
        styleY += imageSpec.height + ROW_GAP;
    });

    const outlineX = styleSpec.width + COLUMN_GAP;
    const configX = outlineX + outlineSpec.width + COLUMN_GAP;
    const rowHeight = Math.max(outlineSpec.height, configSpec.height) + ROW_GAP;

    const pptPages: CanvasProjectPptPage[] = pages.map((page, pageIndex) => {
        const pageId = nanoid();
        const takeId = nanoid();
        const index = pageIndex + 1;
        const rowY = pageIndex * rowHeight;
        const outlineId = nanoid();
        const configId = nanoid();

        const outlineContent = mode === "extract" ? page.outline : [`标题：${page.title}`, page.outline, page.visualHint ? `视觉建议：${page.visualHint}` : ""].filter(Boolean).join("\n\n");
        nodes.push({
            id: outlineId,
            type: CanvasNodeType.Text,
            title: `第${index}页大纲`,
            position: { x: outlineX, y: rowY },
            width: outlineSpec.width,
            height: outlineSpec.height,
            metadata: { ...outlineSpec.metadata, content: outlineContent, status: "success", pptPageId: pageId, pptTakeId: takeId, pptPageIndex: index, pptRole: "outline" },
        });

        const configMetadata: CanvasNodeData["metadata"] = {
            ...configSpec.metadata,
            prompt: "",
            pptLayoutPrompt: mode === "extract" ? "" : PPT_PAGE_PROMPT,
            size: "16:9",
            count: 1,
            pptPageId: pageId,
            pptTakeId: takeId,
            pptPageIndex: index,
            pptRole: "page",
        };
        if (mode === "extract") {
            configMetadata.composerContent = "";
        }
        nodes.push({
            id: configId,
            type: CanvasNodeType.Config,
            title: `第${index}页生成配置`,
            position: { x: configX, y: rowY },
            width: configSpec.width,
            height: configSpec.height,
            metadata: configMetadata,
        });

        connections.push({ id: nanoid(), fromNodeId: outlineId, toNodeId: configId });
        styleNodeIds.forEach((styleNodeId) => connections.push({ id: nanoid(), fromNodeId: styleNodeId, toNodeId: configId }));

        return { pageId, index, title: page.title, outline: page.outline, visualHint: page.visualHint, takes: [{ takeId, anchorNodeId: outlineId, configNodeId: configId }] };
    });
    const compilerModel = buildPptCompilerModel({
        mode,
        sourceMaterial,
        requirements,
        styleDescription,
        pages: pptPages.map((page, index) => ({ pageId: page.pageId, title: page.title, outline: pages[index].outline, visualHint: pages[index].visualHint, sourceRange: pages[index].sourceRange })),
    });

    return {
        title,
        nodes,
        connections,
        viewport: { x: 0, y: INITIAL_VIEWPORT_Y, k: 1 },
        ppt: {
            sourceMaterial,
            requirements,
            style: { description: styleDescription, references: uploadedRefs.map((ref) => ({ storageKey: ref.storageKey })) },
            pages: pptPages,
            deckBrief: compilerModel.deckBrief,
            pageSpecs: compilerModel.pageSpecs,
            compilationSnapshots: [],
            anchorConfirmed: false,
            mode,
        },
    };
}

// 页面标题/要点/视觉建议与风格说明由上游连线的文本节点交给 PPT Compiler 统一编译。
// config 节点只保留可见的版式指令，保证大纲/风格/版式各有单一来源。
export const PPT_PAGE_PROMPT = "生成一张 PPT 页面图片，画面比例 16:9，按下方页面大纲与风格说明设计完整的幻灯片版式，标题与要点文字准确、排版简洁。";
