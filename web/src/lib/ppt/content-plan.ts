import { nanoid } from "nanoid";

import { hashPptContentSource } from "@/lib/ppt/source-lineage";
import { findPptDeckStyleOverrides, previewPptStyleClauseRepair, validatePptPageVisualEncoding } from "@/lib/ppt/style-contract";
import type { CanvasProjectPptContentBlock, CanvasProjectPptLockedFact, CanvasProjectPptPageSpec, CanvasProjectPptSourceRef, CanvasProjectPptVisualEncoding, PptContentBrief, PptContentForm, PptLayoutRole } from "@/stores/canvas/use-canvas-store";

export type PptContentSourceInput = {
    title: string;
    sourceMaterial: string;
    requirements: string;
    previousPageSpecs?: CanvasProjectPptPageSpec[];
};

type RawSourceRange = { source?: unknown; startLine?: unknown; endLine?: unknown; relation?: unknown };
type RawBlock = { key?: unknown; kind?: unknown; text?: unknown; source?: RawSourceRange; gapKey?: unknown };
type RawVisualEncoding = {
    contentKeys?: unknown;
    intent?: unknown;
    channel?: unknown;
    lockedMapping?: unknown;
};
type RawGap = { key?: unknown; kind?: unknown; question?: unknown; reason?: unknown; blocking?: unknown; proposedAnswer?: unknown };
type RawPage = {
    title?: unknown;
    titleSource?: RawSourceRange;
    purpose?: unknown;
    primaryClaim?: unknown;
    primaryClaimSource?: RawSourceRange;
    contentForm?: unknown;
    contentFormNote?: unknown;
    blocks?: unknown;
    layoutIntent?: unknown;
    visualEncoding?: unknown;
    gaps?: unknown;
};
type RawDraft = { brief?: unknown; pages?: unknown };

export type PptInformationGapResolution =
    | { kind: "user_answer"; text: string; resolvedAt: string }
    | { kind: "confirmed_assumption"; text: string; resolvedAt: string }
    | { kind: "placeholder"; text: string; resolvedAt: string }
    | { kind: "omit"; resolvedAt: string };

export type PptInformationGap = {
    id: string;
    lineageKey: string;
    pageId?: string;
    kind: "missing_detail" | "missing_evidence" | "unsupported_claim" | "ambiguous_input";
    question: string;
    reason: string;
    blocking: boolean;
    proposedAnswer?: string;
    resolution?: PptInformationGapResolution;
    briefField?: "audience" | "goal" | "narrative";
};

export type PptContentAuditAction = { kind: "focus_gap"; gapId: string } | { kind: "preview_safe_patch"; issueId: string } | { kind: "regenerate_pages"; pageIds: string[] } | { kind: "merge_pages"; pageIds: string[] };

export type PptContentRepairOperation = { kind: "route_deck_style"; pageId: string; value: string; replacement: string } | { kind: "remove_layout_intent"; pageId: string; value: string; replacement: "" };

export type PptContentAuditIssue = {
    id: string;
    code:
        | "unresolved_gap"
        | "invalid_content_structure"
        | "invalid_content_provenance"
        | "invalid_visual_encoding"
        | "duplicate_page"
        | "noise_text"
        | "deck_style_signal"
        | "monolithic_content"
        | "excessive_copy"
        | "authoring_instruction_as_copy"
        | "invalid_cover"
        | "page_count_exceeded";
    severity: "blocking" | "warning";
    pageIds: string[];
    message: string;
    actions: PptContentAuditAction[];
    field?: string;
    value?: string;
    repair?: PptContentRepairOperation;
};

export type PptContentAudit = { issues: PptContentAuditIssue[]; gaps: PptInformationGap[] };

export type PptContentDraft = {
    revision: number;
    brief: PptContentBrief;
    pageSpecs: CanvasProjectPptPageSpec[];
    audit: PptContentAudit;
    constraints: { maxPages?: number };
};

export type PptContentValidationResult = { valid: boolean; issues: PptContentAuditIssue[] };

export type PptPageRewriteSpec = {
    canonicalText: string;
    title: string;
    primaryClaim: string;
    contentForm: PptContentForm;
    blocks: Array<{ key: string; kind: "supporting_claim" | "body" | "list" | "table" | "chart_data"; text: string }>;
    visualEncoding: Array<Pick<CanvasProjectPptVisualEncoding, "intent" | "channel"> & { contentKeys: string[] }>;
};

export type PptContentRepairPreview = {
    draftRevision: number;
    operations: PptContentRepairOperation[];
};

export type PptContentAction =
    | { kind: "edit_block"; pageId: string; blockId: string; text: string; editedAt: string }
    | { kind: "edit_purpose"; pageId: string; purpose: string }
    | { kind: "remove_page"; pageId: string }
    | { kind: "merge_pages"; pageIds: [string, string] }
    | { kind: "reorder_pages"; pageIds: string[] };

export type PptContentActionPreview = { draftRevision: number; action: PptContentAction };

const CONTENT_FORMS = new Set<PptContentForm>(["cover", "comparison", "architecture", "process", "timeline", "data", "narrative", "closing"]);
const BLOCK_KINDS = new Set<CanvasProjectPptContentBlock["kind"]>(["supporting_claim", "body", "list", "table", "chart_data", "placeholder"]);
const REWRITE_BLOCK_KINDS = new Set<PptPageRewriteSpec["blocks"][number]["kind"]>(["supporting_claim", "body", "list", "table", "chart_data"]);
const RELATIONAL_REWRITE_FORMS = new Set<PptContentForm>(["comparison", "architecture", "process", "timeline"]);
const GAP_KINDS = new Set<PptInformationGap["kind"]>(["missing_detail", "missing_evidence", "unsupported_claim", "ambiguous_input"]);
const ENCODING_INTENTS = new Set<CanvasProjectPptVisualEncoding["intent"]>(["differentiate", "emphasize", "sequence", "group", "show_relationship"]);
const ENCODING_CHANNELS = new Set<CanvasProjectPptVisualEncoding["channel"]>(["color", "shape", "position", "size", "line", "icon"]);
const SOURCE_KINDS = new Set<CanvasProjectPptSourceRef["source"]>(["material", "requirements", "user_answer", "confirmed_assumption"]);
const SOURCE_RELATIONS = new Set<CanvasProjectPptSourceRef["relation"]>(["verbatim", "derived"]);
const NUMBER_PATTERN = /(?:[$¥€£]\s*)?\d(?:[\d,]*\d)?(?:\.\d+)?\s*(?:亿元|万元|百分点|个月|小时|分钟|%|％|倍|万|亿|元|人|家|台|页|年|天|秒|个|项|条|点)?/g;
const ASCII_TERM_PATTERN = /\b[A-Z][A-Z0-9-]{1,}\b/g;
const LIST_ITEM_PATTERN = /^\s*(?:[-*•]\s+|\d+[.)、]\s*)/;
const LAYOUT_GEOMETRY_PATTERN =
    /(?:左图右文|左文右图|一图一结论|左侧|右侧|顶部|底部|上方|下方|中间|中央|居中|整页|本页|页面|左右|上下|横向|纵向|水平|垂直|左对齐|右对齐|对齐|布局|排版|构图|双栏|分栏|分区|主视觉|宫格|网格|矩阵|时间线|流程图|概念图|架构图|柱状图|折线图|饼图|图表|图片|图标|表格|表头|编号|列表|卡片|模块|区块|区域|分层|分类|大标题|标题|正文|结论|要点|指标|对比|行动建议|行动|路径|箭头|连线|留白|展示|呈现|说明|放置|排列|排布|固定为|突出|强调|对应|并列|分组|区分|表达|依次)/g;
const LAYOUT_GEOMETRY_COUNT_PATTERN = /(?:(?:[1-9]|1[0-2]|[一二两三四五六七八九十])(?:个)?(?:柱状图|折线图|饼图|概念图|图表|图片|列|行|栏|区|宫格))/g;
const LAYOUT_CONTENT_COUNT_PATTERN = /([0-9一二三四五六七八九十两]+)(?:个)?(?:指标|要点)|([0-9一二三四五六七八九十两]+)(?:条)?行动建议/g;
const AUTHORING_INSTRUCTION_PATTERN = /^(?:(?:我)?(?:希望|想让)(?:你|AI|模型)|(?:请|麻烦)(?:你|AI|模型)|帮我).{0,40}(?:建议|补充|完善|起草|生成|写|整理)/i;
const DECK_CREATION_INTENT_PATTERN = /^(?:我)?(?:想|希望|准备|需要|要)(?:能|可以|要)?(?:做|制作|生成|写|整理)[^。！？\n]{0,60}(?:PPT|演示|一份[^。！？\n]{0,40}材料|(?:介绍|汇报|路演|说明|宣讲|提案)材料)[^。！？\n]{0,80}$/i;
const DECK_SELF_REFERENCE_PATTERN =
    /^(?:(?:我做)?(?:这份|本份)(?:材料|PPT|演示)|(?:这个|本)\s*(?:PPT|演示))[^。！？\n]{0,100}(?:(?:不是[^。！？\n]{0,40}罗列)|(?:(?:需要|要|希望)[^。！？\n]{0,60}(?:让|讲清|说明|介绍|展示|回答|包含|覆盖|理解|传达))|(?:用于|目的是?|目的|受众|内容(?:包括|包含)|核心受众))/i;
const COVER_TARGET_QUESTION_PATTERN = /(?:为什么|好在哪里|解决(?:了)?什么(?:问题)?|为谁(?:去)?服务|面向谁|怎么(?:使用|做)|如何(?:使用|落地)|是什么)/g;
const PURE_PLACEHOLDER_TEXT_PATTERN = /^(?:待补充|请补充)[。.!！…]*$/;

