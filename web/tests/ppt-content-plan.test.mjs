import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let applyPptContentAction;
let applyPptContentRepair;
let assertPptPageAuditIssuesResolved;
let applyPptCanonicalPageTextEdit;
let applyPptCanonicalPageRewrite;
let acceptPptPageSuggestions;
let approvePptCanonicalPageContent;
let auditPptPageCopyReadiness;
let buildPptDeckProject;
let buildPptPageWorkspace;
let compilePptPromptSnapshot;
let createPptContentRepairPreview;
let createPptVisualDirectionPresetContract;
let derivePptLockedFacts;
let finalizePptContentDraft;
let hashPptSourceText;
let getPptCanonicalPageText;
let isPptAuthoringInstruction;
let isPptLayoutIntentSupported;
let normalizePptContentDraft;
let previewPptContentAction;
let replacePptContentDraftPage;
let resolvePptInformationGap;
let selectPptPageDescriptor;
let selectPptPageRepairAuditIssues;
let pptPageRepairActionLabel;
let renderPptPageSpecText;
let validatePptContentDraft;
let validatePptPageSpec;
let vite;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({
        acceptPptPageSuggestions,
        applyPptContentAction,
        applyPptContentRepair,
        assertPptPageAuditIssuesResolved,
        auditPptPageCopyReadiness,
        createPptContentRepairPreview,
        derivePptLockedFacts,
        finalizePptContentDraft,
        isPptAuthoringInstruction,
        isPptLayoutIntentSupported,
        normalizePptContentDraft,
        previewPptContentAction,
        replacePptContentDraftPage,
        resolvePptInformationGap,
        selectPptPageRepairAuditIssues,
        pptPageRepairActionLabel,
        renderPptPageSpecText,
        validatePptContentDraft,
        validatePptPageSpec,
    } = await vite.ssrLoadModule("/src/lib/ppt/content-plan.ts"));
    ({ compilePptPromptSnapshot } = await vite.ssrLoadModule("/src/lib/ppt/prompt-compiler.ts"));
    ({ buildPptDeckProject, hashPptSourceText } = await vite.ssrLoadModule("/src/lib/ppt/deck-builder.ts"));
    ({ applyPptCanonicalPageRewrite, applyPptCanonicalPageTextEdit, approvePptCanonicalPageContent, buildPptPageWorkspace, getPptCanonicalPageText } = await vite.ssrLoadModule("/src/lib/ppt/page-workspace.ts"));
    ({ selectPptPageDescriptor } = await vite.ssrLoadModule("/src/lib/ppt/page-descriptor.ts"));
    ({ createPptVisualDirectionPresetContract } = await vite.ssrLoadModule("/src/lib/ppt/style-contract.ts"));
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

test("居中布局等纯几何要求可直接通过，仍不放行夹带事实", () => {
    const draft = normalizePptContentDraft(
        {
            brief: rawDraft().brief,
            pages: [{ ...rawDraft().pages[0], gaps: [], blocks: rawDraft().pages[0].blocks.filter((block) => block.key === "known"), visualEncoding: [], layoutIntent: ["居中布局"] }],
        },
        sourceInput(),
    );
    const page = draft.pageSpecs[0];

    assert.equal(isPptLayoutIntentSupported(page, "居中布局"), true);
    assert.equal(isPptLayoutIntentSupported(page, "居中布局并突出服务器投入 999 台"), false);
    assert.equal(isPptLayoutIntentSupported(page, "上方架构图，下方说明"), true);
    assert.equal(isPptLayoutIntentSupported(page, "上下分区"), true);
    assert.equal(isPptLayoutIntentSupported(page, "居中主视觉 · 上下分区"), true);
    assert.equal(isPptLayoutIntentSupported(page, "四宫格"), true);
    assert.equal(isPptLayoutIntentSupported(page, "纵向编号列表"), true);
    assert.equal(isPptLayoutIntentSupported(page, "四宫格或纵向编号列表"), true);
    assert.equal(isPptLayoutIntentSupported(page, "2×2 网格"), true);
    assert.equal(isPptLayoutIntentSupported(page, "下方说明服务器投入 999 台"), false);
    assert.equal(isPptLayoutIntentSupported(page, "四宫格展示腾讯云、阿里云"), false);
    assert.equal(isPptLayoutIntentSupported(page, "999个模块"), false);
    assert.equal(isPptLayoutIntentSupported(page, "999张卡片"), false);
    assert.equal(isPptLayoutIntentSupported(page, "999宫格"), false);
    assert.equal(isPptLayoutIntentSupported(page, "编号列表增加第五项"), false);
    const pageWithApprovedCount = structuredClone(page);
    pageWithApprovedCount.contentBlocks.push({ id: "approved-count", kind: "body", text: "系统包含 4 个模块", sourceRefIds: [] });
    assert.equal(isPptLayoutIntentSupported(pageWithApprovedCount, "4 个模块"), true);
    assert.equal(
        validatePptContentDraft(draft).issues.some((issue) => issue.message === "页面排版要求包含未经批准的文案或事实"),
        false,
    );
});

test("无法识别的布局指出原值，并可按 revision 只移除目标布局", () => {
    const raw = rawDraft();
    raw.pages[0].blocks = raw.pages[0].blocks.filter((block) => block.key === "known");
    raw.pages[0].gaps = [];
    raw.pages[0].visualEncoding = [];
    raw.pages[0].layoutIntent = ["左右分栏", "四宫格展示腾讯云、阿里云"];
    const draft = normalizePptContentDraft(raw, sourceInput());
    const issue = draft.audit.issues.find((item) => item.field === "layoutIntent");

    assert.ok(issue);
    assert.equal(issue.value, "四宫格展示腾讯云、阿里云");
    assert.match(issue.message, /四宫格展示腾讯云、阿里云/);
    assert.equal(issue.repair?.kind, "remove_layout_intent");
    const preview = createPptContentRepairPreview(draft, [issue.id]);
    const repaired = applyPptContentRepair(draft, preview);
    assert.deepEqual(repaired.pageSpecs[0].layoutIntent, ["左右分栏"]);
    assert.deepEqual(repaired.pageSpecs[0].contentBlocks, draft.pageSpecs[0].contentBlocks);
    assert.deepEqual(repaired.pageSpecs[0].sourceRefs, draft.pageSpecs[0].sourceRefs);
    assert.throws(() => applyPptContentRepair(repaired, preview), /已变更|过期/);
});

test("要求 AI 给建议的用户补充会作为创作指令，不会当成页面正文", () => {
    assert.equal(isPptAuthoringInstruction("我希望你来给我按照我的内容来去给这个建议"), true);
    assert.equal(isPptAuthoringInstruction("请你给建议"), true);
    assert.equal(isPptAuthoringInstruction("帮我补充这一页"), true);
    assert.equal(isPptAuthoringInstruction("我想做一份介绍“PPT 工作台”的材料"), true);
    assert.equal(isPptAuthoringInstruction("想做一份介绍 PPT 工作台的材料"), true);
    assert.equal(isPptAuthoringInstruction("我想做一个中转站的介绍材料"), true);
    assert.equal(isPptAuthoringInstruction("我希望能做一个中转站的介绍材料。"), true);
    assert.equal(isPptAuthoringInstruction("我想做一份介绍 PPT 工作台的材料。"), true);
    assert.equal(isPptAuthoringInstruction("我想要做一个中转站的介绍材料。"), true);
    assert.equal(isPptAuthoringInstruction("我做这份材料的核心受众和目的主要有三个"), true);
    assert.equal(isPptAuthoringInstruction("这份材料不是简单罗列功能"), true);
    assert.equal(isPptAuthoringInstruction("这份材料要让第一次接触它的人明确理解四件事"), true);
    assert.equal(isPptAuthoringInstruction("我们希望合作伙伴获得清晰的建设建议"), false);
    assert.equal(isPptAuthoringInstruction("我希望材料利用率提高到 90%"), false);
    assert.equal(isPptAuthoringInstruction("我需要材料成本控制在 100 万元以内"), false);
    assert.equal(isPptAuthoringInstruction("本材料需要耐受 1200°C"), false);
    assert.equal(isPptAuthoringInstruction("我想做一种耐高温材料"), false);
    assert.equal(isPptAuthoringInstruction("为什么需要 PPT 工作台"), false);
    assert.equal(isPptAuthoringInstruction("PPT 工作台解决了什么问题"), false);
    assert.equal(isPptAuthoringInstruction("优先考虑低运维成本"), false);
});

test("有合法来源的 Deck Brief 元话语仍不能成为观众可见正文", () => {
    const sourceMaterial = [
        "我想做一份介绍“PPT 工作台”的材料",
        "这份材料不是简单罗列功能",
        "这份材料要让第一次接触它的人明确理解四件事",
        "为什么需要 PPT 工作台",
        "PPT 工作台解决了什么问题",
        "我们希望合作伙伴获得清晰的建设建议",
        "PPT 工作台把内容规划连接到页面生成",
        "PPT 工作台介绍",
    ].join("\n");
    const draft = normalizePptContentDraft(
        {
            brief: { audience: "第一次接触它的人", goal: "明确理解四件事", narrative: "为什么需要 PPT 工作台" },
            pages: [
                {
                    title: "PPT 工作台介绍",
                    titleSource: { source: "material", startLine: 8, endLine: 8 },
                    purpose: "解释产品价值",
                    primaryClaim: "PPT 工作台把内容规划连接到页面生成",
                    primaryClaimSource: { source: "material", startLine: 7, endLine: 7 },
                    contentForm: "narrative",
                    blocks: [
                        { key: "meta", kind: "body", text: "这份材料要让第一次接触它的人明确理解四件事", source: { source: "material", startLine: 3, endLine: 3 } },
                        { key: "business", kind: "body", text: "我们希望合作伙伴获得清晰的建设建议", source: { source: "material", startLine: 6, endLine: 6 } },
                    ],
                    layoutIntent: ["上下分区"],
                    visualEncoding: [],
                    gaps: [],
                },
            ],
        },
        { title: "PPT 工作台介绍", sourceMaterial, requirements: "" },
    );

    const issue = draft.audit.issues.find((item) => item.code === "authoring_instruction_as_copy");
    assert.ok(issue);
    assert.equal(issue.value, "这份材料要让第一次接触它的人明确理解四件事");
    assert.match(issue.message, /创作目标|上屏/);
    assert.equal(
        draft.audit.issues.some((item) => item.code === "authoring_instruction_as_copy" && item.value === "我们希望合作伙伴获得清晰的建设建议"),
        false,
    );
});

