import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let assertGenerationPlanCompilation;
let assertGenerationPlanCurrentTargets;
let buildPptDeckProject;
let createGenerationPlan;
let createPptVisualDirectionPresetContract;
let createPptGenerationModule;
let defaultConfig;
let hashPptSourceText;
let hashPptContentSource;
let previewGenerationPlan;
let resolvePptCandidateCompilationSnapshot;
let vite;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ buildPptDeckProject, hashPptContentSource, hashPptSourceText } = await vite.ssrLoadModule("/src/lib/ppt/deck-builder.ts"));
    ({ assertGenerationPlanCompilation, assertGenerationPlanCurrentTargets, createGenerationPlan, previewGenerationPlan } = await vite.ssrLoadModule("/src/lib/ppt/generation-plan.ts"));
    ({ createPptGenerationModule } = await vite.ssrLoadModule("/src/lib/ppt/generation-execution.ts"));
    ({ resolvePptCandidateCompilationSnapshot } = await vite.ssrLoadModule("/src/lib/ppt/page-confirmation.ts"));
    ({ defaultConfig } = await vite.ssrLoadModule("/src/stores/use-config-store.ts"));
    ({ createPptVisualDirectionPresetContract } = await vite.ssrLoadModule("/src/lib/ppt/style-contract.ts"));
});

after(async () => {
    await vite?.close();
});

test("生成计划分别冻结 structured 与 verbatim 的 canonical 分支", () => {
    const structured = structuredProject("plan-structured");
    const structuredPlan = planFor(structured);
    assert.equal(structuredPlan.callCount, 1);
    assert.equal(structuredPlan.compilation.compilePolicy, "structured");
    assert.deepEqual(structuredPlan.compilation.pageSpecs, structured.ppt.pageSpecs);
    assert.match(structuredPlan.runs[0].requests[0].prompt, /项目概览/);
    assertGenerationPlanCompilation(structuredPlan);

    const verbatim = verbatimProject("plan-verbatim");
    const take = verbatim.ppt.pages[0].takes[0];
    const anchor = verbatim.nodes.find((node) => node.id === take.anchorNodeId);
    anchor.metadata.content = "节点投影被改写，但不应成为 canonical 输入";
    const verbatimPlan = planFor(verbatim);
    assert.equal(verbatimPlan.callCount, 1);
    assert.equal(verbatimPlan.compilation.compilePolicy, "verbatim");
    assert.deepEqual(verbatimPlan.compilation.verbatimSpecs, verbatim.ppt.verbatimSpecs);
    assert.equal(verbatimPlan.compilation.targets[0].semanticText, verbatim.ppt.verbatimSpecs[0].exactText);
    assert.equal(verbatimPlan.runs[0].requests[0].prompt, `${verbatim.ppt.verbatimSpecs[0].exactText}\n\n${verbatim.ppt.confirmedGlobalSpec}`);
    assertGenerationPlanCompilation(verbatimPlan);
    assertGenerationPlanCurrentTargets(verbatim, verbatimPlan);
});

test("页面描述符损坏时计划中没有请求，逐字模式的节点覆盖也在请求前阻断", () => {
    const invalid = structuredProject("invalid-descriptor");
    invalid.ppt.pageSpecs[0].contentBlocks.find((block) => block.kind === "title").text = "";
    const invalidPlan = planFor(invalid);
    assert.equal(invalidPlan.callCount, 0);
    assert.equal(invalidPlan.runs.flatMap((run) => run.requests).length, 0);
    assert.equal(invalidPlan.compilation, undefined);
    assert.match(invalidPlan.excludedPages[0].reason, /标题或核心信息规格损坏/);

    for (const [suffix, mutate] of [
        ["verbatim-override", (metadata) => (metadata.pptCompiledPromptOverride = "节点私自覆盖逐字正文")],
        ["verbatim-layout", (metadata) => (metadata.pptLayoutPrompt = "节点私自增加版式要求")],
    ]) {
        const overridden = verbatimProject(suffix);
        const configNodeId = overridden.ppt.pages[0].takes[0].configNodeId;
        mutate(overridden.nodes.find((node) => node.id === configNodeId).metadata);
        assert.throws(() => planFor(overridden), /PPT Compiler 阻断生成|逐字规格模式/);
    }
});

