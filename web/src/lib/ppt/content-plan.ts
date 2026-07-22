import { nanoid } from "nanoid";

import { hashPptContentSource } from "@/lib/ppt/source-lineage";
import type { CanvasProjectPptContentBlock, CanvasProjectPptLockedFact, CanvasProjectPptPageSpec, CanvasProjectPptSourceRef, CanvasProjectPptVisualEncoding, PptContentBrief, PptContentForm, PptLayoutRole } from "@/stores/canvas/use-canvas-store";

export type PptContentSourceInput = {
    title: string;
    sourceMaterial: string;
    requirements: string;
    previousPageSpecs?: CanvasProjectPptPageSpec[];
};

type RawSourceRange = { source?: unknown; startLine?: unknown; endLine?: unknown };
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

export type PptContentAuditIssue = {
    id: string;
    code: "unresolved_gap" | "invalid_content_structure" | "invalid_content_provenance" | "invalid_visual_encoding" | "duplicate_page" | "noise_text" | "deck_style_signal";
    severity: "blocking" | "warning";
    pageIds: string[];
    message: string;
    actions: PptContentAuditAction[];
    repair?: { kind: "route_deck_style"; pageId: string; value: string; replacement: string; signals: string[] };
};

export type PptContentAudit = { issues: PptContentAuditIssue[]; gaps: PptInformationGap[] };

export type PptContentDraft = {
    revision: number;
    brief: PptContentBrief;
    pageSpecs: CanvasProjectPptPageSpec[];
    audit: PptContentAudit;
};

export type PptContentValidationResult = { valid: boolean; issues: PptContentAuditIssue[] };

export type PptContentRepairPreview = {
    draftRevision: number;
    operations: Array<{ kind: "route_deck_style"; pageId: string; value: string; replacement: string; signals: string[] }>;
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
const GAP_KINDS = new Set<PptInformationGap["kind"]>(["missing_detail", "missing_evidence", "unsupported_claim", "ambiguous_input"]);
const ENCODING_INTENTS = new Set<CanvasProjectPptVisualEncoding["intent"]>(["differentiate", "emphasize", "sequence", "group", "show_relationship"]);
const ENCODING_CHANNELS = new Set<CanvasProjectPptVisualEncoding["channel"]>(["color", "shape", "position", "size", "line", "icon"]);
const SOURCE_KINDS = new Set<CanvasProjectPptSourceRef["source"]>(["material", "requirements", "user_answer", "confirmed_assumption"]);
const DECK_STYLE_FRAGMENT_PATTERN = /(?:[^\s，,。；;·・]+(?:风格|科技风|朋克风)|科技感|配色|字体|渐变|材质|画面气质|背景色|背景图|画面背景|(?:深色|浅色|纯色|渐变|简洁|淡化|透明|品牌化|抽象|纹理)背景)/g;
const NUMBER_PATTERN = /(?:[$¥€£]\s*)?\d(?:[\d,]*\d)?(?:\.\d+)?\s*(?:亿元|万元|百分点|个月|小时|分钟|%|％|倍|万|亿|元|人|家|台|页|年|天|秒|个|项|条|点)?/g;
const ASCII_TERM_PATTERN = /\b[A-Z][A-Z0-9-]{1,}\b/g;
const LIST_ITEM_PATTERN = /^\s*(?:[-*•]\s+|\d+[.)、]\s*)/;
const LAYOUT_GEOMETRY_PATTERN =
    /(?:左图右文|左文右图|一图一结论|左侧|右侧|顶部|底部|上方|下方|中间|中央|居中|整页|本页|页面|左右|上下|横向|纵向|水平|垂直|左对齐|右对齐|对齐|双栏|分栏|网格|矩阵|时间线|流程图|概念图|柱状图|折线图|饼图|图表|图片|图标|表格|表头|列表|卡片|模块|区块|区域|分层|分类|大标题|标题|正文|结论|要点|指标|对比|行动建议|行动|路径|箭头|连线|留白|展示|呈现|放置|排列|排布|固定为|突出|强调|对应|并列|分组|区分|表达|依次)/g;
