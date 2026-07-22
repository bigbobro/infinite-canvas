import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let PptContentPlanStep;
let vite;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ PptContentPlanStep } = await vite.ssrLoadModule("/src/pages/ppt/components/ppt-content-plan-step.tsx"));
});

after(async () => {
    await vite?.close();
});

test("页面只把未解决项放在信息缺口，已解决项默认折叠保留", () => {
    const html = renderPlan([gap("page-open", "还需要确认什么？", { pageId: "page-1" }), gap("page-resolved", "已经补充了什么？", { pageId: "page-1", resolution: { kind: "user_answer", text: "已补充内容", resolvedAt: "2026-07-23T00:00:00.000Z" } })]);
    const gapSection = sectionStartingAt(html, "信息缺口");

    assert.match(html, /叙事 · 1 项待决定/);
    assert.match(gapSection, /ppt-gap-page-open/);
    assert.doesNotMatch(gapSection, /ppt-gap-page-resolved/);
    assert.match(html, /已确认补充/);
    assert.match(html, /ppt-gap-page-resolved/);
    assert.equal(detailsOpeningTag(html, "已确认补充").includes(" open"), false);
});

test("只有已解决记录时不再显示仍需确认语义", () => {
    const html = renderPlan([
        gap("page-resolved", "页面已确认项", { pageId: "page-1", resolution: { kind: "confirmed_assumption", text: "已确认建议", resolvedAt: "2026-07-23T00:00:00.000Z" } }),
        gap("deck-resolved", "整套已确认项", { resolution: { kind: "omit", resolvedAt: "2026-07-23T00:00:00.000Z" } }),
    ]);

    assert.match(html, /叙事 · 可确认/);
    assert.doesNotMatch(html, />信息缺口</);
    assert.doesNotMatch(html, /整套材料仍需确认/);
    assert.equal(html.match(/已确认补充/g)?.length, 2);
    assert.match(html, /ppt-gap-page-resolved/);
    assert.match(html, /ppt-gap-deck-resolved/);
});

test("SHA-19/21：内容检查按钮按问题显示压缩本页或修复封面", () => {
    const html = renderPlan([], {
        issues: [issue("excessive", "excessive_copy", "单页文案共 374 字，请压缩内容或拆页后再生成"), issue("cover", "invalid_cover", "第一页应承担封面职责，只保留标题和一句定位语"), issue("other", "noise_text", "可能的异常文本")],
    });
    assert.match(html, /压缩本页/);
    assert.match(html, /修复封面/);
    assert.match(html, /修复本页/);
    assert.doesNotMatch(html, /重新生成本页/);
});

test("SHA-25：块已绑定未解决 gap 且无来源时只显示信息缺口，不并列来源待确认", () => {
    const html = renderPlan([gap("g-list", "请补充本页列表内容", { pageId: "page-1" })], {
        contentBlocks: [
            { id: "title", kind: "title", text: "测试页", sourceRefIds: [] },
            { id: "claim", kind: "primary_claim", text: "核心信息", sourceRefIds: ["src-claim"] },
            { id: "list", kind: "placeholder", text: "待补充", sourceRefIds: [], gapId: "g-list" },
        ],
        sourceRefs: [{ id: "src-claim", source: "material", relation: "verbatim", excerpt: "核心信息", startLine: 1, endLine: 1 }],
    });
    const gapSection = sectionStartingAt(html, "信息缺口");
    assert.match(gapSection, /请补充本页列表内容/);
    assert.match(gapSection, /ppt-gap-g-list/);
    assert.doesNotMatch(html, /来源待确认/);
    assert.doesNotMatch(html, /等待你补充/);
});

test("SHA-26：derived 来源标签显示基于材料归纳", () => {
    const html = renderPlan([], {
        contentBlocks: [
            { id: "title", kind: "title", text: "测试页", sourceRefIds: ["src-title"] },
            { id: "claim", kind: "primary_claim", text: "归纳后的核心信息", sourceRefIds: ["src-claim"] },
            { id: "body", kind: "body", text: "归纳后的补充要求", sourceRefIds: ["src-requirements"] },
        ],
        sourceRefs: [
            { id: "src-title", source: "material", relation: "verbatim", excerpt: "测试页", startLine: 1, endLine: 1 },
            { id: "src-claim", source: "material", relation: "derived", excerpt: "原文核心表述", startLine: 2, endLine: 3 },
            { id: "src-requirements", source: "requirements", relation: "derived", excerpt: "补充要求原文", startLine: 4, endLine: 4 },
        ],
    });
    assert.match(html, /基于材料 L2–3 归纳/);
    assert.match(html, /基于补充要求 L4 归纳/);
    assert.match(html, /材料 L1/);
    assert.doesNotMatch(html, /材料 L2–3(?! 归纳)/);
});

