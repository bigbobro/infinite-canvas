import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let applyPptContentAction;
let applyPptContentRepair;
let applyPptCanonicalPageTextEdit;
let approvePptCanonicalPageContent;
let buildPptDeckProject;
let buildPptPageWorkspace;
let compilePptPromptSnapshot;
let createPptContentRepairPreview;
let derivePptLockedFacts;
let finalizePptContentDraft;
let hashPptSourceText;
let getPptCanonicalPageText;
let normalizePptContentDraft;
let previewPptContentAction;
let replacePptContentDraftPage;
let resolvePptInformationGap;
let selectPptPageDescriptor;
let validatePptContentDraft;
let validatePptPageSpec;
let vite;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({
        applyPptContentAction,
        applyPptContentRepair,
        createPptContentRepairPreview,
        derivePptLockedFacts,
        finalizePptContentDraft,
        normalizePptContentDraft,
        previewPptContentAction,
        replacePptContentDraftPage,
        resolvePptInformationGap,
        validatePptContentDraft,
        validatePptPageSpec,
    } = await vite.ssrLoadModule("/src/lib/ppt/content-plan.ts"));
    ({ compilePptPromptSnapshot } = await vite.ssrLoadModule("/src/lib/ppt/prompt-compiler.ts"));
    ({ buildPptDeckProject, hashPptSourceText } = await vite.ssrLoadModule("/src/lib/ppt/deck-builder.ts"));
    ({ applyPptCanonicalPageTextEdit, approvePptCanonicalPageContent, buildPptPageWorkspace, getPptCanonicalPageText } = await vite.ssrLoadModule("/src/lib/ppt/page-workspace.ts"));
    ({ selectPptPageDescriptor } = await vite.ssrLoadModule("/src/lib/ppt/page-descriptor.ts"));
});

after(async () => {
    await vite?.close();
});

test("Content Plan 由原文切片构造溯源，未确认建议不能 finalize", () => {
    const draft = createDraft();
    const page = draft.pageSpecs[0];
    const title = page.contentBlocks.find((block) => block.kind === "title");
    const claim = page.contentBlocks.find((block) => block.kind === "primary_claim");

    assert.ok(page.pageId);
    assert.equal(page.contentBlocks.filter((block) => block.kind === "title").length, 1);
    assert.equal(page.contentBlocks.filter((block) => block.kind === "primary_claim").length, 1);
    assert.equal(title.text, "中转站介绍");
    assert.equal(claim.text, "梳理思路、招募伙伴并展示未来空间");
    assert.equal(page.visualEncoding[0].intent, "differentiate");
    assert.equal(page.visualEncoding[0].channel, "color");
    assert.equal(page.visualEncoding[0].contentBlockIds.length, 1);
    assert.equal(page.contentState.status, "blocked");
    assert.equal(validatePptContentDraft(draft).valid, false);
    assert.throws(() => finalizePptContentDraft(draft), /尚未处理|不能确认/);

    const gap = draft.audit.gaps.find((item) => item.proposedAnswer === "CPA、SUB2API 与 NEWAPI");
    const resolved = resolvePptInformationGap(draft, gap.id, {
        kind: "confirmed_assumption",
        text: gap.proposedAnswer,
        resolvedAt: "2026-07-22T08:00:00.000Z",
    });
    const finalized = finalizePptContentDraft(resolved, "2026-07-22T08:01:00.000Z");
    const finalizedPage = finalized.pageSpecs[0];
    assert.equal(finalizedPage.contentState.status, "approved");
    assert.ok(finalizedPage.sourceRefs.some((sourceRef) => sourceRef.source === "confirmed_assumption"));
    assert.ok(finalizedPage.lockedFacts.some((fact) => fact.kind === "term" && fact.value === "CPA"));
});

test("伪造行号和有效但无关的来源都降级为 blocking gap", () => {
    for (const primaryClaimSource of [
        { source: "material", startLine: 99, endLine: 99 },
        { source: "material", startLine: 1, endLine: 1 },
    ]) {
        const draft = normalizePptContentDraft(
            {
                brief: { audience: "潜在合作伙伴", goal: "说清投入并邀请加入", narrative: "从方案到投入" },
                pages: [
                    {
                        title: "中转站介绍",
                        titleSource: { source: "material", startLine: 1, endLine: 1 },
                        purpose: "说明项目价值",
                        primaryClaim: "需要 8 台服务器",
                        primaryClaimSource,
                        contentForm: "narrative",
                        blocks: [],
                    },
                ],
            },
            sourceInput(),
        );
        assert.equal(draft.pageSpecs[0].contentState.status, "blocked");
        assert.ok(draft.audit.gaps.some((gap) => gap.kind === "unsupported_claim" && gap.blocking));
        assert.equal(
            draft.pageSpecs[0].lockedFacts.some((fact) => fact.value.includes("8")),
            false,
        );
    }
});

