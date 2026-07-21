import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let vite;
let createPptGenerationModule;
let resolvePptGenerationProviderIdentity;
let assertPptGenerationProviderIdentity;
let hasPptRepeatBillingRisk;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ createPptGenerationModule } = await vite.ssrLoadModule("/src/lib/ppt/generation-execution.ts"));
    ({ resolvePptGenerationProviderIdentity, assertPptGenerationProviderIdentity } = await vite.ssrLoadModule("/src/lib/ppt/generation-plan.ts"));
    ({ hasPptRepeatBillingRisk } = await vite.ssrLoadModule("/src/lib/ppt/generation-ledger.ts"));
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
    assert.equal(requestTrace(await harness.durable.read(), "request-unknown").status, "abandoned");
    assert.equal(harness.stats.submitCalls, 0);
});

test("已有 task ID 只 resume 原任务，物化失败后可再次取回且不 POST", async () => {
    const project = projectWithRequest("resume", { status: "running", remoteTaskId: "task-resume" });
    const harness = createHarness(project, { failMaterializeAttempts: 1 });
    const module = createPptGenerationModule(harness.dependencies);

    const firstRecovery = await module.recover({ type: "reconcileProject" });
    await firstRecovery.settled;
    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(harness.stats.resumeCalls, 1);
    assert.equal(requestTrace(await harness.durable.read(), "request-resume").status, "recoverable_error");

    const retry = await module.recover({ type: "retrieveExisting", requestId: "request-resume" });
    await retry.settled;
    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(harness.stats.resumeCalls, 2);
    assert.equal(requestTrace(await harness.durable.read(), "request-resume").status, "completed");

    const finalRecovery = await module.recover({ type: "reconcileProject" });
    await finalRecovery.settled;
    assert.equal(harness.stats.resumeCalls, 2);
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
    assert.equal(requestTrace(await harness.durable.read(), "request-offline").status, "recoverable_error");
    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(harness.stats.resumeCalls, 1);

    const onlineRecovery = await module.recover({ type: "retrieveExisting", requestId: "request-offline" });
    await onlineRecovery.settled;
    assert.equal(requestTrace(await harness.durable.read(), "request-offline").status, "completed");
    assert.equal(harness.stats.submitCalls, 0);
    assert.equal(harness.stats.resumeCalls, 2);
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
        },
    };
}

function generationPlan(count, suffix) {
    const createdAt = "2026-07-21T00:00:00.000Z";
    const rootNodeId = `root-${suffix}`;
    const requestNodeIds = count === 1 ? [rootNodeId] : Array.from({ length: count }, (_, index) => `slot-${suffix}-${index}`);
    const requests = requestNodeIds.map((requestNodeId, slotIndex) => ({
        requestId: `request-${suffix}-${slotIndex}`,
        requestNodeId,
        slotIndex,
        requestType: "textToImage",
        model: "fake-image",
        providerIdentity: fakeProviderIdentity(),
        prompt: "测试提示词",
        inputRefs: [],
        referenceSnapshots: [],
        settings: { size: "1024x1024", quality: "standard" },
    }));
    const run = { runId: `run-${suffix}`, pageId: "page-1", takeId: "take-1", pageIndex: 1, baseNodeId: "config", rootNodeId, plannedCount: count, requests };
    const rootMetadata = {
        prompt: "测试提示词",
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
        pptOps: [],
        pageCount: 1,
        callCount: count,
        callBreakdown: { textToImage: count, imageToImage: 0 },
        excludedPages: [],
    };
}

function projectWithRequest(suffix, { status, remoteTaskId }) {
    const project = baseProject(suffix);
    const at = "2026-07-21T00:00:00.000Z";
    const requestId = `request-${suffix}`;
    const runId = `run-${suffix}`;
    project.nodes.push(
        canvasNode(`root-${suffix}`, "image", {
            status: status === "submission_unknown" || status === "recoverable_error" ? "error" : "loading",
            pptPageId: "page-1",
            pptTakeId: "take-1",
            pptPageIndex: 1,
            pptGenerationRun: { runId, batchId: `batch-${suffix}`, pageId: "page-1", takeId: "take-1", requestIds: [requestId], plannedCount: 1, status: "running", createdAt: at, updatedAt: at },
            pptGenerationRequest: {
                requestId,
                runId,
                batchId: `batch-${suffix}`,
                pageId: "page-1",
                takeId: "take-1",
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
    project.connections.push({ id: `config-root-${suffix}`, fromNodeId: "config", toNodeId: `root-${suffix}` });
    return project;
}

function createHarness(project, options = {}) {
    const durable = createDurable(project, options.durableOptions);
    const stats = { submitCalls: 0, resumeCalls: 0, materializeCalls: 0 };
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
                return { content: providerResult.dataUrl, storageKey: `storage-${providerResult.resultIdentity}`, mimeType: "image/png", bytes: 1, naturalWidth: 1, naturalHeight: 1 };
            },
            notify: async (event) => notifications.push(event),
        },
    };
}

function createDurable(initialProject, { failMutations = [], failReads = [] } = {}) {
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

function fakeProviderIdentity() {
    return { channelId: "fake-channel", baseUrl: "https://fake.example", apiFormat: "maolao", model: "fake-image" };
}

function providerConfig(baseUrl) {
    return {
        channels: [{ id: "channel-a", name: "A", baseUrl, apiKey: "test-key", apiFormat: "maolao", models: [{ name: "fake-image", capability: "image" }] }],
    };
}
