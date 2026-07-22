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

function renderPlan(gaps) {
    const planning = createPlanning(gaps);
    return renderToStaticMarkup(React.createElement(PptContentPlanStep, { planning, onBack() {}, onConfirmed() {} }));
}

function createPlanning(gaps) {
    const noop = () => {};
    return {
        draft: {
            revision: 1,
            pageSpecs: [
                {
                    pageId: "page-1",
                    purpose: "说明用途",
                    contentForm: "narrative",
                    layoutIntent: [],
                    visualEncoding: [],
                    sourceRefs: [],
                    contentBlocks: [
                        { id: "title", kind: "title", text: "测试页", sourceRefIds: [] },
                        { id: "claim", kind: "primary_claim", text: "核心信息", sourceRefIds: [] },
                    ],
                },
            ],
            audit: { issues: [], gaps },
        },
        validation: { valid: false, issues: [] },
        loading: false,
        error: "",
        repairPreview: null,
        input: { sourceMaterial: "测试材料" },
        receivedCharacters: 0,
        streamProgress: { completedPages: [] },
        pageRequest: { pageId: null, loading: false, error: "" },
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
