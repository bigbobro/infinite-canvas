import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let deckBuilder;
let styleContract;
let vite;
let workspaceStyle;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    [deckBuilder, styleContract, workspaceStyle] = await Promise.all([vite.ssrLoadModule("/src/lib/ppt/deck-builder.ts"), vite.ssrLoadModule("/src/lib/ppt/style-contract.ts"), vite.ssrLoadModule("/src/components/canvas/ppt-workspace-style.ts")]);
});

after(async () => {
    await vite?.close();
});

test("工作台摘要直接投影 Contract 的色板、氛围密度和全局外壳", () => {
    const contract = styleContract.createPptVisualDirectionPresetContract("brand-led");
    const summary = workspaceStyle.getPptWorkspaceStyleSummary(contract);

    assert.deepEqual(summary.palette, ["#0B1020", "#15213B", "#4F7CFF", "#38D6C5", "#F8FAFC"]);
    assert.equal(summary.moodAndDensity, "鲜明 / 现代 / 品牌化 · 均衡");
    assert.equal(summary.shell, "标题左上 · 页眉显示整套标题 · 页脚显示标题和页码");
});

test("工作台构图检查忽略默认编译指令，保留功能编码并定位整套风格覆盖", () => {
    assert.deepEqual(workspaceStyle.findPptWorkspaceLayoutStyleOverrides(deckBuilder.PPT_PAGE_PROMPT), []);

    const overrides = workspaceStyle.findPptWorkspaceLayoutStyleOverrides("左右双栏；颜色区分优劣；深蓝背景；页脚固定显示页码");
    assert.deepEqual(
        overrides.map((item) => item.fragment),
        ["深蓝背景", "页脚固定显示页码"],
    );

    const combined = `${deckBuilder.PPT_PAGE_PROMPT}\n左右双栏使用深蓝背景`;
    assert.deepEqual(
        workspaceStyle.findPptWorkspaceLayoutStyleOverrides(combined).map((item) => item.fragment),
        ["左右双栏使用深蓝背景"],
    );
    assert.equal(workspaceStyle.restorePptWorkspaceLayout(combined), "左右双栏");
    assert.equal(workspaceStyle.restorePptWorkspaceLayout("左右双栏；深蓝背景"), "左右双栏");
    assert.deepEqual(workspaceStyle.previewPptWorkspaceLayoutRestore("左图右文采用定制字体"), { safe: true, value: "左图右文" });
    assert.deepEqual(workspaceStyle.previewPptWorkspaceLayoutRestore("左图右文使用微软雅黑字体"), { safe: false });
    assert.deepEqual(workspaceStyle.previewPptWorkspaceLayoutRestore("对比表使用微软雅黑字体"), { safe: false });
});
