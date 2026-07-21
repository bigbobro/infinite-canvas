import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let vite;
let createPptGenerationModule;
let resolvePptGenerationProviderIdentity;
let assertPptGenerationProviderIdentity;
let hasPptRepeatBillingRisk;
let buildPptDeckProject;
let createGenerationPlan;
let createPptCandidateEditPlan;
let compilePptPromptSnapshot;
let PPT_PAGE_PROMPT;
let defaultConfig;
let agentOpsTouchPptGenerationLedger;
let historyEntryTouchesPptGenerationLedger;
let nodeIdsTouchPptControlledNodes;
let sanitizeCopiedCanvasMetadata;
let buildPptGenerationNotificationHref;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ createPptGenerationModule } = await vite.ssrLoadModule("/src/lib/ppt/generation-execution.ts"));
    ({ resolvePptGenerationProviderIdentity, assertPptGenerationProviderIdentity, createGenerationPlan, createPptCandidateEditPlan } = await vite.ssrLoadModule("/src/lib/ppt/generation-plan.ts"));
    ({ compilePptPromptSnapshot } = await vite.ssrLoadModule("/src/lib/ppt/prompt-compiler.ts"));
    ({ PPT_PAGE_PROMPT } = await vite.ssrLoadModule("/src/lib/ppt/deck-builder.ts"));
    ({ hasPptRepeatBillingRisk, agentOpsTouchPptGenerationLedger, historyEntryTouchesPptGenerationLedger, nodeIdsTouchPptControlledNodes, sanitizeCopiedCanvasMetadata } = await vite.ssrLoadModule("/src/lib/ppt/generation-ledger.ts"));
    ({ buildPptDeckProject } = await vite.ssrLoadModule("/src/lib/ppt/deck-builder.ts"));
    ({ defaultConfig } = await vite.ssrLoadModule("/src/stores/use-config-store.ts"));
    ({ buildPptGenerationNotificationHref } = await vite.ssrLoadModule("/src/pages/canvas/hooks/use-ppt-generation-module.ts"));
});

after(async () => {
    await vite?.close();
});

test("count=1 与 count=3 每个请求槽只提交和物化一次", async (context) => {
    for (const count of [1, 3]) {
        await context.test(`count=${count}`, async () => {
            const project = baseProject(`count-${count}`);
            const plan = generationPlan(count, `count-${count}`);
            const harness = createHarness(project, { taskOnSubmit: true });
            const module = createPptGenerationModule(harness.dependencies);

            const firstStart = module.start(plan);
            const duplicateStart = module.start(plan).then(
                () => null,
                (error) => error,
            );
            const started = await firstStart;
            const duplicateError = await duplicateStart;
            assert.match(duplicateError?.message || "", /已经启动/);

            const settled = await started.settled;
            assert.deepEqual(new Set(settled.completedRequestIds), new Set(plan.runs[0].requests.map((request) => request.requestId)));
            assert.equal(settled.attentionRequestIds.length, 0);
            assert.equal(harness.stats.submitCalls, count);
            assert.equal(harness.stats.resumeCalls, 0);
            assert.equal(harness.stats.materializeCalls, count);
            assert.equal(harness.notifications.length, 1);

            const durable = await harness.durable.read();
            const runRoot = durable.nodes.find((node) => node.id === plan.runs[0].rootNodeId);
            assert.equal(runRoot.metadata.pptGenerationRun.status, "completed");
            assert.equal(runRoot.metadata.pptGenerationRun.notifiedTerminalStatus, "completed");
            if (count > 1) assert.ok(runRoot.metadata.primaryImageId);
            for (const request of plan.runs[0].requests) {
                const requestNode = durable.nodes.find((node) => node.id === request.requestNodeId);
                assert.equal(requestNode.metadata.pptGenerationRequest.status, "completed");
                assert.deepEqual(requestNode.metadata.pptGenerationRequest.providerIdentity, request.providerIdentity);
                assert.equal(requestNode.metadata.status, "success");
                assert.equal(requestNode.metadata.imageTask, undefined);
            }

            const recovered = await module.recover({ type: "reconcileProject" });
            await recovered.settled;
            assert.equal(harness.stats.submitCalls, count);
            assert.equal(harness.stats.resumeCalls, 0);
            assert.equal(harness.notifications.length, 1);
        });
    }
});

test("落盘或 durable read-back 失败时 POST 次数为 0", async (context) => {
    for (const failure of [
        { name: "persist mutation", durableOptions: { failMutations: [2] } },
        { name: "durable read-back", durableOptions: { failReads: [2] } },
    ]) {
        await context.test(failure.name, async () => {
            const suffix = failure.name.replaceAll(" ", "-");
            const harness = createHarness(baseProject(suffix), { durableOptions: failure.durableOptions });
            const module = createPptGenerationModule(harness.dependencies);

            await assert.rejects(module.start(generationPlan(3, suffix)));
            assert.equal(harness.stats.submitCalls, 0);
            assert.equal(harness.stats.resumeCalls, 0);
        });
    }
});

test("request.prompt 与 Compiler 快照不一致时 POST 次数为 0", async () => {
    const partial = buildPptDeckProject({
        title: "Compiler durable gate",
        sourceMaterial: "关键指标\n设备在线率 98.5%",
        requirements: "目标：保留关键事实",
        style: { description: "专业咨询风" },
        pages: [{ title: "关键指标", outline: "关键指标\n设备在线率 98.5%", visualHint: "" }],
        uploadedRefs: [],
        mode: "extract",
    });
    const project = {
        id: "project-compiler-tamper",
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        ...partial,
    };
    const plan = createGenerationPlan({ kind: "generateSingle", takeId: project.ppt.pages[0].takes[0].takeId }, { project, effectiveConfig: defaultConfig });
    plan.runs[0].requests[0].prompt += "\n未记录的篡改";
    const harness = createHarness(project);
    const module = createPptGenerationModule(harness.dependencies);

    await assert.rejects(module.start(plan), /实际提示词与编译快照不一致/);
    assert.equal(harness.stats.submitCalls, 0);
});

test("Compiler 快照绑定或整个快照缺失时 POST 次数为 0", async (context) => {
    for (const mutation of [
        {
            name: "missing request binding",
            apply: (plan) => delete plan.runs[0].requests[0].compilationSnapshotId,
            pattern: /编译快照绑定不一致/,
        },
        {
            name: "missing compilation",
            apply: (plan) => delete plan.compilation,
            pattern: /缺少 Compiler 快照/,
        },
    ]) {
        await context.test(mutation.name, async () => {
            const project = compilerProject(`compiler-${mutation.name}`);
            const plan = createGenerationPlan({ kind: "generateSingle", takeId: project.ppt.pages[0].takes[0].takeId }, { project, effectiveConfig: defaultConfig });
            mutation.apply(plan);
            const harness = createHarness(project);
            const module = createPptGenerationModule(harness.dependencies);

            await assert.rejects(module.start(plan), mutation.pattern);
            assert.equal(harness.stats.submitCalls, 0);
        });
    }
});