test("四种缺口处理都保留来源边界，必填内容不能陷入占位死路", () => {
    const proposedDraft = createDraft();
    const proposedGap = proposedDraft.audit.gaps.find((gap) => gap.proposedAnswer);
    const confirmed = resolvePptInformationGap(proposedDraft, proposedGap.id, { kind: "confirmed_assumption", text: proposedGap.proposedAnswer, resolvedAt: "2026-07-22T08:00:00.000Z" });
    assert.ok(confirmed.pageSpecs[0].sourceRefs.some((source) => source.source === "confirmed_assumption"));

    const answeredDraft = createDraft();
    const answeredGap = answeredDraft.audit.gaps.find((gap) => gap.proposedAnswer);
    const answered = resolvePptInformationGap(answeredDraft, answeredGap.id, { kind: "user_answer", text: "CPA 与 SUB2API", resolvedAt: "2026-07-22T08:00:00.000Z" });
    assert.ok(answered.pageSpecs[0].sourceRefs.some((source) => source.source === "user_answer"));

    const unboundRaw = rawDraft();
    unboundRaw.pages[0].gaps.push({ key: "resources", kind: "missing_detail", question: "服务器投入是多少？", reason: "材料未提供", blocking: true, proposedAnswer: "先投入 2 台服务器" });
    const unboundDraft = normalizePptContentDraft(unboundRaw, sourceInput());
    const unboundGap = unboundDraft.audit.gaps.find((gap) => gap.question === "服务器投入是多少？");
    const enriched = resolvePptInformationGap(unboundDraft, unboundGap.id, { kind: "confirmed_assumption", text: unboundGap.proposedAnswer, resolvedAt: "2026-07-22T08:00:00.000Z" });
    assert.ok(enriched.pageSpecs[0].contentBlocks.some((block) => block.gapId === unboundGap.id && block.text === "先投入 2 台服务器"));
    assert.ok(enriched.pageSpecs[0].lockedFacts.some((fact) => fact.value === "2 台"));

    const optionalRaw = rawDraft();
    optionalRaw.pages[0].blocks.push({ key: "optional", kind: "placeholder", text: "待补资源投入", gapKey: "optional" });
    optionalRaw.pages[0].gaps.push({ key: "optional", kind: "missing_detail", question: "资源投入是什么？", reason: "材料未提供", blocking: true });
    const optionalDraft = normalizePptContentDraft(optionalRaw, sourceInput());
    const optionalGap = optionalDraft.audit.gaps.find((gap) => gap.question === "资源投入是什么？");
    const placeholder = resolvePptInformationGap(optionalDraft, optionalGap.id, { kind: "placeholder", text: "待补充", resolvedAt: "2026-07-22T08:00:00.000Z" });
    assert.equal(placeholder.pageSpecs[0].contentBlocks.find((block) => block.gapId === optionalGap.id).kind, "placeholder");
    const omitted = resolvePptInformationGap(optionalDraft, optionalGap.id, { kind: "omit", resolvedAt: "2026-07-22T08:00:00.000Z" });
    assert.equal(
        omitted.pageSpecs[0].contentBlocks.some((block) => block.gapId === optionalGap.id),
        false,
    );

    const requiredDraft = normalizePptContentDraft(
        {
            brief: rawDraft().brief,
            pages: [{ ...rawDraft().pages[0], primaryClaim: "未经确认的核心信息", primaryClaimSource: undefined }],
        },
        sourceInput(),
    );
    const requiredGap = requiredDraft.audit.gaps.find((gap) => gap.proposedAnswer === "未经确认的核心信息");
    assert.throws(() => resolvePptInformationGap(requiredDraft, requiredGap.id, { kind: "placeholder", text: "待补充", resolvedAt: "2026-07-22T08:00:00.000Z" }), /不能省略或保留占位/);
    assert.throws(() => resolvePptInformationGap(requiredDraft, requiredGap.id, { kind: "omit", resolvedAt: "2026-07-22T08:00:00.000Z" }), /不能省略或保留占位/);
});

