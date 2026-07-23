import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let derivePptPageDuty;
let aggregatePptSourceRefs;
let vite;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ derivePptPageDuty, aggregatePptSourceRefs } = await vite.ssrLoadModule("/src/lib/ppt/duty-dashboard.ts"));
});

after(async () => {
    await vite?.close();
});

// --- 封面 ---

test("封面：定位语与无多余承载都满足时两项均为 ok", () => {
    const items = derivePptPageDuty(coverPage(), [], []);
    assert.deepEqual(items, [
        { label: "定位语", state: "ok" },
        { label: "无多余承载", state: "ok" },
    ]);
});

test("封面：核心信息缺口未解决且有多余正文块时两项均为中性待办态", () => {
    const page = coverPage({
        contentBlocks: [
            { id: "title", kind: "title", text: "标题", sourceRefIds: [] },
            { id: "claim", kind: "primary_claim", text: "", sourceRefIds: [], gapId: "g-claim" },
            { id: "extra", kind: "body", text: "多余正文", sourceRefIds: [] },
        ],
    });
    const gaps = [gap("g-claim", "page-1")];
    const items = derivePptPageDuty(page, gaps, []);
    assert.deepEqual(items, [
        { label: "定位语", state: "pending", detail: "定位语待补充" },
        { label: "无多余承载", state: "pending", detail: "1 处待处理" },
    ]);
});

test("封面：核心信息疑似目标清单、未承接偏离前显示待确认", () => {
    const page = coverPage({
        contentBlocks: [
            { id: "title", kind: "title", text: "标题", sourceRefIds: [] },
            { id: "claim", kind: "primary_claim", text: "为什么需要、好在哪里", sourceRefIds: [] },
        ],
    });
    const issues = [{ id: "i1", code: "principle_question", severity: "blocking", pageIds: ["page-1"], message: "封面核心信息应是一句定位语", field: "primaryClaim", actions: [] }];
    const items = derivePptPageDuty(page, [], issues);
    assert.deepEqual(items[0], { label: "定位语", state: "pending", detail: "定位语待确认" });
});

test("封面：已承接理念偏离时两项均显示按你的设计保留，不再是 pending", () => {
    const page = coverPage({
        principleDeviations: [
            { principle: "cover-claim-checklist", acknowledgedAt: "2026-07-23T00:00:00.000Z" },
            { principle: "cover-extra-content", acknowledgedAt: "2026-07-23T00:00:00.000Z" },
        ],
        contentBlocks: [
            { id: "title", kind: "title", text: "标题", sourceRefIds: [] },
            { id: "claim", kind: "primary_claim", text: "目标一、目标二、目标三", sourceRefIds: [] },
            { id: "extra", kind: "body", text: "多余正文", sourceRefIds: [] },
        ],
    });
    const issues = [
        { id: "i1", code: "principle_question", severity: "blocking", pageIds: ["page-1"], message: "...", field: "primaryClaim", actions: [] },
        { id: "i2", code: "principle_question", severity: "blocking", pageIds: ["page-1"], message: "...", field: "contentForm", actions: [] },
    ];
    const items = derivePptPageDuty(page, [], issues);
    assert.deepEqual(items, [
        { label: "定位语", state: "deviated", detail: "按你的设计保留" },
        { label: "无多余承载", state: "deviated", detail: "按你的设计保留" },
    ]);
});

// --- 章节 ---

test("章节页：结构检查通过时章节转场为 ok", () => {
    const items = derivePptPageDuty(sectionPage(), [], []);
    assert.deepEqual(items, [{ label: "章节转场", state: "ok" }]);
});

test("章节页：存在结构问题时章节转场为中性待办态，不是判决语气", () => {
    const issues = [{ id: "i1", code: "invalid_content_structure", severity: "blocking", pageIds: ["page-2"], message: "...", actions: [] }];
    const items = derivePptPageDuty(sectionPage(), [], issues);
    assert.deepEqual(items, [{ label: "章节转场", state: "pending", detail: "章节转场待处理" }]);
});

