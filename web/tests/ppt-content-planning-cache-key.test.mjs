import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

/**
 * SHA-35 回归修复：内容方案缓存 key 不应包含 title。
 *
 * 复现过的问题：usePptContentPlanning 的 inputKey 曾把 title 也纳入
 * createPptContentInputKey 的计算参数，导致「生成内容方案后修改 PPT 名称」
 * 会切换到一个从未写入过的缓存槽，界面误判为「尚未生成」，已生成的草稿从
 * 界面消失。修复后 title 只留在请求 input 里（重新生成时仍会传给模型），
 * 不参与缓存 key；只有材料或要求变化才需要新草稿。
 */

let createPptContentInputKey;
let vite;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ createPptContentInputKey } = await vite.ssrLoadModule("/src/pages/ppt/use-ppt-content-planning.ts"));
});

after(async () => {
    await vite?.close();
});

test("SHA-35：title 不同但 sourceMaterial/requirements 相同时缓存 key 相同", () => {
    const base = { sourceMaterial: "同一份材料正文", requirements: "9 页以内" };
    const keyEmptyTitle = createPptContentInputKey({ ...base, title: "" });
    const keyWithTitle = createPptContentInputKey({ ...base, title: "生成后新起的标题" });
    assert.equal(keyEmptyTitle, keyWithTitle);
});

test("sourceMaterial 或 requirements 变化时缓存 key 仍然不同", () => {
    const keyA = createPptContentInputKey({ title: "同一个标题", sourceMaterial: "材料 A", requirements: "要求" });
    const keyB = createPptContentInputKey({ title: "同一个标题", sourceMaterial: "材料 B", requirements: "要求" });
    const keyC = createPptContentInputKey({ title: "同一个标题", sourceMaterial: "材料 A", requirements: "不同要求" });
    assert.notEqual(keyA, keyB);
    assert.notEqual(keyA, keyC);
});