test("单页重生成未消除触发问题时拒绝接纳新版本", () => {
    const sourceMaterial = "PPT 工作台介绍\nPPT 工作台把内容规划连接到页面生成\n这份材料要让第一次接触它的人明确理解四件事\n第一次接触它的人\n明确理解四件事";
    const raw = {
        brief: { audience: "第一次接触它的人", goal: "明确理解四件事", narrative: "PPT 工作台把内容规划连接到页面生成" },
        pages: [
            {
                title: "PPT 工作台介绍",
                titleSource: { source: "material", startLine: 1, endLine: 1 },
                purpose: "解释产品价值",
                primaryClaim: "PPT 工作台把内容规划连接到页面生成",
                primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                contentForm: "narrative",
                blocks: [{ key: "meta", kind: "body", text: "这份材料要让第一次接触它的人明确理解四件事", source: { source: "material", startLine: 3, endLine: 3 } }],
                layoutIntent: ["上下分区"],
                visualEncoding: [],
                gaps: [],
            },
        ],
    };
    const input = { title: "PPT 工作台介绍", sourceMaterial, requirements: "" };
    const current = normalizePptContentDraft(raw, input);
    const triggering = current.audit.issues.filter((issue) => issue.code === "authoring_instruction_as_copy");
    const regenerated = normalizePptContentDraft(raw, { ...input, previousPageSpecs: current.pageSpecs });
    const next = replacePptContentDraftPage(current, current.revision, current.pageSpecs[0].pageId, regenerated.pageSpecs[0], regenerated.audit.gaps);

    assert.throws(() => assertPptPageAuditIssuesResolved(next, current.pageSpecs[0].pageId, triggering), /问题仍未解决|原页已保留/);
});

test("多页方案的第一页必须是无正文块封面，不能按页序静默改角色", () => {
    const cover = { ...rawDraft().pages[0], contentForm: "cover", blocks: [], gaps: [], visualEncoding: [], layoutIntent: ["居中主视觉"] };
    const content = { ...rawDraft().pages[0], contentForm: "narrative", blocks: [], gaps: [], visualEncoding: [], layoutIntent: ["上下分区"] };
    const valid = normalizePptContentDraft({ brief: rawDraft().brief, pages: [cover, content] }, sourceInput());

    assert.equal(valid.pageSpecs[0].layoutRole, "cover");
    assert.equal(valid.pageSpecs[1].layoutRole, "content");
    assert.equal(
        valid.audit.issues.some((item) => item.code === "invalid_cover"),
        false,
    );

    const narrativeFirst = normalizePptContentDraft({ brief: rawDraft().brief, pages: [content, content] }, sourceInput());
    assert.equal(narrativeFirst.pageSpecs[0].layoutRole, "content");
    assert.ok(narrativeFirst.audit.issues.some((item) => item.code === "invalid_cover" && item.severity === "blocking"));

    const bodyCover = normalizePptContentDraft({ brief: rawDraft().brief, pages: [{ ...cover, blocks: [rawDraft().pages[0].blocks[0]] }, content] }, sourceInput());
    assert.ok(bodyCover.audit.issues.some((item) => item.code === "invalid_cover" && item.severity === "blocking"));

    const secondCover = structuredClone(valid.pageSpecs[1]);
    secondCover.contentForm = "cover";
    secondCover.layoutRole = "cover";
    const regenerated = replacePptContentDraftPage(valid, valid.revision, secondCover.pageId, secondCover, []);
    assert.ok(regenerated.audit.issues.some((item) => item.code === "invalid_cover" && item.pageIds.includes(secondCover.pageId)));
    assert.throws(() => assertPptPageAuditIssuesResolved(regenerated, secondCover.pageId, []), /问题仍未解决|原页已保留/);
    assert.doesNotThrow(() => assertPptPageAuditIssuesResolved(valid, valid.pageSpecs[0].pageId, [{ code: "invalid_cover", field: "contentForm", message: "第一页应为封面" }]));
});

test("封面核心信息必须是一句定位语，不能用四项目标清单冒充", () => {
    const createCover = (primaryClaim) =>
        normalizePptContentDraft(
            {
                brief: { audience: "第一次接触产品的人", goal: "理解产品价值", narrative: "从问题到价值" },
                pages: [
                    {
                        title: "PPT 工作台",
                        titleSource: { source: "material", startLine: 1, endLine: 1 },
                        purpose: "建立产品定位",
                        primaryClaim,
                        primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                        contentForm: "cover",
                        blocks: [],
                        layoutIntent: ["居中主视觉"],
                        visualEncoding: [],
                        gaps: [],
                    },
                ],
            },
            {
                title: "PPT 工作台",
                sourceMaterial: ["PPT 工作台", primaryClaim, "第一次接触产品的人", "理解产品价值", "从问题到价值"].join("\n"),
                requirements: "",
            },
        );

    const checklist = createCover("为什么需要、好在哪里、解决什么问题、为谁服务");
    assert.ok(checklist.audit.issues.some((item) => item.code === "invalid_cover" && item.field === "primaryClaim"));

    const tagline = createCover("把材料、内容规划、视觉方向和页面生成连接成可控流程");
    assert.equal(
        tagline.audit.issues.some((item) => item.code === "invalid_cover"),
        false,
    );
});

test("只执行用户明确给出的最大页数，不为未声明页数的长方案硬设上限", () => {
    const pages = Array.from({ length: 3 }, () => ({ ...rawDraft().pages[0], contentForm: "narrative", blocks: [], gaps: [], visualEncoding: [] }));
    const limited = normalizePptContentDraft({ brief: rawDraft().brief, pages }, { ...sourceInput(), requirements: `${sourceInput().requirements}\n控制在 2 页以内` });
    assert.ok(limited.audit.issues.some((item) => item.code === "page_count_exceeded" && item.severity === "blocking" && /3 页/.test(item.message) && /2 页/.test(item.message)));

    const unlimited = normalizePptContentDraft({ brief: rawDraft().brief, pages: Array.from({ length: 17 }, () => ({ ...rawDraft().pages[0], contentForm: "narrative", blocks: [], gaps: [], visualEncoding: [] })) }, sourceInput());
    assert.equal(
        unlimited.audit.issues.some((item) => item.code === "page_count_exceeded"),
        false,
    );
});

test("稀疏材料仍展示可采纳的完整 AI 建议，而不是只有请补充目录词", () => {
    const sourceMaterial = "我想做一个中转站的介绍材料，目的就是为了把组件选型、部署架构、后续运维，以及整个成本都讲清楚。";
    const proposedAnswer = "建议先用一页说明建设目标，再按组件选型、参考架构、运维机制和成本模型四部分展开；具体供应商、容量和金额在决策页逐项确认。";
    const draft = normalizePptContentDraft(
        {
            brief: {
                audience: "项目发起人与潜在合作伙伴",
                goal: "形成可讨论的中转站建设初稿",
                narrative: "从目标、选型、架构、运维到成本逐层展开",
            },
            pages: [
                {
                    title: "中转站建设方案",
                    purpose: "让读者快速理解要建设什么以及后续如何展开",
                    primaryClaim: "先形成可讨论的建设基线，再逐项确认真实投入",
                    contentForm: "cover",
                    blocks: [{ key: "recommended-structure", kind: "body", text: proposedAnswer, gapKey: "recommended-structure" }],
                    layoutIntent: ["居中布局"],
                    gaps: [
                        {
                            key: "recommended-structure",
                            kind: "missing_detail",
                            question: "是否采用这套建议结构？",
                            reason: "原材料只给出了主题，以下为 AI 编辑建议",
                            blocking: true,
                            proposedAnswer,
                        },
                    ],
                },
            ],
        },
        { title: "中转站介绍", sourceMaterial, requirements: "" },
    );
    const proposal = draft.audit.gaps.find((gap) => gap.proposedAnswer === proposedAnswer);
    const proposalBlock = draft.pageSpecs[0].contentBlocks.find((block) => block.gapId === proposal.id);

    assert.equal(proposalBlock.text, proposedAnswer);
    assert.doesNotMatch(proposalBlock.text, /^(?:待补充|请补充|这里介绍)/);
    const accepted = acceptPptPageSuggestions(draft, draft.pageSpecs[0].pageId, "2026-07-22T10:00:00.000Z");
    const acceptedBlock = accepted.pageSpecs[0].contentBlocks.find((block) => block.id === proposalBlock.id);
    assert.ok(accepted.pageSpecs[0].sourceRefs.some((source) => source.source === "confirmed_assumption" && acceptedBlock.sourceRefIds.includes(source.id)));
});