const LAYOUT_GEOMETRY_COUNT_PATTERN = /(?:[0-9一二三四五六七八九十两]+(?:个)?(?:柱状图|折线图|饼图|概念图|图表|图片|列|行|栏|区|块|图|层|组|卡片|模块))/g;
const LAYOUT_CONTENT_COUNT_PATTERN = /([0-9一二三四五六七八九十两]+)(?:个)?(?:指标|要点)|([0-9一二三四五六七八九十两]+)(?:条)?行动建议/g;

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
        if (value && sourceSupportsText(combinedSource, value)) continue;
        gaps.push({
            id: `brief:gap:${field}`,
            kind: value ? "unsupported_claim" : "missing_detail",
            question: `请确认整套材料的${field === "audience" ? "受众" : field === "goal" ? "目标" : "叙事主线"}`,
            reason: value ? "该描述无法从原始输入中定位" : "内容方案缺少整套定位",
            blocking: true,
            ...(value ? { proposedAnswer: value } : {}),
            briefField: field,
        });
    }
    const pageSpecs = rawPages.map((rawPage, index) => normalizePage(rawPage, index, sourceInput, gaps));
    return rebuildDraft({ revision: 1, brief, pageSpecs, audit: { issues: [], gaps } });
}

export function validatePptContentDraft(draft: PptContentDraft): PptContentValidationResult {
    const issues = deriveAuditIssues(draft.brief, draft.pageSpecs, draft.audit.gaps);
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
                page.contentBlocks.push({ id: `${page.pageId}:block:${stableKey(gapId)}`, kind: "placeholder", text: resolution.text.trim(), sourceRefIds: [], gapId });
            }
        } else {
            prunePptVisualEncoding(page, boundBlockIds, false);
            const sourceRef: CanvasProjectPptSourceRef = {
                id: `${page.pageId}:source:${resolution.kind}:${stableKey(gapId)}`,
                source: resolution.kind,
                excerpt: resolution.text.trim(),
                gapId,
            };
            page.sourceRefs.push(sourceRef);
            for (const block of boundBlocks) {
                if (block.kind === "placeholder") block.kind = "body";
                block.text = resolution.text.trim();
                block.sourceRefIds = [sourceRef.id];
            }
            if (!boundBlocks.length) page.contentBlocks.push({ id: `${page.pageId}:block:${stableKey(gapId)}`, kind: "body", text: resolution.text.trim(), sourceRefIds: [sourceRef.id], gapId });
        }
        page.version += 1;
        pruneUnusedPptSourceRefs(page);
        page.lockedFacts = derivePptLockedFacts(page);
    }
    next.revision += 1;
    return rebuildDraft(next);
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
        next.brief.visualSignals = unique([...next.brief.visualSignals, ...operation.signals]);
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
            const sourceRef: CanvasProjectPptSourceRef = {
                id: `${page.pageId}:source:user-answer:${stableKey(block.id)}:${page.version + 1}`,
                source: "user_answer",
                excerpt: editedText,
                ...(block.gapId ? { gapId: block.gapId } : {}),
            };
            page.sourceRefs.push(sourceRef);
            block.text = editedText;
            block.sourceRefIds = [sourceRef.id];
            prunePptVisualEncoding(page, new Set([block.id]), false);
            if (block.kind === "placeholder") block.kind = "body";
            if (block.gapId) {
                const gap = next.audit.gaps.find((item) => item.id === block.gapId);
                if (gap && !gap.resolution) gap.resolution = { kind: "user_answer", text: editedText, resolvedAt: action.editedAt };
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
    const next = structuredClone(draft);
    next.pageSpecs = next.pageSpecs.map((page) => (page.pageId === pageId ? { ...structuredClone(replacement), version: current.version + 1 } : page));
    next.audit.gaps = [...next.audit.gaps.filter((gap) => gap.pageId !== pageId), ...structuredClone(replacementGaps).map((gap) => ({ ...gap, pageId }))];
    next.revision += 1;
    return rebuildDraft(next);
}

