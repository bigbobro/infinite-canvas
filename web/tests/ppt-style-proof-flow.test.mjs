import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let vite;
let applyGenerationPlanPptOps;
let assertGenerationPlanCompilation;
let assertGenerationPlanCurrentTargets;
let buildPptDeckProject;
let createGenerationPlan;
let createPptGenerationModule;
let createPptVisualDirectionPresetContract;
let defaultConfig;
let derivePptLockedFacts;
let hashPptContentSource;
let selectPptStyleProofPageId;
let setPptPageConfirmedNode;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ buildPptDeckProject, hashPptContentSource } = await vite.ssrLoadModule("/src/lib/ppt/deck-builder.ts"));
    ({ derivePptLockedFacts } = await vite.ssrLoadModule("/src/lib/ppt/content-plan.ts"));
    ({ applyGenerationPlanPptOps, assertGenerationPlanCompilation, assertGenerationPlanCurrentTargets, createGenerationPlan, selectPptStyleProofPageId } = await vite.ssrLoadModule("/src/lib/ppt/generation-plan.ts"));
    ({ createPptGenerationModule } = await vite.ssrLoadModule("/src/lib/ppt/generation-execution.ts"));
    ({ setPptPageConfirmedNode } = await vite.ssrLoadModule("/src/lib/ppt/page-confirmation.ts"));
    ({ createPptVisualDirectionPresetContract } = await vite.ssrLoadModule("/src/lib/ppt/style-contract.ts"));
    ({ defaultConfig } = await vite.ssrLoadModule("/src/stores/use-config-store.ts"));
});

after(async () => {
    await vite?.close();
});

test("代表性校样优先选首个已批准内容型页，不把封面当作内容母版", () => {
    const project = createProject(["cover", "content", "evidence", "close"]);
    project.ppt.pageSpecs[1].contentState = { status: "reviewable" };

    assert.equal(selectPptStyleProofPageId(project), "page-3");

    const fallback = createProject(["cover", "section", "close"]);
    assert.equal(selectPptStyleProofPageId(fallback), "page-2");
});

test("已确认校样冻结 Contract 与内容版本，并在其余每个请求中恰好引用一次", () => {
    const project = createProject(["cover", "content", "evidence", "close"]);
    const proofPlan = createGenerationPlan({ kind: "startBatch", anchorFirst: true }, { project, effectiveConfig: defaultConfig });

    assert.deepEqual(
        proofPlan.runs.map((run) => run.pageId),
        ["page-2"],
    );
    assert.equal(proofPlan.pptOps.find((op) => op.type === "setFlags").flags.styleProofPageId, "page-2");

    const withProofCandidate = materializeSingleCandidate(project, proofPlan);
    const confirmedPpt = setPptPageConfirmedNode(withProofCandidate, "page-2", proofPlan.runs[0].rootNodeId);
    const confirmedProject = { ...withProofCandidate, ppt: confirmedPpt };

    assert.deepEqual(confirmedPpt.styleProof, {
        pageId: "page-2",
        candidateNodeId: proofPlan.runs[0].rootNodeId,
        styleFingerprint: proofPlan.compilation.styleFingerprint,
        contentRevision: confirmedPpt.deckBrief.contentRevision,
    });

    const restPlan = createGenerationPlan({ kind: "generateRest" }, { project: confirmedProject, effectiveConfig: defaultConfig });
    assert.equal(
        restPlan.runs.some((run) => run.pageId === "page-2"),
        false,
    );
    assert.deepEqual(restPlan.styleProof, confirmedPpt.styleProof);
    assert.equal(restPlan.structureOps.filter((op) => op.type === "connect_nodes" && op.fromNodeId === confirmedPpt.styleProof.candidateNodeId).length, restPlan.runs.length);
    for (const request of restPlan.runs.flatMap((run) => run.requests)) {
        assert.equal(request.inputRefs.filter((input) => input.nodeId === confirmedPpt.styleProof.candidateNodeId).length, 1);
        assert.equal(request.referenceSnapshots.filter((reference) => reference.id === confirmedPpt.styleProof.candidateNodeId).length, 1);
    }
    const strippedProofPlan = structuredClone(restPlan);
    delete strippedProofPlan.styleProof;
    assert.throws(() => assertGenerationPlanCompilation(strippedProofPlan), /缺少完整风格校样快照/);
    assert.doesNotThrow(() => assertGenerationPlanCurrentTargets(confirmedProject, restPlan));

    const staleProject = {
        ...confirmedProject,
        ppt: { ...confirmedProject.ppt, deckBrief: { ...confirmedProject.ppt.deckBrief, contentRevision: `${confirmedProject.ppt.deckBrief.contentRevision}:changed` } },
    };
    assert.throws(() => assertGenerationPlanCurrentTargets(staleProject, restPlan), /内容版本已变更/);

    const unconfirmedPpt = setPptPageConfirmedNode(confirmedProject, "page-2", undefined);
    assert.equal(unconfirmedPpt.styleProof, undefined);
    assert.equal(unconfirmedPpt.anchorConfirmed, false);
    assert.throws(() => createGenerationPlan({ kind: "generateRest" }, { project: { ...confirmedProject, ppt: unconfirmedPpt }, effectiveConfig: defaultConfig }), /请先确认代表性风格校样/);
});