test("中转站分镜会点名重复页、异常文本、信息缺口和越界审美描述", () => {
    const materialLines = ["中转站介绍", "技术组件选型", "组件对比与推荐", "整体架构方案", "所需资源投入", "资源与成本投入", "合作伙伴招募要点", "未来规划与发展空间", "H对比列表", "梳理思路、招募合作伙伴、展示未来空间"];
    const source = (text) => {
        const line = materialLines.indexOf(text) + 1;
        return { source: "material", startLine: line, endLine: line };
    };
    const page = (title, purpose, gap) => ({
        title,
        titleSource: source(title),
        purpose,
        primaryClaim: title,
        primaryClaimSource: source(title),
        contentForm: "narrative",
        blocks: [],
        gaps: gap ? [gap] : [],
    });
    const pages = [
        page("中转站介绍", "说清目标", null),
        page("技术组件选型", "组件选型与组件对比", { key: "components", kind: "missing_detail", question: "候选组件有哪些？", reason: "材料未提供组件", blocking: true }),
        {
            ...page("组件对比与推荐", "组件选型与组件对比", { key: "capacity", kind: "missing_detail", question: "目标容量和架构约束是什么？", reason: "对比缺少标准", blocking: true }),
            contentForm: "comparison",
            blocks: [{ key: "noise", kind: "body", text: "H对比列表", source: source("H对比列表") }],
            layoutIntent: ["左右对比", "深蓝科技风"],
            visualEncoding: [{ contentKeys: ["noise"], intent: "differentiate", channel: "color" }],
        },
        page("整体架构方案", "架构关系", { key: "architecture", kind: "missing_detail", question: "架构约束和数据流是什么？", reason: "材料未提供", blocking: true }),
        page("所需资源投入", "资源投入与成本", { key: "resources", kind: "missing_detail", question: "服务器投入和目标容量是多少？", reason: "材料未提供", blocking: true }),
        page("资源与成本投入", "资源投入与成本", { key: "cost", kind: "missing_detail", question: "成本口径和人力投入是什么？", reason: "材料未提供", blocking: true }),
        page("合作伙伴招募要点", "合作机制", { key: "partner", kind: "missing_detail", question: "合作条件与权益是什么？", reason: "材料未提供", blocking: true }),
        page("未来规划与发展空间", "发展路线", { key: "roadmap", kind: "missing_detail", question: "路线图里程碑是什么？", reason: "材料未提供", blocking: true }),
    ];
    const draft = normalizePptContentDraft({ brief: { audience: "合作伙伴", goal: "招募与 Pitching", narrative: "从方案到投入" }, pages }, { title: "中转站", sourceMaterial: materialLines.join("\n"), requirements: "" });
    const duplicateIssues = draft.audit.issues.filter((issue) => issue.code === "duplicate_page");
    assert.ok(duplicateIssues.some((issue) => issue.pageIds.includes(draft.pageSpecs[1].pageId) && issue.pageIds.includes(draft.pageSpecs[2].pageId)));
    assert.ok(duplicateIssues.some((issue) => issue.pageIds.includes(draft.pageSpecs[4].pageId) && issue.pageIds.includes(draft.pageSpecs[5].pageId)));
    assert.ok(draft.audit.issues.some((issue) => issue.code === "noise_text" && /H对比列表/.test(issue.message)));
    assert.ok(draft.audit.issues.some((issue) => issue.code === "deck_style_signal" && issue.repair));
    assert.ok(draft.pageSpecs[2].visualEncoding.some((encoding) => encoding.intent === "differentiate" && encoding.channel === "color"));
    for (const phrase of ["候选组件", "架构约束", "目标容量", "服务器投入", "成本口径", "合作条件", "路线图里程碑"]) {
        assert.ok(
            draft.audit.gaps.some((gap) => gap.question.includes(phrase)),
            `缺少信息缺口：${phrase}`,
        );
    }
});

test("lockedFacts 只由已批准 ContentBlock 派生，篡改或越权 visualEncoding 在 Compiler 阻断", () => {
    const draft = resolveAllGaps(createDraft());
    const { brief, pageSpecs } = finalizePptContentDraft(draft, "2026-07-22T08:01:00.000Z");
    const pageSpec = pageSpecs[0];
    const deckBrief = deckBriefFrom(brief);
    const target = targetFor(pageSpec);

    assert.deepEqual(pageSpec.lockedFacts, derivePptLockedFacts(pageSpec));

    const tampered = structuredClone(pageSpec);
    tampered.lockedFacts.push({ id: "forged", kind: "number", value: "999 台", sourceExcerpt: "999 台" });
    const factSnapshot = compilePptPromptSnapshot({
        compilePolicy: "structured",
        snapshotId: "snapshot-fact",
        compiledAt: "2026-07-22T08:02:00.000Z",
        deckBrief,
        pageSpecs: [tampered],
        targets: [target],
    });
    assert.ok(factSnapshot.issues.some((issue) => issue.code === "invalid_content_provenance" && issue.severity === "blocking"));

    const encoded = structuredClone(pageSpec);
    encoded.visualEncoding[0].contentBlockIds = ["unknown-block"];
    const encodingSnapshot = compilePptPromptSnapshot({
        compilePolicy: "structured",
        snapshotId: "snapshot-encoding",
        compiledAt: "2026-07-22T08:02:00.000Z",
        deckBrief,
        pageSpecs: [encoded],
        targets: [target],
    });
    assert.ok(encodingSnapshot.issues.some((issue) => issue.code === "invalid_visual_encoding" && issue.severity === "blocking"));

    const duplicatedEncoding = structuredClone(pageSpec);
    duplicatedEncoding.visualEncoding.push(structuredClone(duplicatedEncoding.visualEncoding[0]));
    const duplicatedSnapshot = compilePptPromptSnapshot({
        compilePolicy: "structured",
        snapshotId: "snapshot-encoding-duplicate",
        compiledAt: "2026-07-22T08:02:00.000Z",
        deckBrief,
        pageSpecs: [duplicatedEncoding],
        targets: [target],
    });
    assert.ok(duplicatedSnapshot.issues.some((issue) => issue.code === "invalid_visual_encoding" && issue.severity === "blocking"));
});

