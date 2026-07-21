import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let vite;
let layout;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    layout = await vite.ssrLoadModule("/src/lib/ppt/workspace-layout.ts");
});

after(async () => {
    await vite?.close();
});

test("容器只有同时容纳上下最小高度与分隔线时才启用 splitter", () => {
    const minimumHeight = layout.PPT_WORKSPACE_UPPER_MIN_HEIGHT + layout.PPT_WORKSPACE_SPLITTER_SIZE + layout.PPT_WORKSPACE_LOWER_MIN_HEIGHT;

    assert.equal(layout.canEnablePptWorkspaceSplitter(minimumHeight - 1), false);
    assert.equal(layout.canEnablePptWorkspaceSplitter(minimumHeight), true);
    assert.equal(layout.canEnablePptWorkspaceSplitter(Number.NaN), false);
});

test("上区高度同时受上区与下区最小高度约束", () => {
    const containerHeight = 600;
    const maxUpperHeight = containerHeight - layout.PPT_WORKSPACE_SPLITTER_SIZE - layout.PPT_WORKSPACE_LOWER_MIN_HEIGHT;

    assert.equal(layout.clampPptWorkspaceUpperHeight(0, containerHeight), layout.PPT_WORKSPACE_UPPER_MIN_HEIGHT);
    assert.equal(layout.clampPptWorkspaceUpperHeight(300, containerHeight), 300);
    assert.equal(layout.clampPptWorkspaceUpperHeight(999, containerHeight), maxUpperHeight);
});

test("拖动按增量调整上区高度并在边界处 clamp", () => {
    const containerHeight = 600;
    const maxUpperHeight = containerHeight - layout.PPT_WORKSPACE_SPLITTER_SIZE - layout.PPT_WORKSPACE_LOWER_MIN_HEIGHT;

    assert.equal(layout.resizePptWorkspaceByDrag(280, 40, containerHeight), 320);
    assert.equal(layout.resizePptWorkspaceByDrag(280, -999, containerHeight), layout.PPT_WORKSPACE_UPPER_MIN_HEIGHT);
    assert.equal(layout.resizePptWorkspaceByDrag(280, 999, containerHeight), maxUpperHeight);
});

test("ArrowUp 与 ArrowDown 使用固定步长并在边界处 clamp", () => {
    const containerHeight = 600;
    const maxUpperHeight = containerHeight - layout.PPT_WORKSPACE_SPLITTER_SIZE - layout.PPT_WORKSPACE_LOWER_MIN_HEIGHT;

    assert.equal(layout.resizePptWorkspaceByKey(300, "ArrowUp", containerHeight), 300 - layout.PPT_WORKSPACE_SPLITTER_KEY_STEP);
    assert.equal(layout.resizePptWorkspaceByKey(300, "ArrowDown", containerHeight), 300 + layout.PPT_WORKSPACE_SPLITTER_KEY_STEP);
    assert.equal(layout.resizePptWorkspaceByKey(layout.PPT_WORKSPACE_UPPER_MIN_HEIGHT, "ArrowUp", containerHeight), layout.PPT_WORKSPACE_UPPER_MIN_HEIGHT);
    assert.equal(layout.resizePptWorkspaceByKey(maxUpperHeight, "ArrowDown", containerHeight), maxUpperHeight);
});

test("高度不足时 clamp 仍返回有限的上区最小高度", () => {
    assert.equal(layout.clampPptWorkspaceUpperHeight(Number.NaN, 120), layout.PPT_WORKSPACE_UPPER_MIN_HEIGHT);
    assert.equal(layout.resizePptWorkspaceByDrag(Number.NaN, Number.NaN, Number.NaN), layout.PPT_WORKSPACE_UPPER_MIN_HEIGHT);
});