test("Compiler 计划不能伪装成候选图编辑后整体降级", async () => {
    const project = compilerProject("compiler-downgrade");
    const plan = createGenerationPlan({ kind: "generateSingle", takeId: project.ppt.pages[0].takes[0].takeId }, { project, effectiveConfig: defaultConfig });
    plan.kind = "candidateEdit";
    delete plan.compilation;
    plan.pptOps = plan.pptOps.filter((op) => op.type !== "appendCompilationSnapshot");
    plan.runs.forEach((run) => run.requests.forEach((request) => delete request.compilationSnapshotId));
    const harness = createHarness(project);
    const module = createPptGenerationModule(harness.dependencies);

    await assert.rejects(module.start(plan), /缺少 Compiler 快照|启动入口不一致/);
    assert.equal(harness.stats.submitCalls, 0);
});

test("候选图编辑只能从独立入口启动", async () => {
    const project = compilerProject("candidate-entry");
    const page = project.ppt.pages[0];
    const take = page.takes[0];
    const candidate = canvasNode("candidate-source", "image", {
        content: "data:image/png;base64,AA==",
        status: "success",
        pptPageId: page.pageId,
        pptTakeId: take.takeId,
        pptPageIndex: page.index,
    });
    project.nodes.push(candidate);
    project.connections.push({ id: "config-candidate", fromNodeId: take.configNodeId, toNodeId: candidate.id });
    page.confirmedNodeId = candidate.id;
    const sourceContent = candidate.metadata.content;
    const candidateEdit = {
        baseNodeId: candidate.id,
        globalInstruction: "将标题字号放大",
        annotations: [],
        finalPrompt: "将标题字号放大",
    };
    const plan = createPptCandidateEditPlan({
        project,
        effectiveConfig: defaultConfig,
        pageId: page.pageId,
        takeId: take.takeId,
        sourceNodeId: candidate.id,
        candidateEdit,
        reference: { id: candidate.id, name: "candidate.png", type: "image/png", dataUrl: candidate.metadata.content },
    });

    const pageHarness = createHarness(project);
    await assert.rejects(createPptGenerationModule(pageHarness.dependencies).start(plan), /缺少 Compiler 快照/);
    assert.equal(pageHarness.stats.submitCalls, 0);

    const editHarness = createHarness(project);
    const started = await createPptGenerationModule(editHarness.dependencies).startCandidateEdit(plan);
    await started.settled;
    assert.equal(editHarness.stats.submitCalls, 1);
    const durable = await editHarness.durable.read();
    const resultNode = durable.nodes.find((node) => node.id === plan.runs[0].rootNodeId);
    const durableSource = durable.nodes.find((node) => node.id === candidate.id);
    assert.deepEqual(resultNode.metadata.pptGenerationRequest.candidateEdit, candidateEdit);
    assert.ok(durable.connections.some((connection) => connection.fromNodeId === candidate.id && connection.toNodeId === resultNode.id));
    assert.equal(durable.ppt.pages[0].confirmedNodeId, candidate.id);
    assert.equal(durableSource.metadata.content, sourceContent);
});

test("再生成一稿和候选修改都固定为单候选且不改配置 count", () => {
    const project = compilerProject("single-candidate");
    const page = project.ppt.pages[0];
    const take = page.takes[0];
    const configNode = project.nodes.find((node) => node.id === take.configNodeId);
    configNode.metadata.count = 3;

    const firstPlan = createGenerationPlan({ kind: "generateSingle", takeId: take.takeId }, { project, effectiveConfig: defaultConfig });
    assert.equal(firstPlan.runs[0].plannedCount, 3);
    assert.equal(firstPlan.runs[0].requests.length, 3);

    const candidate = canvasNode("single-candidate-source", "image", {
        content: "data:image/png;base64,AA==",
        status: "success",
        model: "fake-image",
        count: 3,
        pptPageId: page.pageId,
        pptTakeId: take.takeId,
        pptPageIndex: page.index,
    });
    project.nodes.push(candidate);
    project.connections.push({ id: "single-candidate-connection", fromNodeId: take.configNodeId, toNodeId: candidate.id });

    const rerunPlan = createGenerationPlan({ kind: "generateOneCandidate", takeId: take.takeId }, { project, effectiveConfig: defaultConfig });
    assert.equal(rerunPlan.runs[0].plannedCount, 1);
    assert.equal(rerunPlan.runs[0].requests.length, 1);
    assert.equal(rerunPlan.callCount, 1);
    assert.equal(rerunPlan.runs[0].requests[0].candidateEdit, undefined);
    assert.equal(rerunPlan.runs[0].requests[0].prompt, firstPlan.runs[0].requests[0].prompt);

    const candidateEdit = {
        baseNodeId: candidate.id,
        globalInstruction: "整体增加留白",
        annotations: [{ index: 1, x: 0.25, y: 0.4, instruction: "图标改为蓝色" }],
        finalPrompt: "整体增加留白\n① 图标改为蓝色",
    };
    const editPlan = createPptCandidateEditPlan({
        project,
        effectiveConfig: defaultConfig,
        pageId: page.pageId,
        takeId: take.takeId,
        sourceNodeId: candidate.id,
        candidateEdit,
        reference: { id: `${candidate.id}-marked`, name: "marked.png", type: "image/png", dataUrl: candidate.metadata.content },
    });
    assert.equal(editPlan.runs[0].plannedCount, 1);
    assert.equal(editPlan.runs[0].requests.length, 1);
    assert.equal(editPlan.callCount, 1);
    assert.equal(editPlan.runs[0].requests[0].candidateEdit, candidateEdit);
    assert.equal(configNode.metadata.count, 3);
});