export function normalizePptContentDraft(rawInput: unknown, sourceInput: PptContentSourceInput): PptContentDraft {
    const raw = asRecord(rawInput) as RawDraft;
    const rawBrief = asRecord(raw.brief);
    const rawPages = Array.isArray(raw.pages) ? (raw.pages as RawPage[]) : [];
    if (!rawPages.length) throw new Error("内容方案缺少页面数据");
    const gaps: PptInformationGap[] = [];
    const combinedSource = `${sourceInput.sourceMaterial}\n${sourceInput.requirements}`;
    const visualSignals = stringArray(rawBrief.visualSignals).filter((signal) => sourceSupportsText(combinedSource, signal));
    const brief: PptContentBrief = {
        version: 1,
        sourceHash: hashPptContentSource(sourceInput.sourceMaterial, sourceInput.requirements),
        title: text(rawBrief.title) || sourceInput.title.trim(),
        audience: text(rawBrief.audience),
        goal: text(rawBrief.goal),
        narrative: text(rawBrief.narrative),
        visualSignals: unique(visualSignals),
    };
    for (const field of ["audience", "goal", "narrative"] as const) {
        const value = brief[field];
        // Deck Brief 是作者侧整套归纳元数据：非空即可进入可审草稿，不因未逐字出现在材料中而阻断
        if (value) continue;
        gaps.push({
            id: `brief:gap:${field}`,
            lineageKey: `brief:${field}`,
            kind: "missing_detail",
            question: `请确认整套材料的${field === "audience" ? "受众" : field === "goal" ? "目标" : "叙事主线"}`,
            reason: "内容方案缺少整套定位",
            blocking: true,
            briefField: field,
        });
    }
    const pageSpecs = rawPages.map((rawPage, index) => normalizePage(rawPage, index, sourceInput, gaps));
    const maxPages = extractExplicitMaxPages(sourceInput.requirements);
    return rebuildDraft({ revision: 1, brief, pageSpecs, audit: { issues: [], gaps }, constraints: maxPages ? { maxPages } : {} });
}

export function validatePptContentDraft(draft: PptContentDraft): PptContentValidationResult {
    const issues = deriveAuditIssues(draft.brief, draft.pageSpecs, draft.audit.gaps, draft.constraints);
    return { valid: !issues.some((issue) => issue.severity === "blocking"), issues };
}

export function resolvePptInformationGap(draft: PptContentDraft, gapId: string, resolution: PptInformationGapResolution): PptContentDraft {
    const gap = draft.audit.gaps.find((item) => item.id === gapId);
    if (!gap) throw new Error("信息缺口不存在");
    if (gap.resolution) throw new Error("信息缺口已处理");
    assertResolution(resolution);
    const boundPage = gap.pageId ? draft.pageSpecs.find((item) => item.pageId === gap.pageId) : undefined;
    const bindsRequiredBlock = boundPage?.contentBlocks.some((block) => block.gapId === gapId && (block.kind === "title" || block.kind === "primary_claim"));
    if ((gap.briefField || bindsRequiredBlock) && (resolution.kind === "omit" || resolution.kind === "placeholder")) throw new Error("整套定位、页面标题和核心信息需要明确内容，不能省略或保留占位");
    const next = structuredClone(draft);
    const nextGap = next.audit.gaps.find((item) => item.id === gapId)!;
    nextGap.resolution = resolution;
    if (gap.briefField) {
        next.brief[gap.briefField] = resolution.kind === "omit" ? "" : resolution.text.trim();
        next.brief.version += 1;
    }
    if (gap.pageId) {
        const page = next.pageSpecs.find((item) => item.pageId === gap.pageId);
        if (!page) throw new Error("信息缺口所属页不存在");
        const boundBlocks = page.contentBlocks.filter((block) => block.gapId === gapId);
        const boundBlockIds = new Set(boundBlocks.map((block) => block.id));
        if (resolution.kind === "omit") {
            if (boundBlocks.some((block) => block.kind === "title" || block.kind === "primary_claim")) throw new Error("标题和核心信息不能省略");
            prunePptVisualEncoding(page, boundBlockIds, true);
            page.contentBlocks = page.contentBlocks.filter((block) => block.gapId !== gapId);
        } else if (resolution.kind === "placeholder") {
            prunePptVisualEncoding(page, boundBlockIds, true);
            if (boundBlocks.length) {
                for (const block of boundBlocks) {
                    block.kind = "placeholder";
                    block.text = resolution.text.trim();
                    block.sourceRefIds = [];
                }
            } else {
                page.contentBlocks.push({ id: `${gapId}:block:resolution`, kind: "placeholder", text: resolution.text.trim(), sourceRefIds: [], gapId });
            }
        } else {
            prunePptVisualEncoding(page, boundBlockIds, false);
            const sourceRef: CanvasProjectPptSourceRef = {
                id: `${gapId}:source:${resolution.kind}`,
                source: resolution.kind,
                relation: "verbatim",
                excerpt: resolution.text.trim(),
                gapId,
            };
            page.sourceRefs.push(sourceRef);
            for (const block of boundBlocks) {
                if (block.kind === "placeholder") block.kind = "body";
                block.text = resolution.text.trim();
                block.sourceRefIds = [sourceRef.id];
            }
            if (!boundBlocks.length) page.contentBlocks.push({ id: `${gapId}:block:resolution`, kind: "body", text: resolution.text.trim(), sourceRefIds: [sourceRef.id], gapId });
        }
        page.version += 1;
        pruneUnusedPptSourceRefs(page);
        page.lockedFacts = derivePptLockedFacts(page);
    }
    next.revision += 1;
    return rebuildDraft(next);
}

export function acceptPptPageSuggestions(draft: PptContentDraft, pageId: string, acceptedAt: string) {
    if (!draft.pageSpecs.some((page) => page.pageId === pageId)) throw new Error("建议所属页不存在");
    const suggestions = draft.audit.gaps.filter((gap) => gap.pageId === pageId && !gap.resolution && gap.proposedAnswer?.trim());
    if (!suggestions.length) throw new Error("本页暂无可采纳的 AI 建议");
    return suggestions.reduce(
        (current, gap) =>
            resolvePptInformationGap(current, gap.id, {
                kind: "confirmed_assumption",
                text: gap.proposedAnswer!,
                resolvedAt: acceptedAt,
            }),
        draft,
    );
}

export function createPptContentRepairPreview(draft: PptContentDraft, issueIds: string[]): PptContentRepairPreview {
    const selected = new Set(issueIds);
    return {
        draftRevision: draft.revision,
        operations: draft.audit.issues.flatMap((issue) => (selected.has(issue.id) && issue.repair ? [issue.repair] : [])),
    };
}

export function applyPptContentRepair(draft: PptContentDraft, repair: PptContentRepairPreview): PptContentDraft {
    if (repair.draftRevision !== draft.revision) throw new Error("内容草稿已变更，修复预览已过期");
    const next = structuredClone(draft);
    const touched = new Set<string>();
    for (const operation of repair.operations) {
        const page = next.pageSpecs.find((item) => item.pageId === operation.pageId);
        if (!page) throw new Error("修复目标页不存在");
        page.layoutIntent = page.layoutIntent.flatMap((value) => (value !== operation.value ? [value] : operation.replacement ? [operation.replacement] : []));
        touched.add(page.pageId);
    }
    for (const page of next.pageSpecs) if (touched.has(page.pageId)) page.version += 1;
    next.revision += 1;
    return rebuildDraft(next);
}

export function previewPptContentAction(draft: PptContentDraft, action: PptContentAction): PptContentActionPreview {
    assertPptContentAction(draft, action);
    return { draftRevision: draft.revision, action: structuredClone(action) };
}

