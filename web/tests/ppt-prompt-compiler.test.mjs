import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before } from "node:test";

import { createServer } from "vite";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/ppt-prompt-compiler-8-pages.json", import.meta.url), "utf8"));

let vite;
let buildPptCompilerModel;
let buildPptPageSpec;
let buildPptDeckProject;
let compilePptPromptSnapshot;
let derivePptStyleRules;
let createGenerationPlan;
let assertGenerationPlanCompilation;
let applyGenerationPlanPptOps;
let defaultConfig;
let hasBlockingCompilationIssues;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ buildPptCompilerModel, buildPptPageSpec, compilePptPromptSnapshot, derivePptStyleRules, hasBlockingCompilationIssues } = await vite.ssrLoadModule("/src/lib/ppt/prompt-compiler.ts"));
    ({ buildPptDeckProject } = await vite.ssrLoadModule("/src/lib/ppt/deck-builder.ts"));
    ({ createGenerationPlan, assertGenerationPlanCompilation, applyGenerationPlanPptOps } = await vite.ssrLoadModule("/src/lib/ppt/generation-plan.ts"));
    ({ defaultConfig } = await vite.ssrLoadModule("/src/stores/use-config-store.ts"));
});

after(async () => {
    await vite?.close();
});

test("8 页已有规格按输入顺序建立统一 PageSpec", () => {
    const { deckBrief, pageSpecs } = buildModel();

    assert.deepEqual(
        pageSpecs.map((pageSpec) => pageSpec.pageId),
        fixture.pages.map((page) => page.pageId),
    );
    assert.equal(pageSpecs.length, 8);
    assert.equal(deckBrief.audience, "集团管理层");
    assert.equal(deckBrief.visualLanguage, fixture.styleDescription);
    assert.ok(pageSpecs.every((pageSpec) => pageSpec.sourceRefs[0].source === "imported_spec"));
    assert.ok(pageSpecs.every((pageSpec) => Number.isInteger(pageSpec.sourceRefs[0].startLine)));
});

test("Compiler 保留 5 点、数字术语和页面布局，且基线无阻断", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const snapshot = compilePptPromptSnapshot(snapshotInput(deckBrief, pageSpecs));

    assert.equal(snapshot.prompts.length, 8);
    assert.deepEqual(
        snapshot.prompts.map((prompt) => prompt.pageId),
        fixture.pages.map((page) => page.pageId),
    );
    assert.equal(hasBlockingCompilationIssues(snapshot), false);
    assert.equal(promptFor(snapshot, "page-1").finalPrompt.split("8页").length - 1, 1);

    const fivePointSpec = pageSpecs.find((pageSpec) => pageSpec.pageId === "page-3");
    assert.equal(fivePointSpec.lockedFacts.find((fact) => fact.kind === "point_count")?.value, "5");
    const fivePointPrompt = promptFor(snapshot, "page-3").finalPrompt;
    for (const point of ["数据可追溯", "模型可解释", "过程可审计", "责任可定位", "价值可量化"]) assert.match(fivePointPrompt, new RegExp(point));

    const metricFacts = pageSpecs.find((pageSpec) => pageSpec.pageId === "page-4").lockedFacts;
    assert.ok(metricFacts.some((fact) => fact.kind === "number" && fact.value === "98.5%"));
    assert.ok(metricFacts.some((fact) => fact.kind === "number" && fact.value === "1,200 台"));
    assert.ok(metricFacts.some((fact) => fact.kind === "term" && fact.value === "TCO"));

    const termFacts = pageSpecs
        .find((pageSpec) => pageSpec.pageId === "page-6")
        .lockedFacts.filter((fact) => fact.kind === "term")
        .map((fact) => fact.value);
    assert.deepEqual(new Set(termFacts), new Set(["EBITDA", "ROIC", "OEE"]));

    const chartPrompt = promptFor(snapshot, "page-5").finalPrompt;
    assert.match(chartPrompt, /整页左对齐/);
    assert.match(chartPrompt, /右侧两个柱状图左右排列/);
    assert.equal(chartPrompt.split("右侧两个柱状图左右排列").length - 1, 1);
    assert.equal(
        snapshot.issues.some((issue) => issue.pageId === "page-5" && issue.code === "layout_conflict"),
        false,
    );
});