test("候选修改拒绝 batch root 与不匹配的基图快照", () => {
    const project = compilerProject("candidate-source-guard");
    const page = project.ppt.pages[0];
    const take = page.takes[0];
    const batchRoot = canvasNode("candidate-batch-root", "image", {
        content: "data:image/png;base64,AA==",
        status: "success",
        batchChildIds: ["candidate-batch-child"],
        pptPageId: page.pageId,
        pptTakeId: take.takeId,
        pptPageIndex: page.index,
    });
    const candidate = canvasNode("candidate-batch-child", "image", {
        content: "data:image/png;base64,AA==",
        status: "success",
        batchRootId: batchRoot.id,
        pptPageId: page.pageId,
        pptTakeId: take.takeId,
        pptPageIndex: page.index,
    });
    const flagOnlyBatchRoot = canvasNode("candidate-flag-only-batch-root", "image", {
        content: "data:image/png;base64,AA==",
        status: "success",
        isBatchRoot: true,
        pptPageId: page.pageId,
        pptTakeId: take.takeId,
        pptPageIndex: page.index,
    });
    project.nodes.push(batchRoot, candidate, flagOnlyBatchRoot);
    project.connections.push({ id: "config-batch-root", fromNodeId: take.configNodeId, toNodeId: batchRoot.id });
    project.connections.push({ id: "config-flag-only-batch-root", fromNodeId: take.configNodeId, toNodeId: flagOnlyBatchRoot.id });

    assert.throws(
        () =>
            createPptCandidateEditPlan({
                project,
                effectiveConfig: defaultConfig,
                pageId: page.pageId,
                takeId: take.takeId,
                sourceNodeId: batchRoot.id,
                candidateEdit: { baseNodeId: batchRoot.id, globalInstruction: "增加留白", annotations: [], finalPrompt: "增加留白" },
                reference: { id: batchRoot.id, name: "batch-root.png", type: "image/png", dataUrl: batchRoot.metadata.content },
            }),
        /不是当前 PPT 方案的成功候选/,
    );
    assert.throws(
        () =>
            createPptCandidateEditPlan({
                project,
                effectiveConfig: defaultConfig,
                pageId: page.pageId,
                takeId: take.takeId,
                sourceNodeId: flagOnlyBatchRoot.id,
                candidateEdit: { baseNodeId: flagOnlyBatchRoot.id, globalInstruction: "增加留白", annotations: [], finalPrompt: "增加留白" },
                reference: { id: flagOnlyBatchRoot.id, name: "batch-root.png", type: "image/png", dataUrl: flagOnlyBatchRoot.metadata.content },
            }),
        /不是当前 PPT 方案的成功候选/,
    );
    assert.throws(
        () =>
            createPptCandidateEditPlan({
                project,
                effectiveConfig: defaultConfig,
                pageId: page.pageId,
                takeId: take.takeId,
                sourceNodeId: candidate.id,
                candidateEdit: { baseNodeId: "other-node", globalInstruction: "增加留白", annotations: [], finalPrompt: "增加留白" },
                reference: { id: candidate.id, name: "candidate.png", type: "image/png", dataUrl: candidate.metadata.content },
            }),
        /基图不一致/,
    );
});

test("候选修改在启动前再次拒绝变成 batch root 的基图", async () => {
    const project = compilerProject("candidate-source-recheck");
    const page = project.ppt.pages[0];
    const take = page.takes[0];
    const candidate = canvasNode("candidate-source-recheck-node", "image", {
        content: "data:image/png;base64,AA==",
        status: "success",
        pptPageId: page.pageId,
        pptTakeId: take.takeId,
        pptPageIndex: page.index,
    });
    project.nodes.push(candidate);
    project.connections.push({ id: "candidate-source-recheck-connection", fromNodeId: take.configNodeId, toNodeId: candidate.id });
    const plan = createPptCandidateEditPlan({
        project,
        effectiveConfig: defaultConfig,
        pageId: page.pageId,
        takeId: take.takeId,
        sourceNodeId: candidate.id,
        candidateEdit: { baseNodeId: candidate.id, globalInstruction: "增加留白", annotations: [], finalPrompt: "增加留白" },
        reference: { id: candidate.id, name: "candidate.png", type: "image/png", dataUrl: candidate.metadata.content },
    });
    candidate.metadata.isBatchRoot = true;
    const harness = createHarness(project);

    await assert.rejects(createPptGenerationModule(harness.dependencies).startCandidateEdit(plan), /候选图编辑计划的结构不合法/);
    assert.equal(harness.stats.submitCalls, 0);
});

test("candidateEdit 快照在 POST 前被篡改时为 0 POST", async () => {
    const project = compilerProject("candidate-lineage-tamper");
    const page = project.ppt.pages[0];
    const take = page.takes[0];
    const candidate = canvasNode("candidate-lineage-source", "image", {
        content: "data:image/png;base64,AA==",
        status: "success",
        pptPageId: page.pageId,
        pptTakeId: take.takeId,
        pptPageIndex: page.index,
    });
    project.nodes.push(candidate);
    project.connections.push({ id: "candidate-lineage-source-connection", fromNodeId: take.configNodeId, toNodeId: candidate.id });
    const plan = createPptCandidateEditPlan({
        project,
        effectiveConfig: defaultConfig,
        pageId: page.pageId,
        takeId: take.takeId,
        sourceNodeId: candidate.id,
        candidateEdit: { baseNodeId: candidate.id, globalInstruction: "增加留白", annotations: [], finalPrompt: "增加留白" },
        reference: { id: candidate.id, name: "candidate.png", type: "image/png", dataUrl: candidate.metadata.content },
    });
    const requestId = plan.runs[0].requests[0].requestId;
    const harness = createHarness(project, {
        durableOptions: {
            beforeReads: {
                5: (current) => ({
                    ...current,
                    nodes: current.nodes.map((node) =>
                        node.metadata?.pptGenerationRequest?.requestId === requestId
                            ? {
                                  ...node,
                                  metadata: {
                                      ...node.metadata,
                                      pptGenerationRequest: { ...node.metadata.pptGenerationRequest, candidateEdit: { ...node.metadata.pptGenerationRequest.candidateEdit, finalPrompt: "被篡改的提示词" } },
                                  },
                              }
                            : node,
                    ),
                }),
            },
        },
    });
    const started = await createPptGenerationModule(harness.dependencies).startCandidateEdit(plan);
    await started.settled;

    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(requestTrace(await harness.durable.read(), requestId).status, "failed");
});

test("Compiler 快照和请求同步篡改仍然 POST 次数为 0", async () => {
    const project = compilerProject("compiler-double-tamper");
    const plan = createGenerationPlan({ kind: "generateSingle", takeId: project.ppt.pages[0].takes[0].takeId }, { project, effectiveConfig: defaultConfig });
    plan.compilation.prompts[0].finalPrompt += "\n未经 Compiler 生成的内容";
    plan.runs[0].requests[0].prompt = plan.compilation.prompts[0].finalPrompt;
    const harness = createHarness(project);
    const module = createPptGenerationModule(harness.dependencies);

    await assert.rejects(module.start(plan), /快照不是由当前编译输入确定性生成/);
    assert.equal(harness.stats.submitCalls, 0);
});