export function applyPptContentAction(draft: PptContentDraft, preview: PptContentActionPreview): PptContentDraft {
    if (preview.draftRevision !== draft.revision) throw new Error("内容草稿已变更，操作预览已过期");
    assertPptContentAction(draft, preview.action);
    const next = structuredClone(draft);
    const action = preview.action;
    if (action.kind === "remove_page") {
        next.pageSpecs = next.pageSpecs.filter((page) => page.pageId !== action.pageId);
        next.audit.gaps = next.audit.gaps.filter((gap) => gap.pageId !== action.pageId);
    } else if (action.kind === "merge_pages") {
        const [targetPageId, sourcePageId] = action.pageIds;
        const target = next.pageSpecs.find((page) => page.pageId === targetPageId)!;
        const source = next.pageSpecs.find((page) => page.pageId === sourcePageId)!;
        const movedBlocks = source.contentBlocks.map((block) => (block.kind === "title" || block.kind === "primary_claim" ? { ...block, kind: "supporting_claim" as const } : block));
        target.purpose = unique([target.purpose, source.purpose]).join("；");
        target.sourceRefs = uniqueById([...target.sourceRefs, ...source.sourceRefs]);
        target.contentBlocks = [...target.contentBlocks, ...movedBlocks];
        target.layoutIntent = unique([...target.layoutIntent, ...source.layoutIntent]);
        target.visualEncoding = uniqueById([...target.visualEncoding, ...source.visualEncoding]);
        target.assetRefs = unique([...target.assetRefs, ...source.assetRefs]);
        target.version += 1;
        target.contentState = { status: "reviewable" };
        target.lockedFacts = derivePptLockedFacts(target);
        next.pageSpecs = next.pageSpecs.filter((page) => page.pageId !== sourcePageId);
        next.audit.gaps = next.audit.gaps.map((gap) => (gap.pageId === sourcePageId ? { ...gap, pageId: targetPageId } : gap));
    } else if (action.kind === "reorder_pages") {
        const byId = new Map(next.pageSpecs.map((page) => [page.pageId, page]));
        next.pageSpecs = action.pageIds.map((pageId) => byId.get(pageId)!);
    } else {
        const page = next.pageSpecs.find((item) => item.pageId === action.pageId)!;
        if (action.kind === "edit_purpose") {
            page.purpose = action.purpose.trim();
        } else {
            const block = page.contentBlocks.find((item) => item.id === action.blockId)!;
            const editedText = action.text.trim();
            const confirmedGapIds = unique(
                block.sourceRefIds.flatMap((sourceRefId) => {
                    const sourceRef = page.sourceRefs.find((item) => item.id === sourceRefId);
                    return isConfirmedSourceRef(sourceRef) && sourceRef.gapId && next.audit.gaps.some((gap) => gap.id === sourceRef.gapId) ? [sourceRef.gapId] : [];
                }),
            );
            const lineageGapId = block.gapId || (confirmedGapIds.length === 1 ? confirmedGapIds[0] : undefined);
            const sourceRef: CanvasProjectPptSourceRef = {
                id: `${page.pageId}:source:user-answer:${encodeURIComponent(block.id)}:${page.version + 1}`,
                source: "user_answer",
                relation: "verbatim",
                excerpt: editedText,
                ...(lineageGapId ? { gapId: lineageGapId } : {}),
            };
            page.sourceRefs.push(sourceRef);
            block.text = editedText;
            block.sourceRefIds = [sourceRef.id];
            if (lineageGapId) block.gapId = lineageGapId;
            prunePptVisualEncoding(page, new Set([block.id]), false);
            if (block.kind === "placeholder") block.kind = "body";
            if (lineageGapId) {
                const gap = next.audit.gaps.find((item) => item.id === lineageGapId);
                if (gap) gap.resolution = { kind: "user_answer", text: editedText, resolvedAt: action.editedAt };
            }
        }
        page.version += 1;
        page.contentState = { status: "reviewable" };
        pruneUnusedPptSourceRefs(page);
        page.lockedFacts = derivePptLockedFacts(page);
    }
    next.revision += 1;
    return rebuildDraft(next);
}

export function replacePptContentDraftPage(draft: PptContentDraft, expectedRevision: number, pageId: string, replacement: CanvasProjectPptPageSpec, replacementGaps: PptInformationGap[]): PptContentDraft {
    if (draft.revision !== expectedRevision) throw new Error("内容草稿已变更，单页生成结果已过期");
    if (replacement.pageId !== pageId) throw new Error("单页生成结果改变了页面身份");
    const current = draft.pageSpecs.find((page) => page.pageId === pageId);
    if (!current) throw new Error("单页生成目标不存在");
    assertRegeneratedPagePreservesConfirmedSources(current, replacement);
    const currentPageGaps = draft.audit.gaps.filter((gap) => gap.pageId === pageId);
    const reconciled = reconcileRegeneratedConfirmedGaps(current, currentPageGaps, replacement, replacementGaps);
    const resolvedLineage = currentPageGaps.filter((gap) => gap.resolution);
    const reopenedLineageKeys = new Set(reconciled.gaps.map((gap) => gap.lineageKey));
    if (resolvedLineage.some((gap) => reopenedLineageKeys.has(gap.lineageKey))) throw new Error("本页生成结果重新开启或改变了已确认信息缺口；原页已保留");
    const next = structuredClone(draft);
    next.pageSpecs = next.pageSpecs.map((page) => (page.pageId === pageId ? { ...structuredClone(reconciled.page), version: current.version + 1 } : page));
    next.audit.gaps = [...next.audit.gaps.filter((gap) => gap.pageId !== pageId), ...structuredClone(resolvedLineage), ...structuredClone(reconciled.gaps).map((gap) => ({ ...gap, pageId }))];
    next.revision += 1;
    return rebuildDraft(next);
}

export function assertPptPageAuditIssuesResolved(draft: PptContentDraft, pageId: string, requestedIssues: Array<Pick<PptContentAuditIssue, "code" | "field" | "message">>) {
    const pageIssues = draft.audit.issues.filter((issue) => issue.pageIds.includes(pageId) && issue.code !== "unresolved_gap");
    const remaining = pageIssues.filter((issue) => issue.severity === "blocking" || requestedIssues.some((requested) => requested.code === issue.code && (!requested.field || requested.field === issue.field)));
    if (remaining.length) throw new Error(`本页重新生成后问题仍未解决：${remaining.map((issue) => issue.message).join("；")}；原页已保留`);
}

/** Issue-triggered repair keeps the selected issue plus same-page blocking checks; general AI fill keeps all page issues. */
export function selectPptPageRepairAuditIssues(draft: PptContentDraft, pageId: string, targetIssueId?: string | null): Array<Pick<PptContentAuditIssue, "code" | "field" | "message" | "value">> {
    const pageIssues = draft.audit.issues.filter((issue) => issue.code !== "unresolved_gap" && issue.pageIds.includes(pageId));
    const selected = new Map<string, PptContentAuditIssue>();
    if (targetIssueId) {
        for (const issue of pageIssues) {
            if (issue.severity === "blocking" || issue.id === targetIssueId) selected.set(issue.id, issue);
        }
    } else {
        for (const issue of pageIssues) selected.set(issue.id, issue);
    }
    return [...selected.values()].map((issue) => ({
        code: issue.code,
        message: issue.message,
        ...(issue.field ? { field: issue.field } : {}),
        ...(issue.value ? { value: issue.value } : {}),
    }));
}

/** Dynamic repair CTA: excessive copy → 压缩, cover → 修复封面, else 修复本页. */
export function pptPageRepairActionLabel(issue?: Pick<PptContentAuditIssue, "code"> | null): string {
    if (issue?.code === "excessive_copy" || issue?.code === "monolithic_content") return "压缩本页";
    if (issue?.code === "invalid_cover") return "修复封面";
    return "修复本页";
}

export function finalizePptContentDraft(draft: PptContentDraft, approvedAt = new Date().toISOString()): { brief: PptContentBrief; pageSpecs: CanvasProjectPptPageSpec[]; contentRevision: string } {
    const validation = validatePptContentDraft(draft);
    if (!validation.valid)
        throw new Error(
            `内容方案尚未处理完成，不能确认：${validation.issues
                .filter((issue) => issue.severity === "blocking")
                .map((issue) => issue.message)
                .join("；")}`,
        );
    const brief = structuredClone(draft.brief);
    const pageSpecs = draft.pageSpecs.map((page) => {
        const next = structuredClone(page);
        next.layoutIntent = unique(
            next.layoutIntent.map((value) => {
                const preview = previewPptStyleClauseRepair(value);
                return preview.safe ? preview.remainder : value;
            }),
        );
        next.lockedFacts = derivePptLockedFacts(next);
        next.contentState = { status: "approved", approvedAt };
        return next;
    });
    return { brief, pageSpecs, contentRevision: `${brief.sourceHash}:r${draft.revision}` };
}

