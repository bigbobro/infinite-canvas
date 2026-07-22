import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before } from "node:test";

import { createServer } from "vite";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/ppt-prompt-compiler-8-pages.json", import.meta.url), "utf8"));

let vite;
let buildPptDeckProject;
let compilePptPromptSnapshot;
let derivePptLockedFacts;
let derivePptStyleRules;
let renderPptPageSpecText;
let createGenerationPlan;
let createPptVisualDirectionPresetContract;
let assertGenerationPlanCompilation;
let applyGenerationPlanPptOps;
let setPptPageConfirmedNode;
let defaultConfig;
let hasBlockingCompilationIssues;
let hashPptContentSource;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ compilePptPromptSnapshot, derivePptStyleRules, hasBlockingCompilationIssues } = await vite.ssrLoadModule("/src/lib/ppt/prompt-compiler.ts"));
    ({ derivePptLockedFacts, renderPptPageSpecText } = await vite.ssrLoadModule("/src/lib/ppt/content-plan.ts"));
    ({ buildPptDeckProject, hashPptContentSource } = await vite.ssrLoadModule("/src/lib/ppt/deck-builder.ts"));
    ({ createGenerationPlan, assertGenerationPlanCompilation, applyGenerationPlanPptOps } = await vite.ssrLoadModule("/src/lib/ppt/generation-plan.ts"));
    ({ setPptPageConfirmedNode } = await vite.ssrLoadModule("/src/lib/ppt/page-confirmation.ts"));
    ({ createPptVisualDirectionPresetContract } = await vite.ssrLoadModule("/src/lib/ppt/style-contract.ts"));
    ({ defaultConfig } = await vite.ssrLoadModule("/src/stores/use-config-store.ts"));
});

after(async () => {
    await vite?.close();
});

test("8 页结构化规格按输入顺序建立 canonical PageSpec", () => {
    const { deckBrief, pageSpecs } = buildModel();

    assert.deepEqual(
        pageSpecs.map((pageSpec) => pageSpec.pageId),
        fixture.pages.map((page) => page.pageId),
    );
    assert.equal(pageSpecs.length, 8);
    assert.equal(deckBrief.audience, "集团管理层");
    assert.deepEqual(deckBrief.styleContract.modelStyle.mood, fixture.styleDescription.split("\n"));
    assert.ok(pageSpecs.every((pageSpec) => pageSpec.contentState.status === "approved"));
    assert.ok(pageSpecs.every((pageSpec) => pageSpec.sourceRefs[0].source === "material"));
    assert.ok(pageSpecs.every((pageSpec) => Number.isInteger(pageSpec.sourceRefs[0].startLine)));
    assert.ok(pageSpecs.every((pageSpec) => pageSpec.contentBlocks.filter((block) => block.kind === "title").length === 1));
    assert.ok(pageSpecs.every((pageSpec) => pageSpec.contentBlocks.filter((block) => block.kind === "primary_claim").length === 1));
});