test("局部重新生成复用未改写的用户补充与已确认建议来源", () => {
    const initial = createDraft();
    const gap = initial.audit.gaps.find((item) => item.proposedAnswer);
    const answered = resolvePptInformationGap(initial, gap.id, { kind: "user_answer", text: "优先考虑低运维成本", resolvedAt: "2026-07-22T10:00:00.000Z" });
    const previousPage = answered.pageSpecs[0];
    const regenerated = normalizePptContentDraft(
        {
            brief: rawDraft().brief,
            pages: [
                {
                    ...rawDraft().pages[0],
                    blocks: [rawDraft().pages[0].blocks[0], { key: "confirmed-choice", kind: "body", text: "优先考虑低运维成本" }],
                    gaps: [],
                    visualEncoding: [],
                },
            ],
        },
        { ...sourceInput(), previousPageSpecs: [previousPage] },
    );
    const preservedBlock = regenerated.pageSpecs[0].contentBlocks.find((block) => block.text === "优先考虑低运维成本");
    const preservedSource = regenerated.pageSpecs[0].sourceRefs.find((source) => preservedBlock.sourceRefIds.includes(source.id));

    assert.equal(preservedSource.source, "user_answer");
    assert.equal(preservedSource.relation, "verbatim");
    const relationChanged = structuredClone(regenerated.pageSpecs[0]);
    relationChanged.sourceRefs.find((source) => source.id === preservedSource.id).relation = "derived";
    assert.throws(() => replacePptContentDraftPage(answered, answered.revision, previousPage.pageId, relationChanged, regenerated.audit.gaps), /遗漏或改写了已确认内容/);
    const replaced = replacePptContentDraftPage(answered, answered.revision, previousPage.pageId, regenerated.pageSpecs[0], regenerated.audit.gaps);
    assert.equal(replaced.revision, answered.revision + 1);
    assert.ok(replaced.pageSpecs[0].sourceRefs.some((source) => source.id === preservedSource.id && source.source === "user_answer"));
    assert.equal(
        regenerated.audit.gaps.some((item) => item.proposedAnswer === "优先考虑低运维成本"),
        false,
    );

    const reopenedRaw = structuredClone(rawDraft().pages[0]);
    reopenedRaw.blocks = [rawDraft().pages[0].blocks[0], { key: "confirmed-choice", kind: "body", text: "优先考虑低运维成本" }];
    reopenedRaw.gaps = [{ key: "components-v2", kind: "missing_detail", question: "候选组件有哪些？", reason: "组件对比需要具体候选项", blocking: true, proposedAnswer: "优先考虑低运维成本" }];
    reopenedRaw.visualEncoding = [];
    const reopened = normalizePptContentDraft({ brief: rawDraft().brief, pages: [reopenedRaw] }, { ...sourceInput(), previousPageSpecs: [previousPage] });
    const reconciled = replacePptContentDraftPage(answered, answered.revision, previousPage.pageId, reopened.pageSpecs[0], reopened.audit.gaps);
    const reconciledBlock = reconciled.pageSpecs[0].contentBlocks.find((block) => block.text === "优先考虑低运维成本");
    assert.equal(
        reconciled.audit.gaps.some((item) => item.proposedAnswer === "优先考虑低运维成本"),
        false,
    );
    assert.equal(reconciledBlock.gapId, gap.id);
    assert.equal(reconciled.pageSpecs[0].contentState.status, "reviewable");
    assert.ok(reconciled.pageSpecs[0].sourceRefs.some((source) => source.source === "user_answer" && reconciledBlock.sourceRefIds.includes(source.id)));
    const resolvedLineage = reconciled.audit.gaps.find((item) => item.id === gap.id);
    assert.equal(resolvedLineage.resolution.text, "优先考虑低运维成本");

    const reopenedAgain = normalizePptContentDraft({ brief: rawDraft().brief, pages: [reopenedRaw] }, { ...sourceInput(), previousPageSpecs: [reconciled.pageSpecs[0]] });
    const reconciledAgain = replacePptContentDraftPage(reconciled, reconciled.revision, previousPage.pageId, reopenedAgain.pageSpecs[0], reopenedAgain.audit.gaps);
    assert.equal(reconciledAgain.pageSpecs[0].contentState.status, "reviewable");
    assert.equal(reconciledAgain.audit.gaps.find((item) => item.id === gap.id).resolution.text, "优先考虑低运维成本");

    const editedAfterReconcile = applyPptContentAction(
        reconciled,
        previewPptContentAction(reconciled, {
            kind: "edit_block",
            pageId: previousPage.pageId,
            blockId: reconciledBlock.id,
            text: "优先采用成熟运维方案",
            editedAt: "2026-07-22T10:03:00.000Z",
        }),
    );
    const editedAfterReconcileBlock = editedAfterReconcile.pageSpecs[0].contentBlocks.find((block) => block.id === reconciledBlock.id);
    const editedAfterReconcileSource = editedAfterReconcile.pageSpecs[0].sourceRefs.find((source) => editedAfterReconcileBlock.sourceRefIds.includes(source.id));
    assert.equal(editedAfterReconcile.audit.gaps.find((item) => item.id === gap.id).resolution.text, "优先采用成熟运维方案");
    assert.equal(editedAfterReconcileSource.gapId, gap.id);

    const rewrittenRaw = structuredClone(rawDraft().pages[0]);
    rewrittenRaw.blocks = [{ key: "rewritten-choice", kind: "body", text: "低运维成本优先" }];
    rewrittenRaw.gaps = [];
    rewrittenRaw.visualEncoding = [];
    const rewritten = normalizePptContentDraft({ brief: rawDraft().brief, pages: [rewrittenRaw] }, { ...sourceInput(), previousPageSpecs: [previousPage] });
    assert.equal(
        rewritten.pageSpecs[0].sourceRefs.some((source) => source.source === "user_answer" && source.excerpt === "低运维成本优先"),
        false,
    );
    assert.ok(rewritten.audit.gaps.some((item) => item.proposedAnswer === "低运维成本优先"));
    assert.throws(() => replacePptContentDraftPage(answered, answered.revision, previousPage.pageId, rewritten.pageSpecs[0], rewritten.audit.gaps), /遗漏或改写了已确认内容/);

    const omittedRaw = structuredClone(rawDraft().pages[0]);
    omittedRaw.blocks = [rawDraft().pages[0].blocks[0]];
    omittedRaw.gaps = [];
    omittedRaw.visualEncoding = [];
    const omitted = normalizePptContentDraft({ brief: rawDraft().brief, pages: [omittedRaw] }, { ...sourceInput(), previousPageSpecs: [previousPage] });
    const before = structuredClone(answered);
    assert.throws(() => replacePptContentDraftPage(answered, answered.revision, previousPage.pageId, omitted.pageSpecs[0], omitted.audit.gaps), /原页已保留/);
    assert.deepEqual(answered, before);

    const materialBlock = initial.pageSpecs[0].contentBlocks.find((block) => block.kind === "supporting_claim");
    const userConfirmed = applyPptContentAction(
        initial,
        previewPptContentAction(initial, {
            kind: "edit_block",
            pageId: initial.pageSpecs[0].pageId,
            blockId: materialBlock.id,
            text: materialBlock.text,
            editedAt: "2026-07-22T10:02:00.000Z",
        }),
    );
    const sourceConflict = normalizePptContentDraft(rawDraft(), { ...sourceInput(), previousPageSpecs: [userConfirmed.pageSpecs[0]] });
    const conflictedBlock = sourceConflict.pageSpecs[0].contentBlocks.find((block) => block.text === materialBlock.text);
    assert.equal(sourceConflict.pageSpecs[0].sourceRefs.find((source) => conflictedBlock.sourceRefIds.includes(source.id)).source, "user_answer");
});

test("局部重新生成不能把已确认正文迁移到标题来冒充保留", () => {
    const initial = createDraft();
    const gap = initial.audit.gaps.find((item) => item.proposedAnswer);
    const answered = resolvePptInformationGap(initial, gap.id, { kind: "user_answer", text: "采用双活", resolvedAt: "2026-07-22T10:00:00.000Z" });
    const previousPage = answered.pageSpecs[0];
    const protectedSource = previousPage.sourceRefs.find((source) => source.source === "user_answer");
    const movedRaw = structuredClone(rawDraft().pages[0]);
    movedRaw.title = "采用双活";
    delete movedRaw.titleSource;
    movedRaw.blocks = [rawDraft().pages[0].blocks[0]];
    movedRaw.gaps = [];
    movedRaw.visualEncoding = [];

    const moved = normalizePptContentDraft({ brief: rawDraft().brief, pages: [movedRaw] }, { ...sourceInput(), previousPageSpecs: [previousPage] });
    const movedTitle = moved.pageSpecs[0].contentBlocks.find((block) => block.kind === "title");
    assert.equal(movedTitle.sourceRefIds.includes(protectedSource.id), false);
    assert.throws(() => replacePptContentDraftPage(answered, answered.revision, previousPage.pageId, moved.pageSpecs[0], moved.audit.gaps), /遗漏或改写了已确认内容/);
});

test("同文但语义不同的新证据缺口不会被当作重复确认删除", () => {
    const initial = createDraft();
    const gap = initial.audit.gaps.find((item) => item.proposedAnswer);
    const answered = resolvePptInformationGap(initial, gap.id, { kind: "user_answer", text: "采用双活", resolvedAt: "2026-07-22T10:00:00.000Z" });
    const previousPage = answered.pageSpecs[0];
    const evidenceRaw = structuredClone(rawDraft().pages[0]);
    evidenceRaw.blocks = [rawDraft().pages[0].blocks[0], { key: "confirmed-choice", kind: "body", text: "采用双活", gapKey: "load-test-evidence" }];
    evidenceRaw.gaps = [{ key: "load-test-evidence", kind: "missing_evidence", question: "是否已经通过压测？", reason: "当前没有压测证据", blocking: true, proposedAnswer: "采用双活" }];
    evidenceRaw.visualEncoding = [];

    const regenerated = normalizePptContentDraft({ brief: rawDraft().brief, pages: [evidenceRaw] }, { ...sourceInput(), previousPageSpecs: [previousPage] });
    const replaced = replacePptContentDraftPage(answered, answered.revision, previousPage.pageId, regenerated.pageSpecs[0], regenerated.audit.gaps);
    const evidenceGap = replaced.audit.gaps.find((item) => item.question === "是否已经通过压测？");
    const confirmedBlock = replaced.pageSpecs[0].contentBlocks.find((block) => block.text === "采用双活");
    assert.ok(evidenceGap);
    assert.equal(confirmedBlock.gapId, evidenceGap.id);
    assert.equal(replaced.pageSpecs[0].contentState.status, "blocked");
});

test("同 key 同类型但问题已改变的新缺口不会沿用旧确认", () => {
    const initial = createDraft();
    const gap = initial.audit.gaps.find((item) => item.proposedAnswer);
    const answered = resolvePptInformationGap(initial, gap.id, { kind: "user_answer", text: "采用双活", resolvedAt: "2026-07-22T10:00:00.000Z" });
    const changedRaw = structuredClone(rawDraft().pages[0]);
    changedRaw.blocks = [rawDraft().pages[0].blocks[0], { key: "confirmed-choice", kind: "body", text: "采用双活", gapKey: "components" }];
    changedRaw.gaps = [{ key: "components", kind: "missing_detail", question: "部署采用主备还是双活？", reason: "部署方式尚未决定", blocking: true, proposedAnswer: "采用双活" }];
    changedRaw.visualEncoding = [];

    const regenerated = normalizePptContentDraft({ brief: rawDraft().brief, pages: [changedRaw] }, { ...sourceInput(), previousPageSpecs: [answered.pageSpecs[0]] });
    const replaced = replacePptContentDraftPage(answered, answered.revision, answered.pageSpecs[0].pageId, regenerated.pageSpecs[0], regenerated.audit.gaps);
    assert.ok(replaced.audit.gaps.some((item) => !item.resolution && item.question === "部署采用主备还是双活？"));
    assert.equal(replaced.pageSpecs[0].contentState.status, "blocked");

    const conflictingRaw = structuredClone(rawDraft().pages[0]);
    conflictingRaw.blocks = [rawDraft().pages[0].blocks[0], { key: "confirmed-choice", kind: "body", text: "采用双活", gapKey: "components" }];
    conflictingRaw.gaps = [{ key: "components", kind: "missing_detail", question: "候选组件有哪些？", reason: "试图改变已经确认的答案", blocking: true, proposedAnswer: "改用主备" }];
    conflictingRaw.visualEncoding = [];
    const conflicting = normalizePptContentDraft({ brief: rawDraft().brief, pages: [conflictingRaw] }, { ...sourceInput(), previousPageSpecs: [answered.pageSpecs[0]] });
    assert.throws(() => replacePptContentDraftPage(answered, answered.revision, answered.pageSpecs[0].pageId, conflicting.pageSpecs[0], conflicting.audit.gaps), /重新开启或改变了已确认信息缺口/);
});