export function derivePptLockedFacts(pageSpec: Pick<CanvasProjectPptPageSpec, "pageId" | "contentBlocks">): CanvasProjectPptLockedFact[] {
    const content = pageSpec.contentBlocks
        .filter((block) => block.kind !== "placeholder" && block.sourceRefIds.length > 0)
        .map((block) => block.text)
        .join("\n");
    const candidates: Array<Omit<CanvasProjectPptLockedFact, "id">> = [];
    for (const line of meaningfulLines(content).map((value) => value.replace(LIST_ITEM_PATTERN, ""))) {
        for (const match of line.matchAll(NUMBER_PATTERN)) {
            const value = match[0].trim();
            if (value) candidates.push({ kind: "number", value, sourceExcerpt: line });
        }
        for (const match of line.matchAll(ASCII_TERM_PATTERN)) candidates.push({ kind: "term", value: match[0], sourceExcerpt: line });
        if (/(?:表格|表头|行列|矩阵|三列|两列|双列)/.test(line)) candidates.push({ kind: "table", value: line, sourceExcerpt: line });
    }
    const pointCount = readPointCount(content);
    if (pointCount !== undefined && pointCount > 1) candidates.push({ kind: "point_count", value: String(pointCount), sourceExcerpt: pointCountExcerpt(content) });
    const seen = new Set<string>();
    return candidates.flatMap((fact) => {
        const key = `${fact.kind}\u0000${normalize(fact.value)}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ ...fact, id: `${pageSpec.pageId}:fact:${fact.kind}:${seen.size}` }];
    });
}

export function validatePptPageSpec(pageSpec: CanvasProjectPptPageSpec, sourceContext?: Pick<PptContentSourceInput, "sourceMaterial" | "requirements">) {
    const issues: Array<{
        code: "content_spec_not_approved" | "unresolved_information_gap" | "invalid_content_provenance" | "invalid_content_structure" | "invalid_visual_encoding";
        message: string;
        field?: string;
        value?: string;
    }> = [];
    const titleBlocks = pageSpec.contentBlocks.filter((block) => block.kind === "title");
    const claimBlocks = pageSpec.contentBlocks.filter((block) => block.kind === "primary_claim");
    const blockIds = pageSpec.contentBlocks.map((block) => block.id);
    if (
        titleBlocks.length !== 1 ||
        claimBlocks.length !== 1 ||
        !titleBlocks[0]?.text.trim() ||
        !claimBlocks[0]?.text.trim() ||
        !pageSpec.purpose.trim() ||
        !CONTENT_FORMS.has(pageSpec.contentForm) ||
        pageSpec.contentBlocks.some((block) => block.kind !== "title" && block.kind !== "primary_claim" && !BLOCK_KINDS.has(block.kind)) ||
        blockIds.some((id) => !id.trim()) ||
        new Set(blockIds).size !== blockIds.length
    ) {
        issues.push({ code: "invalid_content_structure", message: "页面必须包含唯一标题、唯一核心信息、页面目的与有效内容结构" });
    }
    const isCover = pageSpec.contentForm === "cover";
    if (isCover && pageSpec.contentBlocks.some((block) => block.kind !== "title" && block.kind !== "primary_claim")) {
        issues.push({ code: "invalid_content_structure", message: "封面只保留标题和一句定位语，不承载正文或目标清单", field: "contentForm", value: pageSpec.contentForm });
    }
    const primaryClaim = claimBlocks[0]?.text.trim() || "";
    if (isCover && isPptCoverTargetChecklist(primaryClaim)) {
        issues.push({ code: "invalid_content_structure", message: "封面核心信息应是一句定位语，不能复述整套目标或问题清单", field: "primaryClaim", value: primaryClaim });
    }
    if (pageSpec.contentState.status !== "approved") issues.push({ code: "content_spec_not_approved", message: "页面内容规格尚未批准" });
    if (pageSpec.contentState.status === "blocked" && pageSpec.contentState.gapIds.length) issues.push({ code: "unresolved_information_gap", message: "页面仍有未解决的信息缺口" });
    const sourceById = new Map(pageSpec.sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]));
    const duplicateSources = pageSpec.sourceRefs.length !== sourceById.size;
    const invalidSource = pageSpec.sourceRefs.some(
        (sourceRef) =>
            !sourceRef.id.trim() ||
            !sourceRef.excerpt.trim() ||
            !SOURCE_KINDS.has(sourceRef.source) ||
            !SOURCE_RELATIONS.has(sourceRef.relation) ||
            ((sourceRef.source === "material" || sourceRef.source === "requirements") && (!Number.isInteger(sourceRef.startLine) || !Number.isInteger(sourceRef.endLine) || sourceRef.startLine! < 1 || sourceRef.endLine! < sourceRef.startLine!)),
    );
    const invalidBlockSource = pageSpec.contentBlocks.some((block) => {
        if (block.kind === "placeholder") return false;
        const refs = block.sourceRefIds.map((id) => sourceById.get(id)).filter((sourceRef): sourceRef is CanvasProjectPptSourceRef => Boolean(sourceRef));
        return !refs.length || refs.length !== block.sourceRefIds.length || !sourceRefsSupportBlockText(refs, block.text);
    });
    if (duplicateSources || invalidSource || invalidBlockSource) {
        issues.push({ code: "invalid_content_provenance", message: "页面内容存在缺失或无效的来源" });
    }
    if (sourceContext && validatePptPageSourceRefs(pageSpec, sourceContext).length) issues.push({ code: "invalid_content_provenance", message: "页面来源已与当前原始材料或补充要求脱节" });
    if (JSON.stringify(pageSpec.lockedFacts) !== JSON.stringify(derivePptLockedFacts(pageSpec))) issues.push({ code: "invalid_content_provenance", message: "页面锁定事实与内容块派生结果不一致" });
    for (const intent of pageSpec.layoutIntent) {
        if (isPptLayoutIntentSupported(pageSpec, intent)) continue;
        issues.push({ code: "invalid_content_structure", message: `无法识别排版要求「${intent}」；其中可能包含未批准的文案或事实`, field: "layoutIntent", value: intent });
    }
    for (const message of validatePptPageVisualEncoding(pageSpec)) issues.push({ code: "invalid_visual_encoding", message });
    return issues;
}

export function validatePptPageSourceRefs(pageSpec: CanvasProjectPptPageSpec, sourceContext: Pick<PptContentSourceInput, "sourceMaterial" | "requirements">) {
    if (!Array.isArray(pageSpec.sourceRefs)) return ["缺少来源列表"];
    return pageSpec.sourceRefs.flatMap((sourceRef) => {
        if (!sourceRef || typeof sourceRef !== "object" || typeof sourceRef.id !== "string") return ["来源结构损坏"];
        if (sourceRef.source !== "material" && sourceRef.source !== "requirements") return [];
        const sourceText = sourceRef.source === "material" ? sourceContext.sourceMaterial : sourceContext.requirements;
        const lines = sourceText.split("\n");
        const validRange = Number.isInteger(sourceRef.startLine) && Number.isInteger(sourceRef.endLine) && sourceRef.startLine! >= 1 && sourceRef.endLine! >= sourceRef.startLine! && sourceRef.endLine! <= lines.length;
        const excerpt = validRange ? lines.slice(sourceRef.startLine! - 1, sourceRef.endLine).join("\n") : "";
        return validRange && excerpt === sourceRef.excerpt ? [] : [sourceRef.id];
    });
}

export function isPptLayoutIntentSupported(pageSpec: CanvasProjectPptPageSpec, intent: string) {
    const stylePreview = previewPptStyleClauseRepair(intent);
    if (!stylePreview.safe && findPptDeckStyleOverrides(intent).length) return true;
    const layout = stylePreview.remainder;
    if (!layout) return true;
    const approvedSource = [renderPptPageSpecText(pageSpec), ...pageSpec.sourceRefs.map((sourceRef) => sourceRef.excerpt)].join("\n");
    const approvedText = normalizedComparable(approvedSource);
    const approvedItemCount = pageSpec.contentBlocks.filter((block) => block.kind !== "title" && block.kind !== "placeholder").flatMap((block) => meaningfulLines(block.text)).length;
    const contentCountsSupported = [...layout.matchAll(LAYOUT_CONTENT_COUNT_PATTERN)].every((match) => {
        if (approvedText.includes(normalizedComparable(match[0]))) return true;
        const count = parseLayoutCount(match[1] || match[2]);
        return count !== undefined && (approvedItemCount === count || pageSpec.lockedFacts.some((fact) => fact.kind === "point_count" && Number(fact.value) === count));
    });
    if (!contentCountsSupported) return false;
    return layout
        .split(/[，,。；;·・]/)
        .map((clause) =>
            clause
                .replace(/\d+\s*:\s*\d+/g, "")
                .replace(/\d+\s*[×xX*]\s*\d+/g, "")
                .replace(/\bPPT\b/gi, "")
                .replace(LAYOUT_CONTENT_COUNT_PATTERN, "")
                .replace(LAYOUT_GEOMETRY_COUNT_PATTERN, "")
                .replace(LAYOUT_GEOMETRY_PATTERN, "")
                .replace(/[()[\]{}（）【】]/g, ""),
        )
        .flatMap((clause) => clause.split(/[、/]|或/))
        .map(normalizedComparable)
        .filter(Boolean)
        .every((token) => approvedText.includes(token));
}

export function renderPptPageSpecText(pageSpec: CanvasProjectPptPageSpec) {
    return pageSpec.contentBlocks
        .filter((block) => block.kind !== "placeholder")
        .map((block) => block.text)
        .join("\n");
}

export function auditPptPageCopyReadiness(value: string) {
    const lines = meaningfulLines(value);
    const issues: Array<{ code: "monolithic_content" | "excessive_copy"; message: string }> = [];
    const longestBodyLine = Math.max(0, ...lines.slice(2).map(copyLength));
    const total = copyLength(lines.join(""));
    if (longestBodyLine > 100) issues.push({ code: "monolithic_content", message: `正文存在 ${longestBodyLine} 字的连续长段落，请拆分为可独立排版的信息块` });
    if (total > 280) issues.push({ code: "excessive_copy", message: `单页文案共 ${total} 字，请压缩内容或拆页后再生成` });
    return issues;
}

export function requirePptPageRewriteSpec(value: unknown): PptPageRewriteSpec {
    const page = asRecord(value);
    const title = text(page.title);
    const primaryClaim = text(page.primaryClaim);
    if (!title || !primaryClaim) throw new Error("AI 改写结果缺少本页标题或核心信息");
    if (title.includes("|")) throw new Error("AI 改写结果的标题仍混入整套 PPT 名称");
    if (!isContentForm(page.contentForm)) throw new Error("AI 改写结果的内容形态无效");

    const blocks = (Array.isArray(page.blocks) ? page.blocks : []).map((raw) => {
        const block = asRecord(raw);
        const key = text(block.key);
        const kind = block.kind;
        const blockText = text(block.text);
        if (!key || !REWRITE_BLOCK_KINDS.has(kind as PptPageRewriteSpec["blocks"][number]["kind"]) || !blockText) throw new Error("AI 改写结果包含无效的内容块");
        return { key, kind: kind as PptPageRewriteSpec["blocks"][number]["kind"], text: blockText };
    });
    const blockKeys = new Set(blocks.map((block) => block.key));
    if (blockKeys.size !== blocks.length) throw new Error("AI 改写结果的内容块 key 重复");
    const minimumBlocks = RELATIONAL_REWRITE_FORMS.has(page.contentForm) ? 2 : page.contentForm === "cover" || page.contentForm === "closing" ? 0 : 1;
    if (blocks.length < minimumBlocks) throw new Error(`AI 改写结果的 ${page.contentForm} 内容形态至少需要 ${minimumBlocks} 个内容块`);

    const rawEncodings = Array.isArray(page.visualEncoding) ? page.visualEncoding : [];
    if (blocks.length && !rawEncodings.length) throw new Error("AI 改写结果缺少定向信息表达");
    const visualEncoding = rawEncodings.map((raw) => {
        const encoding = asRecord(raw);
        const contentKeys = unique(stringArray(encoding.contentKeys));
        if (!contentKeys.length || contentKeys.some((key) => !blockKeys.has(key))) throw new Error("AI 改写结果的信息表达引用了不存在的内容块");
        if (!isEncodingIntent(encoding.intent) || !isEncodingChannel(encoding.channel)) throw new Error("AI 改写结果的信息表达无效");
        return { contentKeys, intent: encoding.intent, channel: encoding.channel };
    });
    const canonicalText = [title, primaryClaim, ...blocks.map((block) => block.text)].join("\n");
    const issues = auditPptPageCopyReadiness(canonicalText);
    if (issues.length) throw new Error(`改写结果仍不适合单页展示：${issues.map((issue) => issue.message).join("；")}`);
    return { canonicalText, title, primaryClaim, contentForm: page.contentForm, blocks, visualEncoding };
}

export function isPptAuthoringInstruction(value: string) {
    const normalized = value
        .trim()
        .replace(/[。！？!?]+$/g, "")
        .trim();
    return AUTHORING_INSTRUCTION_PATTERN.test(normalized) || DECK_CREATION_INTENT_PATTERN.test(normalized) || DECK_SELF_REFERENCE_PATTERN.test(normalized);
}

function normalizePage(rawPage: RawPage, index: number, sourceInput: PptContentSourceInput, gaps: PptInformationGap[]): CanvasProjectPptPageSpec {
    const previousPageSpec = sourceInput.previousPageSpecs?.[index];
    const pageId = previousPageSpec?.pageId || nanoid();
    const rawGaps = Array.isArray(rawPage.gaps) ? (rawPage.gaps as RawGap[]) : [];
    const gapByKey = new Map<string, PptInformationGap>();
    for (const [gapIndex, rawGap] of rawGaps.entries()) {
        const key = text(rawGap.key) || `gap-${gapIndex + 1}`;
        if (gapByKey.has(key)) throw new Error(`信息缺口 key 重复：${key}`);
        const kind = isGapKind(rawGap.kind) ? rawGap.kind : "missing_detail";
        const question = text(rawGap.question) || "请补充本页所需信息";
        const gap: PptInformationGap = {
            id: `${pageId}:gap:raw:${encodeURIComponent(key)}:${kind}:${encodeURIComponent(normalize(question))}`,
            lineageKey: gapLineageKey(kind, question),
            pageId,
            kind,
            question,
            reason: text(rawGap.reason) || "当前材料不足以支持本页生成",
            blocking: rawGap.blocking !== false,
            ...(text(rawGap.proposedAnswer) ? { proposedAnswer: text(rawGap.proposedAnswer) } : {}),
        };
        gapByKey.set(key, gap);
        gaps.push(gap);
    }
    const sourceRefs: CanvasProjectPptSourceRef[] = [];
    const blockByKey = new Map<string, CanvasProjectPptContentBlock>();
    const consumedPreviousBlockIds = new Set<string>();
    const addBlock = (key: string, identity: string, kind: CanvasProjectPptContentBlock["kind"], value: string, rawSource?: RawSourceRange, gapKey?: string) => {
        if (blockByKey.has(key)) throw new Error(`页面内容 key 重复：${key}`);
        const purePlaceholder = isPurePlaceholderText(value);
        const isRequired = kind === "title" || kind === "primary_claim";
        const effectiveKind: CanvasProjectPptContentBlock["kind"] = purePlaceholder && !isRequired ? "placeholder" : kind;
        const effectiveValue = purePlaceholder && isRequired ? "" : value;
        const previousMatch = resolvePreviousConfirmedBlock(previousPageSpec, effectiveKind, effectiveValue, consumedPreviousBlockIds);
        const blockId = previousMatch?.blockId || `${pageId}:block:${identity}`;
        const shouldResolveSource = !previousMatch && Boolean(effectiveValue) && effectiveKind !== "placeholder" && !purePlaceholder;
        const inputSourceRef = shouldResolveSource ? resolveSourceRef(pageId, key, effectiveValue, rawSource, sourceInput) : undefined;
        const blockSourceRefs = previousMatch?.sourceRefs || (inputSourceRef ? [inputSourceRef] : []);
        for (const sourceRef of blockSourceRefs) {
            if (!sourceRefs.some((item) => item.id === sourceRef.id)) sourceRefs.push(sourceRef);
        }
        let gap = gapKey ? gapByKey.get(gapKey) : undefined;
        if (!blockSourceRefs.length && !gap) {
            const generatedKey = `source-${key}`;
            const autoGapKey = generatedKey === "source-title" || generatedKey === "source-primary_claim" ? generatedKey : `source-${identity}`;
            if (!effectiveValue || purePlaceholder) {
                const question = missingDetailQuestion(key, kind);
                gap = {
                    id: `${pageId}:gap:auto:${encodeURIComponent(autoGapKey)}`,
                    lineageKey: gapLineageKey("missing_detail", question),
                    pageId,
                    kind: "missing_detail",
                    question,
                    reason: "本页缺少所需信息",
                    blocking: true,
                };
                gaps.push(gap);
            } else if (effectiveKind !== "placeholder") {
                const question = unsupportedClaimQuestion(key, effectiveKind);
                gap = {
                    id: `${pageId}:gap:auto:${encodeURIComponent(autoGapKey)}`,
                    lineageKey: gapLineageKey("unsupported_claim", question),
                    pageId,
                    kind: "unsupported_claim",
                    question,
                    reason: "该表述引入了原材料未支持的事实或结论",
                    blocking: true,
                    proposedAnswer: effectiveValue,
                };
                gaps.push(gap);
            }
        }
        const block: CanvasProjectPptContentBlock = {
            id: blockId,
            kind: effectiveKind,
            text: effectiveValue,
            sourceRefIds: blockSourceRefs.map((sourceRef) => sourceRef.id),
            ...(gap ? { gapId: gap.id } : {}),
        };
        blockByKey.set(key, block);
        return block;
    };
    const rawTitle = text(rawPage.title);
    const titleBlock = addBlock("title", "title", "title", rawTitle, rawPage.titleSource);
    // 空标题仍建「请补充本页标题」缺口，展示文案保留第 N 页回退
    if (!rawTitle) titleBlock.text = `第${index + 1}页`;
    const blocks: CanvasProjectPptContentBlock[] = [titleBlock, addBlock("primary_claim", "primary_claim", "primary_claim", text(rawPage.primaryClaim), rawPage.primaryClaimSource)];
    const rawBlocks = Array.isArray(rawPage.blocks) ? (rawPage.blocks as RawBlock[]) : [];
    for (const [blockIndex, rawBlock] of rawBlocks.entries()) {
        const key = text(rawBlock.key) || `content-${blockIndex + 1}`;
        const kind = isBlockKind(rawBlock.kind) ? rawBlock.kind : "body";
        blocks.push(addBlock(key, `${blockIndex + 1}-${stableKey(key)}`, kind, text(rawBlock.text), rawBlock.source, text(rawBlock.gapKey) || undefined));
    }
    const visualEncoding = normalizeVisualEncodings(rawPage.visualEncoding, pageId, blockByKey, sourceRefs);
    const pageGaps = gaps.filter((gap) => gap.pageId === pageId);
    const page: CanvasProjectPptPageSpec = {
        pageId,
        version: previousPageSpec?.version || 1,
        purpose: text(rawPage.purpose),
        contentForm: isContentForm(rawPage.contentForm) ? rawPage.contentForm : "narrative",
        ...(text(rawPage.contentFormNote) ? { contentFormNote: text(rawPage.contentFormNote) } : {}),
        sourceRefs,
        contentBlocks: blocks,
        contentState: contentStateFor(pageGaps),
        lockedFacts: [],
        layoutRole: layoutRoleFor(rawPage.contentForm),
        layoutIntent: unique(stringArray(rawPage.layoutIntent)),
        visualEncoding,
        assetRefs: unique(blocks.flatMap((block) => [...block.text.matchAll(/@\[node:([^\]]+)\]/g)].map((match) => match[1]))),
        freedom: "不得新增或改写可见文案、数字、业务组件名称、参数、型号、成本或结论；允许新增不含文字的图标、形状、连线、分区和装饰图形，只用于组织已批准内容",
    };
    page.lockedFacts = derivePptLockedFacts(page);
    return page;
}

function assertPptContentAction(draft: PptContentDraft, action: PptContentAction) {
    if (action.kind === "merge_pages") {
        const [targetPageId, sourcePageId] = action.pageIds;
        if (!targetPageId || !sourcePageId || targetPageId === sourcePageId) throw new Error("合并页面需要两个不同的页面身份");
        if (!draft.pageSpecs.some((page) => page.pageId === targetPageId) || !draft.pageSpecs.some((page) => page.pageId === sourcePageId)) throw new Error("合并页面不存在");
        return;
    }
    if (action.kind === "reorder_pages") {
        const current = draft.pageSpecs.map((page) => page.pageId);
        if (action.pageIds.length !== current.length || new Set(action.pageIds).size !== current.length || current.some((pageId) => !action.pageIds.includes(pageId))) throw new Error("重排页序必须完整且不重复");
        return;
    }
    const page = draft.pageSpecs.find((item) => item.pageId === action.pageId);
    if (!page) throw new Error("内容操作的目标页不存在");
    if (action.kind === "remove_page") {
        if (draft.pageSpecs.length === 1) throw new Error("内容方案至少保留一页");
        return;
    }
    if (action.kind === "edit_purpose") {
        if (!action.purpose.trim()) throw new Error("页面目的不能为空");
        return;
    }
    if (!action.text.trim() || !action.editedAt.trim()) throw new Error("页面内容和编辑时间不能为空");
    if (!page.contentBlocks.some((block) => block.id === action.blockId)) throw new Error("内容块不存在");
}

function normalizeVisualEncodings(rawValue: unknown, pageId: string, blockByKey: Map<string, CanvasProjectPptContentBlock>, sourceRefs: CanvasProjectPptSourceRef[]) {
    if (!Array.isArray(rawValue)) return [];
    return (rawValue as RawVisualEncoding[]).map((raw, index) => {
        const contentBlockIds = stringArray(raw.contentKeys).map((key) => blockByKey.get(key)?.id || `${pageId}:unknown-block:${stableKey(key)}`);
        const lockedMapping = Array.isArray(raw.lockedMapping)
            ? raw.lockedMapping.map((value) => {
                  const mapping = asRecord(value);
                  const key = text(mapping.contentKey);
                  const token = text(mapping.token);
                  const block = blockByKey.get(key);
                  const blockSourceRefIds = block?.sourceRefIds.filter((id) => {
                      const sourceRef = sourceRefs.find((item) => item.id === id);
                      return Boolean(sourceRef && sourceSupportsText(block.text, token) && sourceSupportsText(sourceRef.excerpt, token));
                  });
                  return {
                      contentBlockId: block?.id || `${pageId}:unknown-block:${stableKey(key)}`,
                      token,
                      sourceRefIds: blockSourceRefIds || [],
                  };
              })
            : undefined;
        return {
            id: `${pageId}:encoding:${index + 1}`,
            contentBlockIds,
            intent: isEncodingIntent(raw.intent) ? raw.intent : "emphasize",
            channel: isEncodingChannel(raw.channel) ? raw.channel : "position",
            ...(lockedMapping?.length ? { lockedMapping } : {}),
        } satisfies CanvasProjectPptVisualEncoding;
    });
}

function resolveSourceRef(pageId: string, key: string, value: string, raw: RawSourceRange | undefined, sourceInput: PptContentSourceInput) {
    if (!normalize(value)) return undefined;
    const declared = raw?.source === "material" || raw?.source === "requirements" ? raw.source : undefined;
    const declaredRelation = raw?.relation === "derived" || raw?.relation === "verbatim" ? raw.relation : undefined;
    // 1) 原文可逐字定位：错误行号也全材料重绑，规范化为 verbatim
    if (declared) {
        const sourceText = declared === "material" ? sourceInput.sourceMaterial : sourceInput.requirements;
        const startLine = Number(raw?.startLine);
        const endLine = Number(raw?.endLine);
        const lines = sourceText.split("\n");
        if (Number.isInteger(startLine) && Number.isInteger(endLine) && startLine >= 1 && endLine >= startLine && endLine <= lines.length) {
            const excerpt = lines.slice(startLine - 1, endLine).join("\n");
            if (sourceSupportsText(excerpt, value)) {
                return makeSourceRef(pageId, key, declared, "verbatim", excerpt, startLine, endLine);
            }
        }
        const rebound = findSmallestSupportingRange(sourceText, value);
        if (rebound) {
            return makeSourceRef(pageId, key, declared, "verbatim", rebound.excerpt, rebound.startLine, rebound.endLine);
        }
    }
    for (const source of ["material", "requirements"] as const) {
        if (source === declared) continue;
        const sourceText = source === "material" ? sourceInput.sourceMaterial : sourceInput.requirements;
        const rebound = findSmallestSupportingRange(sourceText, value);
        if (rebound) {
            return makeSourceRef(pageId, key, source, "verbatim", rebound.excerpt, rebound.startLine, rebound.endLine);
        }
    }
    // 2) 显式 derived：合法行号 + excerpt 与原文切片一致 + 数字/大写术语均落在 excerpt
    if (declaredRelation === "derived" && declared) {
        const sourceText = declared === "material" ? sourceInput.sourceMaterial : sourceInput.requirements;
        const startLine = Number(raw?.startLine);
        const endLine = Number(raw?.endLine);
        const lines = sourceText.split("\n");
        if (Number.isInteger(startLine) && Number.isInteger(endLine) && startLine >= 1 && endLine >= startLine && endLine <= lines.length) {
            const excerpt = lines.slice(startLine - 1, endLine).join("\n");
            if (hardFactsSupported(excerpt, value)) {
                return makeSourceRef(pageId, key, declared, "derived", excerpt, startLine, endLine);
            }
        }
    }
    return undefined;
}

function makeSourceRef(pageId: string, key: string, source: "material" | "requirements", relation: CanvasProjectPptSourceRef["relation"], excerpt: string, startLine: number, endLine: number): CanvasProjectPptSourceRef {
    return {
        id: `${pageId}:source:${stableKey(key)}:${source}:${relation}:${startLine}-${endLine}`,
        source,
        relation,
        excerpt,
        startLine,
        endLine,
    };
}

function hardFactsSupported(source: string, value: string) {
    const normalizedSource = normalize(source);
    if (!normalizedSource || !normalize(value)) return false;
    const facts = extractHardFacts(value);
    return facts.every((fact) => normalizedSource.includes(normalize(fact)));
}

function extractHardFacts(value: string) {
    return [...value.matchAll(NUMBER_PATTERN), ...value.matchAll(ASCII_TERM_PATTERN)].map((match) => match[0].trim()).filter(Boolean);
}

function sourceRefsSupportBlockText(refs: CanvasProjectPptSourceRef[], value: string) {
    if (!refs.length) return false;
    const joined = refs.map((sourceRef) => sourceRef.excerpt).join("\n");
    if (refs.every((sourceRef) => sourceRef.relation === "derived")) return hardFactsSupported(joined, value);
    return sourceSupportsText(joined, value);
}

function findSmallestSupportingRange(sourceText: string, value: string) {
    if (!normalize(value) || !sourceText) return undefined;
    // 全文都不支持时直接返回，避免常见无匹配路径的 O(n²) 窗口扫描
    if (!sourceSupportsText(sourceText, value)) return undefined;
    const lines = sourceText.split("\n");
    let best: { startLine: number; endLine: number; excerpt: string; length: number } | undefined;
    for (let startLine = 1; startLine <= lines.length; startLine++) {
        for (let endLine = startLine; endLine <= lines.length; endLine++) {
            const excerpt = lines.slice(startLine - 1, endLine).join("\n");
            if (!sourceSupportsText(excerpt, value)) continue;
            const length = endLine - startLine + 1;
            if (!best || length < best.length) best = { startLine, endLine, excerpt, length };
            break;
        }
    }
    return best ? { startLine: best.startLine, endLine: best.endLine, excerpt: best.excerpt } : undefined;
}

function isPurePlaceholderText(value: string) {
    return PURE_PLACEHOLDER_TEXT_PATTERN.test(normalize(value));
}

function missingDetailQuestion(key: string, kind: CanvasProjectPptContentBlock["kind"]) {
    if (key === "title" || kind === "title") return "请补充本页标题";
    if (key === "primary_claim" || kind === "primary_claim") return "请补充本页核心信息";
    if (kind === "supporting_claim") return "请补充本页支撑观点";
    if (kind === "body") return "请补充本页正文";
    if (kind === "list") return "请补充本页列表内容";
    if (kind === "table") return "请补充本页表格内容";
    if (kind === "chart_data") return "请补充本页图表数据";
    return "请补充本页所需信息";
}

function unsupportedClaimQuestion(key: string, kind: CanvasProjectPptContentBlock["kind"]) {
    if (key === "title" || kind === "title") return "请确认本页标题中的新增表述";
    if (key === "primary_claim" || kind === "primary_claim") return "请确认本页核心信息中的新增表述";
    if (kind === "supporting_claim") return "请确认本页支撑观点中的新增表述";
    if (kind === "list") return "请确认本页列表中的新增表述";
    if (kind === "table") return "请确认本页表格中的新增表述";
    if (kind === "chart_data") return "请确认本页图表数据中的新增表述";
    return "请确认本段新增表述";
}

function resolvePreviousConfirmedBlock(previousPageSpec: CanvasProjectPptPageSpec | undefined, kind: CanvasProjectPptContentBlock["kind"], value: string, consumedBlockIds: Set<string>) {
    if (!previousPageSpec || !value) return undefined;
    const sourceById = new Map(previousPageSpec.sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]));
    const block = previousPageSpec.contentBlocks.find(
        (candidate) =>
            !consumedBlockIds.has(candidate.id) &&
            candidate.kind === kind &&
            normalize(candidate.text) === normalize(value) &&
            candidate.sourceRefIds.some((sourceRefId) => {
                const sourceRef = sourceById.get(sourceRefId);
                return isConfirmedSourceRef(sourceRef) && normalize(sourceRef.excerpt) === normalize(value);
            }),
    );
    if (!block) return undefined;
    consumedBlockIds.add(block.id);
    return {
        blockId: block.id,
        sourceRefs: block.sourceRefIds.flatMap((sourceRefId) => {
            const sourceRef = sourceById.get(sourceRefId);
            return sourceRef ? [structuredClone(sourceRef)] : [];
        }),
    };
}

function assertRegeneratedPagePreservesConfirmedSources(current: CanvasProjectPptPageSpec, replacement: CanvasProjectPptPageSpec) {
    const protectedSourceIds = confirmedSourceIds(current);
    const replacementSources = new Map(replacement.sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]));
    const missing = current.sourceRefs.some((sourceRef) => {
        if (!protectedSourceIds.has(sourceRef.id)) return false;
        const replacementSource = replacementSources.get(sourceRef.id);
        const currentBindings = current.contentBlocks.filter((block) => block.kind !== "placeholder" && block.sourceRefIds.includes(sourceRef.id));
        const bindingsPreserved =
            currentBindings.length > 0 &&
            currentBindings.every((currentBlock) =>
                replacement.contentBlocks.some((block) => block.id === currentBlock.id && block.kind === currentBlock.kind && block.sourceRefIds.includes(sourceRef.id) && normalize(block.text) === normalize(currentBlock.text)),
            );
        return (
            !replacementSource || replacementSource.source !== sourceRef.source || replacementSource.relation !== sourceRef.relation || replacementSource.excerpt !== sourceRef.excerpt || replacementSource.gapId !== sourceRef.gapId || !bindingsPreserved
        );
    });
    if (missing) throw new Error("本页生成结果遗漏或改写了已确认内容；原页已保留");
}

function reconcileRegeneratedConfirmedGaps(current: CanvasProjectPptPageSpec, currentGaps: PptInformationGap[], replacement: CanvasProjectPptPageSpec, gaps: PptInformationGap[]) {
    const protectedSourceIds = confirmedSourceIds(current);
    const sourceById = new Map(replacement.sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]));
    const currentLineageCounts = new Map<string, number>();
    for (const gap of currentGaps) currentLineageCounts.set(gap.lineageKey, (currentLineageCounts.get(gap.lineageKey) || 0) + 1);
    const replacementLineageCounts = new Map<string, number>();
    for (const gap of gaps) replacementLineageCounts.set(gap.lineageKey, (replacementLineageCounts.get(gap.lineageKey) || 0) + 1);
    const reconciledGapIds = new Map<string, string>();
    for (const gap of gaps) {
        if (currentLineageCounts.get(gap.lineageKey) !== 1 || replacementLineageCounts.get(gap.lineageKey) !== 1) continue;
        const proposedAnswer = normalize(gap.proposedAnswer || "");
        if (!proposedAnswer) continue;
        const candidates = currentGaps.filter((previousGap) => {
            const resolution = previousGap.resolution;
            return previousGap.lineageKey === gap.lineageKey && resolution && (resolution.kind === "user_answer" || resolution.kind === "confirmed_assumption") && normalize(resolution.text) === proposedAnswer;
        });
        if (candidates.length !== 1) continue;
        const previousGap = candidates[0];
        const isConfirmedBlock = (block: CanvasProjectPptContentBlock) =>
            block.kind !== "placeholder" &&
            normalize(block.text) === proposedAnswer &&
            block.sourceRefIds.some((sourceRefId) => {
                const sourceRef = sourceById.get(sourceRefId);
                return protectedSourceIds.has(sourceRefId) && sourceRef?.gapId === previousGap.id && normalize(sourceRef.excerpt) === proposedAnswer;
            });
        const boundBlocks = replacement.contentBlocks.filter((block) => block.gapId === gap.id);
        const confirmedBlocks = replacement.contentBlocks.filter(isConfirmedBlock);
        if (!confirmedBlocks.length || (boundBlocks.length > 0 && !boundBlocks.every(isConfirmedBlock))) continue;
        reconciledGapIds.set(gap.id, previousGap.id);
    }
    if (!reconciledGapIds.size) return { page: replacement, gaps };
    const page = structuredClone(replacement);
    page.contentBlocks = page.contentBlocks.map((block) => {
        const previousGapId = block.gapId ? reconciledGapIds.get(block.gapId) : undefined;
        if (previousGapId) return { ...block, gapId: previousGapId };
        if (block.gapId) return block;
        const confirmedGapIds = unique(
            block.sourceRefIds.flatMap((sourceRefId) => {
                const sourceRef = sourceById.get(sourceRefId);
                return isConfirmedSourceRef(sourceRef) && sourceRef.gapId && currentGaps.some((gap) => gap.id === sourceRef.gapId) ? [sourceRef.gapId] : [];
            }),
        );
        return confirmedGapIds.length === 1 ? { ...block, gapId: confirmedGapIds[0] } : block;
    });
    return { page, gaps: gaps.filter((gap) => !reconciledGapIds.has(gap.id)) };
}

function gapLineageKey(kind: PptInformationGap["kind"], question: string) {
    return `${kind}:${encodeURIComponent(normalize(question))}`;
}

function isConfirmedSourceRef(sourceRef: CanvasProjectPptSourceRef | undefined): sourceRef is CanvasProjectPptSourceRef {
    return sourceRef?.source === "user_answer" || sourceRef?.source === "confirmed_assumption";
}

function confirmedSourceIds(page: CanvasProjectPptPageSpec) {
    return new Set(
        page.contentBlocks
            .filter((block) => block.kind !== "placeholder")
            .flatMap((block) => block.sourceRefIds)
            .filter((sourceRefId) => {
                const sourceRef = page.sourceRefs.find((item) => item.id === sourceRefId);
                return isConfirmedSourceRef(sourceRef);
            }),
    );
}

function deriveAuditIssues(brief: PptContentBrief, pageSpecs: CanvasProjectPptPageSpec[], gaps: PptInformationGap[], constraints: PptContentDraft["constraints"]) {
    const issues: PptContentAuditIssue[] = [];
    if (!brief.audience.trim() || !brief.goal.trim() || !brief.narrative.trim()) {
        issues.push({ id: "issue:brief:incomplete", code: "invalid_content_structure", severity: "blocking", pageIds: [], message: "整套材料缺少受众、目标或叙事主线", actions: [] });
    }
    if (constraints.maxPages && pageSpecs.length > constraints.maxPages) {
        issues.push({
            id: `issue:deck:page-count:${pageSpecs.length}:${constraints.maxPages}`,
            code: "page_count_exceeded",
            severity: "blocking",
            pageIds: [],
            message: `当前方案共 ${pageSpecs.length} 页，超过你要求的最多 ${constraints.maxPages} 页；请重新压缩整套叙事`,
            actions: [{ kind: "regenerate_pages", pageIds: pageSpecs.map((page) => page.pageId) }],
            field: "pages",
            value: String(pageSpecs.length),
        });
    }
    if (pageSpecs.length > 1 && (pageSpecs[0].contentForm !== "cover" || pageSpecs[0].layoutRole !== "cover")) {
        issues.push({
            id: `issue:${pageSpecs[0].pageId}:cover:first-page`,
            code: "invalid_cover",
            severity: "blocking",
            pageIds: [pageSpecs[0].pageId],
            message: "第一页应承担封面职责，只保留标题和一句定位语",
            actions: [{ kind: "regenerate_pages", pageIds: [pageSpecs[0].pageId] }],
            field: "contentForm",
            value: pageSpecs[0].contentForm,
        });
    }
    for (const [index, page] of pageSpecs.entries()) {
        if (index === 0 || (page.contentForm !== "cover" && page.layoutRole !== "cover")) continue;
        issues.push({
            id: `issue:${page.pageId}:cover:later-page`,
            code: "invalid_cover",
            severity: "blocking",
            pageIds: [page.pageId],
            message: `第 ${index + 1} 页不能再次承担整套封面职责，请按本页内容选择页面形态`,
            actions: [{ kind: "regenerate_pages", pageIds: [page.pageId] }],
            field: "contentForm",
            value: page.contentForm,
        });
    }
    for (const gap of gaps.filter((item) => !item.resolution)) {
        issues.push({
            id: `issue:gap:${gap.id}`,
            code: "unresolved_gap",
            severity: gap.blocking ? "blocking" : "warning",
            pageIds: gap.pageId ? [gap.pageId] : [],
            message: gap.question,
            actions: [{ kind: "focus_gap", gapId: gap.id }],
        });
    }
    for (const page of pageSpecs) {
        for (const issue of validatePptPageSpec({ ...page, contentState: page.contentState.status === "approved" ? page.contentState : { status: "approved", approvedAt: "audit" } })) {
            if (issue.code === "content_spec_not_approved" || issue.code === "unresolved_information_gap") continue;
            const layoutRepair = issue.field === "layoutIntent" && issue.value ? ({ kind: "remove_layout_intent", pageId: page.pageId, value: issue.value, replacement: "" } as const) : undefined;
            const coverIssue = page.contentForm === "cover" && (issue.field === "contentForm" || issue.field === "primaryClaim");
            issues.push({
                id: `issue:${page.pageId}:${issue.code}:${issues.length + 1}`,
                code: coverIssue ? "invalid_cover" : issue.code,
                severity: "blocking",
                pageIds: [page.pageId],
                message: issue.message,
                actions: layoutRepair ? [{ kind: "preview_safe_patch", issueId: `issue:${page.pageId}:${issue.code}:${issues.length + 1}` }] : [{ kind: "regenerate_pages", pageIds: [page.pageId] }],
                ...(issue.field ? { field: issue.field } : {}),
                ...(issue.value ? { value: issue.value } : {}),
                ...(layoutRepair ? { repair: layoutRepair } : {}),
            });
        }
        for (const block of page.contentBlocks) {
            if (block.kind !== "placeholder" && isPptAuthoringInstruction(block.text)) {
                issues.push({
                    id: `issue:${page.pageId}:authoring:${block.id}`,
                    code: "authoring_instruction_as_copy",
                    severity: "blocking",
                    pageIds: [page.pageId],
                    message: `「${block.text}」属于整套材料的创作目标，不应直接作为上屏正文`,
                    actions: [{ kind: "regenerate_pages", pageIds: [page.pageId] }],
                    field: `contentBlocks.${block.kind}`,
                    value: block.text,
                });
            }
            if (/^[A-Za-z]\s*(?:对比|列表)/.test(block.text)) {
                issues.push({ id: `issue:${page.pageId}:noise:${block.id}`, code: "noise_text", severity: "warning", pageIds: [page.pageId], message: `可能的异常文本：${block.text}`, actions: [{ kind: "regenerate_pages", pageIds: [page.pageId] }] });
            }
        }
        for (const copyIssue of auditPptPageCopyReadiness(renderPptPageSpecText(page))) {
            issues.push({
                id: `issue:${page.pageId}:${copyIssue.code}`,
                code: copyIssue.code,
                severity: "warning",
                pageIds: [page.pageId],
                message: copyIssue.message,
                actions: [{ kind: "regenerate_pages", pageIds: [page.pageId] }],
            });
        }
        for (const value of page.layoutIntent) {
            if (!findPptDeckStyleOverrides(value).length) continue;
            const preview = previewPptStyleClauseRepair(value);
            const id = `issue:${page.pageId}:style:${stableKey(value)}`;
            issues.push({
                id,
                code: "deck_style_signal",
                severity: "warning",
                pageIds: [page.pageId],
                message: `整套审美描述应留到视觉方向阶段：${value}`,
                actions: preview.safe ? [{ kind: "preview_safe_patch", issueId: id }] : [{ kind: "regenerate_pages", pageIds: [page.pageId] }],
                ...(preview.safe ? { repair: { kind: "route_deck_style" as const, pageId: page.pageId, value, replacement: preview.remainder } } : {}),
            });
        }
    }
    for (let left = 0; left < pageSpecs.length; left++) {
        for (let right = left + 1; right < pageSpecs.length; right++) {
            if (!sameTopic(pageSpecs[left], pageSpecs[right])) continue;
            const pageIds = [pageSpecs[left].pageId, pageSpecs[right].pageId];
            issues.push({ id: `issue:duplicate:${pageIds.join(":")}`, code: "duplicate_page", severity: "warning", pageIds, message: "两页主题可能重复，请确认是否合并", actions: [{ kind: "merge_pages", pageIds }] });
        }
    }
    return issues;
}

function rebuildDraft(draft: PptContentDraft): PptContentDraft {
    if (new Set(draft.audit.gaps.map((gap) => gap.id)).size !== draft.audit.gaps.length) throw new Error("信息缺口身份重复，请重新生成内容方案");
    const unresolved = draft.audit.gaps.filter((gap) => !gap.resolution && gap.blocking);
    const pageSpecs = draft.pageSpecs.map((page) => ({ ...page, contentState: contentStateFor(unresolved.filter((gap) => gap.pageId === page.pageId)), lockedFacts: derivePptLockedFacts(page) }));
    const audit = { gaps: draft.audit.gaps, issues: deriveAuditIssues(draft.brief, pageSpecs, draft.audit.gaps, draft.constraints) };
    return { ...draft, pageSpecs, audit };
}

function contentStateFor(gaps: PptInformationGap[]) {
    const gapIds = gaps.filter((gap) => gap.blocking && !gap.resolution).map((gap) => gap.id);
    return gapIds.length ? ({ status: "blocked", gapIds } as const) : ({ status: "reviewable" } as const);
}

function sameTopic(left: CanvasProjectPptPageSpec, right: CanvasProjectPptPageSpec) {
    const leftPurpose = normalize(left.purpose);
    const rightPurpose = normalize(right.purpose);
    if (leftPurpose && leftPurpose === rightPurpose) return true;
    const signatures = (page: CanvasProjectPptPageSpec) =>
        page.contentBlocks
            .filter((block) => block.kind === "title" || block.kind === "primary_claim")
            .map((block) => normalize(block.text))
            .filter(Boolean);
    const leftSignatures = signatures(left);
    const rightSignatures = signatures(right);
    return leftSignatures.some((value) => rightSignatures.includes(value));
}

function extractExplicitMaxPages(requirements: string) {
    const candidates: number[] = [];
    for (const match of requirements.matchAll(/(?:最多|不超过|至多|控制在|限制在)\s*([0-9一二三四五六七八九十两]+)\s*页(?:以内|以下|之内)?|([0-9一二三四五六七八九十两]+)\s*页(?:以内|以下|之内)/g)) {
        const count = parseLayoutCount(match[1] || match[2]);
        if (count && count > 0) candidates.push(count);
    }
    for (const match of requirements.matchAll(/(?:控制在|限制在)?\s*([0-9一二三四五六七八九十两]+)\s*(?:到|至|[-—~])\s*([0-9一二三四五六七八九十两]+)\s*页/g)) {
        const count = parseLayoutCount(match[2]);
        if (count && count > 0) candidates.push(count);
    }
    return candidates.length ? Math.min(...candidates) : undefined;
}

function isPptCoverTargetChecklist(value: string) {
    return [...value.matchAll(COVER_TARGET_QUESTION_PATTERN)].length >= 2;
}

function sourceSupportsText(source: string, value: string) {
    const normalizedValue = normalize(value);
    if (!normalizedValue) return false;
    if (!normalize(source).includes(normalizedValue)) return false;
    return hardFactsSupported(source, value);
}

function normalizedComparable(value: string) {
    return value.replace(/[\s·・，,。；;、:：/]+/g, "");
}

function parseLayoutCount(value: string) {
    if (/^\d+$/.test(value)) return Number(value);
    const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (value === "十") return 10;
    const [tens, ones] = value.split("十");
    if (ones !== undefined) return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
    return digits[value];
}

function readPointCount(value: string) {
    const bulletCount = value.split(/\r?\n/).filter((line) => LIST_ITEM_PATTERN.test(line)).length;
    const declared = [...value.matchAll(/(\d+)\s*(?:个)?(?:要点|点|项|条)/g)].map((match) => Number(match[1]));
    const counts = [...(bulletCount >= 2 ? [bulletCount] : []), ...declared].filter((count) => count > 0);
    return counts.length ? Math.max(...counts) : undefined;
}

function pointCountExcerpt(value: string) {
    const lines = meaningfulLines(value);
    return lines.find((line) => /(\d+)\s*(?:个)?(?:要点|点|项|条)/.test(line)) || lines.filter((line) => LIST_ITEM_PATTERN.test(line)).join("\n");
}

function assertResolution(resolution: PptInformationGapResolution) {
    if (!resolution.resolvedAt.trim()) throw new Error("缺口处理时间不能为空");
    if (resolution.kind !== "omit" && !resolution.text.trim()) throw new Error("缺口处理内容不能为空");
}

function layoutRoleFor(raw: unknown): PptLayoutRole {
    if (raw === "cover") return "cover";
    if (raw === "comparison") return "comparison";
    if (raw === "data") return "evidence";
    if (raw === "closing") return "close";
    return "content";
}

function isContentForm(value: unknown): value is PptContentForm {
    return typeof value === "string" && CONTENT_FORMS.has(value as PptContentForm);
}

function isBlockKind(value: unknown): value is CanvasProjectPptContentBlock["kind"] {
    return typeof value === "string" && BLOCK_KINDS.has(value as CanvasProjectPptContentBlock["kind"]);
}

function isGapKind(value: unknown): value is PptInformationGap["kind"] {
    return typeof value === "string" && GAP_KINDS.has(value as PptInformationGap["kind"]);
}

function isEncodingIntent(value: unknown): value is CanvasProjectPptVisualEncoding["intent"] {
    return typeof value === "string" && ENCODING_INTENTS.has(value as CanvasProjectPptVisualEncoding["intent"]);
}

function isEncodingChannel(value: unknown): value is CanvasProjectPptVisualEncoding["channel"] {
    return typeof value === "string" && ENCODING_CHANNELS.has(value as CanvasProjectPptVisualEncoding["channel"]);
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown) {
    return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function copyLength(value: string) {
    return [...value.trim().replace(/\r?\n/g, "")].length;
}

function stableKey(value: string) {
    return (
        value
            .trim()
            .replace(/[^\p{L}\p{N}_-]+/gu, "-")
            .replace(/^-+|-+$/g, "") || "item"
    );
}

function unique(values: string[]) {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueById<T extends { id: string }>(values: T[]) {
    const byId = new Map<string, T>();
    for (const value of values) byId.set(value.id, value);
    return [...byId.values()];
}

function prunePptVisualEncoding(page: CanvasProjectPptPageSpec, blockIds: Set<string>, removeReferences: boolean) {
    if (!blockIds.size) return;
    page.visualEncoding = page.visualEncoding.flatMap((encoding) => {
        const contentBlockIds = removeReferences ? encoding.contentBlockIds.filter((id) => !blockIds.has(id)) : encoding.contentBlockIds;
        if (!contentBlockIds.length) return [];
        const lockedMapping = (encoding.lockedMapping || []).filter((mapping) => !blockIds.has(mapping.contentBlockId));
        const next = { ...encoding, contentBlockIds };
        if (lockedMapping.length) return [{ ...next, lockedMapping }];
        delete next.lockedMapping;
        return [next];
    });
}

function pruneUnusedPptSourceRefs(page: CanvasProjectPptPageSpec) {
    const used = new Set([...page.contentBlocks.flatMap((block) => block.sourceRefIds), ...page.visualEncoding.flatMap((encoding) => (encoding.lockedMapping || []).flatMap((mapping) => mapping.sourceRefIds))]);
    page.sourceRefs = page.sourceRefs.filter((sourceRef) => used.has(sourceRef.id));
}

function meaningfulLines(value: string) {
    return value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function normalize(value: string) {
    return value.trim().replace(/\s+/g, " ");
}