test("8 页逐字规格按 exactText 编译，不构造 Contract 或 PageSpec", () => {
    const verbatimSpecs = fixture.pages.map((page) => ({ pageId: page.pageId, version: 1, title: page.title, exactText: pageText(page), origin: { kind: "user_edited" } }));
    const snapshot = compilePptPromptSnapshot({
        compilePolicy: "verbatim",
        snapshotId: "snapshot-8-pages-verbatim",
        compiledAt: "2026-07-21T08:00:00.000Z",
        verbatimSpecs,
        targets: verbatimSpecs.map((spec, index) => ({ pageId: spec.pageId, takeId: fixture.pages[index].takeId, semanticText: spec.exactText, layoutIntent: [], extraTexts: [] })),
    });

    assert.equal(hasBlockingCompilationIssues(snapshot), false);
    assert.deepEqual(
        snapshot.prompts.map((prompt) => prompt.finalPrompt),
        verbatimSpecs.map((spec) => spec.exactText),
    );
    assert.equal("deckBrief" in snapshot, false);
    assert.equal("pageSpecs" in snapshot, false);
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

test("Compiler 把已批准文案按语义块编译，并允许无文字视觉构件", () => {
    const text = ["LLM 中转站选型", "选型需同时平衡接入能力、运行规模、安全与成本", "模型接入：明确服务商与协议兼容性", "容量与路由：评估并发、吞吐和故障切换", "安全治理：覆盖密钥、鉴权、审计与脱敏"].join("\n");
    const { deckBrief, pageSpecs } = singlePageModel({ pageId: "page-semantic-blocks", title: "LLM 中转站选型", text, styleContract: styleContract() });
    pageSpecs[0].visualEncoding = [
        {
            id: "page-semantic-blocks:encoding:1",
            contentBlockIds: [pageSpecs[0].contentBlocks[2].id],
            intent: "group",
            channel: "shape",
        },
    ];
    const snapshot = compilePptPromptSnapshot(snapshotInputForPage(deckBrief, pageSpecs[0], "take-semantic-blocks"));
    const prompt = snapshot.prompts[0].finalPrompt;

    assert.equal(hasBlockingCompilationIssues(snapshot), false);
    assert.match(prompt, /【本页内容】/);
    assert.match(prompt, /\[B1 · 标题\]/);
    assert.match(prompt, /\[B2 · 核心信息\]/);
    assert.match(prompt, /\[B3 · 正文\]/);
    assert.match(prompt, /结构编号.*不作为可见文案/);
    assert.match(prompt, /对 B3 使用形状表达分组/);
    assert.match(prompt, /允许新增不含文字的图标、形状、连线/);
    for (const line of text.split("\n")) assert.equal(prompt.split(line).length - 1, 1);

    const comparison = structuredClone(pageSpecs[0]);
    comparison.contentForm = "comparison";
    const comparisonPrompt = compilePptPromptSnapshot(snapshotInputForPage(deckBrief, comparison, "take-comparison")).prompts[0].finalPrompt;
    assert.notEqual(comparisonPrompt, prompt);
    assert.match(comparisonPrompt, /按可对齐的维度并列表达差异与取舍/);
    assert.match(comparisonPrompt, /【整套视觉系统】/);
});

test("视觉方向 Contract 中的禁止项只进入禁止段，不在视觉方向中重复", () => {
    const { deckBrief, pageSpecs } = singlePageModel({
        pageId: "page-style-rule",
        title: "关键指标",
        text: "关键指标\n设备在线率 98.5%",
        styleContract: styleContract("专业咨询报告风\n深蓝配色\n禁止渐变"),
    });
    const snapshot = compilePptPromptSnapshot({
        compilePolicy: "structured",
        snapshotId: "snapshot-style-rule",
        compiledAt: "2026-07-21T08:00:00.000Z",
        deckBrief,
        pageSpecs,
        targets: [{ pageId: "page-style-rule", takeId: "take-style-rule", semanticText: "关键指标\n设备在线率 98.5%", layoutIntent: [], extraTexts: [] }],
    });

    assert.equal(snapshot.prompts[0].finalPrompt.split("禁止渐变").length - 1, 1);
    assert.match(snapshot.prompts[0].finalPrompt, /【整套视觉系统】/);
    assert.match(snapshot.prompts[0].finalPrompt, /专业咨询报告风、深蓝配色/);
    assert.equal("styleTexts" in snapshot.targets[0], false);
    assert.equal(
        snapshot.issues.some((issue) => issue.code === "duplicate_instruction"),
        false,
    );
});

test("后续修改视觉方向会同步新增或移除禁止项，并保留需求中的禁止项", () => {
    const updated = derivePptStyleRules("禁止二维码", "专业咨询报告风\n禁止渐变");
    assert.equal(updated.direction, "专业咨询报告风");
    assert.deepEqual(updated.forbiddenRules, ["禁止二维码", "禁止渐变"]);

    const { deckBrief, pageSpecs } = singlePageModel({
        pageId: "page-style-update",
        title: "关键指标",
        text: "关键指标\n设备在线率 98.5%",
        requirements: "禁止二维码",
        styleContract: styleContract("专业咨询报告风"),
    });
    const snapshot = compilePptPromptSnapshot({
        compilePolicy: "structured",
        snapshotId: "snapshot-style-update",
        compiledAt: "2026-07-21T08:00:00.000Z",
        deckBrief: { ...deckBrief, styleContract: styleContract("专业咨询报告风\n禁止渐变"), forbiddenRules: updated.forbiddenRules, version: deckBrief.version + 1 },
        pageSpecs,
        targets: [{ pageId: "page-style-update", takeId: "take-style-update", semanticText: "关键指标\n设备在线率 98.5%", layoutIntent: ["使用渐变"], layoutConfirmed: true, extraTexts: [] }],
    });
    assert.ok(snapshot.issues.some((issue) => issue.code === "visual_direction_outside_contract" && issue.message.includes("渐变")));

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
                semanticText: pageSemantic(pageSpecs, page.pageId),
                layoutIntent: [page.layoutIntent],
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
    const override = `${pageSemantic(pageSpecs, page.pageId)}\n6. 无来源的第六点`;
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: [], override }],
    });

    assert.equal(hasBlockingCompilationIssues(snapshot), true);
    assert.ok(snapshot.issues.some((issue) => issue.code === "point_count_mismatch" || issue.code === "unreviewed_fact"));
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
    const { deckBrief, pageSpecs } = singlePageModel({
        pageId: "page-bullets",
        title: "两点页",
        text: "两点页\n1. 甲\n2. 乙",
        requirements: "- 面向管理层\n- 保留全部数据\n- 禁止渐变",
        styleContract: styleContract(),
    });
    const snapshot = compilePptPromptSnapshot({
        compilePolicy: "structured",
        snapshotId: "snapshot-global-bullets",
        compiledAt: "2026-07-21T08:00:00.000Z",
        deckBrief,
        pageSpecs,
        targets: [{ pageId: "page-bullets", takeId: "take-bullets", semanticText: renderPptPageSpecText(pageSpecs[0]), layoutIntent: [], extraTexts: [] }],
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

test("无法溯源或未批准的 canonical PageSpec 必须阻断", () => {
    const { deckBrief, pageSpecs } = singlePageModel({ pageId: "page-source", title: "核心结论", text: "核心结论\n公司已经实现盈利", styleContract: styleContract() });
    pageSpecs[0].sourceRefs[0] = { id: "page-source:source", source: "material", excerpt: "公司尚未实现盈利", startLine: 1, endLine: 1 };
    pageSpecs[0].contentState = { status: "reviewable" };
    const snapshot = compilePptPromptSnapshot({ ...snapshotInputForPage(deckBrief, pageSpecs[0], "take-source"), snapshotId: "snapshot-source" });

    assert.ok(snapshot.issues.some((issue) => issue.code === "invalid_content_provenance"));
    assert.ok(snapshot.issues.some((issue) => issue.code === "content_spec_not_approved"));
});

test("canonical SourceRef 保留用户确认的重复原文行号", () => {
    const { pageSpecs } = singlePageModel({ pageId: "page-repeat", title: "重复页", text: "重复页", styleContract: styleContract() });
    pageSpecs[0].sourceRefs[0] = { id: "page-repeat:source", source: "material", excerpt: "重复页", startLine: 3, endLine: 3 };

    assert.equal(pageSpecs[0].sourceRefs[0].startLine, 3);
    assert.equal(pageSpecs[0].sourceRefs[0].endLine, 3);
});

test("显式 override 不能删除全局、禁止、布局或视觉约束", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: [], override: pageSemantic(pageSpecs, page.pageId) }],
    });

    assert.equal(hasBlockingCompilationIssues(snapshot), true);
    assert.ok(snapshot.issues.some((issue) => issue.code === "missing_required_instruction"));
});

