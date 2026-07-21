import { nanoid } from "nanoid";

import { getNodeSpec } from "@/constant/canvas";
import { buildPptCompilerModel } from "@/lib/ppt/prompt-compiler";
import { assertPptStyleContract, normalizePptStyleContract } from "@/lib/ppt/style-contract";
import type { CanvasProject, CanvasProjectPptPage, CanvasProjectPptStyleContract } from "@/stores/canvas/use-canvas-store";
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
    styleContract: CanvasProjectPptStyleContract;
    pages: PptDeckPageInput[];
    mode?: "outline" | "extract";
};

const COLUMN_GAP = 96;
const ROW_GAP = 48;
// [二开] 顶栏高 64px，视口整体下移 96px 留出呼吸空间，避免首排节点顶边顶进标题栏（07-17-ppt-ux-fixes #5b）。
const INITIAL_VIEWPORT_Y = 96;

export function buildPptDeckProject(params: BuildPptDeckParams): Partial<CanvasProject> {
    const { title, sourceMaterial, requirements, pages, mode = "outline" } = params;
    assertPptStyleContract(params.styleContract);
    const styleContract = normalizePptStyleContract(params.styleContract);

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

    const outlineX = 0;
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
        return { pageId, index, title: page.title, outline: page.outline, visualHint: page.visualHint, takes: [{ takeId, anchorNodeId: outlineId, configNodeId: configId }] };
    });
    const compilerModel = buildPptCompilerModel({
        mode,
        sourceMaterial,
        requirements,
        styleContract,
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
            pages: pptPages,
            deckBrief: compilerModel.deckBrief,
            pageSpecs: compilerModel.pageSpecs,
            compilationSnapshots: [],
            anchorConfirmed: false,
            mode,
        },
    };
}

// 页面标题/要点交给 PPT Compiler 统一编译；视觉方向只来自 DeckBrief Contract。
// config 节点只保留可见的版式指令，保证内容、视觉方向和版式各有单一来源。
export const PPT_PAGE_PROMPT = "生成一张 PPT 页面图片，画面比例 16:9，按下方页面内容、页面职责、视觉方向与排版要求设计完整的幻灯片，文字准确、层级清晰。";