test("风格节点中的禁止项只进入禁止段，不在视觉语言中重复", () => {
    const { deckBrief, pageSpecs } = buildPptCompilerModel({
        mode: "extract",
        sourceMaterial: "关键指标\n设备在线率 98.5%",
        requirements: "",
        styleDescription: "专业咨询报告风\n深蓝配色\n禁止渐变",
        pages: [{ pageId: "page-style-rule", title: "关键指标", outline: "关键指标\n设备在线率 98.5%", visualHint: "" }],
    });
    const snapshot = compilePptPromptSnapshot({
        snapshotId: "snapshot-style-rule",
        compiledAt: "2026-07-21T08:00:00.000Z",
        deckBrief,
        pageSpecs,
        targets: [{ pageId: "page-style-rule", takeId: "take-style-rule", semanticText: "关键指标\n设备在线率 98.5%", layoutIntent: [], styleTexts: ["专业咨询报告风\n深蓝配色\n禁止渐变"], extraTexts: [] }],
    });

    assert.equal(snapshot.prompts[0].finalPrompt.split("禁止渐变").length - 1, 1);
    assert.match(snapshot.prompts[0].finalPrompt, /【视觉语言】\n专业咨询报告风\n深蓝配色/);
    assert.equal(
        snapshot.issues.some((issue) => issue.code === "duplicate_instruction"),
        false,
    );
});

test("后续修改风格会同步新增或移除禁止项，并保留需求中的禁止项", () => {
    const updated = derivePptStyleRules("禁止二维码", "专业咨询报告风\n禁止渐变");
    assert.equal(updated.visualLanguage, "专业咨询报告风");
    assert.deepEqual(updated.forbiddenRules, ["禁止二维码", "禁止渐变"]);

    const { deckBrief, pageSpecs } = buildPptCompilerModel({
        mode: "extract",
        sourceMaterial: "关键指标\n设备在线率 98.5%",
        requirements: "禁止二维码",
        styleDescription: "专业咨询报告风",
        pages: [{ pageId: "page-style-update", title: "关键指标", outline: "关键指标\n设备在线率 98.5%", visualHint: "" }],
    });
    const snapshot = compilePptPromptSnapshot({
        snapshotId: "snapshot-style-update",
        compiledAt: "2026-07-21T08:00:00.000Z",
        deckBrief: { ...deckBrief, ...updated, version: deckBrief.version + 1 },
        pageSpecs,
        targets: [{ pageId: "page-style-update", takeId: "take-style-update", semanticText: "关键指标\n设备在线率 98.5%", layoutIntent: ["使用渐变"], layoutConfirmed: true, styleTexts: ["专业咨询报告风\n禁止渐变"], extraTexts: [] }],
    });
    assert.ok(snapshot.issues.some((issue) => issue.code === "forbidden_conflict" && issue.message.includes("禁止渐变")));

    assert.deepEqual(derivePptStyleRules("禁止二维码", "专业咨询报告风").forbiddenRules, ["禁止二维码"]);
});

test("override 缺少数字事实时阻断生成", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages.find((item) => item.pageId === "page-4");
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [
            {
                pageId: page.pageId,
                takeId: page.takeId,
                semanticText: page.outline,
                layoutIntent: [page.layoutIntent],
                styleTexts: [],
                extraTexts: [],
                override: "关键指标\n设备在线率保持领先\n累计接入设备持续增长\nTCO 持续降低",
            },
        ],
    });

    assert.equal(hasBlockingCompilationIssues(snapshot), true);
    assert.ok(snapshot.issues.some((issue) => issue.code === "missing_locked_fact" && issue.message.includes("98.5%")));
    assert.ok(snapshot.issues.some((issue) => issue.code === "missing_locked_fact" && issue.message.includes("1,200 台")));
});

test("5 点页的 override 新增第 6 点时阻断生成", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages.find((item) => item.pageId === "page-3");
    const override = `${page.outline.replace("\n布局：整页左对齐", "")}\n6. 无来源的第六点`;
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [], override }],
    });

    assert.equal(hasBlockingCompilationIssues(snapshot), true);
    const mismatch = snapshot.issues.find((issue) => issue.code === "point_count_mismatch");
    assert.ok(mismatch);
    assert.match(mismatch.message, /5 点.*6 点/);
});