test("layoutIntent 不能夹带未批准事实或标签，风格词也不能帮它绕过 Compiler", () => {
    for (const [index, layoutIntent] of [["右侧突出服务器投入 999 台"], ["深蓝科技风，右侧突出服务器投入 999 台"], ["左侧腾讯云，右侧阿里云"], ["右侧展示999个指标"], ["顶部排列999个要点"], ["999个指标水平排列"]].entries()) {
        const raw = rawDraft();
        raw.pages[0].blocks = raw.pages[0].blocks.filter((block) => block.key === "known");
        raw.pages[0].gaps = [];
        raw.pages[0].visualEncoding = [];
        raw.pages[0].layoutIntent = layoutIntent;
        const draft = normalizePptContentDraft(raw, sourceInput());

        assert.ok(validatePptContentDraft(draft).issues.some((issue) => issue.code === "invalid_content_structure" && issue.severity === "blocking"));
        assert.throws(() => finalizePptContentDraft(draft), /排版要求|不能确认/);

        const pageSpec = structuredClone(draft.pageSpecs[0]);
        pageSpec.contentState = { status: "approved", approvedAt: "2026-07-22T08:01:00.000Z" };
        const snapshot = compilePptPromptSnapshot({
            compilePolicy: "structured",
            snapshotId: `snapshot-layout-fact-${index}`,
            compiledAt: "2026-07-22T08:02:00.000Z",
            deckBrief: deckBriefFrom(draft.brief),
            pageSpecs: [pageSpec],
            targets: [targetFor(pageSpec)],
        });
        assert.ok(snapshot.issues.some((issue) => issue.severity === "blocking" && issue.code === "invalid_content_structure"));
        assert.doesNotMatch(snapshot.prompts[0].finalPrompt, /999\s*(?:台|个)|腾讯云|阿里云/);
    }
});

test("正文改写会清理旧 lockedMapping，缺口不呈现时同步裁剪 visualEncoding", () => {
    const raw = rawDraft();
    raw.pages[0].visualEncoding[0].lockedMapping = [{ contentKey: "known", token: "原材料未提供候选组件", source: { source: "material", startLine: 3, endLine: 3 } }];
    const draft = normalizePptContentDraft(raw, sourceInput());
    const known = draft.pageSpecs[0].contentBlocks.find((block) => block.text === "原材料未提供候选组件");
    const mappedPage = { ...draft.pageSpecs[0], contentState: { status: "approved", approvedAt: "2026-07-22T08:03:00.000Z" } };
    assert.deepEqual(mappedPage.visualEncoding[0].lockedMapping[0].sourceRefIds, known.sourceRefIds);
    assert.equal(
        validatePptPageSpec(mappedPage).some((issue) => issue.code === "invalid_visual_encoding"),
        false,
    );
    const edited = applyPptContentAction(
        draft,
        previewPptContentAction(draft, {
            kind: "edit_block",
            pageId: draft.pageSpecs[0].pageId,
            blockId: known.id,
            text: "用户重新确认的内容",
            editedAt: "2026-07-22T08:04:00.000Z",
        }),
    );
    assert.equal(edited.pageSpecs[0].visualEncoding[0].lockedMapping, undefined);
    const finalized = finalizePptContentDraft(resolveAllGaps(edited), "2026-07-22T08:05:00.000Z");
    const snapshot = compilePptPromptSnapshot({
        compilePolicy: "structured",
        snapshotId: "snapshot-pruned-mapping",
        compiledAt: "2026-07-22T08:06:00.000Z",
        deckBrief: deckBriefFrom(finalized.brief),
        pageSpecs: finalized.pageSpecs,
        targets: [targetFor(finalized.pageSpecs[0])],
    });
    assert.equal(
        snapshot.issues.some((issue) => issue.severity === "blocking"),
        false,
    );
    assert.doesNotMatch(snapshot.prompts[0].finalPrompt, /原材料未提供候选组件/);

    const optionalRaw = rawDraft();
    optionalRaw.pages[0].blocks.push({ key: "optional", kind: "placeholder", text: "待补充资源", gapKey: "optional" });
    optionalRaw.pages[0].gaps.push({ key: "optional", kind: "missing_detail", question: "资源投入是否呈现？", reason: "材料未提供", blocking: true });
    optionalRaw.pages[0].visualEncoding.push({ contentKeys: ["optional"], intent: "emphasize", channel: "position" });
    const optionalDraft = normalizePptContentDraft(optionalRaw, sourceInput());
    const optionalGap = optionalDraft.audit.gaps.find((gap) => gap.question === "资源投入是否呈现？");
    const optionalBlockId = optionalDraft.pageSpecs[0].contentBlocks.find((block) => block.gapId === optionalGap.id).id;
    const omitted = resolvePptInformationGap(optionalDraft, optionalGap.id, { kind: "omit", resolvedAt: "2026-07-22T08:07:00.000Z" });
    assert.equal(
        omitted.pageSpecs[0].visualEncoding.some((encoding) => encoding.contentBlockIds.includes(optionalBlockId)),
        false,
    );
});

