import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let vite;
let inspectPptDeckExport;
let resolvePptCandidateCompilationSnapshot;
let setPptPageConfirmedNode;
let compilePptPromptSnapshot;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ inspectPptDeckExport } = await vite.ssrLoadModule("/src/lib/ppt/deck-export.ts"));
    ({ resolvePptCandidateCompilationSnapshot, setPptPageConfirmedNode } = await vite.ssrLoadModule("/src/lib/ppt/page-confirmation.ts"));
    ({ compilePptPromptSnapshot } = await vite.ssrLoadModule("/src/lib/ppt/prompt-compiler.ts"));
});

after(async () => {
    await vite?.close();
});

test("严格检查不会用最新候选回退未确认页", async () => {
    const project = projectWithPages([1]);
    project.ppt.pages[0].confirmedNodeId = undefined;
    const harness = dependencies({ 1: [1600, 900] });

    const inspection = await inspectPptDeckExport(project, harness.dependencies);

    assert.equal(inspection.ready, false);
    assert.equal(inspection.pages[0].node, undefined);
    assert.deepEqual(inspection.pages[0].issues, ["尚未确认最终版"]);
    assert.deepEqual(harness.blobCalls, []);
});

test("页序按 index 解析，混合比例只阻止 PPTX", async () => {
    const project = projectWithPages([2, 1]);
    const harness = dependencies({ 1: [1600, 900], 2: [1200, 900] });

    const inspection = await inspectPptDeckExport(project, harness.dependencies);

    assert.deepEqual(
        inspection.pages.map((item) => item.page.index),
        [1, 2],
    );
    assert.deepEqual(harness.blobCalls, ["storage-1", "storage-2"]);
    assert.equal(inspection.ready, true);
    assert.equal(inspection.pptxReady, false);
    assert.deepEqual(inspection.pages[0].pptxIssues, []);
    assert.match(inspection.pages[1].pptxIssues[0], /比例.*第 1 页不一致/);
});

test("缺失和读取失败的 Blob 按页分别诊断", async () => {
    const project = projectWithPages([1, 2]);
    const harness = dependencies({ 1: [1600, 900], 2: [1600, 900] }, async (storageKey) => {
        if (storageKey === "storage-1") return null;
        throw new Error("read failed");
    });

    const inspection = await inspectPptDeckExport(project, harness.dependencies);

    assert.equal(inspection.ready, false);
    assert.deepEqual(inspection.pages[0].issues, ["已确认的图片本地文件不存在"]);
    assert.deepEqual(inspection.pages[1].issues, ["已确认的图片本地文件读取失败"]);
});

test("批量 root 不再作为无血缘的确认兼容入口", async () => {
    const project = projectWithPages([1]);
    const page = project.ppt.pages[0];
    const child = project.nodes.find((node) => node.id === "candidate-1");
    const root = node("root-1", "image", { status: "success", pptPageId: page.pageId, pptTakeId: "take-1", batchChildIds: [child.id], primaryImageId: child.id });
    child.metadata.batchRootId = root.id;
    project.nodes.push(root);
    project.connections.push({ id: "config-root-1", fromNodeId: "config-1", toNodeId: root.id });
    page.confirmedNodeId = root.id;

    const harness = dependencies({ 1: [1600, 900] });
    const inspection = await inspectPptDeckExport(project, harness.dependencies);

    assert.equal(inspection.ready, false);
    assert.deepEqual(harness.blobCalls, []);
    assert.match(inspection.pages[0].issues[0], /已失效/);
});

test("批量生成的 child 候选可通过 root 运行台账回溯快照", async () => {
    const project = projectWithPages([1]);
    const { primary } = convertPageCandidateToBatch(project, 1);
    const harness = dependencies({ 1: [1600, 900] });

    const inspection = await inspectPptDeckExport(project, harness.dependencies);

    assert.equal(inspection.ready, true);
    assert.equal(inspection.pages[0].node.id, primary.id);
    assert.deepEqual(harness.blobCalls, ["storage-1"]);
});