test("同一 snapshot 输入可重用，结果与 promptId 完全一致", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const input = snapshotInput(deckBrief, pageSpecs);
    const first = compilePptPromptSnapshot(input);
    const second = compilePptPromptSnapshot(input);

    assert.deepEqual(second, first);
    assert.equal(first.snapshotId, "snapshot-8-pages");
    assert.equal(first.createdAt, "2026-07-21T08:00:00.000Z");
    assert.equal(first.prompts[0].promptId, "snapshot-8-pages:page-1:take-1");
    assert.deepEqual(first.deckBrief, deckBrief);
    assert.deepEqual(first.pageSpecs, pageSpecs);
});

test("全局要求的项目符号不会被误当成每页点数", () => {
    const { deckBrief, pageSpecs } = buildPptCompilerModel({
        mode: "outline",
        sourceMaterial: "甲\n乙",
        requirements: "- 统一配色\n- 保留留白\n- 禁止渐变",
        styleDescription: "",
        pages: [{ pageId: "page-bullets", title: "两点页", outline: "1. 甲\n2. 乙", visualHint: "" }],
    });
    const snapshot = compilePptPromptSnapshot({
        snapshotId: "snapshot-global-bullets",
        compiledAt: "2026-07-21T08:00:00.000Z",
        deckBrief,
        pageSpecs,
        targets: [{ pageId: "page-bullets", takeId: "take-bullets", semanticText: "标题：两点页\n1. 甲\n2. 乙", layoutIntent: [], styleTexts: [], extraTexts: [] }],
    });

    assert.equal(
        deckBrief.lockedDeckFacts.some((fact) => fact.kind === "point_count"),
        false,
    );
    assert.equal(
        snapshot.issues.some((issue) => issue.code === "point_count_mismatch"),
        false,
    );
});

test("导入规格中无法溯源的手改正文必须确认，定位标题不会额外注入", () => {
    const pageSpec = buildPptPageSpec({
        mode: "extract",
        sourceMaterial: "原始正文",
        page: { pageId: "page-source", title: "模型定位标题", outline: "手工改写正文", visualHint: "" },
    });
    const exactSpec = buildPptPageSpec({
        mode: "extract",
        sourceMaterial: "原始正文",
        page: { pageId: "page-exact", title: "模型定位标题", outline: "原始正文", visualHint: "" },
    });

    assert.equal(pageSpec.requiresReview, true);
    assert.equal(pageSpec.sourceRefs[0].startLine, undefined);
    assert.deepEqual(exactSpec.lockedCopy, ["原始正文"]);
    assert.equal(exactSpec.lockedCopy.includes("模型定位标题"), false);
});

test("导入时保留模型选中的原始行号，不会重新定位到重复内容的第一处", () => {
    const { pageSpecs } = buildPptCompilerModel({
        mode: "extract",
        sourceMaterial: "重复页\n---\n重复页",
        requirements: "",
        styleDescription: "",
        pages: [{ pageId: "page-repeat", title: "重复页", outline: "重复页", visualHint: "", sourceRange: { startLine: 3, endLine: 3 } }],
    });

    assert.equal(pageSpecs[0].sourceRefs[0].startLine, 3);
    assert.equal(pageSpecs[0].sourceRefs[0].endLine, 3);
});

test("显式 override 不能删除全局、禁止、布局或视觉约束", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [], override: page.outline }],
    });

    assert.equal(hasBlockingCompilationIssues(snapshot), true);
    assert.ok(snapshot.issues.some((issue) => issue.code === "missing_required_instruction"));
});

test("显式 override 不能在完整编译结果后追加未确认事实", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages.find((item) => item.pageId === "page-4");
    const baseline = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], layoutConfirmed: true, styleTexts: [], extraTexts: [] }],
    });
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [], override: `${baseline.prompts[0].finalPrompt}\n未确认增长 99%` }],
    });

    assert.ok(snapshot.issues.some((issue) => issue.code === "unreviewed_fact" && issue.message.includes("99%")));
});

test("显式 override 不能追加不含数字的未确认结论", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const baseline = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [] }],
    });
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [], override: `${baseline.prompts[0].finalPrompt}\n公司已经成为全球第一` }],
    });

    assert.ok(snapshot.issues.some((issue) => issue.code === "override_review_required"));
});

