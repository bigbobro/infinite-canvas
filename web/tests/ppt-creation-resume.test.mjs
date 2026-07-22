import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { createServer } from "vite";

/**
 * SHA-18: durable /ppt creation draft at the services persistence seam.
 *
 * Original RED proof (unchanged production, first diagnosis dispatch): load of
 * `web/src/lib/ppt/creation-draft.ts` failed — wizard progress lived only in
 * React memory until confirmBuild→importProject. See research/grok-diagnosis.md.
 *
 * Coordinator REVISE: I/O lives under services/ (localforage/IndexedDB), tests
 * assert save/load/clear and snapshot semantics — not merely "module exists".
 */

let vite;
let buildPptCreationDraftSnapshot;
let clearPptCreationDraft;
let createEmptyPptCreationDraftSnapshot;
let createPptCreationDraftAutosaveScheduler;
let describePptCreationClearFailure;
let getPptListCreateAction;
let getPptCreationDraftWriteEpoch;
let hasPptCreationDraftProgress;
let loadPptCreationDraft;
let normalizePptCreationDraftSnapshot;
let resetPptCreationDraftMemoryForTests;
let resolvePptCreationDraftAutosaveDecision;
let resolvePptCreationDraftUnmountFlush;
let runPptCreationDraftLeaveSequence;
let savePptCreationDraft;
let setPptCreationDraftStorageForTests;
let nextSuppressMountInterruptedStyle;
let shouldAutoGeneratePptStyleDirections;
let shouldSuppressMountAutoStyleFromSnapshot;
let resolvePptStyleRestoredPageSpecsHydration;
let createPptVisualDirectionPresetContract;

const memory = new Map();

const memoryStorage = {
    getItem: async (key) => memory.get(key) ?? null,
    setItem: async (key, value) => {
        memory.set(key, structuredClone(value));
    },
    removeItem: async (key) => {
        memory.delete(key);
    },
};

function sampleExtractSnapshot(overrides = {}) {
    return buildPptCreationDraftSnapshot({
        mode: "extract",
        step: 1,
        deckTitle: "",
        material: "中转站介绍：梳理思路、招募伙伴并展示未来空间。",
        requirements: "简洁商务",
        pages: [
            { title: "中转站介绍", outline: "梳理思路、招募伙伴", visualHint: "" },
            { title: "未来空间", outline: "展示空间规划", visualHint: "" },
        ],
        extractedDirectionHint: "暖色留白",
        extractGlobalDecision: "include",
        contentDraft: null,
        finalizedContent: null,
        styleContract: null,
        stylePageSpecs: null,
        ...overrides,
    });
}

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({
        buildPptCreationDraftSnapshot,
        clearPptCreationDraft,
        createEmptyPptCreationDraftSnapshot,
        createPptCreationDraftAutosaveScheduler,
        describePptCreationClearFailure,
        getPptListCreateAction,
        getPptCreationDraftWriteEpoch,
        hasPptCreationDraftProgress,
        loadPptCreationDraft,
        normalizePptCreationDraftSnapshot,
        resetPptCreationDraftMemoryForTests,
        resolvePptCreationDraftAutosaveDecision,
        resolvePptCreationDraftUnmountFlush,
        runPptCreationDraftLeaveSequence,
        savePptCreationDraft,
        setPptCreationDraftStorageForTests,
        nextSuppressMountInterruptedStyle,
        shouldAutoGeneratePptStyleDirections,
        shouldSuppressMountAutoStyleFromSnapshot,
    } = await vite.ssrLoadModule("/src/services/ppt-creation-draft.ts"));
    ({ createPptVisualDirectionPresetContract } = await vite.ssrLoadModule("/src/lib/ppt/style-contract.ts"));
    ({ resolvePptStyleRestoredPageSpecsHydration } = await vite.ssrLoadModule("/src/pages/ppt/use-ppt-style-planning.ts"));
});

beforeEach(async () => {
    memory.clear();
    resetPptCreationDraftMemoryForTests();
    setPptCreationDraftStorageForTests(memoryStorage);
    await clearPptCreationDraft();
});

after(async () => {
    setPptCreationDraftStorageForTests(null);
    await vite?.close();
});