for (const scenario of [
    { name: "缺少第二个 request 产物", options: { omitSecond: true }, pattern: /缺少请求槽/ },
    { name: "两个 request 重复 slot", options: { secondSlot: 0 }, pattern: /请求槽与运行台账不一致/ },
    { name: "run 与 request 终态不一致", options: { secondStatus: "failed", runStatus: "completed" }, pattern: /请求状态与生成运行台账不一致/ },
]) {
    test(`批量台账${scenario.name}时阻止确认，且全 deck 0 Blob`, async () => {
        const project = projectWithPages([1, 2]);
        const { primary } = convertPageCandidateToBatch(project, 2, scenario.options);
        const harness = dependencies({ 1: [1600, 900], 2: [1600, 900] });

        assert.throws(() => setPptPageConfirmedNode(project, "page-2", primary.id), scenario.pattern);
        const inspection = await inspectPptDeckExport(project, harness.dependencies);

        assert.equal(inspection.ready, false);
        assert.deepEqual(harness.blobCalls, []);
        assert.match(inspection.pages[1].issues[0], /缺少可追溯的编译快照/);
    });
}

test("batch root 不能通过自环冒充缺失的 request 产物，且全 deck 0 Blob", async () => {
    const project = projectWithPages([1, 2]);
    const { root, primary, secondary } = convertPageCandidateToBatch(project, 2);
    project.nodes = project.nodes.filter((node) => node.id !== secondary.id);
    root.metadata.pptGenerationRequest = secondary.metadata.pptGenerationRequest;
    root.metadata.batchRootId = root.id;
    root.metadata.batchChildIds = [primary.id, root.id];
    project.connections = project.connections.filter((connection) => connection.toNodeId !== secondary.id);
    project.connections.push({ id: "batch-root-self-2", fromNodeId: root.id, toNodeId: root.id });
    const harness = dependencies({ 1: [1600, 900], 2: [1600, 900] });

    assert.throws(() => setPptPageConfirmedNode(project, "page-2", primary.id), /批量候选稿与生成运行台账不一致/);
    const inspection = await inspectPptDeckExport(project, harness.dependencies);

    assert.equal(inspection.ready, false);
    assert.deepEqual(harness.blobCalls, []);
    assert.match(inspection.pages[1].issues[0], /缺少可追溯的编译快照/);
});

test("改选最终稿后重新检查只读取新确认图", async () => {
    const project = projectWithPages([1]);
    const page = project.ppt.pages[0];
    const prompt = compiledPrompt(project, page.pageId, "take-1");
    const replacement = node("candidate-1-replacement", "image", {
        status: "success",
        storageKey: "storage-1-replacement",
        prompt,
        pptPageId: page.pageId,
        pptTakeId: "take-1",
        pptGenerationRequest: generationRequest("replacement", page.pageId, "take-1", { compilationSnapshotId: "snapshot-deck" }),
        pptGenerationRun: generationRun("replacement", page.pageId, "take-1"),
    });
    project.nodes.push(replacement);
    project.connections.push({ id: "config-candidate-1-replacement", fromNodeId: "config-1", toNodeId: replacement.id });
    const harness = dependencies({ 1: [1600, 900] });

    const before = await inspectPptDeckExport(project, harness.dependencies);
    page.confirmedNodeId = replacement.id;
    const after = await inspectPptDeckExport(project, harness.dependencies);

    assert.equal(before.pages[0].node.id, "candidate-1");
    assert.equal(after.pages[0].node.id, replacement.id);
    assert.deepEqual(harness.blobCalls, ["storage-1", "storage-1-replacement"]);
});