test("纯中文新结论不能藏在布局段或通过扩写旧句绕过", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const baseline = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [] }],
    });
    const inLayout = baseline.prompts[0].finalPrompt.replace("【本页布局】\n", "【本页布局】\n公司已经成为全球第一\n");
    const expandedCopy = baseline.prompts[0].finalPrompt.replace(page.title, `${page.title}并已经成为全球第一`);
    for (const override of [inLayout, expandedCopy]) {
        const snapshot = compilePptPromptSnapshot({
            ...snapshotInput(deckBrief, pageSpecs),
            targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [], override }],
        });
        assert.ok(snapshot.issues.some((issue) => issue.code === "override_review_required"));
    }
});

test("显式确认只对完整且未变更的 override 生效", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const baseline = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [] }],
    });
    const override = `${baseline.prompts[0].finalPrompt}\n公司已经成为全球第一`;
    const confirmed = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [], override, overrideConfirmed: true }],
    });
    assert.equal(
        confirmed.issues.some((issue) => issue.code === "override_review_required"),
        false,
    );
});

test("override 的删减、重排和 section 归属变化都必须重新确认", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const target = { pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [] };
    const baseline = compilePptPromptSnapshot({ ...snapshotInput(deckBrief, pageSpecs), targets: [target] }).prompts[0].finalPrompt;
    const lines = baseline.split("\n");
    const firstSection = lines.findIndex((line) => line === "【本页内容】");
    const layoutSection = lines.findIndex((line) => line === "【本页布局】");
    const reordered = [...lines];
    [reordered[firstSection + 1], reordered[layoutSection + 1]] = [reordered[layoutSection + 1], reordered[firstSection + 1]];
    const withoutSections = baseline.replace(/^【.+】$/gm, "");

    for (const override of [reordered.join("\n"), withoutSections]) {
        const snapshot = compilePptPromptSnapshot({ ...snapshotInput(deckBrief, pageSpecs), targets: [{ ...target, override }] });
        assert.ok(snapshot.issues.some((issue) => issue.code === "override_review_required"));
    }
});

test("PageSpec 正文被重排或删除时阻断生成", () => {
    const { deckBrief, pageSpecs } = buildPptCompilerModel({
        mode: "extract",
        sourceMaterial: "1. 先调研\n2. 再决策",
        requirements: "",
        styleDescription: "",
        pages: [{ pageId: "page-ordered", title: "流程", outline: "1. 先调研\n2. 再决策", visualHint: "" }],
    });
    const baseInput = { snapshotId: "snapshot-ordered", compiledAt: "2026-07-21T08:00:00.000Z", deckBrief, pageSpecs };
    for (const semanticText of ["2. 再决策\n1. 先调研", "1. 先调研"]) {
        const snapshot = compilePptPromptSnapshot({ ...baseInput, targets: [{ pageId: "page-ordered", takeId: "take-ordered", semanticText, layoutIntent: [], styleTexts: [], extraTexts: [] }] });
        assert.ok(snapshot.issues.some((issue) => issue.code === "unreviewed_fact" && issue.message.includes("内容或顺序")));
    }
});

test("override 明确确认后仍不能注入新的数字事实", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const target = { pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [] };
    const baseline = compilePptPromptSnapshot({ ...snapshotInput(deckBrief, pageSpecs), targets: [target] }).prompts[0].finalPrompt;
    const snapshot = compilePptPromptSnapshot({ ...snapshotInput(deckBrief, pageSpecs), targets: [{ ...target, override: `${baseline}\n未经确认增长 99%`, overrideConfirmed: true }] });
    assert.ok(snapshot.issues.some((issue) => issue.code === "unreviewed_fact" && issue.message.includes("99%")));
});

test("自定义排版文本未显式确认时阻断", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: ["用大号字体突出公司已经成为全球第一"], styleTexts: [], extraTexts: [] }],
    });
    assert.ok(snapshot.issues.some((issue) => issue.code === "review_required" && issue.message.includes("排版要求")));
});