export function finalizePptContentDraft(draft: PptContentDraft, approvedAt = new Date().toISOString()): { brief: PptContentBrief; pageSpecs: CanvasProjectPptPageSpec[] } {
    const validation = validatePptContentDraft(draft);
    if (!validation.valid)
        throw new Error(
            `内容方案尚未处理完成，不能确认：${validation.issues
                .filter((issue) => issue.severity === "blocking")
                .map((issue) => issue.message)
                .join("；")}`,
        );
    const routedVisualSignals = draft.pageSpecs.flatMap((page) => page.layoutIntent.flatMap(extractDeckStyleSignals));
    const brief = { ...structuredClone(draft.brief), visualSignals: unique([...draft.brief.visualSignals, ...routedVisualSignals]) };
    const pageSpecs = draft.pageSpecs.map((page) => {
        const next = structuredClone(page);
        next.layoutIntent = unique(next.layoutIntent.map(stripDeckStyleSignals));
        next.lockedFacts = derivePptLockedFacts(next);
        next.contentState = { status: "approved", approvedAt };
        return next;
    });
    return { brief, pageSpecs };
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
    const issues: Array<{ code: "content_spec_not_approved" | "unresolved_information_gap" | "invalid_content_provenance" | "invalid_content_structure" | "invalid_visual_encoding"; message: string }> = [];
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
        blockIds.some((id) => !id.trim()) ||
        new Set(blockIds).size !== blockIds.length
    ) {
        issues.push({ code: "invalid_content_structure", message: "页面必须包含唯一标题、唯一核心信息、页面目的与有效内容结构" });
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
            ((sourceRef.source === "material" || sourceRef.source === "requirements") && (!Number.isInteger(sourceRef.startLine) || !Number.isInteger(sourceRef.endLine) || sourceRef.startLine! < 1 || sourceRef.endLine! < sourceRef.startLine!)),
    );
    const invalidBlockSource = pageSpec.contentBlocks.some((block) => {
        if (block.kind === "placeholder") return false;
        const refs = block.sourceRefIds.map((id) => sourceById.get(id));
        return !refs.length || refs.some((sourceRef) => !sourceRef) || !sourceSupportsText(refs.map((sourceRef) => sourceRef!.excerpt).join("\n"), block.text);
    });
    if (duplicateSources || invalidSource || invalidBlockSource) {
        issues.push({ code: "invalid_content_provenance", message: "页面内容存在缺失或无效的来源" });
    }
    if (sourceContext && validatePptPageSourceRefs(pageSpec, sourceContext).length) issues.push({ code: "invalid_content_provenance", message: "页面来源已与当前原始材料或补充要求脱节" });
    if (JSON.stringify(pageSpec.lockedFacts) !== JSON.stringify(derivePptLockedFacts(pageSpec))) issues.push({ code: "invalid_content_provenance", message: "页面锁定事实与内容块派生结果不一致" });
    if (pageSpec.layoutIntent.some((intent) => !isPptLayoutIntentSupported(pageSpec, intent))) issues.push({ code: "invalid_content_structure", message: "页面排版要求包含未经批准的文案或事实" });
    const contentById = new Map(pageSpec.contentBlocks.map((block) => [block.id, block]));
    const encodingIds = pageSpec.visualEncoding.map((encoding) => encoding.id);
    if (encodingIds.some((id) => !id.trim()) || new Set(encodingIds).size !== encodingIds.length) issues.push({ code: "invalid_visual_encoding", message: "功能性视觉编码身份缺失或重复" });
    for (const encoding of pageSpec.visualEncoding) {
        const runtimeEncoding = encoding as CanvasProjectPptVisualEncoding & Record<string, unknown>;
        const visibleText = ["text", "label", "copy", "caption"].some((key) => typeof runtimeEncoding[key] === "string" && String(runtimeEncoding[key]).trim());
        const validIds = ENCODING_INTENTS.has(encoding.intent) && ENCODING_CHANNELS.has(encoding.channel) && encoding.contentBlockIds.length > 0 && encoding.contentBlockIds.every((id) => contentById.has(id) && contentById.get(id)?.kind !== "placeholder");
        const validMapping = (encoding.lockedMapping || []).every((mapping) => {
            const block = contentById.get(mapping.contentBlockId);
            return (
                Boolean(block) &&
                encoding.contentBlockIds.includes(mapping.contentBlockId) &&
                sourceSupportsText(block!.text, mapping.token) &&
                mapping.sourceRefIds.length > 0 &&
                mapping.sourceRefIds.every((id) => block!.sourceRefIds.includes(id) && sourceById.has(id)) &&
                sourceSupportsText(mapping.sourceRefIds.map((id) => sourceById.get(id)!.excerpt).join("\n"), mapping.token)
            );
        });
        if (visibleText || !validIds || !validMapping) issues.push({ code: "invalid_visual_encoding", message: "功能性视觉编码引用了未批准内容、无效来源或新增文案" });
    }
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
    const layout = stripDeckStyleSignals(intent);
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
                .replace(/\bPPT\b/gi, "")
                .replace(LAYOUT_CONTENT_COUNT_PATTERN, "")
                .replace(LAYOUT_GEOMETRY_COUNT_PATTERN, "")
                .replace(LAYOUT_GEOMETRY_PATTERN, "")
                .replace(/[()[\]{}（）【】]/g, ""),
        )
        .flatMap((clause) => clause.split(/[、/]/))
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

