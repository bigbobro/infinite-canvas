import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let vite;
let inspectPptDeckExport;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ inspectPptDeckExport } = await vite.ssrLoadModule("/src/lib/ppt/deck-export.ts"));
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

test("历史批量 root 确认仍只读解析到 primary 图", async () => {
    const project = projectWithPages([1]);
    const page = project.ppt.pages[0];
    const child = project.nodes.find((node) => node.id === "candidate-1");
    const root = node("root-1", "image", { status: "success", pptPageId: page.pageId, pptTakeId: "take-1", batchChildIds: [child.id], primaryImageId: child.id });
    child.metadata.batchRootId = root.id;
    project.nodes.push(root);
    project.connections.push({ id: "config-root-1", fromNodeId: "config-1", toNodeId: root.id });
    page.confirmedNodeId = root.id;

    const inspection = await inspectPptDeckExport(project, dependencies({ 1: [1600, 900] }).dependencies);

    assert.equal(inspection.ready, true);
    assert.equal(inspection.pages[0].node.id, child.id);
});

test("改选最终稿后重新检查只读取新确认图", async () => {
    const project = projectWithPages([1]);
    const page = project.ppt.pages[0];
    const replacement = node("candidate-1-replacement", "image", { status: "success", storageKey: "storage-1-replacement", pptPageId: page.pageId, pptTakeId: "take-1" });
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

function projectWithPages(indices) {
    const pages = indices.map((index) => ({
        pageId: `page-${index}`,
        index,
        title: `第${index}页`,
        outline: "",
        visualHint: "",
        confirmedNodeId: `candidate-${index}`,
        takes: [{ takeId: `take-${index}`, anchorNodeId: `anchor-${index}`, configNodeId: `config-${index}` }],
    }));
    return {
        id: "project-export",
        title: "导出测试",
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        nodes: indices.flatMap((index) => [
            node(`anchor-${index}`, "text", { content: "", status: "success", pptPageId: `page-${index}`, pptTakeId: `take-${index}` }),
            node(`config-${index}`, "config", { status: "success", pptPageId: `page-${index}`, pptTakeId: `take-${index}` }),
            node(`candidate-${index}`, "image", { status: "success", storageKey: `storage-${index}`, pptPageId: `page-${index}`, pptTakeId: `take-${index}` }),
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
            style: { description: "", references: [] },
            pages,
            deckBrief: { version: 1, audience: "", goal: "", narrative: "", visualLanguage: "", globalRules: [], forbiddenRules: [], lockedDeckFacts: [] },
            pageSpecs: [],
            compilationSnapshots: [],
        },
    };
}

function node(id, type, metadata) {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 180, metadata };
}