test("普通候选与多级修改稿都回溯到根候选的唯一快照", async () => {
    const project = projectWithPages([1]);
    const page = project.ppt.pages[0];
    const direct = project.nodes.find((item) => item.id === "candidate-1");
    const edit1 = editNode("edit-1", direct.id, page.pageId, "take-1");
    const edit2 = editNode("edit-2", edit1.id, page.pageId, "take-1", { compilationSnapshotId: "forged-on-edit" });
    project.nodes.push(edit1, edit2);
    project.connections.push({ id: "direct-edit-1", fromNodeId: direct.id, toNodeId: edit1.id }, { id: "edit-1-edit-2", fromNodeId: edit1.id, toNodeId: edit2.id });

    assert.equal(resolvePptCandidateCompilationSnapshot(project, direct.id).snapshotId, "snapshot-deck");
    assert.equal(resolvePptCandidateCompilationSnapshot(project, edit2.id).snapshotId, "snapshot-deck");
    const nextPpt = setPptPageConfirmedNode(project, page.pageId, edit2.id);
    project.ppt = nextPpt;
    const harness = dependencies({ 1: [1600, 900] });
    const inspection = await inspectPptDeckExport(project, harness.dependencies);

    assert.equal(inspection.ready, true);
    assert.equal(inspection.pages[0].node.id, edit2.id);
    assert.deepEqual(harness.blobCalls, ["storage-edit-2"]);
});