test("generateSingle promptDraft 不能绕过 PageSpec 新增纯中文结论", () => {
    const partial = buildPptDeckProject({
        title: "promptDraft gate",
        sourceMaterial: "公司正在开展试点",
        requirements: "",
        style: { description: "" },
        pages: [{ title: "试点", outline: "公司正在开展试点", visualHint: "" }],
        uploadedRefs: [],
        mode: "extract",
    });
    const project = { id: "prompt-draft-gate", createdAt: "2026-07-21T08:00:00.000Z", updatedAt: "2026-07-21T08:00:00.000Z", chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, ...partial };
    const takeId = project.ppt.pages[0].takes[0].takeId;
    const plan = createGenerationPlan({ kind: "generateSingle", takeId, promptDraft: "公司正在开展试点\n公司已经成为全球第一" }, { project, effectiveConfig: defaultConfig });
    assert.ok(plan.compilation.issues.some((issue) => issue.code === "unreviewed_fact" && issue.message.includes("内容或顺序")));
});

test("override 否定句子串和未知标题都需要显式确认", () => {
    const { deckBrief, pageSpecs } = buildPptCompilerModel({
        mode: "extract",
        sourceMaterial: "公司不是全球第一",
        requirements: "",
        styleDescription: "",
        pages: [{ pageId: "page-negative-copy", title: "现状", outline: "公司不是全球第一", visualHint: "" }],
    });
    const baseInput = {
        snapshotId: "snapshot-negative-copy",
        compiledAt: "2026-07-21T08:00:00.000Z",
        deckBrief,
        pageSpecs,
        targets: [{ pageId: "page-negative-copy", takeId: "take-negative-copy", semanticText: "公司不是全球第一", layoutIntent: [], styleTexts: [], extraTexts: [] }],
    };
    const baseline = compilePptPromptSnapshot(baseInput);
    for (const addition of ["全球第一", "【公司已经成为全球第一】"]) {
        const snapshot = compilePptPromptSnapshot({ ...baseInput, targets: [{ ...baseInput.targets[0], override: `${baseline.prompts[0].finalPrompt}\n${addition}` }] });
        assert.ok(snapshot.issues.some((issue) => issue.code === "override_review_required"));
    }
});

test("未纳入 PageSpec 的额外文本输入会阻断生成", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: ["公司已经成为全球第一"] }],
    });

    assert.ok(snapshot.issues.some((issue) => issue.code === "unreviewed_fact" && issue.message.includes("未纳入页面规格")));
});

test("未修改的自动编译结果保存为 override 不会误报点数", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages.find((item) => item.pageId === "page-3");
    const first = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [] }],
    });
    const second = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: page.outline, layoutIntent: [page.layoutIntent], layoutConfirmed: true, styleTexts: [], extraTexts: [], override: first.prompts[0].finalPrompt }],
    });

    assert.equal(hasBlockingCompilationIssues(second), false);
});

test("规格节点后续添加的未确认事实会阻断生成", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages.find((item) => item.pageId === "page-4");
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: `${page.outline}\n未确认增长 99%`, layoutIntent: [page.layoutIntent], styleTexts: [], extraTexts: [] }],
    });

    assert.ok(snapshot.issues.some((issue) => issue.code === "unreviewed_fact" && issue.message.includes("99%")));
});

test("原材料规划中无法溯源的普通结论也要求人工确认", () => {
    const { pageSpecs } = buildPptCompilerModel({
        mode: "outline",
        sourceMaterial: "公司正在开展试点",
        requirements: "",
        styleDescription: "",
        pages: [{ pageId: "page-claim", title: "核心结论", outline: "公司已经成为全球第一", visualHint: "" }],
    });

    assert.equal(pageSpecs[0].requiresReview, true);
    assert.match(pageSpecs[0].reviewReason, /结论未在原材料中定位/);
});

test("原材料规划中无法溯源的标题也要求人工确认", () => {
    const { pageSpecs } = buildPptCompilerModel({
        mode: "outline",
        sourceMaterial: "公司正在开展试点",
        requirements: "",
        styleDescription: "",
        pages: [{ pageId: "page-title-claim", title: "公司已经成为全球第一", outline: "公司正在开展试点", visualHint: "" }],
    });

    assert.equal(pageSpecs[0].requiresReview, true);
    assert.match(pageSpecs[0].reviewReason, /公司已经成为全球第一/);
});