test("快照之后 PageSpec 已升版时旧计划 POST 次数为 0", async () => {
    const project = compilerProject("compiler-stale-spec");
    const plan = createGenerationPlan({ kind: "generateSingle", takeId: project.ppt.pages[0].takes[0].takeId }, { project, effectiveConfig: defaultConfig });
    project.ppt.pageSpecs[0] = { ...project.ppt.pageSpecs[0], version: project.ppt.pageSpecs[0].version + 1, reviewedAt: "2026-07-21T01:00:00.000Z" };
    const harness = createHarness(project);
    const module = createPptGenerationModule(harness.dependencies);

    await assert.rejects(module.start(plan), /规格已变更/);
    assert.equal(harness.stats.submitCalls, 0);
});

test("启动时冻结计划，后续内存修改不会改变实际 POST prompt", async () => {
    const project = compilerProject("compiler-frozen-plan");
    const plan = createGenerationPlan({ kind: "generateSingle", takeId: project.ppt.pages[0].takes[0].takeId }, { project, effectiveConfig: defaultConfig });
    const expectedPrompt = plan.runs[0].requests[0].prompt;
    const harness = createHarness(project);
    const module = createPptGenerationModule(harness.dependencies);
    const starting = module.start(plan);
    plan.runs[0].requests[0].prompt += "\n迟到篡改";
    const started = await starting;
    await started.settled;

    assert.deepEqual(harness.stats.submittedPrompts, [expectedPrompt]);
});

test("POST 前 PageSpec 才升版时明确失败且不记为未知提交", async () => {
    const project = compilerProject("compiler-late-stale-spec");
    const plan = createGenerationPlan({ kind: "generateSingle", takeId: project.ppt.pages[0].takes[0].takeId }, { project, effectiveConfig: defaultConfig });
    const harness = createHarness(project, {
        durableOptions: {
            beforeReads: {
                5: (current) => ({
                    ...current,
                    ppt: {
                        ...current.ppt,
                        pageSpecs: current.ppt.pageSpecs.map((pageSpec, index) => (index === 0 ? { ...pageSpec, version: pageSpec.version + 1 } : pageSpec)),
                    },
                }),
            },
        },
    });
    const module = createPptGenerationModule(harness.dependencies);
    const started = await module.start(plan);
    const settled = await started.settled;

    assert.equal(harness.stats.submitCalls, 0);
    assert.deepEqual(settled.attentionRequestIds, [plan.runs[0].requests[0].requestId]);
    assert.equal(requestTrace(await harness.durable.read(), plan.runs[0].requests[0].requestId).status, "failed");
});

test("POST 前 Compiler 输入节点才变更时为 0 POST 且明确失败", async () => {
    const project = compilerProject("compiler-late-target");
    const plan = createGenerationPlan({ kind: "generateSingle", takeId: project.ppt.pages[0].takes[0].takeId }, { project, effectiveConfig: defaultConfig });
    const anchorNodeId = project.ppt.pages[0].takes[0].anchorNodeId;
    const harness = createHarness(project, {
        durableOptions: {
            beforeReads: {
                5: (current) => ({ ...current, nodes: current.nodes.map((node) => (node.id === anchorNodeId ? { ...node, metadata: { ...node.metadata, content: `${node.metadata.content}\n迟到的篡改` } } : node)) }),
            },
        },
    });
    const started = await createPptGenerationModule(harness.dependencies).start(plan);
    await started.settled;

    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(requestTrace(await harness.durable.read(), plan.runs[0].requests[0].requestId).status, "failed");
});

test("Agent 不能修改、连入或删除 PPT 受控输入", () => {
    const project = baseProject("agent-guard");
    project.nodes.push(canvasNode("style", "text", { content: "专业风格", status: "success", pptRole: "style" }), canvasNode("ordinary", "text", { content: "未确认结论", status: "success" }));
    project.connections.push({ id: "style-config", fromNodeId: "style", toNodeId: "config" });

    for (const ops of [
        [{ type: "update_node", id: "style", metadata: { content: "被篡改" } }],
        [{ type: "connect_nodes", fromNodeId: "ordinary", toNodeId: "config" }],
        [{ type: "delete_node", id: "anchor" }],
        [{ type: "delete_connections", id: "style-config" }],
        [{ type: "delete_connections", all: true }],
    ]) {
        assert.equal(agentOpsTouchPptGenerationLedger(ops, project.nodes, project.connections), true);
    }
});

test("结构画布撤销不能改写 PPT 受控节点与连线，但允许位置变化", () => {
    const project = baseProject("history-guard");
    project.nodes.push(canvasNode("style", "text", { content: "专业风格", status: "success", pptRole: "style" }));
    project.connections.push({ id: "style-config", fromNodeId: "style", toNodeId: "config" });

    const moved = project.nodes.map((node) => (node.id === "anchor" ? { ...node, position: { x: 120, y: 80 }, width: 360, height: 240 } : node));
    assert.equal(historyEntryTouchesPptGenerationLedger(project.nodes, moved, project.connections, project.connections), false);
    assert.equal(
        historyEntryTouchesPptGenerationLedger(
            project.nodes,
            project.nodes.filter((node) => node.id !== "anchor"),
            project.connections,
            project.connections,
        ),
        true,
    );
    assert.equal(
        historyEntryTouchesPptGenerationLedger(
            project.nodes,
            project.nodes.map((node) => (node.id === "style" ? { ...node, metadata: { ...node.metadata, content: "被替换的风格" } } : node)),
            project.connections,
            project.connections,
        ),
        true,
    );
    assert.equal(
        historyEntryTouchesPptGenerationLedger(
            project.nodes,
            project.nodes,
            project.connections,
            project.connections.filter((connection) => connection.id !== "style-config"),
        ),
        true,
    );
});

test("共享风格与来源节点受统一保护，复制时移除 PPT 身份", () => {
    const nodes = [canvasNode("style", "image", { content: "data:image/png;base64,AA==", pptRole: "style" }), canvasNode("source", "text", { content: "原文", pptRole: "source" })];
    assert.equal(nodeIdsTouchPptControlledNodes(nodes, new Set(["style"])), true);
    assert.equal(nodeIdsTouchPptControlledNodes(nodes, new Set(["source"])), true);
    assert.equal(sanitizeCopiedCanvasMetadata(nodes[0].metadata).pptRole, undefined);
    assert.equal(sanitizeCopiedCanvasMetadata(nodes[1].metadata).pptRole, undefined);
});

