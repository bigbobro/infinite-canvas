import { nanoid } from "nanoid";

import { getNodeSpec } from "@/constant/canvas";
import { renderPptPageSpecText, validatePptPageSpec } from "@/lib/ppt/content-plan";
import { hashPptContentSource, hashPptSourceText } from "@/lib/ppt/source-lineage";
import { assertPptStyleContract, reviewPptStyle } from "@/lib/ppt/style-contract";
import type { CanvasProject, CanvasProjectPpt, CanvasProjectPptDeckBrief, CanvasProjectPptPage, CanvasProjectPptPageSpec, CanvasProjectPptVerbatimSpec } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

type BuildPptDeckCommon = {
    title: string;
    sourceMaterial: string;
    requirements: string;
};

export type BuildPptDeckParams = BuildPptDeckCommon &
    ({ compilePolicy: "structured"; deckBrief: CanvasProjectPptDeckBrief; pageSpecs: CanvasProjectPptPageSpec[] } | { compilePolicy: "verbatim"; verbatimSpecs: CanvasProjectPptVerbatimSpec[]; confirmedGlobalSpec?: string });

export type PptVerbatimPageInput = {
    title: string;
    outline: string;
    sourceRange?: { startLine: number; endLine: number };
};

const COLUMN_GAP = 96;
const ROW_GAP = 48;
const INITIAL_VIEWPORT_Y = 96;

export function buildPptDeckProject(params: BuildPptDeckParams): Partial<CanvasProject> {
    const specs = params.compilePolicy === "structured" ? params.pageSpecs : params.verbatimSpecs;
    assertCanonicalSpecs(specs);
    if (params.compilePolicy === "structured") {
        assertPptStyleContract(params.deckBrief.styleContract);
        if (params.deckBrief.sourceHash !== hashPptContentSource(params.sourceMaterial, params.requirements)) throw new Error("整套内容定位已与当前原始材料或补充要求脱节");
        if (!params.deckBrief.contentRevision?.trim()) throw new Error("整套内容定位缺少已确认内容版本");
        const styleReview = reviewPptStyle({
            contract: params.deckBrief.styleContract,
            contentRevision: params.deckBrief.contentRevision,
            reviewedContentRevision: params.deckBrief.contentRevision,
            draftRevision: params.deckBrief.version,
            pageSpecs: params.pageSpecs,
            deckRules: params.deckBrief.globalRules,
        });
        const styleBlocker = styleReview.issues.find((issue) => issue.severity === "blocking");
        if (styleBlocker) throw new Error(`视觉系统尚未就绪，不能创建画布：${styleBlocker.location}，${styleBlocker.reason}`);
        const sourceContext = { sourceMaterial: params.sourceMaterial, requirements: params.requirements };
        const issues = params.pageSpecs.flatMap((pageSpec) => validatePptPageSpec(pageSpec, sourceContext));
        if (issues.length) throw new Error(`内容规格尚未就绪，不能创建画布：${issues[0].message}`);
    } else {
        for (const spec of params.verbatimSpecs) assertVerbatimSpec(spec, params.sourceMaterial);
    }

    const outlineSpec = getNodeSpec(CanvasNodeType.Text);
    const configSpec = getNodeSpec(CanvasNodeType.Config);
    const sourceSpec = getNodeSpec(CanvasNodeType.Text);
    const nodes: CanvasNodeData[] = [];
    const connections: CanvasConnection[] = [];
    if (params.compilePolicy === "verbatim") {
        nodes.push({
            id: nanoid(),
            type: CanvasNodeType.Text,
            title: "PPT 原始规格稿",
            position: { x: -(sourceSpec.width + COLUMN_GAP), y: 0 },
            width: sourceSpec.width,
            height: sourceSpec.height,
            metadata: { ...sourceSpec.metadata, content: params.sourceMaterial, status: "success", pptRole: "source" },
        });
    }

    const outlineX = 0;
    const configX = outlineX + outlineSpec.width + COLUMN_GAP;
    const rowHeight = Math.max(outlineSpec.height, configSpec.height) + ROW_GAP;
    const pages: CanvasProjectPptPage[] = specs.map((spec, pageIndex) => {
        const takeId = nanoid();
        const index = pageIndex + 1;
        const outlineId = nanoid();
        const configId = nanoid();
        const outlineContent = params.compilePolicy === "structured" ? renderPptPageSpecText(params.pageSpecs[pageIndex]) : params.verbatimSpecs[pageIndex].exactText;
        nodes.push({
            id: outlineId,
            type: CanvasNodeType.Text,
            title: `第${index}页内容规格`,
            position: { x: outlineX, y: pageIndex * rowHeight },
            width: outlineSpec.width,
            height: outlineSpec.height,
            metadata: { ...outlineSpec.metadata, content: outlineContent, status: "success", pptPageId: spec.pageId, pptTakeId: takeId, pptPageIndex: index, pptRole: "outline" },
        });
        const configMetadata: CanvasNodeData["metadata"] = {
            ...configSpec.metadata,
            prompt: "",
            pptLayoutPrompt: params.compilePolicy === "structured" ? PPT_PAGE_PROMPT : "",
            size: "16:9",
            count: 1,
            pptPageId: spec.pageId,
            pptTakeId: takeId,
            pptPageIndex: index,
            pptRole: "page",
        };
        if (params.compilePolicy === "verbatim") configMetadata.composerContent = "";
        nodes.push({
            id: configId,
            type: CanvasNodeType.Config,
            title: `第${index}页生成配置`,
            position: { x: configX, y: pageIndex * rowHeight },
            width: configSpec.width,
            height: configSpec.height,
            metadata: configMetadata,
        });
        connections.push({ id: nanoid(), fromNodeId: outlineId, toNodeId: configId });
        return { pageId: spec.pageId, index, takes: [{ takeId, anchorNodeId: outlineId, configNodeId: configId }] };
    });

    const base = {
        sourceMaterial: params.sourceMaterial,
        requirements: params.requirements,
        pages,
        compilationSnapshots: [],
        anchorConfirmed: false,
    };
    const ppt: CanvasProjectPpt =
        params.compilePolicy === "structured"
            ? { ...base, compilePolicy: "structured", deckBrief: structuredClone(params.deckBrief), pageSpecs: structuredClone(params.pageSpecs) }
            : {
                  ...base,
                  compilePolicy: "verbatim",
                  verbatimSpecs: structuredClone(params.verbatimSpecs),
                  ...(params.confirmedGlobalSpec === undefined ? {} : { confirmedGlobalSpec: params.confirmedGlobalSpec }),
              };
    return { title: params.title, nodes, connections, viewport: { x: 0, y: INITIAL_VIEWPORT_Y, k: 1 }, ppt };
}