// --- 内容页（narrative/comparison/process/timeline/data/architecture） ---

test("内容页：核心信息非空、来源齐全时三项分别为 ok/支撑计数/ok", () => {
    const items = derivePptPageDuty(contentPage(), [], []);
    assert.deepEqual(items, [
        { label: "核心信息", state: "ok" },
        { label: "支撑 1 条", state: "ok" },
        { label: "来源齐", state: "ok" },
    ]);
});

test("内容页：核心信息缺口未解决时显示待补充；支撑计数恒为 ok 的纯陈述", () => {
    const page = contentPage({
        contentBlocks: [
            { id: "title", kind: "title", text: "标题", sourceRefIds: [] },
            { id: "claim", kind: "primary_claim", text: "", sourceRefIds: [], gapId: "g-claim" },
        ],
    });
    const items = derivePptPageDuty(page, [gap("g-claim", "page-3")], []);
    assert.deepEqual(items[0], { label: "核心信息", state: "pending", detail: "核心信息待补充" });
    assert.deepEqual(items[1], { label: "支撑 0 条", state: "ok" });
});

test("内容页：存在未解决来源缺口时来源齐显示 M/N 覆盖比例", () => {
    const page = contentPage({
        contentBlocks: [
            { id: "title", kind: "title", text: "标题", sourceRefIds: [] },
            { id: "claim", kind: "primary_claim", text: "核心结论", sourceRefIds: ["src-1"] },
            { id: "s1", kind: "supporting_claim", text: "支撑二", sourceRefIds: [], gapId: "g-evidence" },
        ],
    });
    const gaps = [{ id: "g-evidence", pageId: "page-3", kind: "missing_evidence", question: "?", reason: "r", blocking: true }];
    const items = derivePptPageDuty(page, gaps, []);
    assert.deepEqual(items[2], { label: "来源齐", state: "pending", detail: "来源 1/2" });
});

test("内容页：存在来源相关的内容检查问题时来源齐进入待办态，即使块本身已挂来源", () => {
    const issues = [{ id: "i1", code: "invalid_content_provenance", severity: "blocking", pageIds: ["page-3"], message: "...", actions: [] }];
    const items = derivePptPageDuty(contentPage(), [], issues);
    assert.deepEqual(items[2], { label: "来源齐", state: "pending", detail: "来源 2/2" });
});

// --- 收尾 ---

test("收尾页：结构检查通过时两项均为 ok", () => {
    const items = derivePptPageDuty(closingPage(), [], []);
    assert.deepEqual(items, [
        { label: "收束信息", state: "ok" },
        { label: "无新增正文", state: "ok" },
    ]);
});

test("收尾页：存在未解决阻断缺口时两项共享同一个中性待办态", () => {
    const gaps = [gap("g1", "page-4")];
    const items = derivePptPageDuty(closingPage(), gaps, []);
    assert.deepEqual(items, [
        { label: "收束信息", state: "pending", detail: "收束信息待处理" },
        { label: "无新增正文", state: "pending", detail: "无新增正文待处理" },
    ]);
});

// --- 来源聚合 ---

test("来源聚合：同区间多块引用聚合为一条并统计支撑块数", () => {
    const page = {
        sourceRefs: [
            { id: "src-a", source: "material", relation: "verbatim", excerpt: "共享原文片段", startLine: 3, endLine: 3 },
            { id: "src-b", source: "material", relation: "verbatim", excerpt: "共享原文片段", startLine: 3, endLine: 3 },
        ],
        contentBlocks: [
            { id: "block-1", kind: "supporting_claim", text: "共享原文片段", sourceRefIds: ["src-a"] },
            { id: "block-2", kind: "supporting_claim", text: "共享原文片段", sourceRefIds: ["src-b"] },
        ],
    };
    const aggregated = aggregatePptSourceRefs(page);
    assert.equal(aggregated.length, 1);
    assert.equal(aggregated[0].supportedBlockCount, 2);
    assert.equal(aggregated[0].excerpt, "共享原文片段");
    assert.equal(aggregated[0].startLine, 3);
});

