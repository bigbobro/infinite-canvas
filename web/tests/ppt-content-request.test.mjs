import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let buildPptContentPlanMessages;
let buildPptContentPageRegenerationMessages;
let buildPptPageRewriteMessages;
let parsePptContentPlanResponse;
let previewPptContentPlanStream;
let requestImageQuestion;
let requestPptContentPageRegeneration;
let requestPptContentPlan;
let requirePptPageRewriteResult;
let defaultConfig;
let vite;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ buildPptContentPageRegenerationMessages, buildPptContentPlanMessages, buildPptPageRewriteMessages, parsePptContentPlanResponse, previewPptContentPlanStream, requestPptContentPageRegeneration, requestPptContentPlan, requirePptPageRewriteResult } =
        await vite.ssrLoadModule("/src/services/api/ppt-content.ts"));
    ({ requestImageQuestion } = await vite.ssrLoadModule("/src/services/api/image.ts"));
    ({ defaultConfig } = await vite.ssrLoadModule("/src/stores/use-config-store.ts"));
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
        return '{"brief":{"title":"中转站"},"pages":[{"title":"中转站介绍"}]}';
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

test("内容方案请求可恢复模型返回的常见 JSON 瑕疵", async () => {
    let callCount = 0;
    const result = await requestPptContentPlan({ model: "image", textModel: "text" }, { title: "中转站", sourceMaterial: "材料", requirements: "" }, () => {}, {
        requester: async () => {
            callCount++;
            return '{"brief":{"title":"中转站"},"pages":[{"title":"中转站介绍"},],}';
        },
    });

    assert.equal(callCount, 1);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].title, "中转站介绍");
});

test("内容方案解析优先使用 fenced JSON，不被前置说明中的大括号干扰", () => {
    const result = parsePptContentPlanResponse('下面是内容方案（字段为 {brief,pages}）：\n```json\n{"brief":{},"pages":[{"title":"中转站介绍"}]}\n```');
    assert.equal(result.pages[0].title, "中转站介绍");
});

test("内容方案解析可修复字符串内裸换行，并选择最后一个方案对象", () => {
    const result = parsePptContentPlanResponse('思考摘要：{"step":"draft"}\n{"brief":{},"pages":[{"title":"中转\n站介绍"}]}');
    assert.equal(result.pages[0].title, "中转\n站介绍");
});

test("内容方案流式预览只投影严格闭合的直接页面对象", () => {
    const firstPage = {
        title: "中转站介绍",
        purpose: "说明建设范围",
        primaryClaim: "先讲清范围，再进入选型",
        blocks: [{ key: "scope", kind: "body", text: '字符串内的 } 与 \\" 不影响对象边界' }],
        gaps: [{ key: "detail", question: "待确认？", reason: "材料不足" }],
    };
    const secondPage = {
        title: "组件选型",
        purpose: "对比候选方案",
        primaryClaim: "按接入、容量、安全和成本比较",
        blocks: [
            { key: "access", kind: "body", text: "协议兼容" },
            { key: "cost", kind: "body", text: "成本结构" },
        ],
    };
    const full = JSON.stringify({ brief: { title: "中转站介绍", audience: "合作伙伴" }, pages: [firstPage, secondPage] });
    const secondStart = full.indexOf(JSON.stringify(secondPage));
    const partial = full.slice(0, secondStart + JSON.stringify(secondPage).indexOf("按接入") + 2);
    const progress = previewPptContentPlanStream(partial);

    assert.deepEqual(progress, {
        completedPages: [{ ordinal: 1, title: "中转站介绍", primaryClaim: "先讲清范围，再进入选型", blockCount: 1 }],
        pendingPageOrdinal: 2,
    });
    assert.deepEqual(previewPptContentPlanStream(full), {
        completedPages: [
            { ordinal: 1, title: "中转站介绍", primaryClaim: "先讲清范围，再进入选型", blockCount: 1 },
            { ordinal: 2, title: "组件选型", primaryClaim: "按接入、容量、安全和成本比较", blockCount: 2 },
        ],
    });
});

