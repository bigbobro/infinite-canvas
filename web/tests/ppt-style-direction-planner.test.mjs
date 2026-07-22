import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let buildPptStyleDirectionMessages;
let compilePptStyleContract;
let createPptStyleFallbackCandidates;
let createPptVisualDirectionPresetContract;
let isPptStyleDirectionCandidateStale;
let parsePptStyleDirectionResponse;
let requestPptStyleDirections;
let vite;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ buildPptStyleDirectionMessages, createPptStyleFallbackCandidates, isPptStyleDirectionCandidateStale, parsePptStyleDirectionResponse, requestPptStyleDirections } = await vite.ssrLoadModule("/src/lib/ppt/style-direction-planner.ts"));
    ({ compilePptStyleContract, createPptVisualDirectionPresetContract } = await vite.ssrLoadModule("/src/lib/ppt/style-contract.ts"));
});

after(async () => {
    await vite?.close();
});

test("中转站视觉推荐一次文本调用返回三个完整候选，并重建稳定客户端身份", async () => {
    const input = transitStationInput();
    const raw = candidateEnvelope();
    const calls = [];
    const controller = new AbortController();
    const candidates = await requestPptStyleDirections({ model: "image-model", textModel: "text-model", baseUrl: "https://example.test", apiFormat: "openai" }, input, () => undefined, {
        signal: controller.signal,
        requester: async (config, messages, _onDelta, options) => {
            calls.push({ config, messages, options });
            return raw;
        },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].config.model, "text-model");
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(candidates.length, 3);
    assert.equal(candidates.filter((candidate) => candidate.recommended).length, 1);
    assert.deepEqual(
        candidates.map((candidate) => candidate.basedOnContentRevision),
        ["transit:r4", "transit:r4", "transit:r4"],
    );
    assert.ok(candidates.every((candidate) => candidate.id.startsWith("style-generated-")));
    assert.ok(candidates.every((candidate) => candidate.contract.source.kind === "generated" && candidate.contract.source.candidateId === candidate.id));
    assert.ok(candidates.every((candidate) => !candidate.id.includes("model-id")));
    assert.ok(candidates.every((candidate) => compilePptStyleContract(candidate.contract).ok));
    assert.deepEqual(
        parsePptStyleDirectionResponse(raw, input).map((candidate) => candidate.id),
        candidates.map((candidate) => candidate.id),
    );
    assert.match(candidates[0].rationale, /技术可信度/);
    assert.match(candidates[1].rationale, /合作伙伴/);
    assert.match(candidates[2].rationale, /Pitching/);
});

test("推荐请求只发送参考图存在性，不把本地 storageKey 或图片数据交给文本模型", () => {
    const messages = buildPptStyleDirectionMessages(transitStationInput());
    const userInput = JSON.parse(messages[1].content);
    assert.deepEqual(userInput.references, { present: true, count: 2 });
    assert.doesNotMatch(messages[1].content, /private-image-key|another-local-key/);
    assert.match(messages[1].content, /合作伙伴招募/);
    assert.deepEqual(
        userInput.pages.map((page) => [page.contentForm, page.layoutRole]),
        [
            ["cover", "cover"],
            ["comparison", "comparison"],
            ["architecture", "content"],
        ],
    );
});

test("严格解析拒绝非三个候选、代码块和不完整 Contract，且不会自动重试", async () => {
    const input = transitStationInput();
    const twoCandidates = JSON.parse(candidateEnvelope());
    twoCandidates.candidates.pop();
    assert.throws(() => parsePptStyleDirectionResponse(JSON.stringify(twoCandidates), input), /完整返回 3 个候选/);
    assert.throws(() => parsePptStyleDirectionResponse(`\`\`\`json\n${candidateEnvelope()}\n\`\`\``, input), /不是严格 JSON/);

    const incomplete = JSON.parse(candidateEnvelope());
    delete incomplete.candidates[1].contract.modelStyle.palette;
    assert.throws(() => parsePptStyleDirectionResponse(JSON.stringify(incomplete), input), /Contract 无效/);

    let calls = 0;
    await assert.rejects(
        requestPptStyleDirections({ model: "image", textModel: "text" }, input, () => undefined, {
            requester: async () => {
                calls += 1;
                return "not-json";
            },
        }),
        /不是严格 JSON/,
    );
    assert.equal(calls, 1);
});