test("extract 模式：已生成分页在 save→load 后恢复步骤与材料", async () => {
    const committed = sampleExtractSnapshot();

    await savePptCreationDraft(committed);
    const restored = await loadPptCreationDraft();

    assert.ok(restored);
    assert.equal(restored.mode, "extract");
    assert.equal(restored.step, 1);
    assert.equal(restored.material, committed.material);
    assert.equal(restored.requirements, "简洁商务");
    assert.equal(restored.pages.length, 2);
    assert.equal(restored.pages[0].title, "中转站介绍");
    assert.equal(restored.pages[1].title, "未来空间");
    assert.equal(restored.extractedDirectionHint, "暖色留白");
    assert.equal(restored.extractGlobalDecision, "include");
});

test("outline 模式：contentDraft、finalizedContent、style Contract 与 PageSpecs 往返", async () => {
    const styleContract = createPptVisualDirectionPresetContract("clean-report");
    const pageSpecs = [
        {
            pageId: "page-1",
            version: 1,
            purpose: "封面定位",
            contentForm: "cover",
            sourceRefs: [],
            contentBlocks: [
                { id: "b1", kind: "title", text: "中转站", sourceRefIds: [] },
                { id: "b2", kind: "primary_claim", text: "一句话定位", sourceRefIds: [] },
            ],
            contentState: { status: "approved", approvedAt: "2026-07-23T00:00:00.000Z" },
            lockedFacts: [],
            layoutRole: "cover",
            layoutIntent: [],
            visualEncoding: [],
            assetRefs: [],
            freedom: "",
        },
    ];
    const contentDraft = {
        revision: 2,
        brief: {
            version: 1,
            sourceHash: "hash-1",
            title: "中转站",
            audience: "伙伴",
            goal: "招募",
            narrative: "从方案到投入",
            visualSignals: [],
        },
        pageSpecs,
        audit: { gaps: [], issues: [] },
        constraints: {},
    };
    const finalizedContent = {
        brief: contentDraft.brief,
        pageSpecs,
        contentRevision: "rev-abc",
    };
    const stylePageSpecs = pageSpecs.map((page) => ({ ...page, layoutIntent: ["居中主视觉"] }));

    await savePptCreationDraft(
        buildPptCreationDraftSnapshot({
            mode: "outline",
            step: 2,
            deckTitle: "中转站",
            material: "材料正文",
            requirements: "商务",
            pages: [],
            extractedDirectionHint: "",
            extractGlobalDecision: null,
            contentDraft,
            finalizedContent,
            styleContract,
            stylePageSpecs,
        }),
    );

    const restored = await loadPptCreationDraft();
    assert.ok(restored);
    assert.equal(restored.mode, "outline");
    assert.equal(restored.step, 2);
    assert.equal(restored.contentDraft?.revision, 2);
    assert.equal(restored.contentDraft?.pageSpecs[0].pageId, "page-1");
    assert.equal(restored.finalizedContent?.contentRevision, "rev-abc");
    assert.equal(restored.styleContract?.schemaVersion, 1);
    assert.equal(restored.styleContract?.modelStyle.density, styleContract.modelStyle.density);
    assert.deepEqual(restored.stylePageSpecs?.[0].layoutIntent, ["居中主视觉"]);

    // Restored Contract must suppress auto style requests (zero auto model call).
    assert.equal(
        shouldAutoGeneratePptStyleDirections({
            mode: restored.mode,
            step: restored.step,
            hasFinalizedContent: Boolean(restored.finalizedContent),
            hasStyleContract: Boolean(restored.styleContract),
            recommendationStatus: "idle",
            candidateCount: 0,
        }),
        false,
    );
});

test("clear 后 load 为 null；显式清除模拟重新开始", async () => {
    await savePptCreationDraft(sampleExtractSnapshot({ material: "x", pages: [{ title: "A", outline: "B", visualHint: "" }], extractedDirectionHint: "", extractGlobalDecision: null, requirements: "" }));
    assert.ok(await loadPptCreationDraft());
    await clearPptCreationDraft();
    assert.equal(await loadPptCreationDraft(), null);
});

