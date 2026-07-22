import { validatePptPageSourceRefs } from "@/lib/ppt/content-plan";
import { hashPptContentSource, hashPptSourceText } from "@/lib/ppt/source-lineage";
import type { CanvasProjectPpt } from "@/stores/canvas/use-canvas-store";

export type PptPageDescriptor =
    | { status: "ok"; compilePolicy: "structured" | "verbatim"; pageId: string; index: number; title: string; keyMessage: string }
    | { status: "invalid"; pageId: string; index?: number; title: "内容规格待修复"; keyMessage: ""; reason: string };

export function selectPptPageDescriptor(ppt: CanvasProjectPpt | undefined, pageId: string): PptPageDescriptor {
    const pages = Array.isArray(ppt?.pages) ? ppt.pages : [];
    const ledger = pages.find((page) => page?.pageId === pageId);
    const invalid = (reason: string): PptPageDescriptor => ({ status: "invalid", pageId, ...(Number.isInteger(ledger?.index) ? { index: ledger!.index } : {}), title: "内容规格待修复", keyMessage: "", reason });
    if (!ppt) return invalid("缺少 PPT 工程数据");
    if (!ledger) return invalid("页面账本缺少对应页");
    if (
        pages.some(
            (page) =>
                !page?.pageId ||
                !Number.isInteger(page.index) ||
                page.index < 1 ||
                !Array.isArray(page.takes) ||
                page.takes.some(
                    (take) =>
                        !take ||
                        typeof take !== "object" ||
                        typeof take.takeId !== "string" ||
                        !take.takeId.trim() ||
                        typeof take.anchorNodeId !== "string" ||
                        !take.anchorNodeId.trim() ||
                        typeof take.configNodeId !== "string" ||
                        !take.configNodeId.trim(),
                ),
        )
    )
        return invalid("页面账本损坏");
    if (new Set(pages.map((page) => page.pageId)).size !== pages.length) return invalid("页面账本存在重复身份");
    if (
        pages
            .map((page) => page.index)
            .sort((left, right) => left - right)
            .some((index, offset) => index !== offset + 1)
    )
        return invalid("页面账本页序不连续");
    if (ppt.compilePolicy !== "structured" && ppt.compilePolicy !== "verbatim") return invalid("缺少编译策略");
    const specs = ppt.compilePolicy === "structured" ? ppt.pageSpecs : ppt.verbatimSpecs;
    if (!Array.isArray(specs) || specs.length !== pages.length) return invalid("页面账本与内容规格数量不一致");
    const specIds = specs.map((spec) => spec?.pageId);
    if (specIds.some((id) => !id) || new Set(specIds).size !== specIds.length || pages.some((page) => !specIds.includes(page.pageId))) return invalid("页面账本与内容规格身份漂移");
    if (ppt.compilePolicy === "verbatim") {
        const spec = ppt.verbatimSpecs.find((item) => item.pageId === pageId);
        if (typeof spec?.title !== "string" || !spec.title.trim() || typeof spec.exactText !== "string" || !spec.exactText) return invalid("逐字内容规格损坏");
        if (spec.origin?.kind === "source_slice") {
            if (typeof ppt.sourceMaterial !== "string" || spec.origin.sourceHash !== hashPptSourceText(ppt.sourceMaterial)) return invalid("逐字内容的原文版本已变化");
            const lines = ppt.sourceMaterial.split("\n");
            const validRange = Number.isInteger(spec.origin.startLine) && Number.isInteger(spec.origin.endLine) && spec.origin.startLine >= 1 && spec.origin.endLine >= spec.origin.startLine && spec.origin.endLine <= lines.length;
            if (
                !validRange ||
                lines
                    .slice(spec.origin.startLine - 1, spec.origin.endLine)
                    .join("\n")
                    .trim() !== spec.exactText
            )
                return invalid("逐字内容的原文切片已失效");
        } else if (spec.origin?.kind !== "user_edited") {
            return invalid("逐字内容缺少有效来源");
        }
        return { status: "ok", compilePolicy: "verbatim", pageId, index: ledger.index, title: spec.title.trim(), keyMessage: "" };
    }
    if (typeof ppt.deckBrief?.sourceHash !== "string" || ppt.deckBrief.sourceHash !== hashPptContentSource(ppt.sourceMaterial, ppt.requirements)) return invalid("整套内容定位的原始材料版本已变化");
    const spec = ppt.pageSpecs.find((item) => item.pageId === pageId);
    if (!spec) return invalid("缺少 PageSpec");
    if (!Array.isArray(spec.contentBlocks) || spec.contentBlocks.some((block) => !block || typeof block !== "object")) return invalid("页面内容块结构损坏");
    if (!Array.isArray(spec.sourceRefs)) return invalid("页面来源结构损坏");
    const titleBlocks = spec.contentBlocks.filter((block) => block.kind === "title");
    const claimBlocks = spec.contentBlocks.filter((block) => block.kind === "primary_claim");
    if (titleBlocks.length !== 1 || claimBlocks.length !== 1 || typeof titleBlocks[0].text !== "string" || typeof claimBlocks[0].text !== "string" || !titleBlocks[0].text.trim() || !claimBlocks[0].text.trim()) {
        return invalid("标题或核心信息规格损坏");
    }
    if (validatePptPageSourceRefs(spec, { sourceMaterial: ppt.sourceMaterial, requirements: ppt.requirements }).length) return invalid("页面来源已与当前原始材料或补充要求脱节");
    return { status: "ok", compilePolicy: "structured", pageId, index: ledger.index, title: titleBlocks[0].text.trim(), keyMessage: claimBlocks[0].text.trim() };
}