test("structured 与 verbatim 的 canonical 输入漂移都在 provider submit 前失败", async (context) => {
    for (const compilePolicy of ["structured", "verbatim"]) {
        await context.test(compilePolicy, async () => {
            const project = compilePolicy === "structured" ? structuredProject(`drift-${compilePolicy}`) : verbatimProject(`drift-${compilePolicy}`);
            const plan = planFor(project);
            if (project.ppt.compilePolicy === "structured") project.ppt.deckBrief.goal = "已在计划冻结后改变";
            else project.ppt.verbatimSpecs[0].exactText += "\n已在计划冻结后改变";
            const harness = generationHarness(project);
            const generation = createPptGenerationModule(harness.dependencies);

            await assert.rejects(generation.start(plan), /已变更|失效|重新确认生成计划/);
            assert.equal(harness.stats.submitCalls, 0);
        });
    }
});

test("verbatim 原材料在计划冻结后变化时不会提交 provider", async () => {
    const project = verbatimProject("source-drift");
    const plan = planFor(project);
    project.ppt.sourceMaterial += "\n计划后新增的原文";
    const harness = generationHarness(project);
    const generation = createPptGenerationModule(harness.dependencies);

    await assert.rejects(generation.start(plan), /原文版本已变化|逐字规格已失效/);
    assert.equal(harness.stats.submitCalls, 0);
});

test("structured 来源在 Builder 与 provider submit 前都重新绑定当前原文", async () => {
    const forged = structuredProject("forged-source");
    const forgedPage = structuredClone(forged.ppt.pageSpecs[0]);
    forgedPage.contentBlocks[0].text = "伪造标题";
    forgedPage.contentBlocks[1].text = "伪造结论";
    forgedPage.sourceRefs[0] = { ...forgedPage.sourceRefs[0], excerpt: "伪造标题", startLine: 99, endLine: 99 };
    forgedPage.sourceRefs[1] = { ...forgedPage.sourceRefs[1], excerpt: "伪造结论", startLine: 100, endLine: 100 };
    assert.throws(
        () =>
            buildPptDeckProject({
                compilePolicy: "structured",
                title: "伪造来源",
                sourceMaterial: "真实标题\n真实结论",
                requirements: "",
                deckBrief: { ...forged.ppt.deckBrief, sourceHash: hashPptContentSource("真实标题\n真实结论", "") },
                pageSpecs: [forgedPage],
            }),
        /来源.*脱节|内容规格尚未就绪/,
    );

    const project = structuredProject("structured-source-drift");
    const plan = planFor(project);
    project.ppt.sourceMaterial = "项目概览\n原文已在计划后改变";
    const harness = generationHarness(project);
    const generation = createPptGenerationModule(harness.dependencies);
    await assert.rejects(generation.start(plan), /来源.*脱节|内容规格已失效|原始材料版本已变化/);
    assert.equal(harness.stats.submitCalls, 0);
});

test("structured 全局定位的原文版本漂移在 provider submit 前失效", async () => {
    const project = structuredProject("structured-brief-source-drift");
    const plan = planFor(project);
    project.ppt.sourceMaterial = project.ppt.sourceMaterial.replace("受众：项目伙伴\n目标：建立共同理解\n叙事：先讲价值，再讲行动", "受众：已改变\n目标：已改变\n叙事：已改变");
    const harness = generationHarness(project);

    assert.throws(() => assertGenerationPlanCurrentTargets(project, plan), /原始材料版本已变化|内容规格已失效/);
    await assert.rejects(createPptGenerationModule(harness.dependencies).start(plan), /原始材料版本已变化|内容规格已失效/);
    assert.equal(harness.stats.submitCalls, 0);

    const requirementsDrift = structuredProject("structured-brief-requirements-drift");
    const requirementsPlan = planFor(requirementsDrift);
    requirementsDrift.ppt.requirements = "计划冻结后新增的补充要求";
    const requirementsHarness = generationHarness(requirementsDrift);
    assert.throws(() => assertGenerationPlanCurrentTargets(requirementsDrift, requirementsPlan), /原始材料版本已变化|内容规格已失效/);
    await assert.rejects(createPptGenerationModule(requirementsHarness.dependencies).start(requirementsPlan), /原始材料版本已变化|内容规格已失效/);
    assert.equal(requirementsHarness.stats.submitCalls, 0);
});