test("normalize 丢弃 loading/error/apiKey 等瞬态字段；build 不注入假密钥", () => {
    const normalized = normalizePptCreationDraftSnapshot({
        version: 1,
        mode: "extract",
        step: 1,
        deckTitle: "T",
        material: "M",
        requirements: "",
        pages: [{ title: "P", outline: "O", visualHint: "" }],
        extractedDirectionHint: "",
        extractGlobalDecision: null,
        contentDraft: null,
        finalizedContent: null,
        styleContract: null,
        stylePageSpecs: null,
        extractLoading: true,
        loading: true,
        error: "boom",
        apiKey: "sk-secret",
        abortController: {},
        messageApi: {},
    });

    assert.ok(normalized);
    assert.equal(normalized.extractLoading, undefined);
    assert.equal(normalized.loading, undefined);
    assert.equal(normalized.error, undefined);
    assert.equal(normalized.apiKey, undefined);
    assert.equal(normalized.abortController, undefined);
    assert.equal(normalized.messageApi, undefined);
    assert.equal(normalized.pages[0].title, "P");
    assert.equal(hasPptCreationDraftProgress(normalized), true);
    assert.equal(hasPptCreationDraftProgress(createEmptyPptCreationDraftSnapshot()), false);

    const built = buildPptCreationDraftSnapshot({
        mode: "extract",
        step: 1,
        deckTitle: "",
        material: "m",
        requirements: "",
        pages: [{ title: "P", outline: "O", visualHint: "" }],
        extractedDirectionHint: "",
        extractGlobalDecision: null,
        contentDraft: null,
        finalizedContent: null,
        styleContract: null,
        stylePageSpecs: null,
    });
    assert.equal(Object.hasOwn(built, "apiKey"), false);
    assert.equal(Object.hasOwn(built, "error"), false);
    assert.equal(Object.hasOwn(built, "loading"), false);
    assert.equal(Object.hasOwn(built, "extractLoading"), false);
});

test("空快照不会写入存储", async () => {
    await savePptCreationDraft(createEmptyPptCreationDraftSnapshot());
    assert.equal(await loadPptCreationDraft(), null);
    assert.equal(memory.size, 0);
});

test("progress→empty 清除持久草稿；初始 empty 不 clear；clear 中新进度仍可写回", async () => {
    const empty = createEmptyPptCreationDraftSnapshot();
    const withProgress = sampleExtractSnapshot({ material: "will-be-cleared" });

    // Initial empty mount decision: no-op (must not wipe a not-yet-hydrated / unrelated draft).
    const initialEmpty = resolvePptCreationDraftAutosaveDecision({
        snapshot: empty,
        hadMeaningfulProgress: false,
    });
    assert.equal(initialEmpty.kind, "noop");
    await savePptCreationDraft(withProgress);
    assert.ok(await loadPptCreationDraft());
    // noop path does not clear storage
    assert.equal((await loadPptCreationDraft())?.material, "will-be-cleared");

    // After meaningful progress, empty transition must clear durable draft.
    const afterProgress = resolvePptCreationDraftAutosaveDecision({
        snapshot: withProgress,
        hadMeaningfulProgress: false,
    });
    assert.equal(afterProgress.kind, "schedule");
    assert.equal(afterProgress.hadMeaningfulProgress, true);

    const toEmpty = resolvePptCreationDraftAutosaveDecision({
        snapshot: empty,
        hadMeaningfulProgress: true,
    });
    assert.equal(toEmpty.kind, "clear");
    assert.equal(toEmpty.hadMeaningfulProgress, false);
    await clearPptCreationDraft();
    assert.equal(await loadPptCreationDraft(), null);

    // In-flight clear then new progress: clear bumps epoch first; later save wins.
    await savePptCreationDraft(sampleExtractSnapshot({ material: "before-clear-race" }));
    let releaseRemove;
    const removeGate = new Promise((resolve) => {
        releaseRemove = resolve;
    });
    setPptCreationDraftStorageForTests({
        getItem: async (key) => memory.get(key) ?? null,
        setItem: async (key, value) => {
            memory.set(key, structuredClone(value));
        },
        removeItem: async (key) => {
            await removeGate;
            memory.delete(key);
        },
    });
    const clearPromise = clearPptCreationDraft();
    await Promise.resolve();
    await Promise.resolve();
    const savePromise = savePptCreationDraft(sampleExtractSnapshot({ material: "typed-during-clear" }));
    releaseRemove();
    await Promise.all([clearPromise, savePromise]);
    assert.equal((await loadPptCreationDraft())?.material, "typed-during-clear");
});