test("缺口 ID 不会因规范化碰撞，项目背景也不会被误判为视觉风格", () => {
    const raw = rawDraft();
    raw.pages[0].gaps.push({ key: "a b", kind: "missing_detail", question: "问题 A", reason: "待确认", blocking: true }, { key: "a-b", kind: "missing_detail", question: "问题 B", reason: "待确认", blocking: true });
    raw.pages[0].layoutIntent = ["左侧项目背景，右侧目标"];
    const draft = normalizePptContentDraft(raw, sourceInput());
    const gaps = [draft.audit.gaps.find((gap) => gap.question === "问题 A"), draft.audit.gaps.find((gap) => gap.question === "问题 B")];
    assert.notEqual(gaps[0].id, gaps[1].id);
    const first = resolvePptInformationGap(draft, gaps[0].id, { kind: "user_answer", text: "答案 A", resolvedAt: "2026-07-22T08:00:00.000Z" });
    assert.doesNotThrow(() => resolvePptInformationGap(first, gaps[1].id, { kind: "user_answer", text: "答案 B", resolvedAt: "2026-07-22T08:01:00.000Z" }));
    assert.equal(
        draft.audit.issues.some((issue) => issue.code === "deck_style_signal"),
        false,
    );
});

test("安全 repair 绑定 draft revision，过期 patch 原子失败", () => {
    const draft = normalizePptContentDraft(
        {
            brief: { audience: "合作伙伴", goal: "介绍项目", narrative: "方案" },
            pages: [
                {
                    title: "中转站介绍",
                    titleSource: { source: "material", startLine: 1, endLine: 1 },
                    purpose: "说明项目",
                    primaryClaim: "梳理思路、招募伙伴并展示未来空间",
                    primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                    contentForm: "narrative",
                    layoutIntent: ["左右分栏", "深蓝科技风"],
                    blocks: [],
                },
            ],
        },
        sourceInput(),
    );
    const issue = draft.audit.issues.find((item) => item.code === "deck_style_signal");
    const preview = createPptContentRepairPreview(draft, [issue.id]);
    const repaired = applyPptContentRepair(draft, preview);
    assert.deepEqual(repaired.pageSpecs[0].layoutIntent, ["左右分栏"]);
    assert.ok(repaired.brief.visualSignals.includes("深蓝科技风"));
    assert.throws(() => applyPptContentRepair(repaired, preview), /已变更|过期/);

    const finalized = finalizePptContentDraft(resolveAllGaps(draft), "2026-07-22T08:01:00.000Z");
    assert.deepEqual(finalized.pageSpecs[0].layoutIntent, ["左右分栏"]);
    assert.ok(finalized.brief.visualSignals.includes("深蓝科技风"));

    const combined = structuredClone(draft);
    combined.pageSpecs[0].layoutIntent = ["左右对比 · 深蓝科技风", "深蓝科技风，右侧突出服务器投入 999 台"];
    const combinedDraft = normalizePptContentDraft(
        {
            brief: { audience: "合作伙伴", goal: "介绍项目", narrative: "方案" },
            pages: [
                {
                    title: "中转站介绍",
                    titleSource: { source: "material", startLine: 1, endLine: 1 },
                    purpose: "说明项目",
                    primaryClaim: "梳理思路、招募伙伴并展示未来空间",
                    primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                    contentForm: "narrative",
                    layoutIntent: combined.pageSpecs[0].layoutIntent,
                    blocks: [],
                },
            ],
        },
        sourceInput(),
    );
    const combinedIssues = combinedDraft.audit.issues.filter((item) => item.code === "deck_style_signal");
    const combinedRepaired = applyPptContentRepair(
        combinedDraft,
        createPptContentRepairPreview(
            combinedDraft,
            combinedIssues.map((issue) => issue.id),
        ),
    );
    assert.deepEqual(combinedRepaired.pageSpecs[0].layoutIntent, ["左右对比", "右侧突出服务器投入 999 台"]);
    assert.deepEqual(combinedRepaired.brief.visualSignals, ["深蓝科技风"]);
    assert.equal(validatePptContentDraft(combinedRepaired).valid, false);
});

