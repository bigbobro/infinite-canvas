import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let api;
let vite;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    api = await vite.ssrLoadModule("/src/lib/ppt/style-contract.ts");
});

after(async () => {
    await vite?.close();
});

test("三个通用方向都是完整 Contract，来源身份不进入视觉 fingerprint", () => {
    for (const preset of api.PPT_VISUAL_DIRECTION_PRESETS) {
        const contract = api.createPptVisualDirectionPresetContract(preset.id);
        const compiled = api.compilePptStyleContract(contract);
        assert.equal(compiled.ok, true);
        assert.deepEqual(Object.keys(compiled.value.roleInstructions), ["cover", "section", "content", "evidence", "comparison", "close"]);
        assert.equal(compiled.value.globalInstructions.length >= 6, true);
    }
    const preset = api.createPptVisualDirectionPresetContract("clean-report");
    const generated = { ...structuredClone(preset), source: { kind: "generated", candidateId: "candidate-client-1" } };
    assert.equal(api.compilePptStyleContract(preset).value.fingerprint, api.compilePptStyleContract(generated).value.fingerprint);
});

test("缺少 palette、typography、shell 或 roleMasters 都 fail-closed", () => {
    for (const field of ["palette", "typography", "shell", "roleMasters"]) {
        const contract = api.createPptVisualDirectionPresetContract();
        delete contract.modelStyle[field];
        const compiled = api.compilePptStyleContract(contract);
        assert.equal(compiled.ok, false);
        assert.equal(
            compiled.issues.some((issue) => issue.path.startsWith(`modelStyle.${field}`)),
            true,
        );
    }
});

test("页面呈现分类保留功能性编码，只拦截整套风格覆盖", () => {
    const cases = [
        ["左右双栏，右侧放组件对比表", "layout"],
        ["颜色区分优劣", "visual_encoding"],
        ["红色=风险，绿色=正常", "visual_encoding"],
        ["图标标记不同组件类别", "visual_encoding"],
        ["红色=风险并使用赛博朋克风", "deck_style_override"],
        ["颜色区分优劣并使用科技风", "deck_style_override"],
        ["使用深蓝背景和品牌色", "deck_style_override"],
        ["统一使用无衬线字体", "deck_style_override"],
        ["不要渐变材质", "deck_style_override"],
        ["页脚固定显示页码", "deck_style_override"],
    ];
    for (const [value, expected] of cases) assert.equal(api.classifyPptPagePresentationInstruction(value).kind, expected, value);
    assert.equal(api.stripPptDeckStyleOverrides("左右双栏使用深蓝背景"), "左右双栏");
    assert.equal(api.stripPptDeckStyleOverrides("红色=风险并使用赛博朋克风"), "红色=风险");
    assert.equal(api.stripPptDeckStyleOverrides("颜色区分优劣并使用科技风"), "颜色区分优劣");
    assert.equal(api.stripPptDeckStyleOverrides("左右双栏使用简洁背景"), "左右双栏");
    assert.equal(api.stripPptDeckStyleOverrides("上方标题下方正文且页脚固定显示页码"), "上方标题下方正文");
    assert.deepEqual(api.previewPptStyleClauseRepair("左图右文采用定制字体"), { safe: true, remainder: "左图右文" });
    assert.deepEqual(api.previewPptStyleClauseRepair("左右双栏使用大字号"), { safe: true, remainder: "左右双栏" });
    for (const value of ["对比表使用微软雅黑字体", "架构图使用微软雅黑字体", "roadmap使用微软雅黑字体", "三列卡片使用微软雅黑字体"]) {
        assert.equal(api.previewPptStyleClauseRepair(value).safe, false, value);
    }
});

test("六页共享一个全局 fingerprint，同 role 共享 shell，差异只来自角色母版", () => {
    const compiled = api.compilePptStyleContract(api.createPptVisualDirectionPresetContract("brand-led")).value;
    assert.equal(new Set(Object.values(compiled.roleFingerprints)).size, 6);
    assert.equal(compiled.fingerprint, api.compilePptStyleContract(compiled.canonical).value.fingerprint);
    assert.deepEqual(compiled.roleInstructions.content, api.compilePptStyleContract(compiled.canonical).value.roleInstructions.content);
});