test("多个同文确认来源按旧内容块逐个恢复，不折叠为第一个来源", () => {
    const initialRaw = rawDraft();
    initialRaw.pages[0].blocks.push({ key: "components-copy", kind: "placeholder", text: "待确认第二处", gapKey: "components-copy" });
    initialRaw.pages[0].gaps.push({ key: "components-copy", kind: "missing_detail", question: "候选组件有哪些？", reason: "需要独立确认", blocking: true, proposedAnswer: "采用双活" });
    const initial = normalizePptContentDraft(initialRaw, sourceInput());
    const partiallyConfirmed = resolvePptInformationGap(initial, initial.audit.gaps[0].id, { kind: "user_answer", text: "采用双活", resolvedAt: "2026-07-22T09:59:00.000Z" });
    const partialRepeatRaw = structuredClone(rawDraft().pages[0]);
    partialRepeatRaw.blocks = [rawDraft().pages[0].blocks[0], { key: "confirmed-choice", kind: "body", text: "采用双活", gapKey: "components-v2" }];
    partialRepeatRaw.gaps = [{ key: "components-v2", kind: "missing_detail", question: "候选组件有哪些？", reason: "不能吞掉另一处未确认缺口", blocking: true, proposedAnswer: "采用双活" }];
    partialRepeatRaw.visualEncoding = [];
    const partialRepeat = normalizePptContentDraft({ brief: rawDraft().brief, pages: [partialRepeatRaw] }, { ...sourceInput(), previousPageSpecs: [partiallyConfirmed.pageSpecs[0]] });
    assert.throws(() => replacePptContentDraftPage(partiallyConfirmed, partiallyConfirmed.revision, partiallyConfirmed.pageSpecs[0].pageId, partialRepeat.pageSpecs[0], partialRepeat.audit.gaps), /重新开启或改变了已确认信息缺口/);

    const confirmed = initial.audit.gaps.reduce((draft, currentGap) => resolvePptInformationGap(draft, currentGap.id, { kind: "user_answer", text: "采用双活", resolvedAt: "2026-07-22T10:00:00.000Z" }), initial);
    const regeneratedRaw = structuredClone(rawDraft().pages[0]);
    regeneratedRaw.blocks = [rawDraft().pages[0].blocks[0], { key: "first-confirmed", kind: "body", text: "采用双活" }, { key: "second-confirmed", kind: "body", text: "采用双活" }];
    regeneratedRaw.gaps = [];
    regeneratedRaw.visualEncoding = [];

    const regenerated = normalizePptContentDraft({ brief: rawDraft().brief, pages: [regeneratedRaw] }, { ...sourceInput(), previousPageSpecs: [confirmed.pageSpecs[0]] });
    const restoredSources = regenerated.pageSpecs[0].contentBlocks.filter((block) => block.text === "采用双活").map((block) => block.sourceRefIds[0]);
    assert.equal(new Set(restoredSources).size, 2);
    assert.doesNotThrow(() => replacePptContentDraftPage(confirmed, confirmed.revision, confirmed.pageSpecs[0].pageId, regenerated.pageSpecs[0], regenerated.audit.gaps));

    const ambiguousRaw = structuredClone(regeneratedRaw);
    ambiguousRaw.blocks[1].gapKey = "components-v2";
    ambiguousRaw.gaps = [{ key: "components-v2", kind: "missing_detail", question: "候选组件有哪些？", reason: "重复语义无法唯一归属", blocking: true, proposedAnswer: "采用双活" }];
    const ambiguous = normalizePptContentDraft({ brief: rawDraft().brief, pages: [ambiguousRaw] }, { ...sourceInput(), previousPageSpecs: [confirmed.pageSpecs[0]] });
    assert.throws(() => replacePptContentDraftPage(confirmed, confirmed.revision, confirmed.pageSpecs[0].pageId, ambiguous.pageSpecs[0], ambiguous.audit.gaps), /重新开启或改变了已确认信息缺口/);
});

test("局部重新生成只返回部分已确认内容时原子拒绝", () => {
    const initial = createDraft();
    const proposal = initial.audit.gaps.find((item) => item.proposedAnswer);
    const accepted = resolvePptInformationGap(initial, proposal.id, { kind: "confirmed_assumption", text: proposal.proposedAnswer, resolvedAt: "2026-07-22T10:00:00.000Z" });
    const known = accepted.pageSpecs[0].contentBlocks.find((block) => block.kind === "supporting_claim");
    const edited = applyPptContentAction(
        accepted,
        previewPptContentAction(accepted, {
            kind: "edit_block",
            pageId: accepted.pageSpecs[0].pageId,
            blockId: known.id,
            text: "优先考虑低运维成本",
            editedAt: "2026-07-22T10:01:00.000Z",
        }),
    );
    const partialRaw = structuredClone(rawDraft().pages[0]);
    partialRaw.blocks = [{ key: "known", kind: "supporting_claim", text: "优先考虑低运维成本" }];
    partialRaw.gaps = [];
    partialRaw.visualEncoding = [];
    const replacement = normalizePptContentDraft({ brief: rawDraft().brief, pages: [partialRaw] }, { ...sourceInput(), previousPageSpecs: [edited.pageSpecs[0]] });

    assert.ok(replacement.pageSpecs[0].sourceRefs.some((source) => source.source === "user_answer"));
    assert.throws(() => replacePptContentDraftPage(edited, edited.revision, edited.pageSpecs[0].pageId, replacement.pageSpecs[0], replacement.audit.gaps), /遗漏或改写了已确认内容/);
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
    const reorderedRaw = structuredClone(raw);
    reorderedRaw.pages[0].gaps.reverse();
    const reordered = normalizePptContentDraft(reorderedRaw, { ...sourceInput(), previousPageSpecs: [draft.pageSpecs[0]] });
    assert.equal(reordered.audit.gaps.find((gap) => gap.question === "问题 A").id, gaps[0].id);
    assert.equal(reordered.audit.gaps.find((gap) => gap.question === "问题 B").id, gaps[1].id);
    const first = resolvePptInformationGap(draft, gaps[0].id, { kind: "user_answer", text: "答案 A", resolvedAt: "2026-07-22T08:00:00.000Z" });
    assert.doesNotThrow(() => resolvePptInformationGap(first, gaps[1].id, { kind: "user_answer", text: "答案 B", resolvedAt: "2026-07-22T08:01:00.000Z" }));
    assert.equal(
        draft.audit.issues.some((issue) => issue.code === "deck_style_signal"),
        false,
    );
});

test("特殊 gap key 与系统缺口分属命名空间，确认后可正常 finalize", () => {
    const raw = rawDraft();
    raw.pages[0].title = "需要确认的新标题";
    delete raw.pages[0].titleSource;
    raw.pages[0].gaps.push({ key: "source-title", kind: "missing_detail", question: "显式标题建议是否采用？", reason: "验证保留名称", blocking: true, proposedAnswer: "显式标题建议" });
    const draft = normalizePptContentDraft(raw, sourceInput());
    assert.equal(new Set(draft.audit.gaps.map((gap) => gap.id)).size, draft.audit.gaps.length);
    const resolved = resolveAllGaps(draft);
    assert.doesNotThrow(() => finalizePptContentDraft(resolved, "2026-07-22T10:10:00.000Z"));
});

test("无损 gap 派生身份不会折叠不同确认来源或内容块", () => {
    const raw = rawDraft();
    raw.pages[0].gaps.push(
        { key: "a b", kind: "missing_detail", question: "问题 A", reason: "待确认", blocking: true, proposedAnswer: "答案 A" },
        { key: "a-20b", kind: "missing_detail", question: "问题 B", reason: "待确认", blocking: true, proposedAnswer: "答案 B" },
    );
    const resolved = resolveAllGaps(normalizePptContentDraft(raw, sourceInput()));
    const page = resolved.pageSpecs[0];
    assert.equal(new Set(page.sourceRefs.map((source) => source.id)).size, page.sourceRefs.length);
    assert.equal(new Set(page.contentBlocks.map((block) => block.id)).size, page.contentBlocks.length);
    assert.doesNotThrow(() => finalizePptContentDraft(resolved, "2026-07-22T10:11:00.000Z"));
});

test("已确认 gap 的内容手改后同步更新 resolution", () => {
    const initial = createDraft();
    const gap = initial.audit.gaps.find((item) => item.proposedAnswer);
    const answered = resolvePptInformationGap(initial, gap.id, { kind: "user_answer", text: "方案 A", resolvedAt: "2026-07-22T10:00:00.000Z" });
    const block = answered.pageSpecs[0].contentBlocks.find((item) => item.gapId === gap.id);
    const edited = applyPptContentAction(
        answered,
        previewPptContentAction(answered, {
            kind: "edit_block",
            pageId: answered.pageSpecs[0].pageId,
            blockId: block.id,
            text: "方案 B",
            editedAt: "2026-07-22T10:01:00.000Z",
        }),
    );
    assert.deepEqual(edited.audit.gaps.find((item) => item.id === gap.id).resolution, { kind: "user_answer", text: "方案 B", resolvedAt: "2026-07-22T10:01:00.000Z" });
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
    assert.deepEqual(repaired.brief.visualSignals, []);
    assert.throws(() => applyPptContentRepair(repaired, preview), /已变更|过期/);

    const finalized = finalizePptContentDraft(resolveAllGaps(draft), "2026-07-22T08:01:00.000Z");
    assert.deepEqual(finalized.pageSpecs[0].layoutIntent, ["左右分栏"]);
    assert.deepEqual(finalized.brief.visualSignals, []);

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
    assert.deepEqual(combinedRepaired.brief.visualSignals, []);
    assert.equal(validatePptContentDraft(combinedRepaired).valid, false);
});