test("本地编辑 command 绑定 revision，不要求 UI 直接 spread PageSpec", () => {
    const draft = createDraft();
    const block = draft.pageSpecs[0].contentBlocks.find((item) => item.kind === "primary_claim");
    const preview = previewPptContentAction(draft, {
        kind: "edit_block",
        pageId: draft.pageSpecs[0].pageId,
        blockId: block.id,
        text: "用户重新确认的核心信息",
        editedAt: "2026-07-22T08:04:00.000Z",
    });
    const edited = applyPptContentAction(draft, preview);
    assert.equal(edited.revision, draft.revision + 1);
    assert.equal(edited.pageSpecs[0].contentBlocks.find((item) => item.id === block.id).text, "用户重新确认的核心信息");
    assert.ok(edited.pageSpecs[0].sourceRefs.some((sourceRef) => sourceRef.source === "user_answer"));
    assert.throws(() => applyPptContentAction(edited, preview), /已变更|过期/);
});

test("显式合并与单页替换都按 pageId 执行，不覆盖其他页", () => {
    const secondRaw = structuredClone(rawDraft().pages[0]);
    secondRaw.title = "第二页";
    secondRaw.titleSource = { source: "material", startLine: 4, endLine: 4 };
    secondRaw.primaryClaim = "第二页保留内容";
    secondRaw.primaryClaimSource = { source: "material", startLine: 5, endLine: 5 };
    secondRaw.blocks = [];
    secondRaw.gaps = [];
    secondRaw.visualEncoding = [];
    const twoPages = normalizePptContentDraft({ brief: rawDraft().brief, pages: [rawDraft().pages[0], secondRaw] }, twoPageSourceInput());
    const [firstId, secondId] = twoPages.pageSpecs.map((page) => page.pageId);
    const mergePreview = previewPptContentAction(twoPages, { kind: "merge_pages", pageIds: [firstId, secondId] });
    const merged = applyPptContentAction(twoPages, mergePreview);
    assert.deepEqual(
        merged.pageSpecs.map((page) => page.pageId),
        [firstId],
    );
    assert.equal(merged.pageSpecs[0].contentBlocks.filter((block) => block.kind === "title").length, 1);
    assert.equal(merged.pageSpecs[0].contentBlocks.filter((block) => block.kind === "primary_claim").length, 1);
    assert.ok(merged.pageSpecs[0].contentBlocks.some((block) => block.text === "第二页保留内容" && block.kind === "supporting_claim"));
    assert.throws(() => applyPptContentAction(merged, mergePreview), /已变更|过期/);

    const replacementDraft = normalizePptContentDraft({ brief: rawDraft().brief, pages: [secondRaw] }, { ...twoPageSourceInput(), previousPageSpecs: [twoPages.pageSpecs[1]] });
    const replaced = replacePptContentDraftPage(twoPages, twoPages.revision, secondId, replacementDraft.pageSpecs[0], replacementDraft.audit.gaps);
    assert.deepEqual(replaced.pageSpecs[0], twoPages.pageSpecs[0]);
    assert.equal(replaced.pageSpecs[1].pageId, secondId);
    assert.equal(replaced.pageSpecs[1].version, twoPages.pageSpecs[1].version + 1);
    assert.throws(() => replacePptContentDraftPage(replaced, twoPages.revision, secondId, replacementDraft.pageSpecs[0], replacementDraft.audit.gaps), /已变更|过期/);
});