for (const failure of [
    {
        name: "断链",
        mutate(project) {
            const edit = editNode("broken-edit", "missing-base", "page-1", "take-1");
            project.nodes.push(edit);
            project.connections.push({ id: "missing-broken-edit", fromNodeId: "missing-base", toNodeId: edit.id });
            project.ppt.pages[0].confirmedNodeId = edit.id;
        },
        pattern: /断开/,
    },
    {
        name: "循环",
        mutate(project) {
            const edit1 = editNode("cycle-1", "cycle-2", "page-1", "take-1");
            const edit2 = editNode("cycle-2", "cycle-1", "page-1", "take-1");
            project.nodes.push(edit1, edit2);
            project.connections.push({ id: "cycle-2-cycle-1", fromNodeId: edit2.id, toNodeId: edit1.id }, { id: "cycle-1-cycle-2", fromNodeId: edit1.id, toNodeId: edit2.id });
            project.ppt.pages[0].confirmedNodeId = edit1.id;
        },
        pattern: /循环/,
    },
    {
        name: "重复快照",
        mutate(project) {
            project.ppt.compilationSnapshots.push(structuredClone(project.ppt.compilationSnapshots[0]));
        },
        pattern: /重复/,
    },
    {
        name: "伪造快照",
        mutate(project) {
            project.nodes.find((node) => node.id === "candidate-1").metadata.pptGenerationRequest.compilationSnapshotId = "forged-snapshot";
        },
        pattern: /已丢失/,
    },
    {
        name: "不完整同页快照",
        mutate(project) {
            project.ppt.compilationSnapshots.push({
                snapshotId: "same-scope-forged",
                prompts: [{ pageId: "page-1", takeId: "take-1", finalPrompt: project.nodes.find((node) => node.id === "candidate-1").metadata.prompt, issueIds: [] }],
            });
            project.nodes.find((node) => node.id === "candidate-1").metadata.pptGenerationRequest.compilationSnapshotId = "same-scope-forged";
        },
        pattern: /Compiler 快照结构不完整/,
    },
    {
        name: "篡改完整快照",
        mutate(project) {
            const forged = structuredClone(project.ppt.compilationSnapshots[0]);
            forged.snapshotId = "tampered-complete";
            forged.compilerVersion = "2.0.0-tampered";
            forged.prompts = forged.prompts.map((prompt) => ({ ...prompt, promptId: `tampered-complete:${prompt.pageId}:${prompt.takeId}` }));
            project.ppt.compilationSnapshots.push(forged);
            project.nodes.find((node) => node.id === "candidate-1").metadata.pptGenerationRequest.compilationSnapshotId = forged.snapshotId;
        },
        pattern: /确定性完整性校验/,
    },
    {
        name: "伪造修改快照",
        mutate(project) {
            const edit = editNode("malformed-edit", "candidate-1", "page-1", "take-1");
            edit.metadata.pptGenerationRequest.candidateEdit = { baseNodeId: "candidate-1" };
            project.nodes.push(edit);
            project.connections.push({ id: "candidate-1-malformed-edit", fromNodeId: "candidate-1", toNodeId: edit.id });
            project.ppt.pages[0].confirmedNodeId = edit.id;
        },
        pattern: /修改稿的生成快照无效/,
    },
    {
        name: "未完成请求",
        mutate(project) {
            project.nodes.find((node) => node.id === "candidate-1").metadata.pptGenerationRequest.status = "failed";
        },
        pattern: /尚未完整结束/,
    },
    {
        name: "孤立请求",
        mutate(project) {
            delete project.nodes.find((node) => node.id === "candidate-1").metadata.pptGenerationRun;
        },
        pattern: /缺少唯一的生成运行台账/,
    },
    {
        name: "冲突运行台账",
        mutate(project) {
            project.nodes.find((node) => node.id === "candidate-1").metadata.pptGenerationRun.batchId = "other-batch";
        },
        pattern: /请求与生成运行台账不一致/,
    },
    {
        name: "跨页血缘",
        mutate(project) {
            const foreign = node("foreign-page", "image", {
                status: "success",
                storageKey: "storage-foreign-page",
                pptPageId: "page-2",
                pptTakeId: "take-2",
                pptGenerationRequest: generationRequest("foreign-page", "page-2", "take-2", { compilationSnapshotId: "snapshot-deck" }),
                pptGenerationRun: generationRun("foreign-page", "page-2", "take-2"),
            });
            const edit = editNode("cross-page-edit", foreign.id, "page-1", "take-1");
            project.nodes.push(foreign, edit);
            project.connections.push({ id: "foreign-page-cross-page-edit", fromNodeId: foreign.id, toNodeId: edit.id });
            project.ppt.pages[0].confirmedNodeId = edit.id;
        },
        pattern: /跨越/,
    },
    {
        name: "跨方案血缘",
        mutate(project) {
            const foreign = node("foreign-take", "image", {
                status: "success",
                storageKey: "storage-foreign",
                pptPageId: "page-1",
                pptTakeId: "take-other",
                pptGenerationRequest: generationRequest("foreign", "page-1", "take-other", { compilationSnapshotId: "snapshot-deck" }),
                pptGenerationRun: generationRun("foreign", "page-1", "take-other"),
            });
            const edit = editNode("cross-take-edit", foreign.id, "page-1", "take-1");
            project.nodes.push(foreign, edit);
            project.connections.push({ id: "foreign-take-cross-take-edit", fromNodeId: foreign.id, toNodeId: edit.id });
            project.ppt.pages[0].confirmedNodeId = edit.id;
        },
        pattern: /跨越/,
    },
]) {
    test(`血缘${failure.name}时阻止确认与导出，且不读取 Blob`, async () => {
        const project = projectWithPages([1]);
        failure.mutate(project);
        const confirmedNodeId = project.ppt.pages[0].confirmedNodeId;
        const harness = dependencies({ 1: [1600, 900], 2: [1600, 900] });

        assert.throws(() => setPptPageConfirmedNode({ ...project, ppt: { ...project.ppt, pages: project.ppt.pages.map((page) => ({ ...page, confirmedNodeId: undefined })) } }, "page-1", confirmedNodeId), failure.pattern);
        const inspection = await inspectPptDeckExport(project, harness.dependencies);

        assert.equal(inspection.ready, false);
        assert.deepEqual(harness.blobCalls, []);
        assert.match(inspection.pages[0].issues[0], /缺少可追溯的编译快照/);
    });
}

test("任一已确认页血缘损坏时，全 deck 预检在读取首个 Blob 前失败", async () => {
    const project = projectWithPages([1, 2]);
    project.nodes.find((node) => node.id === "candidate-2").metadata.pptGenerationRequest.compilationSnapshotId = "missing-snapshot";
    const harness = dependencies({ 1: [1600, 900], 2: [1600, 900] });

    const inspection = await inspectPptDeckExport(project, harness.dependencies);

    assert.equal(inspection.ready, false);
    assert.deepEqual(harness.blobCalls, []);
    assert.equal(inspection.pages[0].previewUrl, undefined);
    assert.match(inspection.pages[1].issues[0], /缺少可追溯的编译快照/);
});