function normalizePage(rawPage: RawPage, index: number, sourceInput: PptContentSourceInput, gaps: PptInformationGap[]): CanvasProjectPptPageSpec {
    const pageId = sourceInput.previousPageSpecs?.[index]?.pageId || nanoid();
    const rawGaps = Array.isArray(rawPage.gaps) ? (rawPage.gaps as RawGap[]) : [];
    const gapByKey = new Map<string, PptInformationGap>();
    for (const [gapIndex, rawGap] of rawGaps.entries()) {
        const key = text(rawGap.key) || `gap-${gapIndex + 1}`;
        if (gapByKey.has(key)) throw new Error(`信息缺口 key 重复：${key}`);
        const gap: PptInformationGap = {
            id: `${pageId}:gap:${gapIndex + 1}-${stableKey(key)}`,
            pageId,
            kind: isGapKind(rawGap.kind) ? rawGap.kind : "missing_detail",
            question: text(rawGap.question) || "请补充本页所需信息",
            reason: text(rawGap.reason) || "当前材料不足以支持本页生成",
            blocking: rawGap.blocking !== false,
            ...(text(rawGap.proposedAnswer) ? { proposedAnswer: text(rawGap.proposedAnswer) } : {}),
        };
        gapByKey.set(key, gap);
        gaps.push(gap);
    }
    const sourceRefs: CanvasProjectPptSourceRef[] = [];
    const blockByKey = new Map<string, CanvasProjectPptContentBlock>();
    const addBlock = (key: string, identity: string, kind: CanvasProjectPptContentBlock["kind"], value: string, rawSource?: RawSourceRange, gapKey?: string) => {
        if (blockByKey.has(key)) throw new Error(`页面内容 key 重复：${key}`);
        const blockId = `${pageId}:block:${identity}`;
        const sourceRef = resolveSourceRef(pageId, key, value, rawSource, sourceInput);
        if (sourceRef) sourceRefs.push(sourceRef);
        let gap = gapKey ? gapByKey.get(gapKey) : undefined;
        if (!sourceRef && kind !== "placeholder" && !gap) {
            const generatedKey = `source-${key}`;
            gap = {
                id: `${pageId}:gap:${generatedKey === "source-title" || generatedKey === "source-primary_claim" ? generatedKey : `source-${identity}`}`,
                pageId,
                kind: "unsupported_claim",
                question: `请确认或补充：${value || "本页内容"}`,
                reason: rawSource ? "引用范围无效或与内容无关" : "该内容无法从原始输入中定位",
                blocking: true,
                ...(value ? { proposedAnswer: value } : {}),
            };
            gapByKey.set(generatedKey, gap);
            gaps.push(gap);
        }
        const block: CanvasProjectPptContentBlock = {
            id: blockId,
            kind,
            text: value,
            sourceRefIds: sourceRef ? [sourceRef.id] : [],
            ...(gap ? { gapId: gap.id } : {}),
        };
        blockByKey.set(key, block);
        return block;
    };
    const blocks: CanvasProjectPptContentBlock[] = [
        addBlock("title", "title", "title", text(rawPage.title) || `第${index + 1}页`, rawPage.titleSource),
        addBlock("primary_claim", "primary_claim", "primary_claim", text(rawPage.primaryClaim), rawPage.primaryClaimSource),
    ];
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
        version: sourceInput.previousPageSpecs?.[index]?.version || 1,
        purpose: text(rawPage.purpose),
        contentForm: isContentForm(rawPage.contentForm) ? rawPage.contentForm : "narrative",
        ...(text(rawPage.contentFormNote) ? { contentFormNote: text(rawPage.contentFormNote) } : {}),
        sourceRefs,
        contentBlocks: blocks,
        contentState: contentStateFor(pageGaps),
        lockedFacts: [],
        layoutRole: layoutRoleFor(rawPage.contentForm, index),
        layoutIntent: unique(stringArray(rawPage.layoutIntent)),
        visualEncoding,
        assetRefs: unique(blocks.flatMap((block) => [...block.text.matchAll(/@\[node:([^\]]+)\]/g)].map((match) => match[1]))),
        freedom: "不得新增或改写可见文案、数字、组件、参数、型号、成本或结论；只允许在已批准内容内优化视觉组织",
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
    const source = raw?.source;
    if (source !== "material" && source !== "requirements") return undefined;
    const startLine = Number(raw?.startLine);
    const endLine = Number(raw?.endLine);
    const sourceText = source === "material" ? sourceInput.sourceMaterial : sourceInput.requirements;
    const lines = sourceText.split("\n");
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) return undefined;
    const excerpt = lines.slice(startLine - 1, endLine).join("\n");
    if (!sourceSupportsText(excerpt, value)) return undefined;
    return { id: `${pageId}:source:${stableKey(key)}:${source}:${startLine}-${endLine}`, source, excerpt, startLine, endLine } satisfies CanvasProjectPptSourceRef;
}

