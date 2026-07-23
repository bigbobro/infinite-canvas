import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let vite;
let buildAnnotatePrompt;
let compileCandidateEdit;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ buildAnnotatePrompt, compileCandidateEdit } = await vite.ssrLoadModule("/src/lib/canvas/annotate-prompt.ts"));
});

after(async () => {
    await vite?.close();
});

test("仅整页要求可编译，不加入任何点位标记话术", () => {
    const result = compileCandidateEdit("base-1", "  将整页背景改为深蓝渐变  ", []);

    assert.deepEqual(result, {
        baseNodeId: "base-1",
        globalInstruction: "将整页背景改为深蓝渐变",
        annotations: [],
        finalPrompt: ["请按以下整页要求修改这张图：", "将整页背景改为深蓝渐变", "未被上述要求触及的其余所有元素、文字、配色、版式完全保持不变。"].join("\n"),
    });
    assert.doesNotMatch(result.finalPrompt, /红色|标记|编号|所指/);
});

test("仅点位要求时完整保留每条有效说明并用放置序号编号", () => {
    const pins = [
        { id: "pin-a", x: 0.1, y: 0.2, text: "  标题字号放大  " },
        { id: "pin-empty", x: 0.3, y: 0.4, text: "   " },
        { id: "pin-b", x: 0.8, y: 0.7, text: "删除右下角装饰" },
    ];
    const result = compileCandidateEdit("base-2", "", pins);

    // 放置序号：pin-a=1、空 pin 过滤、pin-b=3；允许编号空洞，不紧凑重排为 1、2。
    assert.deepEqual(result.annotations, [
        { index: 1, x: 0.1, y: 0.2, instruction: "标题字号放大" },
        { index: 3, x: 0.8, y: 0.7, instruction: "删除右下角装饰" },
    ]);
    assert.match(result.finalPrompt, /① 标记所指的对象 → 标题字号放大；/);
    assert.match(result.finalPrompt, /③ 标记所指的对象 → 删除右下角装饰；/);
    assert.doesNotMatch(result.finalPrompt, /②/);
    assert.match(result.finalPrompt, /其余所有元素、文字、配色、版式完全保持不变/);
    assert.match(result.finalPrompt, /【不得保留】这些红色编号标记/);
});

test("中间 pin 空文本时 compileCandidateEdit 输出编号保留空洞且与放置序号一致", () => {
    const pins = [
        { id: "p1", x: 0.1, y: 0.1, text: "改标题" },
        { id: "p2", x: 0.5, y: 0.5, text: "  " },
        { id: "p3", x: 0.9, y: 0.9, text: "去水印" },
    ];
    const result = compileCandidateEdit("base-gap", "", pins);

    assert.deepEqual(result.annotations.map((item) => item.index), [1, 3]);
    assert.equal(result.annotations[0].instruction, "改标题");
    assert.equal(result.annotations[1].instruction, "去水印");
    assert.match(result.finalPrompt, /① 标记所指的对象 → 改标题；/);
    assert.match(result.finalPrompt, /③ 标记所指的对象 → 去水印；/);
    assert.doesNotMatch(result.finalPrompt, /②/);
});

test("整页要求与多点位同时编译，点位优先且其余保持不变", () => {
    const result = compileCandidateEdit("base-3", "所有正文使用更高对比度", [
        { id: "pin-1", x: 0.2, y: 0.3, text: "这里的正文保持浅灰" },
        { id: "pin-2", x: 0.6, y: 0.5, text: "图表改为横向" },
    ]);

    assert.deepEqual(
        result.annotations.map((item) => item.instruction),
        ["这里的正文保持浅灰", "图表改为横向"],
    );
    assert.ok(result.finalPrompt.indexOf("这里的正文保持浅灰") < result.finalPrompt.indexOf("所有正文使用更高对比度"));
    assert.match(result.finalPrompt, /点位要求与整页要求冲突时，以点位要求为准/);
    assert.ok(result.finalPrompt.lastIndexOf("其余所有元素") > result.finalPrompt.indexOf("所有正文使用更高对比度"));
});

test("整页要求和有效点位均为空时不可提交", () => {
    const pins = [{ id: "pin-empty", x: 0.5, y: 0.5, text: " \n " }];

    assert.equal(compileCandidateEdit("base-4", " \t ", pins), null);
    assert.equal(buildAnnotatePrompt(pins), "");
});

test("旧的点位入口与统一编译器使用同一份最终提示词", () => {
    const pins = [{ id: "pin-1", x: 0.25, y: 0.75, text: "替换这个图标" }];

    assert.equal(buildAnnotatePrompt(pins), compileCandidateEdit("", "", pins).finalPrompt);
});