test("内容方案流式预览不修复非法页，也不把 brief、blocks 或 gaps 当页面", () => {
    const repairOnly = '{"brief":{},"pages":[{"title":"待修复页","purpose":"说明",},';
    assert.deepEqual(previewPptContentPlanStream(repairOnly), { completedPages: [] });

    const nestedOnly = JSON.stringify({ brief: { title: "整套标题", goal: "说明项目" }, pages: [{ blocks: [{ title: "伪页面", purpose: "嵌套块" }], gaps: [{ title: "伪缺口", purpose: "嵌套缺口" }] }] });
    assert.deepEqual(previewPptContentPlanStream(nestedOnly), { completedPages: [] });

    const siblingArray = JSON.stringify({
        brief: {},
        diagnostics: [{ title: "伪页面", purpose: "仅用于调试" }],
        pages: [{ title: "正式页面", purpose: "正式内容", primaryClaim: "只预览 pages 数组" }],
    });
    assert.deepEqual(previewPptContentPlanStream(siblingArray), {
        completedPages: [{ ordinal: 1, title: "正式页面", primaryClaim: "只预览 pages 数组", blockCount: 0 }],
    });
});

test("内容方案解析拒绝把被截断的 JSON 修补成半份 PPT", () => {
    assert.throws(() => parsePptContentPlanResponse('{"brief":{},"pages":[{"title":"中转站介绍"}'), /返回不完整/);
});

test("更晚开始的截断方案不会回退到前一个完整对象", () => {
    const response = '{"brief":{},"pages":[{"title":"旧方案"}]}\n{"brief":{},"pages":[{"title":"新方案"}';
    assert.throws(() => parsePptContentPlanResponse(response), /返回不完整/);
});

test("未闭合外层 JSON 中的完整嵌套方案不会被当成完整返回", () => {
    const candidate = '{"brief":{},"pages":[{"title":"仅完成第一页"}]}';
    for (const response of [`{"analysis":{"candidate":${candidate}`, `{'analysis':{'candidate':${candidate}`, `{analysis:{candidate:${candidate}`, `{"analysis":"draft",,"candidate":${candidate}`]) {
        assert.throws(() => parsePptContentPlanResponse(response), /返回不完整/);
    }
    assert.throws(() => parsePptContentPlanResponse(`[${candidate}`), /返回不完整/);
    assert.equal(parsePptContentPlanResponse(`[${candidate}]`).pages[0].title, "仅完成第一页");
});

test("弱尾部 metadata 不会覆盖完整方案或单页 envelope", () => {
    const plan = parsePptContentPlanResponse('{"brief":{},"pages":[{"title":"正式方案"}]}\n{"title":"debug metadata"}');
    assert.equal(plan.pages[0].title, "正式方案");

    const page = parsePptContentPlanResponse('{"page":{"title":"正式页面"}}\n{"blocks":[]}\n{"title":"debug metadata"}', "page");
    assert.equal(page.page.title, "正式页面");
});

test("解析可跨过未闭合的前置字段说明重新同步", () => {
    const result = parsePptContentPlanResponse('schema {brief,pages\n{"brief":{},"pages":[{"title":"正式方案"}]}');
    assert.equal(result.pages[0].title, "正式方案");
});

test("单页裸对象必须同时有标题和实质内容", () => {
    assert.throws(() => parsePptContentPlanResponse('{"title":"debug metadata"}', "page"), /解析失败/);
    assert.equal(parsePptContentPlanResponse('{"title":"中转站介绍","primaryClaim":"说清建设方案"}', "page").title, "中转站介绍");
});