test("解析失败时三个零调用通用方向仍各自提供完整、贴合当前 deck 的 Contract", () => {
    const input = transitStationInput();
    assert.throws(() => parsePptStyleDirectionResponse("bad response", input), /不是严格 JSON/);
    const fallback = createPptStyleFallbackCandidates(input);

    assert.equal(fallback.length, 3);
    assert.equal(fallback.filter((candidate) => candidate.recommended).length, 1);
    assert.deepEqual(
        fallback.map((candidate) => candidate.contract.source.kind),
        ["preset", "preset", "preset"],
    );
    assert.ok(fallback.every((candidate) => compilePptStyleContract(candidate.contract).ok));
    assert.ok(fallback.every((candidate) => candidate.rationale.includes("中转站") || candidate.rationale.includes("大模型 API 中转站")));
    assert.match(fallback[0].rationale, /技术可信度/);
    assert.match(fallback[1].rationale, /Pitching/);
    assert.match(fallback[2].rationale, /伙伴招募/);
});

test("AbortSignal 透传给单次请求，取消后没有第二次调用", async () => {
    const controller = new AbortController();
    let calls = 0;
    const request = requestPptStyleDirections({ model: "image", textModel: "text" }, transitStationInput(), () => undefined, {
        signal: controller.signal,
        requester: async (_config, _messages, _onDelta, options) => {
            calls += 1;
            return await new Promise((resolve, reject) => {
                options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
            });
        },
    });
    controller.abort();

    await assert.rejects(request, (error) => error.name === "AbortError");
    assert.equal(calls, 1);
});

test("候选显式记录内容版本，内容变化后可在零调用下判定 stale", () => {
    const candidate = parsePptStyleDirectionResponse(candidateEnvelope(), transitStationInput())[0];
    assert.equal(isPptStyleDirectionCandidateStale(candidate, "transit:r4"), false);
    assert.equal(isPptStyleDirectionCandidateStale(candidate, "transit:r5"), true);
});

function candidateEnvelope() {
    const definitions = [
        {
            presetId: "clean-report",
            label: "技术可信的决策报告",
            rationale: "用稳定架构图和证据层级建立技术可信度，同时让合作投入可审查。",
            recommended: true,
        },
        {
            presetId: "visual-story",
            label: "伙伴共建叙事",
            rationale: "从问题、方案到回报推进合作伙伴招募，让参与方式更容易理解。",
            recommended: false,
        },
        {
            presetId: "brand-led",
            label: "未来平台 Pitch",
            rationale: "强化统一识别和未来增长想象，适合 Pitching 及后续发展空间展示。",
            recommended: false,
        },
    ];
    return JSON.stringify({
        candidates: definitions.map((definition, index) => ({
            label: definition.label,
            rationale: definition.rationale,
            recommended: definition.recommended,
            contract: {
                ...createPptVisualDirectionPresetContract(definition.presetId),
                source: { kind: "generated", candidateId: `model-id-${index + 1}` },
            },
        })),
    });
}

function transitStationInput() {
    return {
        brief: {
            title: "LLM 中转站介绍",
            audience: "潜在合作伙伴与准备搭建中转站的决策者",
            goal: "梳理技术选型、招募合作伙伴并用于未来规划与 Pitching",
            narrative: "从大模型 API 中转站的选型与架构，讲到投入、运维和发展空间",
            visualSignals: ["技术可信", "合作伙伴招募", "未来平台感"],
        },
        contentRevision: "transit:r4",
        referenceKeys: ["private-image-key", "another-local-key"],
        pageSpecs: [
            pageSpec("page-1", "说明要建设什么以及为什么值得参与", "cover", "cover", []),
            pageSpec("page-2", "比较 Sub2API、CPA 与 New API 的取舍", "comparison", "comparison", [{ id: "encoding-1", contentBlockIds: [], intent: "differentiate", channel: "color" }]),
            pageSpec("page-3", "展示接入、路由、安全和运维模块", "architecture", "content", [{ id: "encoding-2", contentBlockIds: [], intent: "show_relationship", channel: "line" }]),
        ],
    };
}

function pageSpec(pageId, purpose, contentForm, layoutRole, visualEncoding) {
    return {
        pageId,
        version: 1,
        purpose,
        contentForm,
        sourceRefs: [],
        contentBlocks: [],
        contentState: { status: "approved", approvedAt: "2026-07-22T00:00:00.000Z" },
        lockedFacts: [],
        layoutRole,
        layoutIntent: [],
        visualEncoding,
        assetRefs: [],
        freedom: "只在已批准内容内组织信息",
    };
}