test("刷新看到无 task ID 的 submitting 时进入 unknown，且不会自动重提", async () => {
    const project = projectWithRequest("unknown", { status: "submitting" });
    const harness = createHarness(project);
    const module = createPptGenerationModule(harness.dependencies);

    const recovered = await module.recover({ type: "reconcileProject" });
    await recovered.settled;
    assert.deepEqual(recovered.unknownRequestIds, ["request-unknown"]);
    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(harness.stats.resumeCalls, 0);

    const unknownProject = await harness.durable.read();
    assert.equal(requestTrace(unknownProject, "request-unknown").status, "submission_unknown");

    const abandoned = await module.recover({ type: "abandonUnknown", requestId: "request-unknown" });
    await abandoned.settled;
    assert.deepEqual(abandoned.abandonedRequestIds, ["request-unknown"]);
    const abandonedTrace = requestTrace(await harness.durable.read(), "request-unknown");
    assert.equal(abandonedTrace.status, "abandoned");
    assert.deepEqual(
        abandonedTrace.recentEvents.map((event) => event.status),
        ["submitting", "submission_unknown", "abandoned"],
    );
    assert.equal(hasPptRepeatBillingRisk([abandonedTrace]), true);
    assert.equal(harness.stats.submitCalls, 0);
});

test("task 已创建后断网，恢复沿用原 request/task 且不重复 POST", async () => {
    const suffix = "task-created-offline";
    const plan = generationPlan(1, suffix);
    const harness = createHarness(baseProject(suffix), {
        taskBeforeSubmitError: true,
        submitError: new Error("offline after task created"),
    });
    const module = createPptGenerationModule(harness.dependencies);

    const started = await module.start(plan);
    await started.settled;
    let durable = await harness.durable.read();
    let trace = requestTrace(durable, `request-${suffix}-0`);
    assert.equal(trace.requestId, `request-${suffix}-0`);
    assert.equal(trace.runId, `run-${suffix}`);
    assert.equal(trace.remoteTaskId, `task-request-${suffix}-0`);
    assert.equal(trace.status, "recoverable_error");
    assert.equal(harness.stats.submitCalls, 1);
    assert.equal(harness.stats.resumeCalls, 0);
    assert.equal(harness.stats.materializeCalls, 0);
    assert.deepEqual(
        harness.notifications.map((event) => event.status),
        ["needs_attention"],
    );

    const recovered = await module.recover({ type: "retrieveExisting", requestId: trace.requestId });
    await recovered.settled;
    durable = await harness.durable.read();
    trace = requestTrace(durable, trace.requestId);
    assert.equal(trace.remoteTaskId, `task-request-${suffix}-0`);
    assert.equal(trace.status, "completed");
    assert.equal(harness.stats.submitCalls, 1);
    assert.equal(harness.stats.resumeCalls, 1);
    assert.deepEqual(harness.stats.resumedTaskIds, [`task-request-${suffix}-0`]);
    assert.equal(harness.stats.materializeCalls, 1);
    assert.deepEqual(harness.stats.materializedResultIdentities, [`result-request-${suffix}-0`]);
    assert.deepEqual(
        harness.notifications.map((event) => event.status),
        ["needs_attention", "completed"],
    );

    const finalRecovery = await module.recover({ type: "reconcileProject" });
    await finalRecovery.settled;
    assert.equal(harness.stats.submitCalls, 1);
    assert.equal(harness.stats.resumeCalls, 1);
    assert.equal(harness.stats.materializeCalls, 1);
    assert.equal(harness.notifications.length, 2);
});

test("已有 task ID 只 resume 原任务，物化失败后可再次取回且不 POST", async () => {
    const project = projectWithRequest("resume", { status: "running", remoteTaskId: "task-resume" });
    const harness = createHarness(project, { failMaterializeAttempts: 1 });
    const module = createPptGenerationModule(harness.dependencies);

    const firstRecovery = await module.recover({ type: "reconcileProject" });
    await firstRecovery.settled;
    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(harness.stats.resumeCalls, 1);
    let trace = requestTrace(await harness.durable.read(), "request-resume");
    assert.equal(trace.requestId, "request-resume");
    assert.equal(trace.runId, "run-resume");
    assert.equal(trace.remoteTaskId, "task-resume");
    assert.equal(trace.resultIdentity, "result-request-resume");
    assert.equal(trace.status, "recoverable_error");
    assert.equal(harness.stats.materializeCalls, 1);
    assert.deepEqual(harness.stats.materializedResultIdentities, []);
    assert.deepEqual(
        harness.notifications.map((event) => event.status),
        ["needs_attention"],
    );

    const retry = await module.recover({ type: "retrieveExisting", requestId: "request-resume" });
    await retry.settled;
    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(harness.stats.resumeCalls, 2);
    trace = requestTrace(await harness.durable.read(), "request-resume");
    assert.equal(trace.remoteTaskId, "task-resume");
    assert.equal(trace.resultIdentity, "result-request-resume");
    assert.equal(trace.status, "completed");
    assert.deepEqual(harness.stats.resumedTaskIds, ["task-resume", "task-resume"]);
    assert.equal(harness.stats.materializeCalls, 2);
    assert.deepEqual(harness.stats.materializedResultIdentities, ["result-request-resume"]);
    assert.deepEqual(
        harness.notifications.map((event) => event.status),
        ["needs_attention", "completed"],
    );

    const finalRecovery = await module.recover({ type: "reconcileProject" });
    await finalRecovery.settled;
    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(harness.stats.resumeCalls, 2);
    assert.equal(harness.stats.materializeCalls, 2);
    assert.equal(harness.notifications.length, 2);
});

test("无 task ID 的网络失败保守进入 submission_unknown", async () => {
    const harness = createHarness(baseProject("network"), { submitError: new Error("network timeout") });
    const module = createPptGenerationModule(harness.dependencies);
    const started = await module.start(generationPlan(1, "network"));
    const settled = await started.settled;

    assert.deepEqual(settled.attentionRequestIds, ["request-network-0"]);
    assert.equal(harness.stats.submitCalls, 1);
    assert.equal(requestTrace(await harness.durable.read(), "request-network-0").status, "submission_unknown");

    const recovered = await module.recover({ type: "reconcileProject" });
    await recovered.settled;
    assert.equal(harness.stats.submitCalls, 1);
    assert.equal(harness.stats.resumeCalls, 0);
});