test("视觉检查为页面越权提供恢复动作，revision-bound 修复只删风格并保留事实", () => {
    const contract = api.createPptVisualDirectionPresetContract();
    const page = pageSpec({ layoutIntent: ["左右双栏，深蓝科技感背景", "架构节点用连线表达关系"] });
    const input = reviewInput(contract, [page]);
    const review = api.reviewPptStyle(input);
    const blocker = review.issues.find((issue) => issue.code === "page_style_override");
    assert.ok(blocker);
    assert.equal(
        blocker.actions.some((action) => action.kind === "restore_role_master" && action.deterministic),
        true,
    );
    assert.equal(
        blocker.actions.some((action) => action.kind === "move_to_global"),
        true,
    );

    const patch = api.previewPptStyleRepair(input);
    assert.match(patch.diff[0].before, /深蓝科技感背景/);
    assert.doesNotMatch(patch.diff[0].after, /深蓝科技感背景/);
    const repaired = api.applyPptStyleRepair(input, patch);
    assert.deepEqual(repaired.pageSpecs[0].contentBlocks, page.contentBlocks);
    assert.deepEqual(repaired.pageSpecs[0].sourceRefs, page.sourceRefs);
    assert.match(repaired.pageSpecs[0].layoutIntent[0], /左右双栏/);
    assert.throws(() => api.applyPptStyleRepair({ ...input, draftRevision: 2 }, patch), /已过期/);

    const changedAfter = structuredClone(patch);
    changedAfter.operations[0].after = "左右双栏；加入未审核内容";
    assert.throws(() => api.applyPptStyleRepair(input, changedAfter), /篡改/);
    assert.deepEqual(input.pageSpecs, [page]);
});

test("当前方案中的越权只提供可执行恢复路径，所有确定性动作都会产生操作", () => {
    const contract = api.createPptVisualDirectionPresetContract();
    contract.references = [{ storageKey: "image:broken" }];
    const input = {
        ...reviewInput(contract, [pageSpec({ layoutIntent: ["左右双栏使用深蓝背景"] })]),
        targetLayouts: [{ pageId: "page-1", values: ["当前方案使用科技风"] }],
        brokenReferenceKeys: ["image:broken"],
    };
    const review = api.reviewPptStyle(input);
    const targetIssue = review.issues.find((issue) => issue.location.includes("当前方案构图"));
    assert.ok(targetIssue);
    assert.equal(
        targetIssue.actions.some((action) => action.deterministic),
        false,
    );
    for (const action of review.issues.flatMap((issue) => issue.actions).filter((action) => action.deterministic)) {
        assert.equal(api.previewPptStyleRepair(input, [action.id]).operations.length > 0, true, action.id);
    }
});

test("PageSpec 与工作台共用同一个确定性恢复判断", () => {
    const contract = api.createPptVisualDirectionPresetContract();
    const safeInput = reviewInput(contract, [pageSpec({ layoutIntent: ["左图右文采用定制字体"] })]);
    const safeAction = api.reviewPptStyle(safeInput).issues[0].actions.find((action) => action.kind === "restore_role_master");
    assert.equal(safeAction?.deterministic, true);
    assert.equal(api.previewPptStyleRepair(safeInput, [safeAction.id]).operations[0].after, "左图右文");

    const unsafeInput = reviewInput(contract, [pageSpec({ layoutIntent: ["左图右文使用微软雅黑字体"] })]);
    const unsafeIssue = api.reviewPptStyle(unsafeInput).issues[0];
    assert.equal(
        unsafeIssue.actions.some((action) => action.deterministic),
        false,
    );

    const mixedInput = reviewInput(contract, [pageSpec({ layoutIntent: ["左右双栏使用深蓝背景", "对比表使用微软雅黑字体"] })]);
    const mixedPatch = api.previewPptStyleRepair(mixedInput);
    assert.deepEqual(
        mixedPatch.operations.map((operation) => [operation.index, operation.before, operation.after]),
        [[0, "左右双栏使用深蓝背景", "左右双栏"]],
    );
});