test("内容阶段不会用 raw strip 删掉无法安全分离的信息构图", () => {
    const raw = rawDraft();
    raw.pages[0].layoutIntent = ["左右双栏使用深蓝背景", "对比表使用微软雅黑字体"];
    const draft = normalizePptContentDraft(raw, sourceInput());
    const styleIssues = draft.audit.issues.filter((issue) => issue.code === "deck_style_signal");
    const safeIssue = styleIssues.find((issue) => issue.message.includes("深蓝背景"));
    const unsafeIssue = styleIssues.find((issue) => issue.message.includes("微软雅黑"));

    assert.ok(safeIssue?.repair);
    assert.equal(unsafeIssue?.repair, undefined);
    assert.deepEqual(
        unsafeIssue?.actions.map((action) => action.kind),
        ["regenerate_pages"],
    );
    const preview = createPptContentRepairPreview(
        draft,
        styleIssues.map((issue) => issue.id),
    );
    assert.equal(preview.operations.length, 1);
    const repaired = applyPptContentRepair(draft, preview);
    assert.deepEqual(repaired.pageSpecs[0].layoutIntent, ["左右双栏", "对比表使用微软雅黑字体"]);

    const finalized = finalizePptContentDraft(resolveAllGaps(draft), "2026-07-22T08:01:00.000Z");
    assert.deepEqual(finalized.pageSpecs[0].layoutIntent, ["左右双栏", "对比表使用微软雅黑字体"]);
    assert.deepEqual(finalized.brief.visualSignals, []);
    assert.equal(isPptLayoutIntentSupported(finalized.pageSpecs[0], "对比表使用微软雅黑字体"), true);
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

test("确认 source 页缺口后合并到 target，单页重生成仍按同一 lineage 幂等", () => {
    const targetRaw = structuredClone(rawDraft().pages[0]);
    targetRaw.blocks = [rawDraft().pages[0].blocks[0]];
    targetRaw.gaps = [];
    const sourceRaw = structuredClone(rawDraft().pages[0]);
    const initial = normalizePptContentDraft({ brief: rawDraft().brief, pages: [targetRaw, sourceRaw] }, sourceInput());
    const [targetPage, sourcePage] = initial.pageSpecs;
    const sourceGap = initial.audit.gaps.find((gap) => gap.pageId === sourcePage.pageId && gap.question === "候选组件有哪些？");
    const answered = resolvePptInformationGap(initial, sourceGap.id, { kind: "user_answer", text: "采用双活", resolvedAt: "2026-07-22T10:20:00.000Z" });
    const merged = applyPptContentAction(
        answered,
        previewPptContentAction(answered, {
            kind: "merge_pages",
            pageIds: [targetPage.pageId, sourcePage.pageId],
        }),
    );
    const repeatRaw = structuredClone(rawDraft().pages[0]);
    repeatRaw.blocks = [rawDraft().pages[0].blocks[0], { key: "confirmed-choice", kind: "body", text: "采用双活" }];
    repeatRaw.gaps = [{ key: "components", kind: "missing_detail", question: "候选组件有哪些？", reason: "组件对比需要具体候选项", blocking: true, proposedAnswer: "采用双活" }];
    repeatRaw.visualEncoding = [];
    const regenerated = normalizePptContentDraft({ brief: rawDraft().brief, pages: [repeatRaw] }, { ...sourceInput(), previousPageSpecs: [merged.pageSpecs[0]] });
    const replaced = replacePptContentDraftPage(merged, merged.revision, targetPage.pageId, regenerated.pageSpecs[0], regenerated.audit.gaps);

    assert.equal(replaced.pageSpecs[0].contentState.status, "reviewable");
    assert.ok(replaced.audit.gaps.some((gap) => gap.id === sourceGap.id && gap.pageId === targetPage.pageId && gap.resolution?.text === "采用双活"));
    assert.equal(
        replaced.audit.gaps.some((gap) => !gap.resolution && gap.question === "候选组件有哪些？"),
        false,
    );
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

test("文章式单块长段落和过量单页文案会进入内容负载检查", () => {
    const draft = resolveAllGaps(createDraft());
    const { brief, pageSpecs } = finalizePptContentDraft(draft, "2026-07-22T08:01:00.000Z");
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "内容密度测试",
        sourceMaterial: sourceInput().sourceMaterial,
        requirements: sourceInput().requirements,
        deckBrief: deckBriefFrom(brief),
        pageSpecs,
    });
    const pageId = partial.ppt.pages[0].pageId;
    const version = partial.ppt.pageSpecs[0].version;
    const denseText = [
        "中转站介绍PPT | LLM中转站选型",
        "选型需基于模型接入能力、并发与吞吐需求、路由策略、安全合规、部署成本及关键组件进行对比分析，选择适合业务的LLM中转站方案",
        "选择LLM中转站时，先明确需接入的模型服务商与协议兼容性（如OpenAI、Anthropic、Azure OpenAI及兼容OpenAI API的模型）、预估并发请求量和Token吞吐需求、模型路由与故障切换能力，以及API密钥管理、访问鉴权、调用审计和数据脱敏等安全要求；重点评估Sub2API、CPA、New API等关键组件在模型统一接入、账号与密钥管理、请求转发、负载均衡、限流熔断、配额计费及可观测性中的能力；通过对比不同方案的多模型统一接入、私有化部署支持和总体成本，决定是否采用该方案。",
    ].join("\n");
    const edited = applyPptCanonicalPageTextEdit(partial.ppt, pageId, version, denseText);
    const issues = auditPptPageCopyReadiness(getPptCanonicalPageText(edited, pageId));

    assert.deepEqual(new Set(issues.map((issue) => issue.code)), new Set(["monolithic_content", "excessive_copy"]));
    assert.ok(issues.every((issue) => issue.message.includes("拆分") || issue.message.includes("拆页") || issue.message.includes("压缩")));
    assert.match(issues.find((issue) => issue.code === "monolithic_content").message, /250 字/);
    assert.match(issues.find((issue) => issue.code === "excessive_copy").message, /330 字/);

    const slideReady = "LLM中转站选型\n选型需平衡接入、运行、安全与成本\n模型接入：明确服务商与协议兼容性\n容量与路由：评估并发、吞吐和故障切换\n安全治理：覆盖密钥、鉴权、审计与脱敏";
    assert.deepEqual(auditPptPageCopyReadiness(slideReady), []);
});

test("全页文本编辑只保留未改写内容块的 visualEncoding", () => {
    const draft = resolveAllGaps(createDraft());
    const { brief, pageSpecs } = finalizePptContentDraft(draft, "2026-07-22T08:01:00.000Z");
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "编码保留测试",
        sourceMaterial: sourceInput().sourceMaterial,
        requirements: sourceInput().requirements,
        deckBrief: deckBriefFrom(brief),
        pageSpecs,
    });
    const pageSpec = partial.ppt.pageSpecs[0];
    const encodedBlockId = pageSpec.visualEncoding[0].contentBlockIds[0];
    const encodedBlock = pageSpec.contentBlocks.find((block) => block.id === encodedBlockId);
    const title = pageSpec.contentBlocks.find((block) => block.kind === "title");
    const editedText = [title.text, "改写后的核心判断", encodedBlock.text].join("\n");
    const edited = applyPptCanonicalPageTextEdit(partial.ppt, pageSpec.pageId, pageSpec.version, editedText);

    assert.deepEqual(edited.pageSpecs[0].visualEncoding[0].contentBlockIds, [encodedBlockId]);
    assert.equal(edited.pageSpecs[0].visualEncoding[0].lockedMapping, undefined);
    assert.equal(edited.pageSpecs[0].contentBlocks.find((block) => block.id === encodedBlockId).text, encodedBlock.text);
});

test("全页文本交换正文块顺序时保留块语义身份并同步视觉编码顺序", () => {
    const draft = resolveAllGaps(createDraft());
    const { brief, pageSpecs } = finalizePptContentDraft(draft, "2026-07-22T08:01:00.000Z");
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "正文排序测试",
        sourceMaterial: sourceInput().sourceMaterial,
        requirements: sourceInput().requirements,
        deckBrief: deckBriefFrom(brief),
        pageSpecs,
    });
    const page = structuredClone(partial.ppt.pageSpecs[0]);
    const [firstBody, secondBody] = page.contentBlocks.slice(2);
    firstBody.kind = "list";
    secondBody.kind = "body";
    page.visualEncoding = [{ id: `${page.pageId}:encoding:order`, contentBlockIds: [firstBody.id, secondBody.id], intent: "sequence", channel: "position" }];
    const ppt = { ...partial.ppt, pageSpecs: [page] };
    const title = page.contentBlocks.find((block) => block.kind === "title");
    const claim = page.contentBlocks.find((block) => block.kind === "primary_claim");
    const editedText = [title.text, claim.text, secondBody.text, firstBody.text].join("\n");
    const edited = applyPptCanonicalPageTextEdit(ppt, page.pageId, page.version, editedText);
    const editedPage = edited.pageSpecs[0];

    assert.deepEqual(
        editedPage.contentBlocks.slice(2).map(({ id, kind, text }) => ({ id, kind, text })),
        [
            { id: secondBody.id, kind: "body", text: secondBody.text },
            { id: firstBody.id, kind: "list", text: firstBody.text },
        ],
    );
    assert.deepEqual(editedPage.visualEncoding[0].contentBlockIds, [secondBody.id, firstBody.id]);
    assert.equal(editedPage.visualEncoding[0].lockedMapping, undefined);
});

test("结构化 AI 改写会原子更新内容形态和定向 visualEncoding", () => {
    const draft = resolveAllGaps(createDraft());
    const { brief, pageSpecs } = finalizePptContentDraft(draft, "2026-07-22T08:01:00.000Z");
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "结构化改写测试",
        sourceMaterial: sourceInput().sourceMaterial,
        requirements: sourceInput().requirements,
        deckBrief: deckBriefFrom(brief),
        pageSpecs,
    });
    const pageSpec = partial.ppt.pageSpecs[0];
    const originalTitle = pageSpec.contentBlocks.find((block) => block.kind === "title").text;
    const originalClaim = pageSpec.contentBlocks.find((block) => block.kind === "primary_claim").text;
    const originalBodies = pageSpec.contentBlocks.filter((block) => block.kind !== "title" && block.kind !== "primary_claim" && block.kind !== "placeholder");
    const rewrite = {
        canonicalText: [originalTitle, originalClaim, ...originalBodies.map((block) => block.text)].join("\n"),
        title: originalTitle,
        primaryClaim: originalClaim,
        contentForm: "comparison",
        blocks: originalBodies.map((block, index) => ({ key: `body-${index + 1}`, kind: block.kind, text: block.text })),
        visualEncoding: [{ contentKeys: originalBodies.map((_, index) => `body-${index + 1}`), intent: "group", channel: "shape" }],
    };
    const rewritten = applyPptCanonicalPageRewrite(partial.ppt, pageSpec.pageId, pageSpec.version, rewrite);
    const rewrittenPage = rewritten.pageSpecs[0];

    assert.equal(rewrittenPage.contentForm, "comparison");
    assert.equal(rewrittenPage.visualEncoding.length, 1);
    assert.deepEqual(
        rewrittenPage.visualEncoding[0].contentBlockIds,
        rewrittenPage.contentBlocks.slice(2).map((block) => block.id),
    );
    const approved = approvePptCanonicalPageContent(rewritten, pageSpec.pageId, rewrittenPage.version, "2026-07-22T09:00:00.000Z");
    const snapshot = compilePptPromptSnapshot({
        compilePolicy: "structured",
        snapshotId: "snapshot-structured-rewrite",
        compiledAt: "2026-07-22T09:01:00.000Z",
        deckBrief: approved.deckBrief,
        pageSpecs: approved.pageSpecs,
        targets: [targetFor(approved.pageSpecs[0])],
    });
    const prompt = snapshot.prompts[0].finalPrompt;
    assert.match(prompt, /【内容结构】[\s\S]*对比/);
    assert.match(prompt, /【信息表达】[\s\S]*对 B3、B4 使用形状表达分组/);
    for (const line of rewrite.canonicalText.split("\n")) assert.equal(prompt.split(line).length - 1, 1);
});