test("已有 style Contract 时不得自动请求视觉模型", () => {
    assert.equal(
        shouldAutoGeneratePptStyleDirections({
            mode: "outline",
            step: 2,
            hasFinalizedContent: true,
            hasStyleContract: true,
            recommendationStatus: "idle",
            candidateCount: 0,
        }),
        false,
    );
    assert.equal(
        shouldAutoGeneratePptStyleDirections({
            mode: "outline",
            step: 2,
            hasFinalizedContent: true,
            hasStyleContract: false,
            recommendationStatus: "idle",
            candidateCount: 0,
        }),
        true,
    );
    assert.equal(
        shouldAutoGeneratePptStyleDirections({
            mode: "outline",
            step: 2,
            hasFinalizedContent: true,
            hasStyleContract: false,
            recommendationStatus: "ready",
            candidateCount: 0,
        }),
        false,
    );
});

test("resume 生命周期：中断于 step2 无 Contract 不自动请求；新进 step2 与先恢复后进入 step2 仍可自动", () => {
    const finalized = {
        brief: { version: 1, sourceHash: "h", title: "T", audience: "", goal: "", narrative: "", visualSignals: [] },
        pageSpecs: [],
        contentRevision: "rev-1",
    };

    // Page seam: seed sets suppress; nextSuppress clears it when step leaves 2 (one-shot).
    function simulateMountAutoStyleCalls(seed, runtimeSteps) {
        let suppress = shouldSuppressMountAutoStyleFromSnapshot(seed);
        let autoCalls = 0;
        for (const runtime of runtimeSteps) {
            suppress = nextSuppressMountInterruptedStyle({ suppress, step: runtime.step });
            if (
                shouldAutoGeneratePptStyleDirections({
                    mode: "outline",
                    step: runtime.step,
                    hasFinalizedContent: runtime.hasFinalizedContent,
                    hasStyleContract: runtime.hasStyleContract,
                    recommendationStatus: runtime.recommendationStatus ?? "idle",
                    candidateCount: runtime.candidateCount ?? 0,
                    suppressMountInterruptedStyle: suppress,
                })
            ) {
                autoCalls += 1;
            }
        }
        return { suppress, autoCalls };
    }

    // Resumed at step 2 with content but no Contract (left mid style request) → zero auto-calls.
    const interrupted = buildPptCreationDraftSnapshot({
        mode: "outline",
        step: 2,
        deckTitle: "T",
        material: "M",
        requirements: "",
        pages: [],
        extractedDirectionHint: "",
        extractGlobalDecision: null,
        contentDraft: null,
        finalizedContent: finalized,
        styleContract: null,
        stylePageSpecs: null,
    });
    assert.equal(shouldSuppressMountAutoStyleFromSnapshot(interrupted), true);
    const interruptedRun = simulateMountAutoStyleCalls(interrupted, [
        { step: 2, hasFinalizedContent: true, hasStyleContract: false },
        { step: 2, hasFinalizedContent: true, hasStyleContract: false }, // effect re-run still 0
    ]);
    assert.equal(interruptedRun.autoCalls, 0);
    assert.equal(interruptedRun.suppress, true);

    // Fresh session (null seed) entering step 2 → auto once.
    assert.equal(shouldSuppressMountAutoStyleFromSnapshot(null), false);
    const freshRun = simulateMountAutoStyleCalls(null, [{ step: 2, hasFinalizedContent: true, hasStyleContract: false }]);
    assert.equal(freshRun.suppress, false);
    assert.equal(freshRun.autoCalls, 1);

    // Resumed earlier (step 1) then transitions to step 2 → mount suppress false, auto allowed.
    const earlier = buildPptCreationDraftSnapshot({
        mode: "outline",
        step: 1,
        deckTitle: "T",
        material: "M",
        requirements: "",
        pages: [],
        extractedDirectionHint: "",
        extractGlobalDecision: null,
        contentDraft: { revision: 1, brief: finalized.brief, pageSpecs: [], audit: { gaps: [], issues: [] }, constraints: {} },
        finalizedContent: null,
        styleContract: null,
        stylePageSpecs: null,
    });
    assert.equal(shouldSuppressMountAutoStyleFromSnapshot(earlier), false);
    const earlierThenStep2 = simulateMountAutoStyleCalls(earlier, [
        { step: 1, hasFinalizedContent: false, hasStyleContract: false },
        { step: 2, hasFinalizedContent: true, hasStyleContract: false },
    ]);
    assert.equal(earlierThenStep2.suppress, false);
    assert.equal(earlierThenStep2.autoCalls, 1);
});