test("显式 override 不能在完整编译结果后追加未确认事实", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages.find((item) => item.pageId === "page-4");
    const baseline = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], layoutConfirmed: true, extraTexts: [] }],
    });
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: [], override: `${baseline.prompts[0].finalPrompt}\n未确认增长 99%` }],
    });

    assert.ok(snapshot.issues.some((issue) => issue.code === "unreviewed_fact" && issue.message.includes("99%")));
});

test("显式 override 不能追加不含数字的未确认结论", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const baseline = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: [] }],
    });
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: [], override: `${baseline.prompts[0].finalPrompt}\n公司已经成为全球第一` }],
    });

    assert.ok(snapshot.issues.some((issue) => issue.code === "override_review_required"));
});

test("纯中文新结论不能藏在布局段或通过扩写旧句绕过", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const baseline = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: [] }],
    });
    const inLayout = baseline.prompts[0].finalPrompt.replace("【本页布局】\n", "【本页布局】\n公司已经成为全球第一\n");
    const expandedCopy = baseline.prompts[0].finalPrompt.replace(page.title, `${page.title}并已经成为全球第一`);
    for (const override of [inLayout, expandedCopy]) {
        const snapshot = compilePptPromptSnapshot({
            ...snapshotInput(deckBrief, pageSpecs),
            targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: [], override }],
        });
        assert.ok(snapshot.issues.some((issue) => issue.code === "override_review_required"));
    }
});