function deriveAuditIssues(brief: PptContentBrief, pageSpecs: CanvasProjectPptPageSpec[], gaps: PptInformationGap[]) {
    const issues: PptContentAuditIssue[] = [];
    if (!brief.audience.trim() || !brief.goal.trim() || !brief.narrative.trim()) {
        issues.push({ id: "issue:brief:incomplete", code: "invalid_content_structure", severity: "blocking", pageIds: [], message: "整套材料缺少受众、目标或叙事主线", actions: [] });
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
            issues.push({
                id: `issue:${page.pageId}:${issue.code}:${issues.length + 1}`,
                code: issue.code,
                severity: "blocking",
                pageIds: [page.pageId],
                message: issue.message,
                actions: [{ kind: "regenerate_pages", pageIds: [page.pageId] }],
            });
        }
        for (const block of page.contentBlocks) {
            if (/^[A-Za-z]\s*(?:对比|列表)/.test(block.text)) {
                issues.push({ id: `issue:${page.pageId}:noise:${block.id}`, code: "noise_text", severity: "warning", pageIds: [page.pageId], message: `可能的异常文本：${block.text}`, actions: [{ kind: "regenerate_pages", pageIds: [page.pageId] }] });
            }
        }
        for (const value of page.layoutIntent) {
            const signals = extractDeckStyleSignals(value);
            if (!signals.length) continue;
            const replacement = stripDeckStyleSignals(value);
            const id = `issue:${page.pageId}:style:${stableKey(value)}`;
            issues.push({
                id,
                code: "deck_style_signal",
                severity: "warning",
                pageIds: [page.pageId],
                message: `整套审美描述应留到视觉方向阶段：${value}`,
                actions: [{ kind: "preview_safe_patch", issueId: id }],
                repair: { kind: "route_deck_style", pageId: page.pageId, value, replacement, signals },
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
    const unresolved = draft.audit.gaps.filter((gap) => !gap.resolution && gap.blocking);
    const pageSpecs = draft.pageSpecs.map((page) => ({ ...page, contentState: contentStateFor(unresolved.filter((gap) => gap.pageId === page.pageId)), lockedFacts: derivePptLockedFacts(page) }));
    const audit = { gaps: draft.audit.gaps, issues: deriveAuditIssues(draft.brief, pageSpecs, draft.audit.gaps) };
    return { ...draft, pageSpecs, audit };
}

function contentStateFor(gaps: PptInformationGap[]) {
    const gapIds = gaps.filter((gap) => gap.blocking && !gap.resolution).map((gap) => gap.id);
    return gapIds.length ? ({ status: "blocked", gapIds } as const) : ({ status: "reviewable" } as const);
}

function sameTopic(left: CanvasProjectPptPageSpec, right: CanvasProjectPptPageSpec) {
    const leftText = `${left.purpose} ${renderPptPageSpecText(left)}`;
    const rightText = `${right.purpose} ${renderPptPageSpecText(right)}`;
    const keywords = ["组件", "选型", "对比", "资源", "投入", "成本", "架构", "合作", "规划", "未来"];
    const shared = keywords.filter((keyword) => leftText.includes(keyword) && rightText.includes(keyword));
    return shared.length >= 2 || normalize(leftText) === normalize(rightText);
}

function sourceSupportsText(source: string, value: string) {
    const normalizedValue = normalize(value);
    if (!normalizedValue) return false;
    if (!normalize(source).includes(normalizedValue)) return false;
    const facts = [...value.matchAll(NUMBER_PATTERN), ...value.matchAll(ASCII_TERM_PATTERN)].map((match) => match[0].trim()).filter(Boolean);
    return facts.every((fact) => normalize(source).includes(normalize(fact)));
}

function extractDeckStyleSignals(value: string) {
    return unique([...value.matchAll(DECK_STYLE_FRAGMENT_PATTERN)].map((match) => match[0]));
}

function stripDeckStyleSignals(value: string) {
    return value
        .replace(DECK_STYLE_FRAGMENT_PATTERN, "")
        .replace(/^[\s·・，,。；;、]+|[\s·・，,。；;、]+$/g, "")
        .replace(/(?:[\s]*[·・，,。；;、][\s]*){2,}/g, " · ")
        .trim();
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

function layoutRoleFor(raw: unknown, index: number): PptLayoutRole {
    if (raw === "cover" || index === 0) return "cover";
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