test("SHA-26：proposedAnswer 与已显示 block 相同时不渲染第二份 AI 建议，并提供确认当前内容", () => {
    const claim = "解决从材料到可交付 PPT 的关键工作";
    const html = renderPlan([gap("g-claim", "请确认本页核心信息中的新增表述", { pageId: "page-1", kind: "unsupported_claim", reason: "该表述引入了原材料未支持的事实或结论", proposedAnswer: claim })], {
        contentBlocks: [
            { id: "title", kind: "title", text: "测试页", sourceRefIds: [] },
            { id: "claim", kind: "primary_claim", text: claim, sourceRefIds: [], gapId: "g-claim" },
        ],
    });
    const gapSection = sectionStartingAt(html, "信息缺口");
    assert.match(gapSection, /请确认本页核心信息中的新增表述/);
    assert.match(gapSection, /确认采用当前内容/);
    assert.doesNotMatch(gapSection, /AI 建议，尚未采纳/);
    assert.doesNotMatch(gapSection, /采纳 AI 建议/);
});

test("SHA-26：没有 proposedAnswer 的占位缺口不能确认当前占位内容", () => {
    const html = renderPlan([gap("g-missing", "请补充本页列表内容", { pageId: "page-1" })], {
        contentBlocks: [
            { id: "title", kind: "title", text: "测试页", sourceRefIds: [] },
            { id: "claim", kind: "primary_claim", text: "核心信息", sourceRefIds: [] },
            { id: "list", kind: "placeholder", text: "待补充", sourceRefIds: [], gapId: "g-missing" },
        ],
    });
    const gapSection = sectionStartingAt(html, "信息缺口");
    assert.match(gapSection, /让 AI 给建议/);
    assert.doesNotMatch(gapSection, /确认采用当前内容/);
});

test("SHA-20：页级修复可见 loading、success、error 终态且进行中禁用重复提交", () => {
    const loading = renderPlan([], {
        pageRequest: { pageId: "page-1", loading: true, status: "loading", error: "", successMessage: "" },
        issues: [issue("excessive", "excessive_copy", "单页文案过长")],
    });
    assert.match(loading, /正在修复本页|取消本页生成/);
    assert.match(loading, /disabled|aria-disabled|loading/);

    const success = renderPlan([], {
        pageRequest: { pageId: "page-1", loading: false, status: "success", error: "", successMessage: "本页已更新" },
    });
    assert.match(success, /本页已更新/);

    const failed = renderPlan([], {
        pageRequest: {
            pageId: "page-1",
            loading: false,
            status: "error",
            error: "本页重新生成后问题仍未解决：单页文案共 374 字；原页已保留",
            successMessage: "",
        },
    });
    assert.match(failed, /本页重新生成失败|问题仍未解决/);
    assert.match(failed, /原页/);
});

function renderPlan(gaps, overrides = {}) {
    const planning = createPlanning(gaps, overrides);
    return renderToStaticMarkup(React.createElement(PptContentPlanStep, { planning, onBack() {}, onConfirmed() {} }));
}

function createPlanning(gaps, overrides = {}) {
    const noop = () => {};
    return {
        draft: {
            revision: 1,
            pageSpecs: [
                {
                    pageId: "page-1",
                    purpose: "说明用途",
                    contentForm: overrides.contentForm || "narrative",
                    layoutIntent: [],
                    visualEncoding: [],
                    sourceRefs: overrides.sourceRefs || [],
                    contentBlocks: overrides.contentBlocks || [
                        { id: "title", kind: "title", text: "测试页", sourceRefIds: [] },
                        { id: "claim", kind: "primary_claim", text: "核心信息", sourceRefIds: [] },
                    ],
                },
            ],
            audit: { issues: overrides.issues || [], gaps },
        },
        validation: { valid: false, issues: [] },
        loading: Boolean(overrides.pageRequest?.loading),
        error: "",
        repairPreview: null,
        input: { sourceMaterial: "测试材料" },
        receivedCharacters: 0,
        streamProgress: { completedPages: [] },
        pageRequest: overrides.pageRequest || { pageId: null, loading: false, status: "idle", error: "", successMessage: "" },
        cancel: noop,
        clearError: noop,
        generate: async () => {},
        previewRepair: noop,
        finalize: noop,
        reorderPages: noop,
        regeneratePage: async () => {},
        acceptPageSuggestions: noop,
        mergePages: noop,
        removePage: noop,
        editBlock: noop,
        editPurpose: noop,
        resolveGap: noop,
        dismissRepair: noop,
        applyRepair: noop,
    };
}

function issue(id, code, message) {
    return {
        id: `issue-${id}`,
        code,
        severity: code === "invalid_cover" ? "blocking" : "warning",
        pageIds: ["page-1"],
        message,
        actions: [{ kind: "regenerate_pages", pageIds: ["page-1"] }],
    };
}

function gap(id, question, overrides = {}) {
    return { id, kind: "missing_detail", question, reason: "测试原因", blocking: true, ...overrides };
}

function sectionStartingAt(html, label) {
    const labelIndex = html.indexOf(label);
    assert.notEqual(labelIndex, -1);
    const start = html.lastIndexOf("<section", labelIndex);
    const end = html.indexOf("</section>", labelIndex);
    return html.slice(start, end + "</section>".length);
}

function detailsOpeningTag(html, label) {
    const labelIndex = html.indexOf(label);
    assert.notEqual(labelIndex, -1);
    const start = html.lastIndexOf("<details", labelIndex);
    return html.slice(start, html.indexOf(">", start) + 1);
}
