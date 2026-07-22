import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let buildPptContentPlanMessages;
let buildPptContentPageRegenerationMessages;
let parsePptContentPlanResponse;
let requestPptContentPageRegeneration;
let requestPptContentPlan;
let vite;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ buildPptContentPageRegenerationMessages, buildPptContentPlanMessages, parsePptContentPlanResponse, requestPptContentPageRegeneration, requestPptContentPlan } = await vite.ssrLoadModule("/src/services/api/ppt-content.ts"));
});

after(async () => {
    await vite?.close();
});

test("内容方案请求只调用一次文本模型并透传取消信号", async () => {
    const controller = new AbortController();
    const calls = [];
    const requester = async (config, messages, onDelta, options) => {
        calls.push({ config, messages, options });
        onDelta('{"brief":');
        return '{"brief":{"title":"中转站"},"pages":[]}';
    };

    const result = await requestPptContentPlan({ model: "image-model", textModel: "text-model" }, { title: "中转站", sourceMaterial: "第一行\n第二行", requirements: "面向合作伙伴" }, () => {}, { signal: controller.signal, requester });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].config.model, "text-model");
    assert.equal(calls[0].options.signal, controller.signal);
    assert.match(calls[0].messages[1].content, /1\|第一行\n2\|第二行/);
    assert.match(calls[0].messages[1].content, /补充要求（行号\|原文）：\n1\|面向合作伙伴/);
    assert.equal(result.brief.title, "中转站");
});

test("内容方案解析失败不会自动重试", async () => {
    let callCount = 0;
    await assert.rejects(
        requestPptContentPlan({ model: "image-model", textModel: "text-model" }, { title: "中转站", sourceMaterial: "材料", requirements: "" }, () => {}, {
            requester: async () => {
                callCount++;
                return "not json";
            },
        }),
        /不是有效的 JSON/,
    );
    assert.equal(callCount, 1);
});

test("内容方案 prompt 不要求模型生成稳定 ID、action 或 lockedFacts", () => {
    const messages = buildPptContentPlanMessages({ title: "中转站", sourceMaterial: "材料", requirements: "" });
    assert.match(messages[0].content, /contentKeys 必须引用本页 blocks/);
    assert.doesNotMatch(messages[0].content, /"pageId"|"actionId"|"lockedFacts"/);
    assert.deepEqual(parsePptContentPlanResponse('```json\n{"brief":{},"pages":[]}\n```'), { brief: {}, pages: [] });
});

test("单页重新生成只发起一次请求，并锁定其他页", async () => {
    const input = {
        title: "中转站",
        sourceMaterial: "第一行\n第二行",
        requirements: "",
        draftRevision: 4,
        targetPageNumber: 2,
        targetPage: { title: "组件对比", purpose: "说清选型", primaryClaim: "候选项待确认", contentBlocks: ["需要对比维度"] },
        unresolvedGaps: [{ question: "候选组件有哪些？", reason: "材料没有具体候选项", proposedAnswer: "CPA 与 SUB2API" }],
        otherPageTitles: ["封面", "架构方案"],
    };
    const messages = buildPptContentPageRegenerationMessages(input);
    assert.match(messages[0].content, /pages 必须且只能返回 1 页/);
    assert.match(messages[1].content, /当前内容版本：4/);
    assert.match(messages[1].content, /只重新生成第 2 页/);
    assert.match(messages[1].content, /候选组件有哪些/);
    assert.match(messages[1].content, /其他页标题已锁定/);
    assert.match(messages[1].content, /1\. 封面\n2\. 架构方案/);

    let callCount = 0;
    const result = await requestPptContentPageRegeneration({ model: "image", textModel: "text" }, input, () => {}, {
        requester: async (config) => {
            callCount++;
            assert.equal(config.model, "text");
            return '{"brief":{},"pages":[{"title":"组件对比"}]}';
        },
    });
    assert.equal(callCount, 1);
    assert.equal(result.pages.length, 1);
});