test("标题不能通过截掉原文否定语来伪造相反结论", () => {
    for (const sample of [
        { sourceMaterial: "项目尚未实现盈利", title: "实现盈利" },
        { sourceMaterial: "公司不是全球第一", title: "全球第一" },
    ]) {
        const { pageSpecs } = buildPptCompilerModel({
            mode: "outline",
            sourceMaterial: sample.sourceMaterial,
            requirements: "",
            styleDescription: "",
            pages: [{ pageId: `page-negation-${sample.title}`, title: sample.title, outline: sample.sourceMaterial, visualHint: "" }],
        });
        assert.equal(pageSpecs[0].requiresReview, true);
        assert.match(pageSpecs[0].reviewReason, new RegExp(sample.title));
    }
});

test("参考图只改变请求类型与输入快照，不改变编译后提示词与锁定事实", () => {
    const pageInput = fixture.pages.find((page) => page.pageId === "page-4");
    const partial = buildPptDeckProject({
        title: "Compiler 参考图测试",
        sourceMaterial: fixture.sourceMaterial,
        requirements: fixture.requirements,
        style: { description: fixture.styleDescription },
        pages: [pageInput],
        uploadedRefs: [],
        mode: "extract",
    });
    const project = {
        id: "compiler-reference-project",
        createdAt: "2026-07-21T08:00:00.000Z",
        updatedAt: "2026-07-21T08:00:00.000Z",
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        ...partial,
    };
    const take = project.ppt.pages[0].takes[0];
    const intent = { kind: "generateSingle", takeId: take.takeId };
    const withoutReference = createGenerationPlan(intent, { project, effectiveConfig: defaultConfig });
    const referenceNode = {
        id: "compiler-reference-image",
        type: "image",
        title: "锨定参考图",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: { content: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png", status: "success" },
    };
    const projectWithReference = {
        ...project,
        nodes: [...project.nodes, referenceNode],
        connections: [...project.connections, { id: "compiler-reference-connection", fromNodeId: referenceNode.id, toNodeId: take.configNodeId }],
    };
    const withReference = createGenerationPlan(intent, { project: projectWithReference, effectiveConfig: defaultConfig });
    const textRequest = withoutReference.runs[0].requests[0];
    const imageRequest = withReference.runs[0].requests[0];

    assert.equal(textRequest.prompt, imageRequest.prompt);
    assert.equal(withoutReference.compilation.prompts[0].finalPrompt, withReference.compilation.prompts[0].finalPrompt);
    assert.equal(textRequest.requestType, "textToImage");
    assert.deepEqual(textRequest.inputRefs, []);
    assert.deepEqual(textRequest.referenceSnapshots, []);
    assert.equal(imageRequest.requestType, "imageToImage");
    assert.deepEqual(imageRequest.inputRefs, [{ nodeId: referenceNode.id, type: "image" }]);
    assert.equal(imageRequest.referenceSnapshots[0].id, referenceNode.id);
    for (const fact of project.ppt.pageSpecs[0].lockedFacts) {
        if (fact.kind !== "point_count") {
            assert.match(textRequest.prompt, new RegExp(escapeRegExp(fact.value)));
            assert.match(imageRequest.prompt, new RegExp(escapeRegExp(fact.value)));
        }
    }
});

test("首页锚定开关只为后续页增加图片参考，不改变后续页提示词", () => {
    const partial = buildPptDeckProject({
        title: "Compiler 首页锚定测试",
        sourceMaterial: fixture.sourceMaterial,
        requirements: fixture.requirements,
        style: { description: fixture.styleDescription },
        pages: [fixture.pages[0], fixture.pages[3]],
        uploadedRefs: [],
        mode: "extract",
    });
    const project = {
        id: "compiler-anchor-project",
        createdAt: "2026-07-21T08:00:00.000Z",
        updatedAt: "2026-07-21T08:00:00.000Z",
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        ...partial,
    };
    const secondPage = project.ppt.pages[1];
    const directPlan = createGenerationPlan({ kind: "startBatch", anchorFirst: false }, { project, effectiveConfig: defaultConfig });
    const directRun = directPlan.runs.find((run) => run.pageId === secondPage.pageId);
    const firstPage = project.ppt.pages[0];
    const firstTake = firstPage.takes[0];
    const candidate = {
        id: "compiler-anchor-candidate",
        type: "image",
        title: "首页锚定",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: {
            content: "data:image/png;base64,AA==",
            storageKey: "image:compiler-anchor",
            mimeType: "image/png",
            status: "success",
            pptPageId: firstPage.pageId,
            pptTakeId: firstTake.takeId,
            pptPageIndex: firstPage.index,
        },
    };
    const anchoredProject = {
        ...project,
        nodes: [...project.nodes, candidate],
        connections: [...project.connections, { id: "compiler-anchor-output", fromNodeId: firstTake.configNodeId, toNodeId: candidate.id }],
        ppt: {
            ...project.ppt,
            skipAnchor: false,
            pages: project.ppt.pages.map((page) => (page.pageId === firstPage.pageId ? { ...page, confirmedNodeId: candidate.id } : page)),
        },
    };
    const anchoredPlan = createGenerationPlan({ kind: "generateRest" }, { project: anchoredProject, effectiveConfig: defaultConfig });
    const anchoredRun = anchoredPlan.runs.find((run) => run.pageId === secondPage.pageId);
    const directRequest = directRun.requests[0];
    const anchoredRequest = anchoredRun.requests[0];

    assert.equal(directRequest.prompt, anchoredRequest.prompt);
    assert.equal(directRequest.requestType, "textToImage");
    assert.deepEqual(directRequest.inputRefs, []);
    assert.equal(anchoredRequest.requestType, "imageToImage");
    assert.deepEqual(anchoredRequest.inputRefs, [{ nodeId: candidate.id, type: "image" }]);
    assert.equal(anchoredRequest.referenceSnapshots[0].storageKey, candidate.metadata.storageKey);
});

test("快照 ID 冲突或 request.prompt 与快照不一致时在提交前失败", () => {
    const pageInput = fixture.pages[0];
    const partial = buildPptDeckProject({
        title: "Compiler durable gate",
        sourceMaterial: fixture.sourceMaterial,
        requirements: fixture.requirements,
        style: { description: fixture.styleDescription },
        pages: [pageInput],
        uploadedRefs: [],
        mode: "extract",
    });
    const project = {
        id: "compiler-durable-project",
        createdAt: "2026-07-21T08:00:00.000Z",
        updatedAt: "2026-07-21T08:00:00.000Z",
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        ...partial,
    };
    const plan = createGenerationPlan({ kind: "generateSingle", takeId: project.ppt.pages[0].takes[0].takeId }, { project, effectiveConfig: defaultConfig });
    const tampered = structuredClone(plan);
    tampered.runs[0].requests[0].prompt += "\n被篡改";

    assert.throws(() => assertGenerationPlanCompilation(tampered), /实际提示词与编译快照不一致/);
    const missingBinding = structuredClone(plan);
    delete missingBinding.runs[0].requests[0].compilationSnapshotId;
    assert.throws(() => assertGenerationPlanCompilation(missingBinding), /编译快照绑定不一致/);
    const missingCompilation = structuredClone(plan);
    delete missingCompilation.compilation;
    assert.throws(() => assertGenerationPlanCompilation(missingCompilation), /缺少 Compiler 快照/);
    const persisted = applyGenerationPlanPptOps(project.ppt, plan.pptOps);
    const collision = structuredClone(plan.compilation);
    collision.prompts[0].finalPrompt += "\n冲突";
    assert.throws(() => applyGenerationPlanPptOps(persisted, [{ type: "appendCompilationSnapshot", snapshot: collision }]), /内容与已落盘记录不一致/);
});

function buildModel() {
    return buildPptCompilerModel({
        mode: fixture.mode,
        sourceMaterial: fixture.sourceMaterial,
        requirements: fixture.requirements,
        styleDescription: fixture.styleDescription,
        pages: fixture.pages.map(({ pageId, title, outline, visualHint }) => ({ pageId, title, outline, visualHint })),
    });
}

function snapshotInput(deckBrief, pageSpecs) {
    return {
        snapshotId: "snapshot-8-pages",
        compiledAt: "2026-07-21T08:00:00.000Z",
        deckBrief,
        pageSpecs,
        targets: fixture.pages.map((page) => ({
            pageId: page.pageId,
            takeId: page.takeId,
            semanticText: page.outline,
            layoutIntent: [page.layoutIntent],
            layoutConfirmed: true,
            styleTexts: [],
            extraTexts: [],
        })),
    };
}

function promptFor(snapshot, pageId) {
    const prompt = snapshot.prompts.find((item) => item.pageId === pageId);
    assert.ok(prompt, `missing compiled prompt for ${pageId}`);
    return prompt;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