test("待确认 PageSpec 的生成预览不抛错，确认后恢复计划", () => {
    const project = structuredProject("reviewable-preview");
    project.ppt.pageSpecs[0].contentState = { status: "reviewable" };
    const intent = { kind: "generateSingle", takeId: project.ppt.pages[0].takes[0].takeId };
    const blocked = previewGenerationPlan(intent, { project, effectiveConfig: defaultConfig });
    assert.equal(blocked.plan, undefined);
    assert.match(blocked.error, /内容规格尚未批准|Compiler 阻断/);

    project.ppt.pageSpecs[0].contentState = { status: "approved", approvedAt: "2026-07-22T09:00:00.000Z" };
    const ready = previewGenerationPlan(intent, { project, effectiveConfig: defaultConfig });
    assert.equal(ready.error, undefined);
    assert.equal(ready.plan.callCount, 1);
});

test("页面确认可重建 verbatim 血缘，并拒绝篡改或跨 policy 快照", () => {
    const project = verbatimProject("confirmation-verbatim");
    const plan = planFor(project);
    const durable = attachLineagedCandidate(project, plan);
    const candidateId = plan.runs[0].rootNodeId;
    const snapshot = resolvePptCandidateCompilationSnapshot(durable, candidateId);
    assert.equal(snapshot.compilePolicy, "verbatim");
    assert.equal(snapshot.snapshotId, plan.compilation.snapshotId);

    const tampered = structuredClone(durable);
    tampered.ppt.compilationSnapshots[0].verbatimSpecs[0].exactText += "\n篡改";
    assert.throws(() => resolvePptCandidateCompilationSnapshot(tampered, candidateId), /确定性完整性校验/);

    const crossPolicy = structuredClone(durable);
    const structured = structuredProject("confirmation-cross-policy");
    crossPolicy.ppt = {
        ...crossPolicy.ppt,
        compilePolicy: "structured",
        deckBrief: structured.ppt.deckBrief,
        pageSpecs: structured.ppt.pageSpecs,
    };
    delete crossPolicy.ppt.verbatimSpecs;
    delete crossPolicy.ppt.confirmedGlobalSpec;
    assert.throws(() => resolvePptCandidateCompilationSnapshot(crossPolicy, candidateId), /编译策略不一致/);
});

test("structured 候选稿不能在全局来源或 PageSpec 变更后继续确认", () => {
    const project = structuredProject("confirmation-structured-drift");
    const plan = planFor(project);
    const candidateId = plan.runs[0].rootNodeId;
    const durable = attachLineagedCandidate(project, plan);
    assert.equal(resolvePptCandidateCompilationSnapshot(durable, candidateId).snapshotId, plan.compilation.snapshotId);

    const sourceDrift = structuredClone(durable);
    sourceDrift.ppt.sourceMaterial = sourceDrift.ppt.sourceMaterial.replace("受众：项目伙伴", "受众：已改变");
    assert.throws(() => resolvePptCandidateCompilationSnapshot(sourceDrift, candidateId), /整套内容来源已变化/);

    const specDrift = structuredClone(durable);
    specDrift.ppt.pageSpecs[0].version += 1;
    assert.throws(() => resolvePptCandidateCompilationSnapshot(specDrift, candidateId), /PageSpec|页面内容规格已变化/);

    const briefDrift = structuredClone(durable);
    briefDrift.ppt.deckBrief.audience = "已改变的受众";
    assert.throws(() => resolvePptCandidateCompilationSnapshot(briefDrift, candidateId), /全局内容规格已变化/);

    const styleOnlyDrift = structuredClone(durable);
    styleOnlyDrift.ppt.deckBrief = { ...styleOnlyDrift.ppt.deckBrief, version: styleOnlyDrift.ppt.deckBrief.version + 1, styleContract: createPptVisualDirectionPresetContract("visual-story") };
    assert.throws(() => resolvePptCandidateCompilationSnapshot(styleOnlyDrift, candidateId), /全局内容规格已变化|视觉方向已变化/);
});

function planFor(project) {
    return createGenerationPlan({ kind: "generateSingle", takeId: project.ppt.pages[0].takes[0].takeId }, { project, effectiveConfig: defaultConfig });
}

