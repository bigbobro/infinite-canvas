import type { PptContentAuditIssue, PptInformationGap } from "@/lib/ppt/content-plan";
import type { CanvasProjectPptPageSpec, CanvasProjectPptSourceRef, PptPrincipleDeviation } from "@/stores/canvas/use-canvas-store";

/**
 * SHA-30d：职责仪表——把「这页对不对」的理念从报错文案搬进页面骨架，正向展示。
 * 派生函数是校验结果的投影，不重复实现任何校验判断：ok/pending/deviated 只读取已有的
 * gaps（页面级过滤后）、issues（页面级过滤后）与 pageSpec.principleDeviations。
 * 仪表本身永不出现红色/判决语气——不满足项一律是中性的 "pending"，不是 "blocking"。
 */
export type PptPageDutyItem = { label: string; state: "ok" | "pending" | "deviated"; detail?: string };

export function derivePptPageDuty(pageSpec: CanvasProjectPptPageSpec, gaps: PptInformationGap[], issues: PptContentAuditIssue[]): PptPageDutyItem[] {
    const category = categorizePptPage(pageSpec);
    if (category === "cover") return [coverClaimDutyItem(pageSpec, gaps, issues), coverExtraContentDutyItem(pageSpec)];
    if (category === "section") return [sectionTransitionDutyItem(pageSpec, gaps, issues)];
    if (category === "closing") return closingDutyItems(pageSpec, gaps, issues);
    return [contentCoreClaimDutyItem(pageSpec, gaps), contentSupportingCountDutyItem(pageSpec), contentSourceCoverageDutyItem(pageSpec, gaps, issues)];
}

type PptPageDutyCategory = "cover" | "section" | "content" | "closing";

function categorizePptPage(pageSpec: Pick<CanvasProjectPptPageSpec, "layoutRole" | "contentForm">): PptPageDutyCategory {
    if (pageSpec.layoutRole === "section") return "section";
    if (pageSpec.contentForm === "cover") return "cover";
    if (pageSpec.contentForm === "closing") return "closing";
    return "content";
}

function hasDeviation(pageSpec: Pick<CanvasProjectPptPageSpec, "principleDeviations">, principle: PptPrincipleDeviation["principle"]) {
    return Boolean(pageSpec.principleDeviations?.some((deviation) => deviation.principle === principle));
}

function coverClaimDutyItem(pageSpec: CanvasProjectPptPageSpec, gaps: PptInformationGap[], issues: PptContentAuditIssue[]): PptPageDutyItem {
    const label = "定位语";
    if (hasDeviation(pageSpec, "cover-claim-checklist")) return { label, state: "deviated", detail: "按你的设计保留" };
    const claimBlock = pageSpec.contentBlocks.find((block) => block.kind === "primary_claim");
    const claimText = claimBlock?.text.trim() || "";
    const gapUnresolved = Boolean(claimBlock?.gapId) && gaps.some((gap) => gap.id === claimBlock!.gapId && !gap.resolution);
    if (!claimText || gapUnresolved) return { label, state: "pending", detail: "定位语待补充" };
    if (issues.some((issue) => issue.code === "principle_question" && issue.field === "primaryClaim")) return { label, state: "pending", detail: "定位语待确认" };
    return { label, state: "ok" };
}

function coverExtraContentDutyItem(pageSpec: CanvasProjectPptPageSpec): PptPageDutyItem {
    const label = "无多余承载";
    if (hasDeviation(pageSpec, "cover-extra-content")) return { label, state: "deviated", detail: "按你的设计保留" };
    const extraCount = pageSpec.contentBlocks.filter((block) => block.kind !== "title" && block.kind !== "primary_claim").length;
    if (extraCount === 0) return { label, state: "ok" };
    return { label, state: "pending", detail: `${extraCount} 处待处理` };
}

/** 章节/收尾没有理念层的可偏离子项，只有一套「本页结构齐全」的既有检查——ok 判定复用页面级 issues/gaps，不新增判断。 */
function structuralDutyOk(gaps: PptInformationGap[], issues: PptContentAuditIssue[]) {
    return !issues.some((issue) => issue.code === "invalid_content_structure") && !gaps.some((gap) => gap.blocking && !gap.resolution);
}

function sectionTransitionDutyItem(_pageSpec: CanvasProjectPptPageSpec, gaps: PptInformationGap[], issues: PptContentAuditIssue[]): PptPageDutyItem {
    const ok = structuralDutyOk(gaps, issues);
    return ok ? { label: "章节转场", state: "ok" } : { label: "章节转场", state: "pending", detail: "章节转场待处理" };
}