function dependencies(dimensions, getBlob) {
    const blobCalls = [];
    return {
        blobCalls,
        dependencies: {
            getImageBlob: async (storageKey) => {
                blobCalls.push(storageKey);
                return getBlob ? getBlob(storageKey) : new Blob([storageKey], { type: "image/png" });
            },
            resolveImageUrl: async (storageKey) => `blob:${storageKey}`,
            readImageDimensions: async (pageNumber) => ({ width: dimensions[pageNumber][0], height: dimensions[pageNumber][1] }),
        },
    };
}

function compiledPrompt(project, pageId, takeId) {
    return project.ppt.compilationSnapshots[0].prompts.find((prompt) => prompt.pageId === pageId && prompt.takeId === takeId).finalPrompt;
}

function pageSemantic(index) {
    return `页面${String.fromCharCode(64 + index)}已编译`;
}

function convertPageCandidateToBatch(project, index, { omitSecond = false, secondSlot = 1, secondStatus = "completed", runStatus = secondStatus === "completed" ? "completed" : "partial" } = {}) {
    const pageId = `page-${index}`;
    const takeId = `take-${index}`;
    const primary = project.nodes.find((node) => node.id === `candidate-${index}`);
    const runId = `run-batch-${index}`;
    const batchId = `batch-batch-${index}`;
    const secondaryId = `candidate-${index}-secondary`;
    const secondaryRequestId = `request-batch-${index}-1`;
    Object.assign(primary.metadata.pptGenerationRequest, { runId, batchId, slotIndex: 0 });
    delete primary.metadata.pptGenerationRun;
    primary.metadata.batchRootId = `batch-root-${index}`;
    const secondary = node(secondaryId, "image", {
        status: secondStatus === "completed" ? "success" : "error",
        ...(secondStatus === "completed" ? { storageKey: `storage-${index}-secondary` } : {}),
        prompt: compiledPrompt(project, pageId, takeId),
        batchRootId: `batch-root-${index}`,
        pptPageId: pageId,
        pptTakeId: takeId,
        pptGenerationRequest: generationRequest(`batch-${index}-secondary`, pageId, takeId, {
            requestId: secondaryRequestId,
            runId,
            batchId,
            slotIndex: secondSlot,
            status: secondStatus,
            compilationSnapshotId: "snapshot-deck",
        }),
    });
    const root = node(`batch-root-${index}`, "image", {
        status: "success",
        isBatchRoot: true,
        batchChildIds: [primary.id, secondary.id],
        primaryImageId: primary.id,
        pptPageId: pageId,
        pptTakeId: takeId,
        pptGenerationRun: {
            runId,
            batchId,
            pageId,
            takeId,
            requestIds: [primary.metadata.pptGenerationRequest.requestId, secondaryRequestId],
            plannedCount: 2,
            status: runStatus,
            createdAt: "2026-07-21T00:00:00.000Z",
            updatedAt: "2026-07-21T00:00:00.000Z",
        },
    });
    project.nodes.push(root, ...(omitSecond ? [] : [secondary]));
    project.connections = project.connections.filter((connection) => connection.toNodeId !== primary.id);
    project.connections.push({ id: `config-batch-root-${index}`, fromNodeId: `config-${index}`, toNodeId: root.id }, { id: `batch-root-primary-${index}`, fromNodeId: root.id, toNodeId: primary.id });
    if (!omitSecond) project.connections.push({ id: `batch-root-secondary-${index}`, fromNodeId: root.id, toNodeId: secondary.id });
    return { root, primary, secondary };
}