test("显式确认只对完整且未变更的 override 生效", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const baseline = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: [] }],
    });
    const override = `${baseline.prompts[0].finalPrompt}\n公司已经成为全球第一`;
    const confirmed = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: [], override, overrideConfirmed: true }],
    });
    assert.equal(
        confirmed.issues.some((issue) => issue.code === "override_review_required"),
        false,
    );
});

test("override 的删减、重排和 section 归属变化都必须重新确认", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const target = { pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: [] };
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
    const { deckBrief, pageSpecs } = singlePageModel({ pageId: "page-ordered", title: "流程", text: "流程\n1. 先调研\n2. 再决策", styleContract: styleContract() });
    const baseInput = { compilePolicy: "structured", snapshotId: "snapshot-ordered", compiledAt: "2026-07-21T08:00:00.000Z", deckBrief, pageSpecs };
    for (const semanticText of ["2. 再决策\n1. 先调研", "1. 先调研"]) {
        const snapshot = compilePptPromptSnapshot({ ...baseInput, targets: [{ pageId: "page-ordered", takeId: "take-ordered", semanticText, layoutIntent: [], extraTexts: [] }] });
        assert.ok(snapshot.issues.some((issue) => issue.code === "invalid_content_provenance" && issue.message.includes("PageSpec")));
    }
});

test("override 明确确认后仍不能注入新的数字事实", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const target = { pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: [] };
    const baseline = compilePptPromptSnapshot({ ...snapshotInput(deckBrief, pageSpecs), targets: [target] }).prompts[0].finalPrompt;
    const snapshot = compilePptPromptSnapshot({ ...snapshotInput(deckBrief, pageSpecs), targets: [{ ...target, override: `${baseline}\n未经确认增长 99%`, overrideConfirmed: true }] });
    assert.ok(snapshot.issues.some((issue) => issue.code === "unreviewed_fact" && issue.message.includes("99%")));
});

test("自定义排版文本未显式确认时阻断", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: ["用大号字体突出公司已经成为全球第一"], extraTexts: [] }],
    });
    assert.ok(snapshot.issues.some((issue) => issue.code === "review_required" && issue.message.includes("排版要求")));
});

test("generateSingle promptDraft 不能绕过 PageSpec 新增纯中文结论", () => {
    const { deckBrief, pageSpecs } = singlePageModel({ pageId: "page-prompt-draft", title: "试点", text: "试点\n公司正在开展试点", sourceMaterial: "公司正在开展试点", styleContract: styleContract() });
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "promptDraft gate",
        sourceMaterial: "公司正在开展试点",
        requirements: "",
        deckBrief,
        pageSpecs,
    });
    const project = { id: "prompt-draft-gate", createdAt: "2026-07-21T08:00:00.000Z", updatedAt: "2026-07-21T08:00:00.000Z", chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, ...partial };
    const takeId = project.ppt.pages[0].takes[0].takeId;
    assert.throws(() => createGenerationPlan({ kind: "generateSingle", takeId, promptDraft: "公司正在开展试点\n公司已经成为全球第一" }, { project, effectiveConfig: defaultConfig }), /Compiler 阻断生成.*PageSpec/);
});

test("未纳入 PageSpec 的额外文本输入会阻断生成", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages[0];
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: ["公司已经成为全球第一"] }],
    });

    assert.ok(snapshot.issues.some((issue) => issue.code === "unreviewed_fact" && issue.message.includes("未纳入 PageSpec")));
});