test("结构化 AI 改写保留未变原始溯源，拒绝非法块与新增事实", () => {
    const draft = resolveAllGaps(createDraft());
    const { brief, pageSpecs } = finalizePptContentDraft(draft, "2026-07-22T08:01:00.000Z");
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "AI 改写溯源测试",
        sourceMaterial: sourceInput().sourceMaterial,
        requirements: sourceInput().requirements,
        deckBrief: deckBriefFrom(brief),
        pageSpecs,
    });
    const page = partial.ppt.pageSpecs[0];
    const title = page.contentBlocks.find((block) => block.kind === "title");
    const claim = page.contentBlocks.find((block) => block.kind === "primary_claim");
    const body = page.contentBlocks.find((block) => block.kind !== "title" && block.kind !== "primary_claim" && block.kind !== "placeholder");
    const unchanged = {
        canonicalText: [title.text, claim.text, body.text].join("\n"),
        title: title.text,
        primaryClaim: claim.text,
        contentForm: "narrative",
        blocks: [{ key: "body", kind: body.kind, text: body.text }],
        visualEncoding: [{ contentKeys: ["body"], intent: "group", channel: "shape" }],
    };
    const rewritten = applyPptCanonicalPageRewrite(partial.ppt, page.pageId, page.version, unchanged);
    const rewrittenPage = rewritten.pageSpecs[0];

    assert.deepEqual(
        rewrittenPage.contentBlocks.map((block) => block.id),
        [title.id, claim.id, body.id],
    );
    assert.deepEqual(
        rewrittenPage.sourceRefs.map((source) => source.source),
        page.sourceRefs.filter((source) => [...title.sourceRefIds, ...claim.sourceRefIds, ...body.sourceRefIds].includes(source.id)).map((source) => source.source),
    );

    const invalidKind = {
        ...unchanged,
        canonicalText: [title.text, claim.text, "无效块"].join("\n"),
        blocks: [{ key: "body", kind: "evil_kind", text: "无效块" }],
    };
    assert.throws(() => applyPptCanonicalPageRewrite(partial.ppt, page.pageId, page.version, invalidKind), /无效的内容块/);

    const inventedFact = {
        ...unchanged,
        canonicalText: [title.text, claim.text, "资源投入：需要 999 台服务器"].join("\n"),
        blocks: [{ key: "body", kind: "body", text: "资源投入：需要 999 台服务器" }],
    };
    assert.throws(() => applyPptCanonicalPageRewrite(partial.ppt, page.pageId, page.version, inventedFact), /新增了未批准的事实/);
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
        contentRevision: `${brief.sourceHash}:r${brief.version}`,
        audience: brief.audience,
        goal: brief.goal,
        narrative: brief.narrative,
        styleContract: createPptVisualDirectionPresetContract("clean-report"),
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

// --- SHA-19 / SHA-21 page repair closure ---

test("SHA-19：374 字超长页未压缩结果被拒绝，压缩后可通过", () => {
    const title = "选型标题";
    const claim = "一句话主张";
    const body = "密".repeat(374 - [...title].length - [...claim].length);
    const material = [title, claim, body, "合作伙伴", "完成选型", "从问题到方案"].join("\n");
    const input = { title: "选型", sourceMaterial: material, requirements: "" };
    const raw = {
        brief: { audience: "合作伙伴", goal: "完成选型", narrative: "从问题到方案" },
        pages: [
            {
                title,
                titleSource: { source: "material", startLine: 1, endLine: 1 },
                purpose: "说明选型",
                primaryClaim: claim,
                primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                contentForm: "narrative",
                blocks: [{ key: "dense", kind: "body", text: body, source: { source: "material", startLine: 3, endLine: 3 } }],
                layoutIntent: ["上下分区"],
                visualEncoding: [],
                gaps: [],
            },
        ],
    };
    const current = normalizePptContentDraft(raw, input);
    const text = renderPptPageSpecText(current.pageSpecs[0]);
    assert.equal([...text.replace(/\r?\n/g, "")].length, 374);
    const excessive = current.audit.issues.filter((issue) => issue.code === "excessive_copy" && issue.pageIds.includes(current.pageSpecs[0].pageId));
    assert.ok(excessive.length, "应检出超长文案");
    assert.match(excessive[0].message, /374|压缩|拆页/);

    const requested = selectPptPageRepairAuditIssues(current, current.pageSpecs[0].pageId, excessive[0].id);
    assert.ok(requested.some((issue) => issue.code === "excessive_copy"));

    const unchanged = normalizePptContentDraft(raw, { ...input, previousPageSpecs: current.pageSpecs });
    const rejected = replacePptContentDraftPage(current, current.revision, current.pageSpecs[0].pageId, unchanged.pageSpecs[0], unchanged.audit.gaps);
    assert.throws(() => assertPptPageAuditIssuesResolved(rejected, current.pageSpecs[0].pageId, requested), /问题仍未解决|原页已保留/);

    const shortClaim = "选型要覆盖接入、容量、安全与成本";
    const shortBody = "接入能力、并发容量、安全合规与总成本需一并评估。";
    const shortMaterial = [title, shortClaim, shortBody, "合作伙伴", "完成选型", "从问题到方案"].join("\n");
    const shortInput = { title: "选型", sourceMaterial: shortMaterial, requirements: "" };
    const shortRaw = {
        brief: raw.brief,
        pages: [
            {
                title,
                titleSource: { source: "material", startLine: 1, endLine: 1 },
                purpose: "说明选型",
                primaryClaim: shortClaim,
                primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                contentForm: "narrative",
                blocks: [{ key: "dense", kind: "body", text: shortBody, source: { source: "material", startLine: 3, endLine: 3 } }],
                layoutIntent: ["上下分区"],
                visualEncoding: [],
                gaps: [],
            },
        ],
    };
    const compressed = normalizePptContentDraft(shortRaw, { ...shortInput, previousPageSpecs: current.pageSpecs });
    const accepted = replacePptContentDraftPage(current, current.revision, current.pageSpecs[0].pageId, compressed.pageSpecs[0], compressed.audit.gaps);
    assert.doesNotThrow(() => assertPptPageAuditIssuesResolved(accepted, current.pageSpecs[0].pageId, requested));
    assert.equal(
        accepted.audit.issues.some((issue) => issue.code === "excessive_copy" && issue.pageIds.includes(current.pageSpecs[0].pageId)),
        false,
    );
    assert.equal(pptPageRepairActionLabel(excessive[0]), "压缩本页");
});

test("SHA-21：不合格封面拒绝替换，合格封面可通过", () => {
    const material = ["PPT 工作台", "把内容规划连接到页面生成", "第一次接触产品的人", "理解产品价值", "从问题到价值", "正文页要点"].join("\n");
    const input = { title: "PPT 工作台", sourceMaterial: material, requirements: "" };
    const badCoverRaw = {
        brief: { audience: "第一次接触产品的人", goal: "理解产品价值", narrative: "从问题到价值" },
        pages: [
            {
                title: "PPT 工作台",
                titleSource: { source: "material", startLine: 1, endLine: 1 },
                purpose: "建立定位",
                primaryClaim: "为什么需要、好在哪里、解决什么问题、为谁服务",
                primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                contentForm: "cover",
                blocks: [{ key: "extra", kind: "body", text: "正文页要点", source: { source: "material", startLine: 6, endLine: 6 } }],
                layoutIntent: ["居中主视觉"],
                visualEncoding: [],
                gaps: [],
            },
            {
                title: "正文页",
                titleSource: { source: "material", startLine: 6, endLine: 6 },
                purpose: "展开要点",
                primaryClaim: "把内容规划连接到页面生成",
                primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                contentForm: "narrative",
                blocks: [],
                layoutIntent: ["上下分区"],
                visualEncoding: [],
                gaps: [],
            },
        ],
    };
    const current = normalizePptContentDraft(badCoverRaw, input);
    const coverIssues = current.audit.issues.filter((issue) => issue.code === "invalid_cover" && issue.pageIds.includes(current.pageSpecs[0].pageId));
    assert.ok(coverIssues.length);
    assert.equal(pptPageRepairActionLabel(coverIssues[0]), "修复封面");

    const requested = selectPptPageRepairAuditIssues(current, current.pageSpecs[0].pageId, coverIssues[0].id);
    assert.ok(requested.some((issue) => issue.code === "invalid_cover"));

    const stillBad = normalizePptContentDraft(badCoverRaw, { ...input, previousPageSpecs: [current.pageSpecs[0]] });
    const rejected = replacePptContentDraftPage(
        current,
        current.revision,
        current.pageSpecs[0].pageId,
        stillBad.pageSpecs[0],
        stillBad.audit.gaps.filter((gap) => gap.pageId === current.pageSpecs[0].pageId),
    );
    assert.throws(() => assertPptPageAuditIssuesResolved(rejected, current.pageSpecs[0].pageId, requested), /问题仍未解决|原页已保留/);

    const goodCoverRaw = {
        brief: badCoverRaw.brief,
        pages: [
            {
                title: "PPT 工作台",
                titleSource: { source: "material", startLine: 1, endLine: 1 },
                purpose: "建立定位",
                primaryClaim: "把内容规划连接到页面生成",
                primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                contentForm: "cover",
                blocks: [],
                layoutIntent: ["居中主视觉"],
                visualEncoding: [],
                gaps: [],
            },
        ],
    };
    const fixed = normalizePptContentDraft(goodCoverRaw, { ...input, previousPageSpecs: [current.pageSpecs[0]] });
    const accepted = replacePptContentDraftPage(current, current.revision, current.pageSpecs[0].pageId, fixed.pageSpecs[0], fixed.audit.gaps);
    assert.doesNotThrow(() => assertPptPageAuditIssuesResolved(accepted, current.pageSpecs[0].pageId, requested));
    assert.equal(
        accepted.audit.issues.some((issue) => issue.code === "invalid_cover" && issue.pageIds.includes(current.pageSpecs[0].pageId)),
        false,
    );
});

test("页级修复目标：选中问题并保留同页 blocking", () => {
    const draft = normalizePptContentDraft(
        {
            brief: { audience: "伙伴", goal: "理解", narrative: "主线" },
            pages: [
                {
                    title: "页",
                    purpose: "说明",
                    primaryClaim: "主张",
                    contentForm: "narrative",
                    blocks: [{ key: "b", kind: "body", text: "密".repeat(300) }],
                    layoutIntent: ["上下分区"],
                    visualEncoding: [],
                    gaps: [],
                },
            ],
        },
        { title: "页", sourceMaterial: `页\n主张\n${"密".repeat(300)}\n伙伴\n理解\n主线`, requirements: "" },
    );
    const pageId = draft.pageSpecs[0].pageId;
    const warning = draft.audit.issues.find((issue) => issue.code === "excessive_copy" && issue.pageIds.includes(pageId));
    assert.ok(warning);
    const onlyTarget = selectPptPageRepairAuditIssues(draft, pageId, warning.id);
    assert.ok(onlyTarget.some((issue) => issue.code === "excessive_copy"));
    const all = selectPptPageRepairAuditIssues(draft, pageId);
    assert.ok(all.length >= onlyTarget.length);
    assert.equal(pptPageRepairActionLabel({ code: "noise_text" }), "修复本页");
});

// --- SHA-22 / SHA-23 / SHA-24 / SHA-25 gap provenance ---

test("SHA-22：错误行号在材料中可定位时自动重绑，不生成同文 unsupported_claim", () => {
    const claim = "安全决策：SSH 22端口不收紧来源，仅限制 root 登录";
    const draft = normalizePptContentDraft(
        {
            brief: { audience: "运维同事", goal: "对齐安全边界", narrative: "从决策到落地" },
            pages: [
                {
                    title: "安全决策",
                    titleSource: { source: "material", startLine: 1, endLine: 1 },
                    purpose: "说明安全边界",
                    primaryClaim: claim,
                    primaryClaimSource: { source: "material", startLine: 99, endLine: 99 },
                    contentForm: "narrative",
                    blocks: [],
                    visualEncoding: [],
                    gaps: [],
                },
            ],
        },
        {
            title: "安全决策",
            sourceMaterial: `安全决策\n${claim}\n运维同事\n对齐安全边界\n从决策到落地`,
            requirements: "",
        },
    );
    const page = draft.pageSpecs[0];
    const claimBlock = page.contentBlocks.find((block) => block.kind === "primary_claim");
    const source = page.sourceRefs.find((item) => claimBlock.sourceRefIds.includes(item.id));
    assert.ok(source);
    assert.equal(source.startLine, 2);
    assert.equal(source.endLine, 2);
    assert.equal(source.excerpt, claim);
    assert.equal(
        draft.audit.gaps.some((gap) => gap.kind === "unsupported_claim" && gap.proposedAnswer === claim),
        false,
    );
    assert.doesNotMatch(draft.audit.gaps.map((gap) => gap.question).join("\n"), /请确认或补充：安全决策/);
});