function structuredProject(suffix) {
    const sourceMaterial = "项目概览\n用一页说清项目价值\n受众：项目伙伴\n目标：建立共同理解\n叙事：先讲价值，再讲行动";
    const pageSpec = {
        pageId: `page-${suffix}`,
        version: 1,
        purpose: "建立共同理解",
        contentForm: "cover",
        sourceRefs: [
            { id: `source-title-${suffix}`, source: "material", relation: "verbatim", excerpt: "项目概览", startLine: 1, endLine: 1 },
            { id: `source-claim-${suffix}`, source: "material", relation: "verbatim", excerpt: "用一页说清项目价值", startLine: 2, endLine: 2 },
        ],
        contentBlocks: [
            { id: `title-${suffix}`, kind: "title", text: "项目概览", sourceRefIds: [`source-title-${suffix}`] },
            { id: `claim-${suffix}`, kind: "primary_claim", text: "用一页说清项目价值", sourceRefIds: [`source-claim-${suffix}`] },
        ],
        contentState: { status: "approved", approvedAt: "2026-07-22T08:00:00.000Z" },
        lockedFacts: [],
        layoutRole: "cover",
        layoutIntent: [],
        visualEncoding: [],
        assetRefs: [],
        freedom: "可优化信息层级，但不能改变正文",
    };
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "Structured canonical",
        sourceMaterial,
        requirements: "",
        deckBrief: {
            version: 1,
            sourceHash: hashPptContentSource(sourceMaterial, ""),
            contentRevision: `${hashPptContentSource(sourceMaterial, "")}:r1`,
            audience: "项目伙伴",
            goal: "建立共同理解",
            narrative: "先讲价值，再讲行动",
            styleContract: createPptVisualDirectionPresetContract("clean-report"),
            globalRules: [],
            forbiddenRules: [],
            lockedDeckFacts: [],
        },
        pageSpecs: [pageSpec],
    });
    return completeProject(suffix, partial);
}

function verbatimProject(suffix) {
    const exactText = "逐字标题\n必须逐字保留的正文";
    const partial = buildPptDeckProject({
        compilePolicy: "verbatim",
        title: "Verbatim canonical",
        sourceMaterial: exactText,
        requirements: "",
        verbatimSpecs: [{ pageId: `page-${suffix}`, version: 1, title: "逐字标题", exactText, origin: { kind: "source_slice", sourceHash: hashPptSourceText(exactText), startLine: 1, endLine: 2 } }],
        confirmedGlobalSpec: "全局要求已经确认",
    });
    return completeProject(suffix, partial);
}

function completeProject(suffix, partial) {
    return {
        id: `project-${suffix}`,
        createdAt: "2026-07-22T08:00:00.000Z",
        updatedAt: "2026-07-22T08:00:00.000Z",
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        ...partial,
    };
}

function attachLineagedCandidate(project, plan) {
    const next = structuredClone(project);
    const run = plan.runs[0];
    const request = run.requests[0];
    next.ppt.compilationSnapshots.push(structuredClone(plan.compilation));
    next.nodes.push({
        id: run.rootNodeId,
        type: "image",
        title: "已生成页面",
        position: { x: 800, y: 0 },
        width: 320,
        height: 180,
        metadata: {
            content: "data:image/png;base64,AA==",
            storageKey: "image:lineaged-candidate",
            status: "success",
            prompt: request.prompt,
            pptPageId: run.pageId,
            pptTakeId: run.takeId,
            pptPageIndex: run.pageIndex,
            pptGenerationRequest: {
                requestId: request.requestId,
                runId: run.runId,
                batchId: plan.batchId,
                pageId: run.pageId,
                takeId: run.takeId,
                slotIndex: 0,
                requestType: request.requestType,
                model: request.model,
                providerIdentity: request.providerIdentity,
                compilationSnapshotId: plan.compilation.snapshotId,
                status: "completed",
                createdAt: plan.createdAt,
                updatedAt: plan.createdAt,
                recentEvents: [],
            },
            pptGenerationRun: {
                runId: run.runId,
                batchId: plan.batchId,
                pageId: run.pageId,
                takeId: run.takeId,
                requestIds: [request.requestId],
                plannedCount: 1,
                status: "completed",
                createdAt: plan.createdAt,
                updatedAt: plan.createdAt,
            },
        },
    });
    return next;
}

function generationHarness(project) {
    let state = structuredClone(project);
    const stats = { submitCalls: 0 };
    const durable = {
        async mutate(mutator) {
            state = structuredClone(mutator(structuredClone(state)));
            return structuredClone(state);
        },
        async read() {
            return structuredClone(state);
        },
    };
    return {
        durable,
        stats,
        dependencies: {
            projectId: project.id,
            durableCanvas: durable,
            provider: {
                async submit({ request }) {
                    stats.submitCalls += 1;
                    return { dataUrl: "data:image/png;base64,AA==", resultIdentity: `result-${request.requestId}` };
                },
                async resume() {
                    throw new Error("测试不应进入恢复流程");
                },
            },
            async materialize(result) {
                return { content: result.dataUrl, storageKey: `image:${result.resultIdentity}`, mimeType: "image/png", bytes: 1, naturalWidth: 1, naturalHeight: 1 };
            },
        },
    };
}
