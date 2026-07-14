import { nanoid } from "nanoid";

import { getNodeSpec } from "@/constant/canvas";
import type { UploadedImage } from "@/services/image-storage";
import type { CanvasProject, CanvasProjectPptPage } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type PptDeckPageInput = {
    title: string;
    outline: string;
    visualHint: string;
};

export type BuildPptDeckParams = {
    title: string;
    sourceMaterial: string;
    requirements: string;
    style: { description: string };
    pages: PptDeckPageInput[];
    uploadedRefs: UploadedImage[];
};

const COLUMN_GAP = 96;
const ROW_GAP = 48;

export function buildPptDeckProject(params: BuildPptDeckParams): Partial<CanvasProject> {
    const { title, sourceMaterial, requirements, style, pages, uploadedRefs } = params;
    const styleDescription = style.description.trim();

    const styleSpec = getNodeSpec(CanvasNodeType.Text);
    const imageSpec = getNodeSpec(CanvasNodeType.Image);
    const outlineSpec = getNodeSpec(CanvasNodeType.Text);
    const configSpec = getNodeSpec(CanvasNodeType.Config);

    const nodes: CanvasNodeData[] = [];
    const connections: CanvasConnection[] = [];

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
        const index = pageIndex + 1;
        const rowY = pageIndex * rowHeight;
        const outlineId = nanoid();
        const configId = nanoid();

        const outlineContent = [`标题：${page.title}`, page.outline, page.visualHint ? `视觉建议：${page.visualHint}` : ""].filter(Boolean).join("\n\n");
        nodes.push({
            id: outlineId,
            type: CanvasNodeType.Text,
            title: `第${index}页大纲`,
            position: { x: outlineX, y: rowY },
            width: outlineSpec.width,
            height: outlineSpec.height,
            metadata: { ...outlineSpec.metadata, content: outlineContent, status: "success", pptPageIndex: index, pptRole: "outline" },
        });

        nodes.push({
            id: configId,
            type: CanvasNodeType.Config,
            title: `第${index}页生成配置`,
            position: { x: configX, y: rowY },
            width: configSpec.width,
            height: configSpec.height,
            metadata: { ...configSpec.metadata, prompt: PPT_PAGE_PROMPT, size: "16:9", count: 1, pptPageIndex: index, pptRole: "page" },
        });

        connections.push({ id: nanoid(), fromNodeId: outlineId, toNodeId: configId });
        styleNodeIds.forEach((styleNodeId) => connections.push({ id: nanoid(), fromNodeId: styleNodeId, toNodeId: configId }));

        return { index, title: page.title, outline: page.outline, visualHint: page.visualHint, anchorNodeId: outlineId, configNodeId: configId };
    });

    return {
        title,
        nodes,
        connections,
        ppt: {
            sourceMaterial,
            requirements,
            style: { description: styleDescription, references: uploadedRefs.map((ref) => ({ storageKey: ref.storageKey })) },
            pages: pptPages,
            anchorConfirmed: false,
        },
    };
}

// 页面标题/要点/视觉建议与风格说明由上游连线的文本节点在生成时自动拼入 prompt（buildNodeGenerationContext），
// config 节点的 prompt 只保留版式与生成指令，保证大纲/风格的单一来源（画布上改文本节点后重新生成即生效）。
export const PPT_PAGE_PROMPT = "生成一张 PPT 页面图片，画面比例 16:9，按下方页面大纲与风格说明设计完整的幻灯片版式，标题与要点文字准确、排版简洁。";