test("中断 resume step2 → 回 step1 → 再进 step2 应恢复自动视觉请求", () => {
    const finalized = {
        brief: { version: 1, sourceHash: "h", title: "T", audience: "", goal: "", narrative: "", visualSignals: [] },
        pageSpecs: [],
        contentRevision: "rev-1",
    };
    const interrupted = buildPptCreationDraftSnapshot({
        mode: "outline",
        step: 2,
        deckTitle: "T",
        material: "M",
        requirements: "",
        pages: [],
        extractedDirectionHint: "",
        extractGlobalDecision: null,
        contentDraft: null,
        finalizedContent: finalized,
        styleContract: null,
        stylePageSpecs: null,
    });

    let suppress = shouldSuppressMountAutoStyleFromSnapshot(interrupted);
    let autoCalls = 0;
    const steps = [
        { step: 2, hasFinalizedContent: true, hasStyleContract: false }, // restored — blocked
        { step: 1, hasFinalizedContent: false, hasStyleContract: false }, // back to content — clear one-shot
        { step: 2, hasFinalizedContent: true, hasStyleContract: false }, // re-enter after reconfirm — allow
    ];
    for (const runtime of steps) {
        suppress = nextSuppressMountInterruptedStyle({ suppress, step: runtime.step });
        if (
            shouldAutoGeneratePptStyleDirections({
                mode: "outline",
                step: runtime.step,
                hasFinalizedContent: runtime.hasFinalizedContent,
                hasStyleContract: runtime.hasStyleContract,
                recommendationStatus: "idle",
                candidateCount: 0,
                suppressMountInterruptedStyle: suppress,
            })
        ) {
            autoCalls += 1;
        }
    }
    assert.equal(autoCalls, 1);
    assert.equal(suppress, false);
});

test("StrictMode 双 setup 保留 restored PageSpecs；真实 inputKey 切换后不再回灌", () => {
    const restoredSpecs = [
        {
            pageId: "page-1",
            version: 1,
            purpose: "封面",
            contentForm: "cover",
            sourceRefs: [],
            contentBlocks: [{ id: "b1", kind: "title", text: "T", sourceRefIds: [] }],
            contentState: { status: "approved", approvedAt: "2026-07-23T00:00:00.000Z" },
            lockedFacts: [],
            layoutRole: "cover",
            layoutIntent: ["restored-user-reviewed-layout"],
            visualEncoding: [],
            assetRefs: [],
            freedom: "",
        },
    ];
    const plannerSpecs = [
        {
            pageId: "page-1",
            version: 1,
            purpose: "封面",
            contentForm: "cover",
            sourceRefs: [],
            contentBlocks: [{ id: "b1", kind: "title", text: "T", sourceRefIds: [] }],
            contentState: { status: "approved", approvedAt: "2026-07-23T00:00:00.000Z" },
            lockedFacts: [],
            layoutRole: "cover",
            layoutIntent: [],
            visualEncoding: [],
            assetRefs: [],
            freedom: "",
        },
    ];
    const nextPlannerSpecs = [
        {
            ...plannerSpecs[0],
            pageId: "page-2",
            purpose: "新内容页",
            layoutIntent: ["fresh-session-layout"],
        },
    ];
    const initialKey = "style-key-initial";
    const nextKey = "style-key-after-content-change";

    // First effect setup (and StrictMode re-setup) at initial key must keep restored layoutIntent.
    let state = { restoredInitialKey: initialKey, leftRestoredInitialKey: false };
    const setup1 = resolvePptStyleRestoredPageSpecsHydration({
        inputKey: initialKey,
        ...state,
        restoredPageSpecs: restoredSpecs,
        plannerPageSpecs: plannerSpecs,
    });
    assert.equal(setup1.usedRestored, true);
    assert.deepEqual(setup1.pageSpecs[0].layoutIntent, ["restored-user-reviewed-layout"]);
    state = { restoredInitialKey: setup1.restoredInitialKey, leftRestoredInitialKey: setup1.leftRestoredInitialKey };

    const setup2StrictMode = resolvePptStyleRestoredPageSpecsHydration({
        inputKey: initialKey,
        ...state,
        restoredPageSpecs: restoredSpecs,
        plannerPageSpecs: plannerSpecs,
    });
    assert.equal(setup2StrictMode.usedRestored, true);
    assert.deepEqual(setup2StrictMode.pageSpecs[0].layoutIntent, ["restored-user-reviewed-layout"]);
    assert.notDeepEqual(setup2StrictMode.pageSpecs[0].layoutIntent, plannerSpecs[0].layoutIntent);
    state = {
        restoredInitialKey: setup2StrictMode.restoredInitialKey,
        leftRestoredInitialKey: setup2StrictMode.leftRestoredInitialKey,
    };

    // Real identity transition: use planner specs, mark left.
    const afterLeave = resolvePptStyleRestoredPageSpecsHydration({
        inputKey: nextKey,
        ...state,
        restoredPageSpecs: restoredSpecs,
        plannerPageSpecs: nextPlannerSpecs,
    });
    assert.equal(afterLeave.usedRestored, false);
    assert.equal(afterLeave.leftRestoredInitialKey, true);
    assert.deepEqual(afterLeave.pageSpecs[0].layoutIntent, ["fresh-session-layout"]);
    state = {
        restoredInitialKey: afterLeave.restoredInitialKey,
        leftRestoredInitialKey: afterLeave.leftRestoredInitialKey,
    };

    // Returning to initial key must not re-apply restored over new session planner edits.
    const afterReturn = resolvePptStyleRestoredPageSpecsHydration({
        inputKey: initialKey,
        ...state,
        restoredPageSpecs: restoredSpecs,
        plannerPageSpecs: plannerSpecs,
    });
    assert.equal(afterReturn.usedRestored, false);
    assert.deepEqual(afterReturn.pageSpecs[0].layoutIntent, []);
});