test("未修改的自动编译结果保存为 override 不会误报点数", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages.find((item) => item.pageId === "page-3");
    const first = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], extraTexts: [] }],
    });
    const second = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: pageSemantic(pageSpecs, page.pageId), layoutIntent: [page.layoutIntent], layoutConfirmed: true, extraTexts: [], override: first.prompts[0].finalPrompt }],
    });

    assert.equal(hasBlockingCompilationIssues(second), false);
});

test("规格节点后续添加的未确认事实会阻断生成", () => {
    const { deckBrief, pageSpecs } = buildModel();
    const page = fixture.pages.find((item) => item.pageId === "page-4");
    const snapshot = compilePptPromptSnapshot({
        ...snapshotInput(deckBrief, pageSpecs),
        targets: [{ pageId: page.pageId, takeId: page.takeId, semanticText: `${pageSemantic(pageSpecs, page.pageId)}\n未确认增长 99%`, layoutIntent: [page.layoutIntent], extraTexts: [] }],
    });

    assert.ok(snapshot.issues.some((issue) => issue.code === "invalid_content_provenance" && issue.message.includes("PageSpec")));
});

test("篡改 PageSpec 派生的 lockedFacts 会被 Compiler 拒绝", () => {
    const { deckBrief, pageSpecs } = singlePageModel({ pageId: "page-facts", title: "关键指标", text: "关键指标\n设备在线率 98.5%\nTCO 降低 23%", styleContract: styleContract() });
    pageSpecs[0].lockedFacts = [];
    const snapshot = compilePptPromptSnapshot({ ...snapshotInputForPage(deckBrief, pageSpecs[0], "take-facts"), snapshotId: "snapshot-facts" });

    assert.ok(snapshot.issues.some((issue) => issue.code === "invalid_content_provenance" && issue.severity === "blocking"));
});