test("count=3 单槽明确拒绝时其余槽完成，Run 收敛为 partial", async () => {
    const rejected = Object.assign(new Error("request rejected"), { knownRejected: true });
    const harness = createHarness(baseProject("partial"), {
        submitErrorFor: (request) => (request.slotIndex === 1 ? rejected : undefined),
        classifyError: (error, trace) => (error?.knownRejected ? "failed" : trace.remoteTaskId ? "recoverable_error" : "submission_unknown"),
    });
    const plan = generationPlan(3, "partial");
    const module = createPptGenerationModule(harness.dependencies);
    const started = await module.start(plan);
    const settled = await started.settled;

    assert.equal(settled.completedRequestIds.length, 2);
    assert.deepEqual(settled.attentionRequestIds, ["request-partial-1"]);
    assert.equal(harness.stats.submitCalls, 3);
    const durable = await harness.durable.read();
    assert.equal(durable.nodes.find((node) => node.id === plan.runs[0].rootNodeId).metadata.pptGenerationRun.status, "partial");
    assert.equal(requestTrace(durable, "request-partial-1").status, "failed");
});

test("已有 task ID 的临时网络错误保持 recoverable，恢复时不 POST", async () => {
    const project = projectWithRequest("offline", { status: "running", remoteTaskId: "task-offline" });
    const harness = createHarness(project, { resumeErrorAttempts: 1 });
    const module = createPptGenerationModule(harness.dependencies);

    const offlineRecovery = await module.recover({ type: "reconcileProject" });
    await offlineRecovery.settled;
    let trace = requestTrace(await harness.durable.read(), "request-offline");
    assert.equal(trace.requestId, "request-offline");
    assert.equal(trace.runId, "run-offline");
    assert.equal(trace.remoteTaskId, "task-offline");
    assert.equal(trace.status, "recoverable_error");
    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(harness.stats.resumeCalls, 1);
    assert.equal(harness.stats.materializeCalls, 0);
    assert.deepEqual(harness.stats.resumedTaskIds, ["task-offline"]);
    assert.deepEqual(
        harness.notifications.map((event) => event.status),
        ["needs_attention"],
    );

    const refreshedModule = createPptGenerationModule(harness.dependencies);
    const onlineRecovery = await refreshedModule.recover({ type: "retrieveExisting", requestId: "request-offline" });
    await onlineRecovery.settled;
    trace = requestTrace(await harness.durable.read(), "request-offline");
    assert.equal(trace.remoteTaskId, "task-offline");
    assert.equal(trace.status, "completed");
    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(harness.stats.resumeCalls, 2);
    assert.equal(harness.stats.materializeCalls, 1);
    assert.deepEqual(harness.stats.resumedTaskIds, ["task-offline", "task-offline"]);
    assert.deepEqual(harness.stats.materializedResultIdentities, ["result-request-offline"]);
    assert.deepEqual(
        harness.notifications.map((event) => event.status),
        ["needs_attention", "completed"],
    );

    const finalRecovery = await refreshedModule.recover({ type: "reconcileProject" });
    await finalRecovery.settled;
    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(harness.stats.resumeCalls, 2);
    assert.equal(harness.stats.materializeCalls, 1);
    assert.equal(harness.notifications.length, 2);
});

test("跨页终态通知保留稳定身份、生成直达地址且每个终态只 claim 一次", async () => {
    const project = projectWithRequest("cross-page-notification", {
        status: "running",
        remoteTaskId: "task-cross-page",
        pageId: "page-2",
        takeId: "take-2",
        pageIndex: 2,
    });
    const harness = createHarness(project);
    const module = createPptGenerationModule(harness.dependencies);

    const recovered = await module.recover({ type: "reconcileProject" });
    await recovered.settled;
    assert.deepEqual(harness.notifications, [{ runId: "run-cross-page-notification", pageId: "page-2", takeId: "take-2", status: "completed" }]);
    assert.equal(
        buildPptGenerationNotificationHref({ projectId: project.id, pageId: "page-2", takeId: "take-2", runId: "run-cross-page-notification", status: "completed" }),
        `/canvas/${project.id}?pptPage=page-2&pptTake=take-2&pptRun=run-cross-page-notification&pptStatus=completed`,
    );
    assert.equal(runSummary(await harness.durable.read(), "run-cross-page-notification").notifiedTerminalStatus, "completed");

    const refreshedModule = createPptGenerationModule(harness.dependencies);
    const secondRecovery = await refreshedModule.recover({ type: "reconcileProject" });
    await secondRecovery.settled;
    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(harness.stats.resumeCalls, 1);
    assert.equal(harness.stats.materializeCalls, 1);
    assert.equal(harness.notifications.length, 1);
});

test("明确远端失败在 task 已落盘后收敛为 failed", async () => {
    const harness = createHarness(baseProject("remote-failed"), {
        taskBeforeSubmitError: true,
        submitError: new Error("remote failed"),
        classifyError: () => "failed",
    });
    const plan = generationPlan(1, "remote-failed");
    const module = createPptGenerationModule(harness.dependencies);
    const started = await module.start(plan);
    await started.settled;

    const trace = requestTrace(await harness.durable.read(), "request-remote-failed-0");
    assert.equal(trace.remoteTaskId, "task-request-remote-failed-0");
    assert.equal(trace.status, "failed");
    assert.equal(harness.stats.submitCalls, 1);
    assert.equal(harness.stats.resumeCalls, 0);
});

test("恢复只接受冻结的原渠道身份，不回退到其他渠道", () => {
    const config = providerConfig("https://old.example/v1/");
    const identity = resolvePptGenerationProviderIdentity(config, "channel-a::fake-image");
    assert.deepEqual(identity, { channelId: "channel-a", baseUrl: "https://old.example/v1", apiFormat: "maolao", model: "fake-image" });
    assert.doesNotThrow(() => assertPptGenerationProviderIdentity(config, identity));
    assert.throws(() => assertPptGenerationProviderIdentity(providerConfig("https://new.example/v1"), identity), /不会改用其他渠道/);
    assert.throws(() => assertPptGenerationProviderIdentity({ ...config, channels: [{ ...config.channels[0], id: "channel-b" }] }, identity), /不会改用其他渠道/);
});

test("远端成功但结果不可取时持久化重复计费风险", async () => {
    const deliveryError = Object.assign(new Error("生成结果已过期"), { deliveryUnavailable: true });
    const harness = createHarness(baseProject("delivery-unavailable"), {
        taskBeforeSubmitError: true,
        submitError: deliveryError,
        classifyError: () => "failed",
        hasBillingRisk: (error) => Boolean(error?.deliveryUnavailable),
    });
    const module = createPptGenerationModule(harness.dependencies);
    const started = await module.start(generationPlan(1, "delivery-unavailable"));
    await started.settled;

    const trace = requestTrace(await harness.durable.read(), "request-delivery-unavailable-0");
    assert.equal(trace.status, "failed");
    assert.equal(trace.billingRisk, true);
    assert.equal(hasPptRepeatBillingRisk([trace]), true);
});