test("只保留最近一份草稿：后写覆盖前写", async () => {
    await savePptCreationDraft(
        buildPptCreationDraftSnapshot({
            mode: "extract",
            step: 1,
            deckTitle: "",
            material: "first",
            requirements: "",
            pages: [{ title: "1", outline: "a", visualHint: "" }],
            extractedDirectionHint: "",
            extractGlobalDecision: null,
            contentDraft: null,
            finalizedContent: null,
            styleContract: null,
            stylePageSpecs: null,
        }),
    );
    await savePptCreationDraft(
        buildPptCreationDraftSnapshot({
            mode: "outline",
            step: 1,
            deckTitle: "",
            material: "second",
            requirements: "",
            pages: [],
            extractedDirectionHint: "",
            extractGlobalDecision: null,
            contentDraft: { revision: 1, brief: { version: 1, sourceHash: "h", title: "", audience: "", goal: "", narrative: "", visualSignals: [] }, pageSpecs: [], audit: { gaps: [], issues: [] }, constraints: {} },
            finalizedContent: null,
            styleContract: null,
            stylePageSpecs: null,
        }),
    );
    const restored = await loadPptCreationDraft();
    assert.equal(restored?.material, "second");
    assert.equal(restored?.mode, "outline");
    assert.equal(memory.size, 1);
});

test("延迟 setItem 的 in-flight save 不得在 clear 后复活草稿", async () => {
    let releaseSet;
    const gate = new Promise((resolve) => {
        releaseSet = resolve;
    });
    let setCalls = 0;
    const delayedStorage = {
        getItem: async (key) => memory.get(key) ?? null,
        setItem: async (key, value) => {
            setCalls += 1;
            await gate;
            memory.set(key, structuredClone(value));
        },
        removeItem: async (key) => {
            memory.delete(key);
        },
    };
    setPptCreationDraftStorageForTests(delayedStorage);

    const savePromise = savePptCreationDraft(sampleExtractSnapshot({ material: "stale-in-flight" }));
    // Allow save to enter the mutation queue and hit delayed setItem before clear is enqueued.
    await Promise.resolve();
    await Promise.resolve();
    const clearPromise = clearPptCreationDraft();
    releaseSet();
    await Promise.all([savePromise, clearPromise]);

    assert.equal(await loadPptCreationDraft(), null);
    assert.equal(memory.has("latest"), false);
    assert.ok(setCalls >= 1);
});