test("SHA-24：多条正文错误行号各自重绑到支持它们的最小连续行", () => {
    const panel = "面板使用 3x-ui 管理入站";
    const cert = "证书续期：x-ui x25519";
    const draft = normalizePptContentDraft(
        {
            brief: { audience: "运维", goal: "落地", narrative: "步骤" },
            pages: [
                {
                    title: "部署要点",
                    titleSource: { source: "material", startLine: 1, endLine: 1 },
                    purpose: "部署步骤",
                    primaryClaim: "按顺序完成面板与证书",
                    primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                    contentForm: "process",
                    blocks: [
                        { key: "panel", kind: "list", text: panel, source: { source: "material", startLine: 88, endLine: 88 } },
                        { key: "cert", kind: "list", text: cert, source: { source: "material", startLine: 77, endLine: 77 } },
                    ],
                    visualEncoding: [],
                    gaps: [],
                },
            ],
        },
        {
            title: "部署要点",
            sourceMaterial: `部署要点\n按顺序完成面板与证书\n${panel}\n${cert}\n运维\n落地\n步骤`,
            requirements: "",
        },
    );
    const page = draft.pageSpecs[0];
    const panelBlock = page.contentBlocks.find((block) => block.text === panel);
    const certBlock = page.contentBlocks.find((block) => block.text === cert);
    const panelSource = page.sourceRefs.find((item) => panelBlock.sourceRefIds.includes(item.id));
    const certSource = page.sourceRefs.find((item) => certBlock.sourceRefIds.includes(item.id));
    assert.equal(panelSource?.startLine, 3);
    assert.equal(certSource?.startLine, 4);
    assert.equal(
        draft.audit.gaps.some((gap) => gap.kind === "unsupported_claim" && (gap.proposedAnswer === panel || gap.proposedAnswer === cert)),
        false,
    );
});

test("SHA-23：空核心信息只产生请补充本页核心信息，不出现本页内容", () => {
    const draft = normalizePptContentDraft(
        {
            brief: { audience: "读者", goal: "理解", narrative: "主线" },
            pages: [
                {
                    title: "空核心页",
                    titleSource: { source: "material", startLine: 1, endLine: 1 },
                    purpose: "待写核心",
                    primaryClaim: "",
                    contentForm: "narrative",
                    blocks: [],
                    visualEncoding: [],
                    gaps: [],
                },
            ],
        },
        { title: "空核心页", sourceMaterial: "空核心页\n读者\n理解\n主线", requirements: "" },
    );
    const claimGaps = draft.audit.gaps.filter((gap) => gap.pageId === draft.pageSpecs[0].pageId && draft.pageSpecs[0].contentBlocks.some((block) => block.kind === "primary_claim" && block.gapId === gap.id));
    assert.ok(claimGaps.some((gap) => gap.kind === "missing_detail" && gap.question === "请补充本页核心信息"));
    assert.equal(
        draft.audit.gaps.some((gap) => /本页内容/.test(gap.question)),
        false,
    );
    assert.equal(
        draft.audit.gaps.some((gap) => gap.kind === "unsupported_claim" && !gap.proposedAnswer),
        false,
    );
});

test("SHA-23：真正空标题保留第N页展示回退，并产生请补充本页标题", () => {
    const draft = normalizePptContentDraft(
        {
            brief: { audience: "读者", goal: "理解", narrative: "主线" },
            pages: [
                {
                    title: "",
                    purpose: "待写标题",
                    primaryClaim: "已有核心信息",
                    primaryClaimSource: { source: "material", startLine: 1, endLine: 1 },
                    contentForm: "narrative",
                    blocks: [],
                    visualEncoding: [],
                    gaps: [],
                },
            ],
        },
        { title: "材料标题", sourceMaterial: "已有核心信息\n读者\n理解\n主线", requirements: "" },
    );
    const page = draft.pageSpecs[0];
    const titleBlock = page.contentBlocks.find((block) => block.kind === "title");
    assert.equal(titleBlock?.text, "第1页");
    const titleGap = draft.audit.gaps.find((gap) => gap.id === titleBlock?.gapId);
    assert.ok(titleGap);
    assert.equal(titleGap.kind, "missing_detail");
    assert.equal(titleGap.question, "请补充本页标题");
    assert.equal(titleGap.proposedAnswer, undefined);
    assert.equal(
        draft.audit.gaps.some((gap) => /本页内容|请确认或补充：第1页/.test(gap.question)),
        false,
    );
});

test("SHA-25：纯占位列表归一为 placeholder + 具体 missing_detail，且无同文建议", () => {
    const draft = normalizePptContentDraft(
        {
            brief: { audience: "读者", goal: "理解", narrative: "主线" },
            pages: [
                {
                    title: "占位页",
                    titleSource: { source: "material", startLine: 1, endLine: 1 },
                    purpose: "说明占位",
                    primaryClaim: "先列清单",
                    primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                    contentForm: "narrative",
                    blocks: [{ key: "todo", kind: "list", text: "待补充" }],
                    visualEncoding: [],
                    gaps: [],
                },
            ],
        },
        { title: "占位页", sourceMaterial: "占位页\n先列清单\n读者\n理解\n主线", requirements: "" },
    );
    const page = draft.pageSpecs[0];
    const block = page.contentBlocks.find((item) => item.kind === "placeholder" || item.text === "待补充");
    assert.ok(block);
    assert.equal(block.kind, "placeholder");
    assert.equal(block.sourceRefIds.length, 0);
    const gap = draft.audit.gaps.find((item) => item.id === block.gapId);
    assert.ok(gap);
    assert.equal(gap.kind, "missing_detail");
    assert.equal(gap.question, "请补充本页列表内容");
    assert.equal(gap.proposedAnswer, undefined);
    assert.equal(
        draft.audit.gaps.some((item) => item.question === "请确认或补充：待补充"),
        false,
    );
});

// --- SHA-26 content provenance contract ---

test("SHA-26：derived 核心信息绑定材料行号，不阻断且不生成同文 unsupported_claim", () => {
    const claim = "解决从“手里有一份材料”到“得到一套可以讲、可以修改、可以交付的PPT”之间的全部关键工作";
    const material = `PPT 工作台
把零散材料整理成可讲、可改、可交付的演示文稿
从手里有一份材料，到得到一套可以讲、可以修改、可以交付的 PPT
需要处理结构梳理、内容精炼和版式落地等关键工作
受众是产品团队
目标是对齐方案`;
    const raw = {
        brief: { audience: "产品团队", goal: "对齐方案", narrative: "从材料到可交付演示" },
        pages: [
            {
                title: "PPT 工作台",
                titleSource: { source: "material", relation: "verbatim", startLine: 1, endLine: 1 },
                purpose: "定位产品价值",
                primaryClaim: claim,
                primaryClaimSource: { source: "material", relation: "derived", startLine: 3, endLine: 4 },
                contentForm: "narrative",
                blocks: [{ key: "body", kind: "body", text: "把零散材料整理成可讲、可改、可交付的演示文稿", source: { source: "material", relation: "verbatim", startLine: 2, endLine: 2 } }],
                visualEncoding: [],
                gaps: [],
            },
        ],
    };
    const input = { title: "PPT 工作台", sourceMaterial: material, requirements: "" };
    const draft = normalizePptContentDraft(raw, input);
    const page = draft.pageSpecs[0];
    const claimBlock = page.contentBlocks.find((block) => block.kind === "primary_claim");
    const source = page.sourceRefs.find((item) => claimBlock.sourceRefIds.includes(item.id));
    assert.ok(source);
    assert.equal(source.relation, "derived");
    assert.equal(source.source, "material");
    assert.equal(source.startLine, 3);
    assert.equal(source.endLine, 4);
    assert.equal(source.excerpt, "从手里有一份材料，到得到一套可以讲、可以修改、可以交付的 PPT\n需要处理结构梳理、内容精炼和版式落地等关键工作");
    assert.equal(claimBlock.gapId, undefined);
    assert.equal(
        draft.audit.gaps.some((gap) => gap.kind === "unsupported_claim" && gap.pageId === page.pageId),
        false,
    );
    assert.doesNotMatch(draft.audit.gaps.map((gap) => gap.question).join("\n"), /请确认或补充：|引用范围无效或与内容无关/);
    assert.equal(page.contentState.status === "blocked", false);

    const finalized = finalizePptContentDraft(draft, "2026-07-23T00:00:00.000Z");
    assert.equal(finalized.pageSpecs[0].sourceRefs.find((item) => item.id === source.id)?.relation, "derived");
    const regenerated = normalizePptContentDraft(raw, { ...input, previousPageSpecs: finalized.pageSpecs });
    const replacement = replacePptContentDraftPage(draft, draft.revision, page.pageId, regenerated.pageSpecs[0], regenerated.audit.gaps);
    assert.equal(replacement.pageSpecs[0].sourceRefs.find((item) => item.id === source.id)?.relation, "derived");
});

test("SHA-26：derived 新增未支持硬事实仍阻断，且问题为短句", () => {
    const claim = "先投入 8 台服务器完成双活";
    const draft = normalizePptContentDraft(
        {
            brief: { audience: "运维", goal: "落地", narrative: "资源" },
            pages: [
                {
                    title: "资源投入",
                    titleSource: { source: "material", relation: "verbatim", startLine: 1, endLine: 1 },
                    purpose: "说明资源",
                    primaryClaim: claim,
                    primaryClaimSource: { source: "material", relation: "derived", startLine: 2, endLine: 2 },
                    contentForm: "narrative",
                    blocks: [],
                    visualEncoding: [],
                    gaps: [],
                },
            ],
        },
        { title: "资源投入", sourceMaterial: "资源投入\n先规划服务器与带宽，具体数量待评估\n运维\n落地\n资源", requirements: "" },
    );
    const page = draft.pageSpecs[0];
    const claimBlock = page.contentBlocks.find((block) => block.kind === "primary_claim");
    assert.equal(claimBlock.sourceRefIds.length, 0);
    const gap = draft.audit.gaps.find((item) => item.id === claimBlock.gapId);
    assert.ok(gap);
    assert.equal(gap.kind, "unsupported_claim");
    assert.equal(gap.blocking, true);
    assert.equal(gap.question, "请确认本页核心信息中的新增表述");
    assert.equal(gap.reason, "该表述引入了原材料未支持的事实或结论");
    assert.equal(gap.proposedAnswer, claim);
    assert.doesNotMatch(gap.question, /请确认或补充：/);
    assert.doesNotMatch(gap.reason, /引用范围无效/);
});