export function createPptVerbatimSpecs(pages: PptVerbatimPageInput[], sourceMaterial: string): CanvasProjectPptVerbatimSpec[] {
    const sourceHash = hashPptSourceText(sourceMaterial);
    return pages.map((page) => ({
        pageId: nanoid(),
        version: 1,
        title: page.title.trim(),
        exactText: page.outline,
        origin: page.sourceRange ? { kind: "source_slice", sourceHash, startLine: page.sourceRange.startLine, endLine: page.sourceRange.endLine } : { kind: "user_edited" },
    }));
}

export { hashPptContentSource, hashPptSourceText } from "@/lib/ppt/source-lineage";

function assertCanonicalSpecs(specs: Array<{ pageId: string }>) {
    if (!specs.length) throw new Error("PPT 至少需要一页内容规格");
    const ids = specs.map((spec) => spec.pageId.trim());
    if (ids.some((id) => !id) || ids.length !== new Set(ids).size) throw new Error("PPT 页面身份缺失或重复");
}

function assertVerbatimSpec(spec: CanvasProjectPptVerbatimSpec, sourceMaterial: string) {
    if (!spec.title.trim() || !spec.exactText) throw new Error("VerbatimSpec 缺少标题或逐字正文");
    if (spec.origin.kind === "source_slice") {
        const lines = sourceMaterial.split("\n");
        const invalidRange = !Number.isInteger(spec.origin.startLine) || !Number.isInteger(spec.origin.endLine) || spec.origin.startLine < 1 || spec.origin.endLine < spec.origin.startLine || spec.origin.endLine > lines.length;
        const sourceSlice = invalidRange
            ? ""
            : lines
                  .slice(spec.origin.startLine - 1, spec.origin.endLine)
                  .join("\n")
                  .trim();
        if (spec.origin.sourceHash !== hashPptSourceText(sourceMaterial) || invalidRange || sourceSlice !== spec.exactText) throw new Error("VerbatimSpec 原文切片无效");
    }
}

export const PPT_PAGE_PROMPT = "生成一张 PPT 页面图片，画面比例 16:9，按下方已批准的页面内容、页面职责、信息表达、视觉方向与排版要求设计完整的幻灯片，文字准确、层级清晰。";