test("clear 之后的新 save 是有意进度，会正常写入", async () => {
    await savePptCreationDraft(sampleExtractSnapshot({ material: "keep-until-clear" }));
    assert.ok(await loadPptCreationDraft());

    await clearPptCreationDraft();
    assert.equal(await loadPptCreationDraft(), null);

    // A save requested after clear completed is new user progress, not a stale race.
    await savePptCreationDraft(sampleExtractSnapshot({ material: "post-clear-new-progress" }));
    assert.equal((await loadPptCreationDraft())?.material, "post-clear-new-progress");
    await clearPptCreationDraft();
    assert.equal(await loadPptCreationDraft(), null);
});

test("clear 调用后，延迟 setItem 的旧 epoch save 会撤销写回", async () => {
    memory.clear();
    let releaseSet;
    const setGate = new Promise((resolve) => {
        releaseSet = resolve;
    });
    const gatedStorage = {
        getItem: async (key) => memory.get(key) ?? null,
        setItem: async (key, value) => {
            await setGate;
            memory.set(key, structuredClone(value));
        },
        removeItem: async (key) => {
            memory.delete(key);
        },
    };
    setPptCreationDraftStorageForTests(gatedStorage);

    // Stale save captures epoch 0, enters mutation, blocks on setItem.
    const staleSave = savePptCreationDraft(sampleExtractSnapshot({ material: "stale-pre-clear" }));
    await Promise.resolve();
    await Promise.resolve();
    // clear bumps epoch immediately; save must not leave a resurrected draft.
    const clearPromise = clearPptCreationDraft();
    releaseSet();
    await Promise.all([staleSave, clearPromise]);

    assert.equal(await loadPptCreationDraft(), null);
    assert.equal(memory.has("latest"), false);
});

test("load 等待 pending clear 完成后再读", async () => {
    await savePptCreationDraft(sampleExtractSnapshot({ material: "before-clear" }));
    let releaseRemove;
    const removeGate = new Promise((resolve) => {
        releaseRemove = resolve;
    });
    const gatedStorage = {
        getItem: async (key) => memory.get(key) ?? null,
        setItem: async (key, value) => {
            memory.set(key, structuredClone(value));
        },
        removeItem: async (key) => {
            await removeGate;
            memory.delete(key);
        },
    };
    setPptCreationDraftStorageForTests(gatedStorage);

    const clearPromise = clearPptCreationDraft();
    await Promise.resolve();
    await Promise.resolve();
    const loadPromise = loadPptCreationDraft();
    releaseRemove();
    const [cleared, loaded] = await Promise.all([clearPromise.then(() => "cleared"), loadPromise]);
    assert.equal(cleared, "cleared");
    assert.equal(loaded, null);
});

test("列表 CTA：有草稿时为继续创建，无草稿时为新建 PPT", () => {
    const empty = getPptListCreateAction(null);
    assert.equal(empty.kind, "create");
    assert.equal(empty.primaryLabel, "新建 PPT");
    assert.equal(empty.supportingCue, null);

    const resume = getPptListCreateAction(sampleExtractSnapshot());
    assert.equal(resume.kind, "resume");
    assert.equal(resume.primaryLabel, "继续创建");
    assert.ok(resume.supportingCue && resume.supportingCue.includes("未完成"));
});

test("clear 失败文案：finalize 不叫建图失败；restart 不暗示 UI 已重置", () => {
    const finalizeMsg = describePptCreationClearFailure("finalize");
    assert.ok(finalizeMsg.includes("画布已创建"));
    assert.ok(finalizeMsg.includes("草稿"));
    assert.equal(finalizeMsg.includes("建图失败"), false);

    const restartMsg = describePptCreationClearFailure("restart");
    assert.ok(restartMsg.includes("清除"));
    assert.ok(restartMsg.includes("重试"));
});