test("直接全部生成仍是独立高级路径，不写入校样血缘", () => {
    const project = createProject(["cover", "content", "evidence"]);
    const plan = createGenerationPlan({ kind: "startBatch", anchorFirst: false }, { project, effectiveConfig: defaultConfig });
    const flags = plan.pptOps.find((op) => op.type === "setFlags").flags;

    assert.deepEqual(
        plan.runs.map((run) => run.pageId),
        ["page-1", "page-2", "page-3"],
    );
    assert.equal(flags.skipAnchor, true);
    assert.equal(flags.styleProofPageId, undefined);
    assert.equal(flags.styleProof, undefined);
    assert.equal(plan.styleProof, undefined);
});

test("重新校样 B 与直接全部都排除历史校样 A", () => {
    const project = createProject(["cover", "content", "evidence", "close"]);
    const proofPlanA = createGenerationPlan({ kind: "startBatch", anchorFirst: true }, { project, effectiveConfig: defaultConfig });
    const candidateAId = proofPlanA.runs[0].rootNodeId;
    const withCandidateA = materializeSingleCandidate(project, proofPlanA);
    const confirmedA = { ...withCandidateA, ppt: setPptPageConfirmedNode(withCandidateA, "page-2", candidateAId) };
    const restPlanA = createGenerationPlan({ kind: "generateRest" }, { project: confirmedA, effectiveConfig: defaultConfig });
    const withHistoricalAConnections = applyProofConnections(confirmedA, restPlanA, candidateAId);

    const unconfirmedA = { ...withHistoricalAConnections, ppt: setPptPageConfirmedNode(withHistoricalAConnections, "page-2", undefined) };
    const proofPlanB = createGenerationPlan({ kind: "startBatch", anchorFirst: true }, { project: unconfirmedA, effectiveConfig: defaultConfig });
    const candidateBId = proofPlanB.runs[0].rootNodeId;
    const withCandidateB = materializeSingleCandidate(unconfirmedA, proofPlanB);
    const confirmedB = { ...withCandidateB, ppt: setPptPageConfirmedNode(withCandidateB, "page-2", candidateBId) };

    assert.deepEqual(confirmedB.ppt.styleProofCandidateIds, [candidateAId, candidateBId]);
    const restPlanB = createGenerationPlan({ kind: "generateRest" }, { project: confirmedB, effectiveConfig: defaultConfig });
    for (const request of restPlanB.runs.flatMap((run) => run.requests)) {
        assert.equal(request.inputRefs.filter((input) => input.nodeId === candidateAId).length, 0);
        assert.equal(request.referenceSnapshots.filter((reference) => reference.id === candidateAId).length, 0);
        assert.equal(request.inputRefs.filter((input) => input.nodeId === candidateBId).length, 1);
        assert.equal(request.referenceSnapshots.filter((reference) => reference.id === candidateBId).length, 1);
    }

    const withHistoricalBConnections = applyProofConnections(confirmedB, restPlanB, candidateBId);
    const directProject = {
        ...withHistoricalBConnections,
        ppt: { ...withHistoricalBConnections.ppt, skipAnchor: true, anchorConfirmed: false, styleProofPageId: undefined, styleProof: undefined },
    };
    const directPlan = createGenerationPlan({ kind: "startBatch", anchorFirst: false }, { project: directProject, effectiveConfig: defaultConfig });
    assert.ok(directPlan.runs.length > 0);
    assert.equal(directPlan.styleProof, undefined);
    for (const request of directPlan.runs.flatMap((run) => run.requests)) {
        assert.deepEqual(request.inputRefs, []);
        assert.equal(request.referenceSnapshots.length, 0);
        assert.equal(request.requestType, "textToImage");
    }
});