test("structured/verbatim Builder 与 Snapshot 只消费 canonical source，exactText 逐字不受节点投影影响", () => {
    const exactText = "【第 1 页】\n标题与全角空格  \n不得改写";
    const partial = buildPptDeckProject({
        compilePolicy: "verbatim",
        title: "逐字稿",
        sourceMaterial: exactText,
        requirements: "",
        verbatimSpecs: [
            {
                pageId: "page-verbatim",
                version: 1,
                title: "第 1 页",
                exactText,
                origin: { kind: "source_slice", sourceHash: hashPptSourceText(exactText), startLine: 1, endLine: 3 },
            },
        ],
        confirmedGlobalSpec: "全局规则",
    });
    const ppt = partial.ppt;
    assert.equal(ppt.compilePolicy, "verbatim");
    assert.equal("deckBrief" in ppt, false);
    assert.deepEqual(Object.keys(ppt.pages[0]).sort(), ["index", "pageId", "takes"]);
    assert.equal(selectPptPageDescriptor(ppt, "page-verbatim").title, "第 1 页");

    const outlineNode = partial.nodes.find((node) => node.metadata?.pptRole === "outline");
    outlineNode.metadata.content = "节点被篡改";
    const target = { pageId: "page-verbatim", takeId: ppt.pages[0].takes[0].takeId, semanticText: "节点被篡改", layoutIntent: [], extraTexts: [] };
    const snapshot = compilePptPromptSnapshot({
        compilePolicy: "verbatim",
        snapshotId: "snapshot-verbatim",
        compiledAt: "2026-07-22T08:03:00.000Z",
        verbatimSpecs: ppt.verbatimSpecs,
        confirmedGlobalSpec: ppt.confirmedGlobalSpec,
        targets: [target],
    });
    assert.equal(snapshot.prompts[0].finalPrompt, `${exactText}\n\n全局规则`);
    assert.equal(snapshot.prompts[0].finalPrompt.split("全局规则").length - 1, 1);
    assert.equal(snapshot.compilePolicy, "verbatim");
    assert.equal("pageSpecs" in snapshot, false);

    const editedText = "【第 1 页】\n用户修订后保留尾部空格  ";
    const editedPpt = applyPptCanonicalPageTextEdit(ppt, "page-verbatim", 1, editedText);
    assert.equal(editedPpt.verbatimSpecs[0].version, 2);
    assert.equal(editedPpt.verbatimSpecs[0].exactText, editedText);
    assert.deepEqual(editedPpt.verbatimSpecs[0].origin, { kind: "user_edited" });
    assert.equal(selectPptPageDescriptor(editedPpt, "page-verbatim").title, "第 1 页");
});

test("PPT 工作台的 structured 文本是 canonical PageSpec 投影，编辑会返回 reviewable 并重建溯源", () => {
    const draft = resolveAllGaps(createDraft());
    const { brief, pageSpecs } = finalizePptContentDraft(draft, "2026-07-22T08:01:00.000Z");
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "内容投影测试",
        sourceMaterial: sourceInput().sourceMaterial,
        requirements: sourceInput().requirements,
        deckBrief: deckBriefFrom(brief),
        pageSpecs,
    });
    const originalPpt = partial.ppt;
    const pageId = originalPpt.pages[0].pageId;
    const originalVersion = originalPpt.pageSpecs[0].version;
    const editedText = "新标题\n用户确认的核心判断\n设备在线率 98.5%";
    const editedPpt = applyPptCanonicalPageTextEdit(originalPpt, pageId, originalVersion, editedText);

    assert.equal(originalPpt.pageSpecs[0].version, originalVersion);
    assert.equal(editedPpt.pageSpecs[0].version, originalVersion + 1);
    assert.deepEqual(editedPpt.pageSpecs[0].contentState, { status: "reviewable" });
    assert.equal(getPptCanonicalPageText(editedPpt, pageId), editedText);
    assert.ok(editedPpt.pageSpecs[0].contentBlocks.every((block) => block.sourceRefIds.length === 1));
    assert.ok(editedPpt.pageSpecs[0].sourceRefs.every((sourceRef) => sourceRef.source === "user_answer"));
    assert.ok(editedPpt.pageSpecs[0].lockedFacts.some((fact) => fact.kind === "number" && fact.value === "98.5%"));
    assert.deepEqual(editedPpt.pageSpecs[0].visualEncoding, []);

    const approved = approvePptCanonicalPageContent(editedPpt, pageId, originalVersion + 1, "2026-07-22T09:00:00.000Z");
    assert.deepEqual(approved.pageSpecs[0].contentState, { status: "approved", approvedAt: "2026-07-22T09:00:00.000Z" });
    assert.equal(approved.pageSpecs[0].version, originalVersion + 2);

    const project = { ...partial, ppt: editedPpt };
    const workspace = buildPptPageWorkspace(project, editedPpt.pages[0]);
    assert.equal(workspace.canonicalPrompt, editedText);
    assert.equal(workspace.takes[0].prompt, editedText);
    assert.ok(workspace.takes[0].issues.some((issue) => issue.includes("投影与 canonical")));
});