test("业务语义色与 Contract 禁止项冲突时给出三种明确选择", () => {
    const contract = api.createPptVisualDirectionPresetContract();
    contract.modelStyle.forbiddenRules.push("禁止红色");
    const page = pageSpec({
        visualEncoding: [{ id: "risk-color", contentBlockIds: ["body"], intent: "differentiate", channel: "color", lockedMapping: [{ contentBlockId: "body", token: "红色", sourceRefIds: ["source"] }] }],
        bodyText: "风险使用红色标记",
        sourceExcerpt: "风险使用红色标记",
    });
    const issue = api.reviewPptStyle(reviewInput(contract, [page])).issues.find((item) => item.code === "semantic_color_conflict");
    assert.ok(issue);
    assert.deepEqual(
        issue.actions.map((action) => action.kind),
        ["keep_semantic_encoding", "change_contract", "use_non_color_encoding"],
    );

    const input = reviewInput(contract, [page]);
    const reviewFingerprint = api.reviewPptStyle(input).reviewFingerprint;
    const keepSemantic = api.applyPptStyleReviewChoice(input, issue.id, "keep_semantic_encoding", reviewFingerprint);
    assert.equal(keepSemantic.contract.modelStyle.forbiddenRules.includes("禁止红色"), false);
    assert.deepEqual(keepSemantic.pageSpecs[0].contentBlocks, page.contentBlocks);
    assert.equal(api.reviewPptStyle({ ...input, contract: keepSemantic.contract, pageSpecs: keepSemantic.pageSpecs, draftRevision: keepSemantic.draftRevision }).blocking, false);

    const useShape = api.applyPptStyleReviewChoice(input, issue.id, "use_non_color_encoding", reviewFingerprint);
    assert.equal(useShape.pageSpecs[0].visualEncoding[0].channel, "shape");
    assert.deepEqual(useShape.pageSpecs[0].visualEncoding[0].lockedMapping, page.visualEncoding[0].lockedMapping);
    assert.equal(api.reviewPptStyle({ ...input, contract: useShape.contract, pageSpecs: useShape.pageSpecs, draftRevision: useShape.draftRevision }).blocking, false);
    assert.throws(() => api.applyPptStyleReviewChoice({ ...input, draftRevision: 2 }, issue.id, "keep_semantic_encoding", reviewFingerprint), /已过期/);
});

test("损坏参考图只在仍属于当前 Contract 时阻断，移除后不会形成死锁", () => {
    const contract = api.createPptVisualDirectionPresetContract();
    contract.references = [{ storageKey: "image:broken" }];
    const input = { ...reviewInput(contract, [pageSpec()]), brokenReferenceKeys: ["image:broken", "image:obsolete"] };
    const review = api.reviewPptStyle(input);
    assert.deepEqual(
        review.issues.filter((issue) => issue.code === "reference_unreadable").map((issue) => issue.fragment),
        ["image:broken"],
    );
    const patch = api.previewPptStyleRepair(input);
    const changedReference = structuredClone(patch);
    changedReference.operations[0].storageKey = "image:healthy";
    assert.throws(() => api.applyPptStyleRepair(input, changedReference), /篡改/);
    const repaired = api.applyPptStyleRepair(input, patch);
    assert.equal(api.reviewPptStyle({ ...input, contract: repaired.contract, pageSpecs: repaired.pageSpecs, draftRevision: repaired.draftRevision }).blocking, false);
});

test("未知 block、视觉编码新增文案和旧内容版本都在检查阶段阻断", () => {
    const contract = api.createPptVisualDirectionPresetContract();
    const unknown = pageSpec({ visualEncoding: [{ id: "bad", contentBlockIds: ["unknown"], intent: "emphasize", channel: "size", label: "新增标签" }] });
    const review = api.reviewPptStyle({ ...reviewInput(contract, [unknown]), reviewedContentRevision: "old" });
    assert.equal(
        review.issues.some((issue) => issue.code === "invalid_visual_encoding"),
        true,
    );
    const stale = review.issues.find((issue) => issue.code === "stale_content_revision");
    assert.ok(stale);
    assert.deepEqual(
        stale.actions.map((action) => action.kind),
        ["recheck_current_contract", "regenerate_candidates"],
    );
});

function reviewInput(contract, pageSpecs) {
    return { contract, contentRevision: "content:r1", reviewedContentRevision: "content:r1", draftRevision: 1, pageSpecs, brokenReferenceKeys: [] };
}

function pageSpec({ layoutIntent = ["左右双栏"], visualEncoding = [], bodyText = "项目结论", sourceExcerpt = "项目结论" } = {}) {
    return {
        pageId: "page-1",
        version: 1,
        purpose: "说明项目结论",
        contentForm: "narrative",
        sourceRefs: [{ id: "source", source: "material", relation: "verbatim", excerpt: sourceExcerpt, startLine: 1, endLine: 1 }],
        contentBlocks: [
            { id: "title", kind: "title", text: "项目标题", sourceRefIds: ["source"] },
            { id: "claim", kind: "primary_claim", text: "项目结论", sourceRefIds: ["source"] },
            { id: "body", kind: "body", text: bodyText, sourceRefIds: ["source"] },
        ],
        contentState: { status: "approved", approvedAt: "2026-07-22T00:00:00.000Z" },
        lockedFacts: [],
        layoutRole: "content",
        layoutIntent,
        visualEncoding,
        assetRefs: [],
        freedom: "不得新增事实",
    };
}