test("SHA-29：生成其余页提示词含各自页码与参考图约束，rebuild 确定性通过", () => {
    const project = createProject(["cover", "section", "content", "evidence", "close"]);
    project.title = "风格校样测试";
    const proofPlan = createGenerationPlan({ kind: "startBatch", anchorFirst: true }, { project, effectiveConfig: defaultConfig });
    const withProofCandidate = materializeSingleCandidate(project, proofPlan);
    const confirmedProject = { ...withProofCandidate, ppt: setPptPageConfirmedNode(withProofCandidate, proofPlan.runs[0].pageId, proofPlan.runs[0].rootNodeId) };
    const restPlan = createGenerationPlan({ kind: "generateRest" }, { project: confirmedProject, effectiveConfig: defaultConfig });

    assert.doesNotThrow(() => assertGenerationPlanCompilation(restPlan));
    assert.doesNotThrow(() => assertGenerationPlanCurrentTargets(confirmedProject, restPlan));
    assert.equal(restPlan.compilation.deckShell.pageCount, 5);
    assert.equal(restPlan.compilation.deckShell.deckTitle, "风格校样测试");
    assert.equal(restPlan.compilation.pageSpecs.length, restPlan.runs.length);
    assert.ok(restPlan.compilation.deckShell.pages.length === 5);

    for (const run of restPlan.runs) {
        const pageFact = restPlan.compilation.deckShell.pages.find((page) => page.pageId === run.pageId);
        assert.ok(pageFact);
        const prompt = run.requests[0].prompt;
        assert.match(prompt, new RegExp(`本页页码 ${pageFact.pageNumber}，总页数 5；页脚页码必须显示为 ${pageFact.pageNumber}/5`));
        assert.match(prompt, /参考图仅用于对齐配色、字体、图形语言与外壳位置/);
        assert.match(prompt, /不得复制参考图或其他页面的正文构图/);
        assert.equal(prompt, restPlan.compilation.prompts.find((item) => item.pageId === run.pageId && item.takeId === run.takeId).finalPrompt);
    }

    // rebuild 使用过滤后的 pageSpecs，但页码仍来自快照 deckShell，不得因列表位置重算而漂移
    const rebuiltOnlyTargets = restPlan.compilation.pageSpecs.map((spec) => spec.pageId);
    assert.ok(rebuiltOnlyTargets.length < 5);
    assert.doesNotThrow(() => assertGenerationPlanCompilation(restPlan));
});

test("rest plan 冻结后校样漂移在任何结构落盘和 provider 调用前拒绝", async () => {
    const project = createProject(["cover", "content", "evidence"]);
    const proofPlan = createGenerationPlan({ kind: "startBatch", anchorFirst: true }, { project, effectiveConfig: defaultConfig });
    const withCandidate = materializeSingleCandidate(project, proofPlan);
    const confirmedProject = { ...withCandidate, ppt: setPptPageConfirmedNode(withCandidate, "page-2", proofPlan.runs[0].rootNodeId) };
    const restPlan = createGenerationPlan({ kind: "generateRest" }, { project: confirmedProject, effectiveConfig: defaultConfig });
    const driftedProject = { ...confirmedProject, ppt: setPptPageConfirmedNode(confirmedProject, "page-2", undefined) };
    const before = {
        nodes: structuredClone(driftedProject.nodes),
        connections: structuredClone(driftedProject.connections),
        compilationSnapshots: structuredClone(driftedProject.ppt.compilationSnapshots),
    };
    const harness = generationHarness(driftedProject);

    await assert.rejects(createPptGenerationModule(harness.dependencies).start(restPlan), /请先确认代表性风格校样|校样已变更/);

    const durable = await harness.read();
    assert.equal(harness.stats.submitCalls, 0);
    assert.deepEqual(durable.nodes, before.nodes);
    assert.deepEqual(durable.connections, before.connections);
    assert.deepEqual(durable.ppt.compilationSnapshots, before.compilationSnapshots);
});