function baseProject(suffix) {
    return {
        id: `project-${suffix}`,
        title: "可靠性测试",
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        nodes: [
            canvasNode("anchor", "text", { content: "测试提示词", status: "success", pptPageId: "page-1", pptTakeId: "take-1", pptPageIndex: 1, pptRole: "outline" }),
            canvasNode("config", "config", { prompt: "测试提示词", status: "success", model: "fake-image", count: 1, pptPageId: "page-1", pptTakeId: "take-1", pptPageIndex: 1 }),
        ],
        connections: [{ id: "anchor-config", fromNodeId: "anchor", toNodeId: "config" }],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        ppt: {
            sourceMaterial: "测试材料",
            requirements: "",
            style: { description: "", references: [] },
            pages: [{ pageId: "page-1", index: 1, title: "第一页", outline: "测试提示词", visualHint: "", takes: [{ takeId: "take-1", anchorNodeId: "anchor", configNodeId: "config" }] }],
            deckBrief: { version: 1, audience: "", goal: "", narrative: "", visualLanguage: "", globalRules: [], forbiddenRules: [], lockedDeckFacts: [] },
            pageSpecs: [
                {
                    pageId: "page-1",
                    version: 1,
                    sourceRefs: [{ source: "material", excerpt: "测试提示词", startLine: 1, endLine: 1 }],
                    lockedCopy: ["测试提示词"],
                    lockedFacts: [],
                    message: "第一页",
                    layoutIntent: [],
                    assetRefs: [],
                    freedom: "可在不改变锁定内容的前提下优化视觉组织",
                    requiresReview: false,
                },
            ],
            compilationSnapshots: [],
            mode: "outline",
        },
    };
}

function compilerProject(suffix) {
    const partial = buildPptDeckProject({
        title: "Compiler durable gate",
        sourceMaterial: "关键指标\n设备在线率 98.5%",
        requirements: "目标：保留关键事实",
        style: { description: "专业咨询风" },
        pages: [{ title: "关键指标", outline: "关键指标\n设备在线率 98.5%", visualHint: "" }],
        uploadedRefs: [],
        mode: "extract",
    });
    return {
        id: `project-${suffix}`,
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        ...partial,
    };
}

function generationPlan(count, suffix) {
    const createdAt = "2026-07-21T00:00:00.000Z";
    const deckBrief = { version: 1, audience: "", goal: "", narrative: "", visualLanguage: "", globalRules: [], forbiddenRules: [], lockedDeckFacts: [] };
    const pageSpec = {
        pageId: "page-1",
        version: 1,
        sourceRefs: [{ source: "material", excerpt: "测试提示词", startLine: 1, endLine: 1 }],
        lockedCopy: ["测试提示词"],
        lockedFacts: [],
        message: "第一页",
        layoutIntent: [],
        assetRefs: [],
        freedom: "可在不改变锁定内容的前提下优化视觉组织",
        requiresReview: false,
    };
    const target = { pageId: "page-1", takeId: "take-1", semanticText: "测试提示词", layoutIntent: [PPT_PAGE_PROMPT], layoutConfirmed: true, styleTexts: [], extraTexts: [], override: undefined, overrideConfirmed: false };
    const compilation = compilePptPromptSnapshot({ snapshotId: `snapshot-${suffix}`, compiledAt: createdAt, deckBrief, pageSpecs: [pageSpec], targets: [target] });
    const prompt = compilation.prompts[0].finalPrompt;
    const rootNodeId = `root-${suffix}`;
    const requestNodeIds = count === 1 ? [rootNodeId] : Array.from({ length: count }, (_, index) => `slot-${suffix}-${index}`);
    const requests = requestNodeIds.map((requestNodeId, slotIndex) => ({
        requestId: `request-${suffix}-${slotIndex}`,
        requestNodeId,
        slotIndex,
        requestType: "textToImage",
        model: "fake-image",
        providerIdentity: fakeProviderIdentity(),
        compilationSnapshotId: compilation.snapshotId,
        prompt,
        inputRefs: [],
        referenceSnapshots: [],
        settings: { size: "1024x1024", quality: "standard" },
    }));
    const run = { runId: `run-${suffix}`, pageId: "page-1", takeId: "take-1", pageIndex: 1, baseNodeId: "config", rootNodeId, plannedCount: count, requests };
    const rootMetadata = {
        prompt,
        status: "idle",
        model: "fake-image",
        count,
        pptPageId: "page-1",
        pptTakeId: "take-1",
        pptPageIndex: 1,
        ...(count > 1 ? { isBatchRoot: true, batchChildIds: requestNodeIds, imageBatchExpanded: true } : {}),
    };
    const structureOps = [
        addImageNode(rootNodeId, rootMetadata),
        ...requestNodeIds.flatMap((requestNodeId, slotIndex) =>
            requestNodeId === rootNodeId ? [] : [addImageNode(requestNodeId, { ...rootMetadata, count: 1, isBatchRoot: undefined, batchChildIds: undefined, imageBatchExpanded: undefined, batchRootId: rootNodeId }, slotIndex + 2)],
        ),
        { type: "connect_nodes", id: `config-root-${suffix}`, fromNodeId: "config", toNodeId: rootNodeId },
        ...requestNodeIds.flatMap((requestNodeId, slotIndex) => (requestNodeId === rootNodeId ? [] : [{ type: "connect_nodes", id: `root-slot-${suffix}-${slotIndex}`, fromNodeId: rootNodeId, toNodeId: requestNodeId }])),
    ];
    return {
        batchId: `batch-${suffix}`,
        createdAt,
        runs: [run],
        structureOps,
        pptOps: [{ type: "appendCompilationSnapshot", snapshot: compilation }],
        pageCount: 1,
        callCount: count,
        callBreakdown: { textToImage: count, imageToImage: 0 },
        excludedPages: [],
        kind: "pageGeneration",
        compilation,
    };
}

