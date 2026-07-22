import { PPT_PAGE_PROMPT } from "@/lib/ppt/deck-builder";
import { findPptDeckStyleOverrides, previewPptStyleClauseRepair, type PptStyleOverride } from "@/lib/ppt/style-contract";
import type { CanvasProjectPptStyleContract } from "@/stores/canvas/use-canvas-store";

const DENSITY_LABELS: Record<CanvasProjectPptStyleContract["modelStyle"]["density"], string> = {
    airy: "宽松",
    balanced: "均衡",
    dense: "紧凑",
};

const TITLE_REGION_LABELS: Record<CanvasProjectPptStyleContract["modelStyle"]["shell"]["titleRegion"], string> = {
    "top-left": "标题左上",
    "top-center": "标题顶部居中",
    center: "标题居中",
};

const HEADER_LABELS: Record<CanvasProjectPptStyleContract["modelStyle"]["shell"]["header"], string> = {
    none: "无页眉",
    "deck-title": "页眉显示整套标题",
    "section-label": "页眉显示章节",
};

const FOOTER_LABELS: Record<CanvasProjectPptStyleContract["modelStyle"]["shell"]["footer"], string> = {
    none: "无页脚",
    "page-number": "页脚显示页码",
    "deck-title-and-page-number": "页脚显示标题和页码",
};

export function getPptWorkspaceStyleSummary(contract: CanvasProjectPptStyleContract) {
    const { modelStyle } = contract;
    return {
        palette: [modelStyle.palette.background, modelStyle.palette.surface, modelStyle.palette.primary, modelStyle.palette.accent, modelStyle.palette.text],
        moodAndDensity: `${modelStyle.mood.join(" / ")} · ${DENSITY_LABELS[modelStyle.density]}`,
        shell: `${TITLE_REGION_LABELS[modelStyle.shell.titleRegion]} · ${HEADER_LABELS[modelStyle.shell.header]} · ${FOOTER_LABELS[modelStyle.shell.footer]}`,
    };
}

export function findPptWorkspaceLayoutStyleOverrides(value: string): PptStyleOverride[] {
    return findPptDeckStyleOverrides(withoutDefaultPrompt(value));
}

export function restorePptWorkspaceLayout(value: string) {
    const preview = previewPptWorkspaceLayoutRestore(value);
    return preview.safe ? preview.value : value.trim();
}

export function previewPptWorkspaceLayoutRestore(value: string): { safe: true; value: string } | { safe: false } {
    const preview = previewPptStyleClauseRepair(withoutDefaultPrompt(value));
    return preview.safe ? { safe: true, value: preview.remainder || PPT_PAGE_PROMPT } : { safe: false };
}

function withoutDefaultPrompt(value: string) {
    return value.split(PPT_PAGE_PROMPT).join("\n").trim();
}