function createProject(roles) {
    const pageTexts = roles.map((role, index) => [`第 ${index + 1} 页标题`, `第 ${index + 1} 页核心信息（${role}）`]);
    const sourceMaterial = pageTexts.flat().join("\n");
    const requirements = "";
    const sourceHash = hashPptContentSource(sourceMaterial, requirements);
    const styleContract = createPptVisualDirectionPresetContract("clean-report");
    const pageSpecs = roles.map((role, index) => {
        const pageId = `page-${index + 1}`;
        const lines = pageTexts[index];
        const sourceRef = {
            id: `${pageId}:source`,
            source: "material",
            relation: "verbatim",
            excerpt: lines.join("\n"),
            startLine: index * 2 + 1,
            endLine: index * 2 + 2,
        };
        const pageSpec = {
            pageId,
            version: 1,
            purpose: `讲清第 ${index + 1} 页`,
            contentForm: role === "cover" ? "cover" : role === "comparison" ? "comparison" : role === "close" ? "closing" : "narrative",
            sourceRefs: [sourceRef],
            contentBlocks: [
                { id: `${pageId}:title`, kind: "title", text: lines[0], sourceRefIds: [sourceRef.id] },
                { id: `${pageId}:claim`, kind: "primary_claim", text: lines[1], sourceRefIds: [sourceRef.id] },
            ],
            contentState: { status: "approved", approvedAt: "2026-07-22T00:00:00.000Z" },
            lockedFacts: [],
            layoutRole: role,
            layoutIntent: [],
            visualEncoding: [],
            assetRefs: [],
            freedom: "不得新增或改写可见文案、数字、型号或结论；只允许在已批准内容内优化视觉组织",
        };
        pageSpec.lockedFacts = derivePptLockedFacts(pageSpec);
        return pageSpec;
    });
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "风格校样测试",
        sourceMaterial,
        requirements,
        deckBrief: {
            version: 1,
            sourceHash,
            contentRevision: `${sourceHash}:r1`,
            audience: "方案决策者",
            goal: "形成统一且可读的方案",
            narrative: "从背景到证据再到行动",
            styleContract,
            globalRules: [],
            forbiddenRules: [...styleContract.modelStyle.forbiddenRules],
            lockedDeckFacts: [],
        },
        pageSpecs,
    });
    return {
        id: "style-proof-project",
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        ...partial,
    };
}

function materializeSingleCandidate(project, plan) {
    const run = plan.runs[0];
    const request = run.requests[0];
    assert.equal(run.plannedCount, 1);
    const candidate = {
        id: run.rootNodeId,
        type: "image",
        title: "代表性风格校样",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: {
            content: "data:image/png;base64,AA==",
            storageKey: `image:${run.rootNodeId}`,
            mimeType: "image/png",
            prompt: request.prompt,
            status: "success",
            pptPageId: run.pageId,
            pptTakeId: run.takeId,
            pptPageIndex: run.pageIndex,
            pptGenerationRequest: {
                requestId: request.requestId,
                runId: run.runId,
                batchId: plan.batchId,
                pageId: run.pageId,
                takeId: run.takeId,
                slotIndex: request.slotIndex,
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
    };
    const ppt = applyGenerationPlanPptOps(project.ppt, plan.pptOps);
    return {
        ...project,
        nodes: [...project.nodes, candidate],
        connections: [...project.connections, { id: `style-proof-output:${candidate.id}`, fromNodeId: run.baseNodeId, toNodeId: candidate.id }],
        ppt,
    };
}

function applyProofConnections(project, plan, candidateNodeId) {
    const additions = plan.structureOps.flatMap((op) =>
        op.type === "connect_nodes" && op.fromNodeId === candidateNodeId && !project.connections.some((connection) => connection.fromNodeId === op.fromNodeId && connection.toNodeId === op.toNodeId)
            ? [{ id: op.id, fromNodeId: op.fromNodeId, toNodeId: op.toNodeId }]
            : [],
    );
    return { ...project, connections: [...project.connections, ...additions] };
}

function generationHarness(initialProject) {
    let state = structuredClone(initialProject);
    const stats = { submitCalls: 0 };
    const durableCanvas = {
        async mutate(mutator) {
            state = structuredClone(mutator(structuredClone(state)));
            return structuredClone(state);
        },
        async read() {
            return structuredClone(state);
        },
    };
    return {
        stats,
        read: durableCanvas.read,
        dependencies: {
            projectId: initialProject.id,
            durableCanvas,
            provider: {
                async submit() {
                    stats.submitCalls += 1;
                    return { dataUrl: "data:image/png;base64,AA==", resultIdentity: "unexpected-submit" };
                },
                async resume() {
                    throw new Error("测试不应进入恢复路径");
                },
            },
            async materialize() {
                throw new Error("测试不应物化图片");
            },
        },
    };
}