test("参考图只改变请求类型与输入快照，不改变编译后提示词与锁定事实", () => {
    const { deckBrief, pageSpecs } = modelForFixturePages(["page-4"]);
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "Compiler 参考图测试",
        sourceMaterial: fixture.sourceMaterial,
        requirements: fixture.requirements,
        deckBrief,
        pageSpecs,
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

test("代表页校样只为其余页面增加图片参考，不改变页面提示词", () => {
    const { deckBrief, pageSpecs } = modelForFixturePages(["page-1", "page-4"]);
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "Compiler 首页锚定测试",
        sourceMaterial: fixture.sourceMaterial,
        requirements: fixture.requirements,
        deckBrief,
        pageSpecs,
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
    const directPlan = createGenerationPlan({ kind: "startBatch", anchorFirst: false }, { project, effectiveConfig: defaultConfig });
    const proofPlan = createGenerationPlan({ kind: "startBatch", anchorFirst: true }, { project, effectiveConfig: defaultConfig });
    const proofRun = proofPlan.runs[0];
    const proofPage = project.ppt.pages.find((page) => page.pageId === proofRun.pageId);
    const proofTake = proofPage.takes.find((take) => take.takeId === proofRun.takeId);
    const proofRequest = proofRun.requests[0];
    const proofCompiledPrompt = proofPlan.compilation.prompts.find((prompt) => prompt.pageId === proofPage.pageId && prompt.takeId === proofTake.takeId).finalPrompt;
    const remainingPage = project.ppt.pages.find((page) => page.pageId !== proofPage.pageId);
    const directRun = directPlan.runs.find((run) => run.pageId === remainingPage.pageId);
    const candidate = {
        id: proofRun.rootNodeId,
        type: "image",
        title: "代表页校样",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: {
            content: "data:image/png;base64,AA==",
            storageKey: "image:compiler-anchor",
            mimeType: "image/png",
            prompt: proofCompiledPrompt,
            status: "success",
            pptPageId: proofPage.pageId,
            pptTakeId: proofTake.takeId,
            pptPageIndex: proofPage.index,
            pptGenerationRequest: {
                requestId: proofRequest.requestId,
                runId: proofRun.runId,
                batchId: proofPlan.batchId,
                pageId: proofPage.pageId,
                takeId: proofTake.takeId,
                slotIndex: proofRequest.slotIndex,
                requestType: proofRequest.requestType,
                model: proofRequest.model,
                providerIdentity: proofRequest.providerIdentity,
                compilationSnapshotId: proofPlan.compilation.snapshotId,
                status: "completed",
                createdAt: proofPlan.createdAt,
                updatedAt: proofPlan.createdAt,
                recentEvents: [],
            },
            pptGenerationRun: {
                runId: proofRun.runId,
                batchId: proofPlan.batchId,
                pageId: proofPage.pageId,
                takeId: proofTake.takeId,
                requestIds: [proofRequest.requestId],
                plannedCount: 1,
                status: "completed",
                createdAt: proofPlan.createdAt,
                updatedAt: proofPlan.createdAt,
            },
        },
    };
    const withCandidate = {
        ...project,
        nodes: [...project.nodes, candidate],
        connections: [...project.connections, { id: "compiler-anchor-output", fromNodeId: proofTake.configNodeId, toNodeId: candidate.id }],
        ppt: applyGenerationPlanPptOps(project.ppt, proofPlan.pptOps),
    };
    const anchoredProject = { ...withCandidate, ppt: setPptPageConfirmedNode(withCandidate, proofPage.pageId, candidate.id) };
    const anchoredPlan = createGenerationPlan({ kind: "generateRest" }, { project: anchoredProject, effectiveConfig: defaultConfig });
    const anchoredRun = anchoredPlan.runs.find((run) => run.pageId === remainingPage.pageId);
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
    const { deckBrief, pageSpecs } = modelForFixturePages(["page-1"]);
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "Compiler durable gate",
        sourceMaterial: fixture.sourceMaterial,
        requirements: fixture.requirements,
        deckBrief,
        pageSpecs,
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
    return modelForFixturePages(fixture.pages.map((page) => page.pageId));
}

function modelForFixturePages(pageIds) {
    const styleRules = derivePptStyleRules(fixture.requirements, fixture.styleDescription);
    const deckBrief = {
        version: 1,
        sourceHash: hashPptContentSource(fixture.sourceMaterial, fixture.requirements),
        contentRevision: `${hashPptContentSource(fixture.sourceMaterial, fixture.requirements)}:r1`,
        audience: "集团管理层",
        goal: "在8页内形成可决策的工业智能方案",
        narrative: "判断、原则、指标、路径、行动",
        styleContract: styleContract(fixture.styleDescription),
        globalRules: ["保留全部数据"],
        forbiddenRules: styleRules.forbiddenRules,
        lockedDeckFacts: [],
    };
    const pages = fixture.pages.filter((page) => pageIds.includes(page.pageId));
    const pageSpecs = pages.map((page, index) =>
        createPageSpec({
            pageId: page.pageId,
            title: page.title,
            text: pageText(page),
            sourceMaterial: fixture.sourceMaterial,
            sourceKind: "material",
            layoutIntent: [page.layoutIntent],
            layoutRole: page.pageId === "page-1" ? "cover" : page.pageId === "page-4" || page.pageId === "page-5" ? "evidence" : page.pageId === "page-8" ? "close" : "content",
            contentForm: page.pageId === "page-5" ? "comparison" : page.pageId === "page-4" ? "data" : index === 0 && page.pageId === "page-1" ? "cover" : "narrative",
        }),
    );
    return { deckBrief, pageSpecs };
}

function singlePageModel({ pageId, title, text, requirements = "", styleContract: contract = styleContract(), layoutIntent = [], globalRules = [], forbiddenRules, sourceMaterial = text }) {
    const styleRules = derivePptStyleRules(requirements);
    return {
        deckBrief: {
            version: 1,
            sourceHash: hashPptContentSource(sourceMaterial, requirements),
            contentRevision: `${hashPptContentSource(sourceMaterial, requirements)}:r1`,
            audience: "",
            goal: "",
            narrative: "",
            styleContract: contract,
            globalRules,
            forbiddenRules: forbiddenRules ?? styleRules.forbiddenRules,
            lockedDeckFacts: [],
        },
        pageSpecs: [createPageSpec({ pageId, title, text, sourceMaterial, sourceKind: "confirmed_assumption", layoutIntent })],
    };
}

function createPageSpec({ pageId, title, text, sourceMaterial, sourceKind, layoutIntent = [], layoutRole = "content", contentForm = "narrative" }) {
    const lines = text.split("\n");
    const bodyLines = lines[0] === title ? lines.slice(1) : lines;
    const primaryClaim = bodyLines[0] || title;
    const sourceRef = { id: `${pageId}:source`, source: sourceKind, excerpt: text };
    if (sourceKind === "material" || sourceKind === "requirements") Object.assign(sourceRef, locateSourceRange(sourceMaterial, text));
    const contentBlocks = [
        { id: `${pageId}:title`, kind: "title", text: title, sourceRefIds: [sourceRef.id] },
        { id: `${pageId}:claim`, kind: "primary_claim", text: primaryClaim, sourceRefIds: [sourceRef.id] },
        ...(bodyLines.length > 1 ? [{ id: `${pageId}:body`, kind: bodyLines.some((line) => /^\d+[.)、]\s*/.test(line)) ? "list" : "body", text: bodyLines.slice(1).join("\n"), sourceRefIds: [sourceRef.id] }] : []),
    ];
    const pageSpec = {
        pageId,
        version: 1,
        purpose: `讲清${title}`,
        contentForm,
        sourceRefs: [sourceRef],
        contentBlocks,
        contentState: { status: "approved", approvedAt: "2026-07-21T08:00:00.000Z" },
        lockedFacts: [],
        layoutRole,
        layoutIntent,
        visualEncoding: [],
        assetRefs: [],
        freedom: "不得新增或改写可见文案、数字、型号或结论；只允许在已批准内容内优化视觉组织",
    };
    pageSpec.lockedFacts = derivePptLockedFacts(pageSpec);
    return pageSpec;
}

function locateSourceRange(sourceMaterial, text) {
    const sourceLines = sourceMaterial.split("\n");
    const targetLines = text.split("\n");
    const offset = sourceLines.findIndex((_, index) => targetLines.every((line, lineIndex) => sourceLines[index + lineIndex] === line));
    assert.notEqual(offset, -1, `source fixture does not contain canonical page text: ${text}`);
    return { startLine: offset + 1, endLine: offset + targetLines.length };
}

function pageText(page) {
    return page.content;
}

function pageSemantic(pageSpecs, pageId) {
    const pageSpec = pageSpecs.find((item) => item.pageId === pageId);
    assert.ok(pageSpec, `missing PageSpec for ${pageId}`);
    return renderPptPageSpecText(pageSpec);
}

function snapshotInput(deckBrief, pageSpecs) {
    return {
        compilePolicy: "structured",
        snapshotId: "snapshot-8-pages",
        compiledAt: "2026-07-21T08:00:00.000Z",
        deckBrief,
        pageSpecs,
        targets: fixture.pages.map((page) => ({
            pageId: page.pageId,
            takeId: page.takeId,
            semanticText: pageSemantic(pageSpecs, page.pageId),
            layoutIntent: [page.layoutIntent],
            layoutConfirmed: true,
            extraTexts: [],
        })),
    };
}

function snapshotInputForPage(deckBrief, pageSpec, takeId) {
    return {
        compilePolicy: "structured",
        snapshotId: `snapshot-${pageSpec.pageId}`,
        compiledAt: "2026-07-21T08:00:00.000Z",
        deckBrief,
        pageSpecs: [pageSpec],
        targets: [{ pageId: pageSpec.pageId, takeId, semanticText: renderPptPageSpecText(pageSpec), layoutIntent: [...pageSpec.layoutIntent], layoutConfirmed: true, extraTexts: [] }],
    };
}

function styleContract(direction = "清晰专业的报告视觉") {
    const contract = createPptVisualDirectionPresetContract("clean-report");
    contract.source = { kind: "custom" };
    const lines = direction
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    contract.modelStyle.mood = lines.filter((line) => !/(?:不要|禁止|不得|避免)/.test(line));
    contract.modelStyle.forbiddenRules = lines.filter((line) => /(?:不要|禁止|不得|避免)/.test(line));
    return contract;
}

function promptFor(snapshot, pageId) {
    const prompt = snapshot.prompts.find((item) => item.pageId === pageId);
    assert.ok(prompt, `missing compiled prompt for ${pageId}`);
    return prompt;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