test("PPT 工作台遇到 ledger/spec 漂移时不崩溃，且不使用节点文本回退", () => {
    const draft = resolveAllGaps(createDraft());
    const { brief, pageSpecs } = finalizePptContentDraft(draft, "2026-07-22T08:01:00.000Z");
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "损坏工程测试",
        sourceMaterial: sourceInput().sourceMaterial,
        requirements: sourceInput().requirements,
        deckBrief: deckBriefFrom(brief),
        pageSpecs,
    });
    const brokenPpt = { ...partial.ppt, pageSpecs: [] };
    const workspace = buildPptPageWorkspace({ ...partial, ppt: brokenPpt }, brokenPpt.pages[0]);

    assert.equal(workspace.descriptor.status, "invalid");
    assert.equal(workspace.canonicalPrompt, "");
    assert.equal(workspace.takes[0].prompt, "");
    assert.equal(workspace.takes[0].canEditPrompt, false);
    assert.ok(workspace.contentIssues.some((issue) => issue.includes("需要修复")));

    const malformedPpt = { ...partial.ppt, pageSpecs: [{ ...pageSpecs[0], contentBlocks: [...pageSpecs[0].contentBlocks, null] }] };
    const malformedDescriptor = selectPptPageDescriptor(malformedPpt, malformedPpt.pages[0].pageId);
    const malformedWorkspace = buildPptPageWorkspace({ ...partial, ppt: malformedPpt }, malformedPpt.pages[0]);
    assert.equal(malformedDescriptor.status, "invalid");
    assert.equal(malformedWorkspace.descriptor.status, "invalid");
    assert.equal(malformedWorkspace.canonicalPrompt, "");

    const nullTakePpt = { ...partial.ppt, pages: [{ ...partial.ppt.pages[0], takes: [null] }] };
    const nullTakeWorkspace = buildPptPageWorkspace({ ...partial, ppt: nullTakePpt }, nullTakePpt.pages[0]);
    assert.equal(nullTakeWorkspace.descriptor.status, "invalid");
    assert.deepEqual(nullTakeWorkspace.takes, []);
});

function createDraft() {
    return normalizePptContentDraft(rawDraft(), sourceInput());
}

function rawDraft() {
    return {
        brief: { audience: "潜在合作伙伴", goal: "说清投入并邀请加入", narrative: "从方案到投入" },
        pages: [
            {
                title: "中转站介绍",
                titleSource: { source: "material", startLine: 1, endLine: 1 },
                purpose: "说明项目价值",
                primaryClaim: "梳理思路、招募伙伴并展示未来空间",
                primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                contentForm: "comparison",
                layoutIntent: ["左右分栏"],
                blocks: [
                    { key: "known", kind: "supporting_claim", text: "原材料未提供候选组件", source: { source: "material", startLine: 3, endLine: 3 } },
                    { key: "components", kind: "placeholder", text: "待确认组件候选", gapKey: "components" },
                ],
                visualEncoding: [{ contentKeys: ["known"], intent: "differentiate", channel: "color" }],
                gaps: [{ key: "components", kind: "missing_detail", question: "候选组件有哪些？", reason: "组件对比需要具体候选项", blocking: true, proposedAnswer: "CPA、SUB2API 与 NEWAPI" }],
            },
        ],
    };
}

function resolveAllGaps(draft) {
    return draft.audit.gaps.reduce(
        (current, gap) =>
            gap.resolution
                ? current
                : resolvePptInformationGap(current, gap.id, {
                      kind: "confirmed_assumption",
                      text: gap.proposedAnswer || "用户已确认",
                      resolvedAt: "2026-07-22T08:00:00.000Z",
                  }),
        draft,
    );
}

function sourceInput() {
    return {
        title: "中转站介绍",
        sourceMaterial: "中转站介绍\n梳理思路、招募伙伴并展示未来空间\n原材料未提供候选组件",
        requirements: "受众：潜在合作伙伴\n目标：说清投入并邀请加入\n叙事：从方案到投入",
    };
}

function twoPageSourceInput() {
    return {
        ...sourceInput(),
        sourceMaterial: `${sourceInput().sourceMaterial}\n第二页\n第二页保留内容`,
    };
}

function deckBriefFrom(brief) {
    return {
        version: 1,
        sourceHash: brief.sourceHash,
        audience: brief.audience,
        goal: brief.goal,
        narrative: brief.narrative,
        styleContract: { source: { kind: "custom" }, direction: "清晰、专业、克制", references: [] },
        globalRules: [],
        forbiddenRules: [],
        lockedDeckFacts: [],
    };
}

function targetFor(pageSpec) {
    return {
        pageId: pageSpec.pageId,
        takeId: "take-1",
        semanticText: pageSpec.contentBlocks
            .filter((block) => block.kind !== "placeholder")
            .map((block) => block.text)
            .join("\n"),
        layoutIntent: [],
        extraTexts: [],
    };
}