test("来源聚合：无行号来源（confirmed_assumption/user_answer）按摘要聚合", () => {
    const page = {
        sourceRefs: [
            { id: "src-a", source: "confirmed_assumption", relation: "verbatim", excerpt: "用户已确认的补充" },
            { id: "src-b", source: "confirmed_assumption", relation: "verbatim", excerpt: "用户已确认的补充" },
        ],
        contentBlocks: [
            { id: "block-1", kind: "body", text: "用户已确认的补充", sourceRefIds: ["src-a"] },
            { id: "block-2", kind: "body", text: "用户已确认的补充", sourceRefIds: ["src-b"] },
        ],
    };
    const aggregated = aggregatePptSourceRefs(page);
    assert.equal(aggregated.length, 1);
    assert.equal(aggregated[0].supportedBlockCount, 2);
    assert.equal(aggregated[0].startLine, undefined);
    assert.equal(aggregated[0].endLine, undefined);
});

test("来源聚合：不同区间或摘要保持独立条目，各自的支撑块数不互相污染", () => {
    const page = {
        sourceRefs: [
            { id: "src-a", source: "material", relation: "verbatim", excerpt: "第一段", startLine: 1, endLine: 1 },
            { id: "src-b", source: "material", relation: "verbatim", excerpt: "第二段", startLine: 2, endLine: 2 },
        ],
        contentBlocks: [
            { id: "block-1", kind: "supporting_claim", text: "第一段", sourceRefIds: ["src-a"] },
            { id: "block-2", kind: "supporting_claim", text: "第二段", sourceRefIds: ["src-b"] },
        ],
    };
    const aggregated = aggregatePptSourceRefs(page);
    assert.equal(aggregated.length, 2);
    assert.equal(aggregated[0].supportedBlockCount, 1);
    assert.equal(aggregated[1].supportedBlockCount, 1);
});

// --- fixtures ---

function coverPage(overrides = {}) {
    return {
        pageId: "page-1",
        contentForm: "cover",
        layoutRole: "cover",
        sourceRefs: [],
        contentBlocks: [
            { id: "title", kind: "title", text: "标题", sourceRefIds: [] },
            { id: "claim", kind: "primary_claim", text: "一句定位语", sourceRefIds: [] },
        ],
        ...overrides,
    };
}

function sectionPage(overrides = {}) {
    return {
        pageId: "page-2",
        contentForm: "narrative",
        layoutRole: "section",
        sourceRefs: [],
        contentBlocks: [
            { id: "title", kind: "title", text: "第二章", sourceRefIds: [] },
            { id: "claim", kind: "primary_claim", text: "从问题到方案", sourceRefIds: [] },
        ],
        ...overrides,
    };
}

function contentPage(overrides = {}) {
    return {
        pageId: "page-3",
        contentForm: "narrative",
        layoutRole: "content",
        sourceRefs: [{ id: "src-1", source: "material", relation: "verbatim", excerpt: "支撑一", startLine: 1, endLine: 1 }],
        contentBlocks: [
            { id: "title", kind: "title", text: "标题", sourceRefIds: [] },
            { id: "claim", kind: "primary_claim", text: "核心结论", sourceRefIds: ["src-1"] },
            { id: "s1", kind: "supporting_claim", text: "支撑一", sourceRefIds: ["src-1"] },
        ],
        ...overrides,
    };
}

function closingPage(overrides = {}) {
    return {
        pageId: "page-4",
        contentForm: "closing",
        layoutRole: "close",
        sourceRefs: [],
        contentBlocks: [
            { id: "title", kind: "title", text: "结语", sourceRefIds: [] },
            { id: "claim", kind: "primary_claim", text: "回到核心结论", sourceRefIds: [] },
        ],
        ...overrides,
    };
}

function gap(id, pageId) {
    return { id, pageId, kind: "missing_detail", question: "请补充", reason: "测试原因", blocking: true };
}