function projectWithPages(indices) {
    const pages = indices.map((index) => ({
        pageId: `page-${index}`,
        index,
        title: `第${index}页`,
        outline: pageSemantic(index),
        visualHint: "",
        confirmedNodeId: `candidate-${index}`,
        takes: [{ takeId: `take-${index}`, anchorNodeId: `anchor-${index}`, configNodeId: `config-${index}` }],
    }));
    const deckBrief = {
        version: 1,
        audience: "",
        goal: "",
        narrative: "",
        styleContract: { source: { kind: "custom" }, direction: "清晰专业的报告视觉", references: [] },
        globalRules: [],
        forbiddenRules: [],
        lockedDeckFacts: [],
    };
    const pageSpecs = indices.map((index) => ({
        pageId: `page-${index}`,
        version: 1,
        sourceRefs: [],
        lockedCopy: [pageSemantic(index)],
        lockedFacts: [],
        message: `第${index}页`,
        layoutRole: index === indices[0] ? "cover" : "content",
        layoutIntent: [],
        assetRefs: [],
        freedom: "可在不改变锁定内容的前提下优化视觉组织",
        requiresReview: false,
    }));
    const targets = indices.map((index) => ({
        pageId: `page-${index}`,
        takeId: `take-${index}`,
        semanticText: pageSemantic(index),
        layoutIntent: [],
        layoutConfirmed: true,
        extraTexts: [],
    }));
    const compilation = compilePptPromptSnapshot({
        snapshotId: "snapshot-deck",
        compiledAt: "2026-07-21T00:00:00.000Z",
        deckBrief,
        pageSpecs,
        targets,
    });
    const promptByScope = new Map(compilation.prompts.map((prompt) => [`${prompt.pageId}:${prompt.takeId}`, prompt.finalPrompt]));
    return {
        id: "project-export",
        title: "导出测试",
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        nodes: indices.flatMap((index) => [
            node(`anchor-${index}`, "text", { content: pageSemantic(index), status: "success", pptPageId: `page-${index}`, pptTakeId: `take-${index}` }),
            node(`config-${index}`, "config", { status: "success", pptPageId: `page-${index}`, pptTakeId: `take-${index}` }),
            node(`candidate-${index}`, "image", {
                status: "success",
                storageKey: `storage-${index}`,
                prompt: promptByScope.get(`page-${index}:take-${index}`),
                pptPageId: `page-${index}`,
                pptTakeId: `take-${index}`,
                pptGenerationRequest: generationRequest(`candidate-${index}`, `page-${index}`, `take-${index}`, { compilationSnapshotId: "snapshot-deck" }),
                pptGenerationRun: generationRun(`candidate-${index}`, `page-${index}`, `take-${index}`),
            }),
        ]),
        connections: indices.flatMap((index) => [
            { id: `anchor-config-${index}`, fromNodeId: `anchor-${index}`, toNodeId: `config-${index}` },
            { id: `config-candidate-${index}`, fromNodeId: `config-${index}`, toNodeId: `candidate-${index}` },
        ]),
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        ppt: {
            sourceMaterial: "",
            requirements: "",
            pages,
            deckBrief,
            pageSpecs,
            compilationSnapshots: [compilation],
            mode: "outline",
        },
    };
}

function editNode(id, baseNodeId, pageId, takeId, requestPatch = {}) {
    return node(id, "image", {
        status: "success",
        storageKey: `storage-${id}`,
        prompt: "增加留白",
        pptPageId: pageId,
        pptTakeId: takeId,
        pptGenerationRequest: generationRequest(id, pageId, takeId, {
            candidateEdit: { baseNodeId, globalInstruction: "增加留白", annotations: [], finalPrompt: "增加留白" },
            ...requestPatch,
        }),
        pptGenerationRun: generationRun(id, pageId, takeId),
    });
}

function generationRequest(id, pageId, takeId, patch = {}) {
    return {
        requestId: `request-${id}`,
        runId: `run-${id}`,
        batchId: `batch-${id}`,
        pageId,
        takeId,
        slotIndex: 0,
        requestType: patch.candidateEdit ? "imageToImage" : "textToImage",
        model: "test-image",
        providerIdentity: { channelId: "test", baseUrl: "https://example.test", apiFormat: "openai", model: "test-image" },
        status: "completed",
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        recentEvents: [],
        ...patch,
    };
}

function generationRun(id, pageId, takeId) {
    return {
        runId: `run-${id}`,
        batchId: `batch-${id}`,
        pageId,
        takeId,
        requestIds: [`request-${id}`],
        plannedCount: 1,
        status: "completed",
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
    };
}

function node(id, type, metadata) {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 180, metadata };
}