/** 收尾页两项展示同一条结构检查结果——现有校验没有把「收束信息」与「无新增正文」拆成两条独立规则。 */
function closingDutyItems(_pageSpec: CanvasProjectPptPageSpec, gaps: PptInformationGap[], issues: PptContentAuditIssue[]): PptPageDutyItem[] {
    const ok = structuralDutyOk(gaps, issues);
    return [ok ? { label: "收束信息", state: "ok" } : { label: "收束信息", state: "pending", detail: "收束信息待处理" }, ok ? { label: "无新增正文", state: "ok" } : { label: "无新增正文", state: "pending", detail: "无新增正文待处理" }];
}

function contentCoreClaimDutyItem(pageSpec: CanvasProjectPptPageSpec, gaps: PptInformationGap[]): PptPageDutyItem {
    const label = "核心信息";
    const claimBlock = pageSpec.contentBlocks.find((block) => block.kind === "primary_claim");
    const claimText = claimBlock?.text.trim() || "";
    const gapUnresolved = Boolean(claimBlock?.gapId) && gaps.some((gap) => gap.id === claimBlock!.gapId && !gap.resolution);
    if (!claimText || gapUnresolved) return { label, state: "pending", detail: "核心信息待补充" };
    return { label, state: "ok" };
}

/** 纯陈述，不判断内容质量，恒 ok——只报数字。 */
function contentSupportingCountDutyItem(pageSpec: CanvasProjectPptPageSpec): PptPageDutyItem {
    const count = pageSpec.contentBlocks.filter((block) => block.kind !== "title" && block.kind !== "primary_claim").length;
    return { label: `支撑 ${count} 条`, state: "ok" };
}

function contentSourceCoverageDutyItem(pageSpec: CanvasProjectPptPageSpec, gaps: PptInformationGap[], issues: PptContentAuditIssue[]): PptPageDutyItem {
    const label = "来源齐";
    const hasProvenanceGap = gaps.some((gap) => !gap.resolution && gap.kind === "missing_evidence");
    const hasProvenanceIssue = issues.some((issue) => issue.code === "invalid_content_provenance");
    if (!hasProvenanceGap && !hasProvenanceIssue) return { label, state: "ok" };
    const sourceIds = new Set(pageSpec.sourceRefs.map((sourceRef) => sourceRef.id));
    const relevantBlocks = pageSpec.contentBlocks.filter((block) => block.kind !== "title" && block.kind !== "placeholder");
    const total = relevantBlocks.length;
    const covered = relevantBlocks.filter((block) => block.sourceRefIds.length > 0 && block.sourceRefIds.every((id) => sourceIds.has(id))).length;
    return { label, state: "pending", detail: `来源 ${covered}/${total}` };
}

/**
 * SHA-30d：来源依据按 (source, relation, 行号区间, 摘要) 聚合——normalizePage 为每个内容块各自解析来源，
 * 同一区间被多个块引用时会产生多条结构相同的 sourceRef；这里只做展示层合并，不改 pageSpec.sourceRefs 本身。
 * 无行号的来源（confirmed_assumption/user_answer）区间退化为占位符，实际按摘要聚合。
 */
export type PptAggregatedSourceRef = {
    source: CanvasProjectPptSourceRef["source"];
    relation: CanvasProjectPptSourceRef["relation"];
    startLine?: number;
    endLine?: number;
    excerpt: string;
    supportedBlockCount: number;
};

export function aggregatePptSourceRefs(pageSpec: Pick<CanvasProjectPptPageSpec, "sourceRefs" | "contentBlocks">): PptAggregatedSourceRef[] {
    const groups = new Map<string, { ref: CanvasProjectPptSourceRef; refIds: Set<string> }>();
    for (const sourceRef of pageSpec.sourceRefs) {
        const key = `${sourceRef.source}:${sourceRef.relation}:${sourceRef.startLine ?? "-"}-${sourceRef.endLine ?? "-"}:${normalizeExcerpt(sourceRef.excerpt)}`;
        const group = groups.get(key);
        if (group) group.refIds.add(sourceRef.id);
        else groups.set(key, { ref: sourceRef, refIds: new Set([sourceRef.id]) });
    }
    return [...groups.values()].map(({ ref, refIds }) => ({
        source: ref.source,
        relation: ref.relation,
        ...(ref.startLine !== undefined ? { startLine: ref.startLine } : {}),
        ...(ref.endLine !== undefined ? { endLine: ref.endLine } : {}),
        excerpt: ref.excerpt,
        supportedBlockCount: pageSpec.contentBlocks.filter((block) => block.sourceRefIds.some((id) => refIds.has(id))).length,
    }));
}

function normalizeExcerpt(value: string) {
    return value.trim().replace(/\s+/g, " ");
}