test("leave sequence：先 flush 再 close/refresh，列表 CTA 读到最新草稿", async () => {
    // Models PptWizard handleCancel: await leave sequence, then parent load for CTA.
    const older = sampleExtractSnapshot({ material: "stale-on-disk" });
    const latest = sampleExtractSnapshot({ material: "typed-then-left-immediately" });
    await savePptCreationDraft(older);

    let listActionAfterClose = null;
    const closeThenRefresh = async () => {
        // Parent closeWizard: only after leave sequence resolves.
        listActionAfterClose = getPptListCreateAction(await loadPptCreationDraft());
    };

    const leave = await runPptCreationDraftLeaveSequence({
        suppressUnmountFlush: false,
        pendingSnapshot: latest,
        save: savePptCreationDraft,
    });
    assert.equal(leave.flushed, true);
    assert.equal(leave.suppressUnmountFlush, true);

    // Duplicate unmount flush must be suppressed after successful leave flush.
    assert.equal(
        resolvePptCreationDraftUnmountFlush({
            suppressUnmountFlush: leave.suppressUnmountFlush,
            pendingSnapshot: latest,
        }),
        null,
    );

    await closeThenRefresh();
    assert.equal(listActionAfterClose?.kind, "resume");
    assert.equal(listActionAfterClose?.primaryLabel, "继续创建");
    assert.equal((await loadPptCreationDraft())?.material, "typed-then-left-immediately");
});

test("leave sequence：save 失败时不 suppress，unmount 仍可 best-effort 重试", async () => {
    const pending = sampleExtractSnapshot({ material: "flush-fail-then-retry" });
    let attempts = 0;
    const leave = await runPptCreationDraftLeaveSequence({
        suppressUnmountFlush: false,
        pendingSnapshot: pending,
        save: async () => {
            attempts += 1;
            throw new Error("disk full");
        },
    });
    assert.equal(leave.flushed, false);
    assert.equal(leave.suppressUnmountFlush, false);
    assert.equal(attempts, 1);

    // Passive unmount path may still resolve and save.
    const retry = resolvePptCreationDraftUnmountFlush({
        suppressUnmountFlush: leave.suppressUnmountFlush,
        pendingSnapshot: pending,
    });
    assert.ok(retry);
    await savePptCreationDraft(retry);
    assert.equal((await loadPptCreationDraft())?.material, "flush-fail-then-retry");
});

test("pre-clear 已调度的 debounce 在 cancel 后不得在 clear 后写回", async () => {
    const scheduled = [];
    let fire = null;
    const scheduler = createPptCreationDraftAutosaveScheduler({
        save: async (snapshot) => {
            scheduled.push(snapshot.material);
            await savePptCreationDraft(snapshot);
        },
        nowEpoch: getPptCreationDraftWriteEpoch,
        setTimer: (fn) => {
            fire = fn;
            return 1;
        },
        clearTimer: () => {
            fire = null;
        },
    });

    await savePptCreationDraft(sampleExtractSnapshot({ material: "committed" }));
    scheduler.schedule(sampleExtractSnapshot({ material: "stale-after-clear" }), 400);
    assert.equal(scheduler.hasPendingTimer(), true);

    // Restart/finalize path: cancel timer synchronously, then clear.
    scheduler.cancel();
    assert.equal(scheduler.hasPendingTimer(), false);
    assert.equal(fire, null);
    await clearPptCreationDraft();

    // Even if a leaked callback ran, schedule-time epoch would block — but cancel must drop it.
    assert.equal(await loadPptCreationDraft(), null);
    assert.deepEqual(scheduled, []);
});

test("未 cancel 时，clear 后误触发的旧 schedule 回调因 epoch 不会写回", async () => {
    let fire = null;
    const scheduler = createPptCreationDraftAutosaveScheduler({
        save: savePptCreationDraft,
        nowEpoch: getPptCreationDraftWriteEpoch,
        setTimer: (fn) => {
            fire = fn;
            return 1;
        },
        clearTimer: () => {
            fire = null;
        },
    });

    scheduler.schedule(sampleExtractSnapshot({ material: "should-not-land" }), 400);
    assert.ok(fire);
    await clearPptCreationDraft();
    // Simulate timer firing after clear without cancel (defense in depth).
    fire();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(await loadPptCreationDraft(), null);
});

test("storage.getItem 失败时 load 抛错，不与「无草稿」混淆", async () => {
    setPptCreationDraftStorageForTests({
        getItem: async () => {
            throw new Error("IndexedDB unavailable");
        },
        setItem: async () => {},
        removeItem: async () => {},
    });

    await assert.rejects(() => loadPptCreationDraft(), /IndexedDB unavailable/);
});