test("OpenAI Responses 输出达到 token 上限时不返回部分内容", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response('data: {"type":"response.output_text.delta","delta":"{\\"brief\\":"}\n\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_tokens"}}}\n\ndata: [DONE]\n\n', {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
        });
    try {
        await assert.rejects(
            requestImageQuestion(textProviderConfig("openai"), [{ role: "user", content: "生成内容方案" }], () => {}),
            /模型返回不完整/,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Gemini 输出达到 token 上限时不返回部分内容", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response('data: {"candidates":[{"content":{"parts":[{"text":"{\\"brief\\":"}]},"finishReason":"MAX_TOKENS"}]}\n\n', {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
        });
    try {
        await assert.rejects(
            requestImageQuestion(textProviderConfig("gemini"), [{ role: "user", content: "生成内容方案" }], () => {}),
            /模型返回不完整/,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("文本流缺少供应商终态信号时不返回已累计的部分内容", async () => {
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () =>
            new Response('data: {"type":"response.output_text.delta","delta":"{\\"brief\\":{},\\"pages\\":[{\\"title\\":\\"仅完成第一页\\"}]}"}\n\ndata: [DONE]\n\n', {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        await assert.rejects(
            requestImageQuestion(textProviderConfig("openai"), [{ role: "user", content: "生成内容方案" }], () => {}),
            /模型返回不完整/,
        );

        globalThis.fetch = async () =>
            new Response('data: {"candidates":[{"content":{"parts":[{"text":"{\\"brief\\":{},\\"pages\\":[{\\"title\\":\\"仅完成第一页\\"}]}"}]}}]}\n\n', {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        await assert.rejects(
            requestImageQuestion(textProviderConfig("gemini"), [{ role: "user", content: "生成内容方案" }], () => {}),
            /模型返回不完整/,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("文本渠道正常结束时不被不完整门禁误拦", async () => {
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () =>
            new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output_text":"ok"}}\n\ndata: [DONE]\n\n', {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        assert.equal(await requestImageQuestion(textProviderConfig("openai"), [{ role: "user", content: "测试" }], () => {}), "ok");

        globalThis.fetch = async () =>
            new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n', {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        assert.equal(await requestImageQuestion(textProviderConfig("gemini"), [{ role: "user", content: "测试" }], () => {}), "ok");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("内容方案 prompt 不要求模型生成稳定 ID、action 或 lockedFacts", () => {
    const messages = buildPptContentPlanMessages({ title: "中转站", sourceMaterial: "材料", requirements: "" });
    assert.match(messages[0].content, /contentKeys 必须引用本页 blocks/);
    assert.match(messages[0].content, /gapKey/);
    assert.match(messages[0].content, /不依赖用户私有信息[^\n]*proposedAnswer[^\n]*(?:必须|务必)/);
    assert.match(messages[0].content, /不得只(?:写|输出)[^\n]*(?:待补充|请补充|这里介绍)/);
    assert.doesNotMatch(messages[0].content, /"pageId"|"actionId"|"lockedFacts"/);
    assert.deepEqual(parsePptContentPlanResponse('```json\n{"brief":{},"pages":[]}\n```'), { brief: {}, pages: [] });
});

test("SHA-26：内容方案 prompt 要求 source.relation 声明 verbatim 或 derived", () => {
    const messages = buildPptContentPlanMessages({ title: "中转站", sourceMaterial: "材料", requirements: "" });
    const systemPrompt = messages[0].content;
    assert.match(systemPrompt, /"relation":"verbatim"/);
    assert.match(systemPrompt, /"relation":"derived"/);
    assert.match(systemPrompt, /relation[^\n]*verbatim[^\n]*derived|verbatim[^\n]*derived/);
    assert.match(systemPrompt, /不得引入引用行中不存在的数字、大写术语/);
    assert.match(systemPrompt, /brief\.audience\/goal\/narrative[^\n]*归纳/);
});

test("内容方案 prompt 先分离 Deck Brief 与上屏正文，再规划最少的非重复页面", () => {
    const messages = buildPptContentPlanMessages({
        title: "PPT 工作台介绍",
        sourceMaterial: "我想做一份介绍 PPT 工作台的材料\n这份材料要让第一次接触的人明确理解四件事",
        requirements: "最多 9 页\n希望回答为什么需要使用 PPT 工作台",
    });
    const systemPrompt = messages[0].content;

    assert.match(systemPrompt, /Deck Brief/);
    assert.match(systemPrompt, /创作意图[^\n]*观众可见正文/);
    assert.match(systemPrompt, /我想做一份[^\n]*这份材料要让[^\n]*希望回答/);
    assert.match(systemPrompt, /第一页[^\n]*contentForm[^\n]*cover/);
    assert.match(systemPrompt, /封面[^\n]*blocks[^\n]*为空/);
    assert.match(systemPrompt, /先规划整套叙事[^\n]*最少/);
    assert.match(systemPrompt, /不按[^\n]*段落[^\n]*拆页/);
    assert.match(systemPrompt, /最多 N 页[^\n]*N 页以内/);
    assert.match(systemPrompt, /没有明确页数[^\n]*固定上限/);
    assert.match(messages[1].content, /补充要求（行号\|原文）：\n1\|最多 9 页\n2\|希望回答/);
});

test("页面 AI 改写返回 slide-ready 内容块与定向信息表达", () => {
    const messages = buildPptPageRewriteMessages("中转站介绍\n核心判断\n很长的正文", "重新改写本页");
    assert.match(messages[0].content, /只返回 JSON/);
    assert.match(messages[0].content, /title.*primaryClaim.*contentForm.*blocks.*visualEncoding/s);
    assert.match(messages[0].content, /contentKeys/);
    assert.match(messages[0].content, /不是文章|禁止连续长段落/);
    assert.match(messages[0].content, /不重复整套 PPT 名称/);
    assert.match(messages[1].content, /当前页面规格：/);
    assert.match(messages[1].content, /修改要求：/);
    assert.match(messages[1].content, /重新改写本页/);

    const valid = JSON.stringify({
        title: "LLM 中转站选型",
        primaryClaim: "选型需平衡接入、运行、安全与成本",
        contentForm: "comparison",
        blocks: [
            { key: "access", kind: "body", text: "模型接入：明确服务商与协议兼容性" },
            { key: "routing", kind: "body", text: "容量与路由：评估并发、吞吐和故障切换" },
        ],
        visualEncoding: [{ contentKeys: ["access", "routing"], intent: "group", channel: "shape" }],
    });
    const result = requirePptPageRewriteResult(valid);
    assert.equal(result.canonicalText, "LLM 中转站选型\n选型需平衡接入、运行、安全与成本\n模型接入：明确服务商与协议兼容性\n容量与路由：评估并发、吞吐和故障切换");
    assert.equal(result.contentForm, "comparison");
    assert.deepEqual(result.visualEncoding[0].contentKeys, ["access", "routing"]);

    const dense = JSON.stringify({
        ...JSON.parse(valid),
        blocks: [
            { key: "body", kind: "body", text: "长".repeat(101) },
            { key: "support", kind: "body", text: "支持信息" },
        ],
        visualEncoding: [{ contentKeys: ["body", "support"], intent: "group", channel: "shape" }],
    });
    assert.throws(() => requirePptPageRewriteResult(dense), /仍不适合单页展示/);
    const invalidEncoding = JSON.stringify({ ...JSON.parse(valid), visualEncoding: [{ contentKeys: ["missing"], intent: "group", channel: "shape" }] });
    assert.throws(() => requirePptPageRewriteResult(invalidEncoding), /信息表达引用了不存在的内容块/);
    const emptyComparison = JSON.stringify({ ...JSON.parse(valid), blocks: [], visualEncoding: [] });
    assert.throws(() => requirePptPageRewriteResult(emptyComparison), /至少需要 2 个内容块/);
    assert.throws(() => requirePptPageRewriteResult("```\n{}\n```"), /不应包含代码块/);
});

test("完整内容方案缺少非空 pages 时在 adapter 边界失败且不重试", async () => {
    let callCount = 0;
    await assert.rejects(
        requestPptContentPlan({ model: "image", textModel: "text" }, { title: "中转站", sourceMaterial: "材料", requirements: "" }, () => {}, {
            requester: async () => {
                callCount++;
                return '{"brief":{},"pages":[]}';
            },
        }),
        /缺少页面内容/,
    );
    assert.equal(callCount, 1);
});

test("单页重新生成只发起一次请求，并锁定其他页", async () => {
    const input = {
        title: "中转站",
        sourceMaterial: "第一行\n第二行",
        requirements: "",
        draftRevision: 4,
        targetPageNumber: 2,
        targetPage: { title: "组件对比", purpose: "说清选型", primaryClaim: "候选项待确认", contentBlocks: [{ kind: "list", text: "需要对比维度" }] },
        authoringInstructions: ["我希望你来给我按照我的内容来去给这个建议"],
        confirmedInputs: [
            { source: "user_answer", kind: "list", text: "优先考虑低运维成本" },
            { source: "confirmed_assumption", kind: "supporting_claim", text: "先比较托管与自建两类方案" },
        ],
        unresolvedGaps: [{ question: "候选组件有哪些？", reason: "材料没有具体候选项", proposedAnswer: "CPA 与 SUB2API" }],
        auditIssues: [
            {
                code: "authoring_instruction_as_copy",
                field: "primaryClaim",
                value: "我想做一份中转站介绍材料",
                message: "核心信息包含创作意图，不应作为观众可见正文",
            },
        ],
        otherPageTitles: ["封面", "架构方案"],
    };
    const messages = buildPptContentPageRegenerationMessages(input);
    assert.match(messages[0].content, /pages 必须且只能返回 1 页/);
    assert.match(messages[0].content, /整套第 2 页[^\n]*不得使用 cover/);
    assert.match(messages[0].content, /唯一返回页[^\n]*整套第一页/);
    assert.match(messages[1].content, /当前内容版本：4/);
    assert.match(messages[1].content, /只重新生成第 2 页/);
    assert.match(messages[1].content, /候选组件有哪些/);
    assert.match(messages[1].content, /用户希望 AI 执行的创作指令/);
    assert.match(messages[1].content, /我希望你来给我按照我的内容来去给这个建议/);
    assert.match(messages[1].content, /user_answer/);
    assert.match(messages[0].content, /text 与 kind 都必须原样保留/);
    assert.match(messages[1].content, /"kind":"list"/);
    assert.match(messages[1].content, /优先考虑低运维成本/);
    assert.match(messages[0].content, /逐项消除[^\n]*审核问题/);
    assert.match(messages[1].content, /本页必须修复的审核问题/);
    assert.match(messages[1].content, /"code":"authoring_instruction_as_copy"/);
    assert.match(messages[1].content, /"field":"primaryClaim"/);
    assert.match(messages[1].content, /"value":"我想做一份中转站介绍材料"/);
    assert.match(messages[1].content, /核心信息包含创作意图/);
    assert.match(messages[1].content, /其他页标题已锁定/);
    assert.match(messages[1].content, /1\. 封面\n2\. 架构方案/);

    let callCount = 0;
    const result = await requestPptContentPageRegeneration({ model: "image", textModel: "text" }, input, () => {}, {
        requester: async (config) => {
            callCount++;
            assert.equal(config.model, "text");
            return '{"brief":{},"page":{"title":"组件对比"}}';
        },
    });
    assert.equal(callCount, 1);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].title, "组件对比");
});

test("单页重新生成兼容裸页面，并拒绝空页或多页响应", async () => {
    const input = {
        title: "中转站",
        sourceMaterial: "材料",
        requirements: "",
        draftRevision: 1,
        targetPageNumber: 1,
        targetPage: { title: "中转站介绍", purpose: "说明项目", primaryClaim: "讲清建设方案", contentBlocks: [] },
        authoringInstructions: [],
        confirmedInputs: [],
        unresolvedGaps: [],
        auditIssues: [],
        otherPageTitles: [],
    };
    const coverMessages = buildPptContentPageRegenerationMessages(input);
    assert.match(coverMessages[0].content, /整套第 1 页[^\n]*必须使用 cover/);
    const request = (response) => requestPptContentPageRegeneration({ model: "image", textModel: "text" }, input, () => {}, { requester: async () => response });

    const bare = await request('{"title":"中转站介绍","purpose":"说明项目","primaryClaim":"给出建设建议"}');
    assert.equal(bare.pages.length, 1);
    await assert.rejects(request('{"brief":{},"pages":[]}'), /本页生成结果缺少页面内容/);
    await assert.rejects(request('{"page":{}}'), /本页生成结果缺少页面内容/);
    await assert.rejects(request('{"brief":{},"pages":[{"title":"一"},{"title":"二"}]}'), /只能包含一个页面/);
});

function textProviderConfig(apiFormat) {
    const model = "test::text-model";
    return {
        ...defaultConfig,
        apiFormat,
        baseUrl: "https://example.test",
        apiKey: "test-key",
        channels: [{ id: "test", name: "测试渠道", baseUrl: "https://example.test", apiKey: "test-key", apiFormat, models: [{ name: "text-model", capability: "text" }] }],
        models: [model],
        model,
        textModel: model,
    };
}