test("SHA-26：错误行号但原文可逐字定位仍重绑为 verbatim", () => {
    const claim = "安全决策：SSH 22端口不收紧来源，仅限制 root 登录";
    const draft = normalizePptContentDraft(
        {
            brief: { audience: "运维同事", goal: "对齐安全边界", narrative: "从决策到落地" },
            pages: [
                {
                    title: "安全决策",
                    titleSource: { source: "material", relation: "derived", startLine: 1, endLine: 1 },
                    purpose: "说明安全边界",
                    primaryClaim: claim,
                    primaryClaimSource: { source: "material", relation: "derived", startLine: 99, endLine: 99 },
                    contentForm: "narrative",
                    blocks: [],
                    visualEncoding: [],
                    gaps: [],
                },
            ],
        },
        {
            title: "安全决策",
            sourceMaterial: `安全决策\n${claim}\n运维同事\n对齐安全边界\n从决策到落地`,
            requirements: "",
        },
    );
    const claimBlock = draft.pageSpecs[0].contentBlocks.find((block) => block.kind === "primary_claim");
    const source = draft.pageSpecs[0].sourceRefs.find((item) => claimBlock.sourceRefIds.includes(item.id));
    assert.ok(source);
    assert.equal(source.relation, "verbatim");
    assert.equal(source.startLine, 2);
    assert.equal(source.endLine, 2);
    assert.equal(source.excerpt, claim);
});

test("SHA-26：Deck Brief 非空归纳不因未逐字出现而创建 unsupported gap", () => {
    const draft = normalizePptContentDraft(
        {
            brief: { audience: "首次接触的产品经理", goal: "在十分钟内对齐交付边界", narrative: "从材料到可讲可改可交付" },
            pages: [
                {
                    title: "封面",
                    titleSource: { source: "material", relation: "verbatim", startLine: 1, endLine: 1 },
                    purpose: "封面",
                    primaryClaim: "PPT 工作台",
                    primaryClaimSource: { source: "material", relation: "verbatim", startLine: 1, endLine: 1 },
                    contentForm: "cover",
                    blocks: [],
                    visualEncoding: [],
                    gaps: [],
                },
            ],
        },
        { title: "PPT 工作台", sourceMaterial: "PPT 工作台\n材料整理\n交付演示", requirements: "" },
    );
    assert.equal(
        draft.audit.gaps.some((gap) => gap.briefField),
        false,
    );
    assert.equal(draft.brief.audience, "首次接触的产品经理");
    assert.equal(draft.brief.goal, "在十分钟内对齐交付边界");
});

test("SHA-26：Deck Brief 空字段仍产生 missing_detail", () => {
    const draft = normalizePptContentDraft(
        {
            brief: { audience: "", goal: "", narrative: "" },
            pages: [
                {
                    title: "封面",
                    titleSource: { source: "material", relation: "verbatim", startLine: 1, endLine: 1 },
                    purpose: "封面",
                    primaryClaim: "PPT 工作台",
                    primaryClaimSource: { source: "material", relation: "verbatim", startLine: 1, endLine: 1 },
                    contentForm: "cover",
                    blocks: [],
                    visualEncoding: [],
                    gaps: [],
                },
            ],
        },
        { title: "PPT 工作台", sourceMaterial: "PPT 工作台", requirements: "" },
    );
    const briefGaps = draft.audit.gaps.filter((gap) => gap.briefField);
    assert.equal(briefGaps.length, 3);
    assert.ok(briefGaps.every((gap) => gap.kind === "missing_detail" && gap.blocking));
});

// --- SHA-27：多块同 gap 采纳不得覆写实质内容 ---

test("SHA-27：多实质块绑定同 gap 采纳后文本不变且挂确认 sourceRef", () => {
    const answer = "主推官方一键脚本（最适合小白）；页脚备注";
    const texts = ["正文一：选型说明", "正文二：部署步骤", "正文三：运维要点", "列表：成本与资源"];
    const draft = normalizePptContentDraft(
        {
            brief: rawDraft().brief,
            pages: [
                {
                    title: "中转站介绍",
                    titleSource: { source: "material", startLine: 1, endLine: 1 },
                    purpose: "说明项目价值",
                    primaryClaim: "梳理思路、招募伙伴并展示未来空间",
                    primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                    contentForm: "narrative",
                    blocks: texts.map((text, index) => ({
                        key: `body-${index}`,
                        kind: index === 3 ? "list" : "body",
                        text,
                        gapKey: "shared-gap",
                    })),
                    visualEncoding: [],
                    gaps: [
                        {
                            key: "shared-gap",
                            kind: "missing_detail",
                            question: "是否采用脚本建议？",
                            reason: "材料未明确脚本口径",
                            blocking: true,
                            proposedAnswer: answer,
                        },
                    ],
                },
            ],
        },
        sourceInput(),
    );
    const gap = draft.audit.gaps.find((item) => item.proposedAnswer === answer);
    assert.ok(gap);
    const boundBefore = draft.pageSpecs[0].contentBlocks.filter((block) => block.gapId === gap.id);
    assert.ok(boundBefore.length >= 3);

    const accepted = acceptPptPageSuggestions(draft, draft.pageSpecs[0].pageId, "2026-07-22T10:00:00.000Z");
    const page = accepted.pageSpecs[0];
    const sourceRef = page.sourceRefs.find((item) => item.source === "confirmed_assumption" && item.excerpt === answer);
    assert.ok(sourceRef);

    for (const text of texts) {
        const block = page.contentBlocks.find((item) => item.text === text);
        assert.ok(block, `应保留原文：${text}`);
        assert.ok(block.sourceRefIds.includes(sourceRef.id));
        assert.equal(block.gapId, gap.id);
    }
    assert.equal(
        page.contentBlocks.filter((block) => block.text === answer).length,
        0,
    );
    const bodyTexts = page.contentBlocks.filter((block) => block.kind !== "title" && block.kind !== "primary_claim").map((block) => block.text);
    assert.equal(new Set(bodyTexts).size, bodyTexts.length);
    assert.equal(page.contentState.status, "reviewable");
});

test("SHA-27：多 placeholder 绑定同 gap 答案只落一个块", () => {
    const answer = "先投入 2 台服务器";
    const draft = normalizePptContentDraft(
        {
            brief: rawDraft().brief,
            pages: [
                {
                    title: "中转站介绍",
                    titleSource: { source: "material", startLine: 1, endLine: 1 },
                    purpose: "说明项目价值",
                    primaryClaim: "梳理思路、招募伙伴并展示未来空间",
                    primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
                    contentForm: "narrative",
                    blocks: [
                        { key: "slot-a", kind: "placeholder", text: "待补资源一", gapKey: "resources" },
                        { key: "slot-b", kind: "placeholder", text: "待补资源二", gapKey: "resources" },
                        { key: "slot-c", kind: "placeholder", text: "待补资源三", gapKey: "resources" },
                    ],
                    visualEncoding: [],
                    gaps: [
                        {
                            key: "resources",
                            kind: "missing_detail",
                            question: "服务器投入是多少？",
                            reason: "材料未提供",
                            blocking: true,
                            proposedAnswer: answer,
                        },
                    ],
                },
            ],
        },
        sourceInput(),
    );
    const gap = draft.audit.gaps.find((item) => item.proposedAnswer === answer);
    assert.ok(gap);
    assert.equal(draft.pageSpecs[0].contentBlocks.filter((block) => block.gapId === gap.id).length, 3);

    const resolved = resolvePptInformationGap(draft, gap.id, {
        kind: "confirmed_assumption",
        text: answer,
        resolvedAt: "2026-07-22T10:00:00.000Z",
    });
    const page = resolved.pageSpecs[0];
    const answerBlocks = page.contentBlocks.filter((block) => block.text === answer);
    assert.equal(answerBlocks.length, 1);
    assert.equal(answerBlocks[0].kind, "body");
    assert.equal(page.contentBlocks.filter((block) => block.gapId === gap.id).length, 1);
    assert.ok(page.sourceRefs.some((source) => source.source === "confirmed_assumption" && answerBlocks[0].sourceRefIds.includes(source.id)));
});

test("SHA-27：多实质块采纳后重跑解析确认状态不丢", () => {
    const answer = "主推官方一键脚本（最适合小白）";
    const texts = ["正文一：选型说明", "正文二：部署步骤", "正文三：运维要点"];
    const pageRaw = {
        title: "中转站介绍",
        titleSource: { source: "material", startLine: 1, endLine: 1 },
        purpose: "说明项目价值",
        primaryClaim: "梳理思路、招募伙伴并展示未来空间",
        primaryClaimSource: { source: "material", startLine: 2, endLine: 2 },
        contentForm: "narrative",
        blocks: texts.map((text, index) => ({
            key: `body-${index}`,
            kind: "body",
            text,
            gapKey: "shared-gap",
        })),
        visualEncoding: [],
        gaps: [
            {
                key: "shared-gap",
                kind: "missing_detail",
                question: "是否采用脚本建议？",
                reason: "材料未明确脚本口径",
                blocking: true,
                proposedAnswer: answer,
            },
        ],
    };
    const initial = normalizePptContentDraft({ brief: rawDraft().brief, pages: [pageRaw] }, sourceInput());
    const gap = initial.audit.gaps.find((item) => item.proposedAnswer === answer);
    const accepted = resolvePptInformationGap(initial, gap.id, {
        kind: "confirmed_assumption",
        text: answer,
        resolvedAt: "2026-07-22T10:00:00.000Z",
    });
    const previousPage = accepted.pageSpecs[0];

    const regenerated = normalizePptContentDraft({ brief: rawDraft().brief, pages: [structuredClone(pageRaw)] }, { ...sourceInput(), previousPageSpecs: [previousPage] });
    const replaced = replacePptContentDraftPage(accepted, accepted.revision, previousPage.pageId, regenerated.pageSpecs[0], regenerated.audit.gaps);
    const page = replaced.pageSpecs[0];
    const resolvedGap = replaced.audit.gaps.find((item) => item.id === gap.id);
    assert.ok(resolvedGap?.resolution);
    assert.equal(resolvedGap.resolution.kind, "confirmed_assumption");
    assert.equal(resolvedGap.resolution.text, answer);
    assert.equal(
        replaced.audit.gaps.some((item) => !item.resolution && item.proposedAnswer === answer),
        false,
    );
    for (const text of texts) {
        const block = page.contentBlocks.find((item) => item.text === text);
        assert.ok(block, `重跑后仍应保留原文：${text}`);
        assert.ok(page.sourceRefs.some((source) => isConfirmedSourceOnBlock(page, block, source)));
    }
    assert.equal(page.contentState.status, "reviewable");
});

function isConfirmedSourceOnBlock(page, block, source) {
    return (source.source === "confirmed_assumption" || source.source === "user_answer") && block.sourceRefIds.includes(source.id);
}