function projectWithRequest(suffix, { status, remoteTaskId, pageId = "page-1", takeId = "take-1", pageIndex = 1 }) {
    const project = baseProject(suffix);
    const at = "2026-07-21T00:00:00.000Z";
    const requestId = `request-${suffix}`;
    const runId = `run-${suffix}`;
    let configNodeId = "config";
    if (pageId !== "page-1" || takeId !== "take-1") {
        const anchorNodeId = `anchor-${suffix}`;
        configNodeId = `config-${suffix}`;
        project.nodes.push(
            canvasNode(anchorNodeId, "text", { content: "跨页测试提示词", status: "success", pptPageId: pageId, pptTakeId: takeId, pptPageIndex: pageIndex, pptRole: "outline" }),
            canvasNode(configNodeId, "config", { prompt: "跨页测试提示词", status: "success", model: "fake-image", count: 1, pptPageId: pageId, pptTakeId: takeId, pptPageIndex: pageIndex }),
        );
        project.connections.push({ id: `${anchorNodeId}-${configNodeId}`, fromNodeId: anchorNodeId, toNodeId: configNodeId });
        project.ppt.pages.push({ pageId, index: pageIndex, title: "跨页", outline: "跨页测试提示词", visualHint: "", takes: [{ takeId, anchorNodeId, configNodeId }] });
        project.ppt.pageSpecs.push({ ...project.ppt.pageSpecs[0], pageId, message: "跨页" });
    }
    project.nodes.push(
        canvasNode(`root-${suffix}`, "image", {
            status: status === "submission_unknown" || status === "recoverable_error" ? "error" : "loading",
            pptPageId: pageId,
            pptTakeId: takeId,
            pptPageIndex: pageIndex,
            pptGenerationRun: { runId, batchId: `batch-${suffix}`, pageId, takeId, requestIds: [requestId], plannedCount: 1, status: "running", createdAt: at, updatedAt: at },
            pptGenerationRequest: {
                requestId,
                runId,
                batchId: `batch-${suffix}`,
                pageId,
                takeId,
                slotIndex: 0,
                requestType: "textToImage",
                model: "fake-image",
                providerIdentity: fakeProviderIdentity(),
                status,
                ...(remoteTaskId ? { remoteTaskId } : {}),
                createdAt: at,
                updatedAt: at,
                recentEvents: [{ status, at }],
            },
            ...(remoteTaskId ? { imageTask: { taskId: remoteTaskId, model: "fake-image" } } : {}),
        }),
    );
    project.connections.push({ id: `config-root-${suffix}`, fromNodeId: configNodeId, toNodeId: `root-${suffix}` });
    return project;
}

function createHarness(project, options = {}) {
    const durable = createDurable(project, options.durableOptions);
    const stats = { submitCalls: 0, resumeCalls: 0, materializeCalls: 0, submittedPrompts: [], resumedTaskIds: [], materializedResultIdentities: [] };
    const notifications = [];
    let materializeAttempts = 0;
    let resumeAttempts = 0;
    const result = (requestId, remoteTaskId) => ({ dataUrl: "data:image/png;base64,AA==", resultIdentity: `result-${requestId}`, ...(remoteTaskId ? { remoteTaskId } : {}) });
    return {
        durable,
        stats,
        notifications,
        dependencies: {
            projectId: project.id,
            durableCanvas: durable,
            provider: {
                submit: async ({ request, onEvent }) => {
                    stats.submitCalls += 1;
                    stats.submittedPrompts.push(request.prompt);
                    const taskId = options.taskOnSubmit || options.taskBeforeSubmitError ? `task-${request.requestId}` : undefined;
                    if (taskId) {
                        await onEvent({ type: "task_created", taskId });
                    }
                    const submitError = options.submitErrorFor?.(request) || options.submitError;
                    if (submitError) throw submitError;
                    if (taskId) {
                        await onEvent({ type: "running" });
                    }
                    return result(request.requestId, taskId);
                },
                resume: async ({ trace, onEvent }) => {
                    stats.resumeCalls += 1;
                    stats.resumedTaskIds.push(trace.remoteTaskId);
                    resumeAttempts += 1;
                    if (resumeAttempts <= (options.resumeErrorAttempts || 0)) throw new Error("offline");
                    await onEvent({ type: "running" });
                    return result(trace.requestId, trace.remoteTaskId);
                },
                ...(options.classifyError ? { classifyError: options.classifyError } : {}),
                ...(options.hasBillingRisk ? { hasBillingRisk: options.hasBillingRisk } : {}),
            },
            materialize: async (providerResult) => {
                stats.materializeCalls += 1;
                materializeAttempts += 1;
                if (materializeAttempts <= (options.failMaterializeAttempts || 0)) throw new Error("materialize failed");
                stats.materializedResultIdentities.push(providerResult.resultIdentity);
                return { content: providerResult.dataUrl, storageKey: `storage-${providerResult.resultIdentity}`, mimeType: "image/png", bytes: 1, naturalWidth: 1, naturalHeight: 1 };
            },
            notify: async (event) => notifications.push(event),
        },
    };
}

function createDurable(initialProject, { failMutations = [], failReads = [], beforeReads = {} } = {}) {
    let state = structuredClone(initialProject);
    let mutationCount = 0;
    let readCount = 0;
    let queue = Promise.resolve();
    return {
        mutate(mutator) {
            const operation = queue.then(() => {
                mutationCount += 1;
                if (failMutations.includes(mutationCount)) throw new Error(`durable mutation ${mutationCount} failed`);
                state = structuredClone(mutator(structuredClone(state)));
                return structuredClone(state);
            });
            queue = operation.then(
                () => undefined,
                () => undefined,
            );
            return operation;
        },
        async read() {
            await queue;
            readCount += 1;
            if (failReads.includes(readCount)) throw new Error(`durable read ${readCount} failed`);
            if (beforeReads[readCount]) state = structuredClone(beforeReads[readCount](structuredClone(state)));
            return structuredClone(state);
        },
    };
}

function canvasNode(id, type, metadata) {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 180, metadata };
}

function addImageNode(id, metadata, offset = 1) {
    return { type: "add_node", id, nodeType: "image", title: id, position: { x: offset * 400, y: 0 }, width: 320, height: 180, metadata };
}

function requestTrace(project, requestId) {
    return project.nodes.find((node) => node.metadata?.pptGenerationRequest?.requestId === requestId)?.metadata.pptGenerationRequest;
}

function runSummary(project, runId) {
    return project.nodes.find((node) => node.metadata?.pptGenerationRun?.runId === runId)?.metadata.pptGenerationRun;
}

function fakeProviderIdentity() {
    return { channelId: "fake-channel", baseUrl: "https://fake.example", apiFormat: "maolao", model: "fake-image" };
}

function providerConfig(baseUrl) {
    return {
        channels: [{ id: "channel-a", name: "A", baseUrl, apiKey: "test-key", apiFormat: "maolao", models: [{ name: "fake-image", capability: "image" }] }],
    };
}
