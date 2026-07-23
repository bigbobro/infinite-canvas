import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createServer } from "vite";

let vite;
let applyPptPageSpecUpdate;
let assertGenerationPlanCompilation;
let buildPptDeckProject;
let buildPptPageWorkspace;
let collectImageStorageKeys;
let compilePptPromptSnapshot;
let derivePptDeckShellFacts;
let compilePptStyleContract;
let createGenerationPlan;
let createPptVisualDirectionPresetContract;
let derivePptLockedFacts;
let deriveDefaultPptLayoutRole;
let defaultConfig;
let freezeGenerationPlanReferences;
let getPptVisualDirectionLabel;
let normalizePptStyleContract;
let PPT_LAYOUT_ROLES;
let PPT_VISUAL_DIRECTION_PRESETS;
let renderPptPageSpecText;
let useCanvasStore;
let hashPptContentSource;

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    ({ compilePptStyleContract, createPptVisualDirectionPresetContract, deriveDefaultPptLayoutRole, getPptVisualDirectionLabel, normalizePptStyleContract, PPT_LAYOUT_ROLES, PPT_VISUAL_DIRECTION_PRESETS } =
        await vite.ssrLoadModule("/src/lib/ppt/style-contract.ts"));
    ({ compilePptPromptSnapshot, derivePptDeckShellFacts } = await vite.ssrLoadModule("/src/lib/ppt/prompt-compiler.ts"));
    ({ derivePptLockedFacts, renderPptPageSpecText } = await vite.ssrLoadModule("/src/lib/ppt/content-plan.ts"));
    ({ buildPptDeckProject, hashPptContentSource } = await vite.ssrLoadModule("/src/lib/ppt/deck-builder.ts"));
    ({ buildPptPageWorkspace } = await vite.ssrLoadModule("/src/lib/ppt/page-workspace.ts"));
    ({ assertGenerationPlanCompilation, createGenerationPlan } = await vite.ssrLoadModule("/src/lib/ppt/generation-plan.ts"));
    ({ applyPptPageSpecUpdate, useCanvasStore } = await vite.ssrLoadModule("/src/stores/canvas/use-canvas-store.ts"));
    ({ freezeGenerationPlanReferences } = await vite.ssrLoadModule("/src/pages/canvas/hooks/use-ppt-generation-module.ts"));
    ({ collectImageStorageKeys } = await vite.ssrLoadModule("/src/services/image-storage.ts"));
    ({ defaultConfig } = await vite.ssrLoadModule("/src/stores/use-config-store.ts"));
});

after(async () => {
    useCanvasStore?.setState({ projects: [] });
    await vite?.close();
});

test("三个 preset 冻结完整设计系统，Contract 引用去重且可被图片清理 used-set 发现", () => {
    assert.deepEqual(
        PPT_VISUAL_DIRECTION_PRESETS.map((preset) => preset.id),
        ["clean-report", "visual-story", "brand-led"],
    );
    const frozen = createPptVisualDirectionPresetContract("clean-report");
    assert.equal(compilePptStyleContract(frozen).ok, true);
    const normalized = normalizePptStyleContract({ ...frozen, references: [{ storageKey: " image:a " }, { storageKey: "image:a" }, { storageKey: "image:b" }] });
    assert.deepEqual(normalized.references, [{ storageKey: "image:a" }, { storageKey: "image:b" }]);
    assert.deepEqual(new Set(collectImageStorageKeys({ styleContract: normalized })), new Set(["image:a", "image:b"]));

    frozen.modelStyle.mood[0] = "只修改当前草稿";
    assert.notEqual(createPptVisualDirectionPresetContract("clean-report").modelStyle.mood[0], "只修改当前草稿");
});

test("presetId 只记录来源，相同冻结设计系统编译出相同最终提示词", () => {
    const base = createPptVisualDirectionPresetContract("clean-report");
    const build = (presetId) => compilerModel([], { ...structuredClone(base), source: { kind: "preset", presetId } });
    const clean = build("clean-report");
    const brand = build("brand-led");
    assert.equal(compilePptPromptSnapshot(snapshotInput(clean.deckBrief, clean.pageSpecs)).prompts[0].finalPrompt, compilePptPromptSnapshot(snapshotInput(brand.deckBrief, brand.pageSpecs)).prompts[0].finalPrompt);
});

test("Contract 是唯一视觉事实源，要求与页面排版中的视觉覆盖 fail-closed", () => {
    const { deckBrief, pageSpecs } = compilerModel();
    deckBrief.globalRules = ["保留全部数据", "专业咨询报告风格"];
    pageSpecs[0].layoutIntent = ["左图右文", "红色赛博朋克风"];
    const snapshot = compilePptPromptSnapshot(snapshotInput(deckBrief, pageSpecs));
    assert.equal(snapshot.issues.filter((issue) => issue.code === "visual_direction_outside_contract" && issue.severity === "blocking").length, 2);
    assert.match(snapshot.prompts[0].finalPrompt, /保留全部数据/);
    assert.match(snapshot.prompts[0].finalPrompt, /左图右文/);
    assert.doesNotMatch(snapshot.prompts[0].finalPrompt, /专业咨询报告风格|红色赛博朋克风/);
});

test("建立画布前也会拦截 globalRules 中的第二套视觉事实源", () => {
    const { deckBrief, pageSpecs } = compilerModel();
    deckBrief.globalRules = ["保留全部数据", "统一使用科技风"];
    assert.throws(
        () =>
            buildPptDeckProject({
                compilePolicy: "structured",
                title: "全局规则检查",
                sourceMaterial: "项目结论",
                requirements: "",
                deckBrief,
                pageSpecs,
            }),
        /整套内容规则/,
    );
});

test("损坏 Contract 显示待修复而不是让工作台 render crash", () => {
    assert.equal(getPptVisualDirectionLabel({ source: undefined, direction: "深蓝专业", references: [] }), "待修复");
    assert.equal(getPptVisualDirectionLabel(createPptVisualDirectionPresetContract("clean-report")), "清晰专业");
});

test("PPT 列表读取缺少稳定身份或方案数组的本地工程时不会崩溃", () => {
    for (const missingField of ["pageId", "takes"]) {
        const { deckBrief, pageSpecs } = compilerModel([], undefined, "第一页");
        const partial = buildPptDeckProject({
            compilePolicy: "structured",
            title: "旧本地工程",
            sourceMaterial: "第一页",
            requirements: "",
            deckBrief,
            pageSpecs,
        });
        const project = {
            id: `legacy-local-project-${missingField}`,
            createdAt: "2026-07-22T00:00:00.000Z",
            updatedAt: "2026-07-22T00:00:00.000Z",
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "lines",
            showImageInfo: false,
            ...partial,
        };
        const page = project.ppt.pages[0];
        assert.doesNotThrow(() => buildPptPageWorkspace(project, page));
        const takeId = page.takes[0].takeId;
        delete page[missingField];
        if (missingField === "pageId") {
            project.nodes.push({
                id: "legacy-incomplete-ledger-image",
                type: "image",
                title: "旧台账图片",
                position: { x: 0, y: 0 },
                width: 320,
                height: 180,
                metadata: { status: "success", pptGenerationRequest: { pageId: undefined, takeId } },
            });
        }

        const workspace = buildPptPageWorkspace(project, page);
        if (missingField === "takes") assert.deepEqual(workspace.takes, []);
        else
            assert.equal(
                workspace.takes[0].candidates.some((candidate) => candidate.id === "legacy-incomplete-ledger-image"),
                false,
            );
    }
});

test("页面职责确定性推导且六种 role 都进入最终提示词", () => {
    assert.equal(deriveDefaultPptLayoutRole({ title: "项目封面" }, 0, 6), "cover");
    assert.equal(deriveDefaultPptLayoutRole({ title: "第二章节" }, 1, 6), "section");
    assert.equal(deriveDefaultPptLayoutRole({ title: "方案对比" }, 2, 6), "comparison");
    assert.equal(deriveDefaultPptLayoutRole({ title: "关键数据" }, 3, 6), "evidence");
    assert.equal(deriveDefaultPptLayoutRole({ title: "方法说明" }, 4, 6), "content");
    assert.equal(deriveDefaultPptLayoutRole({ title: "谢谢" }, 5, 6), "close");

    for (const { id, instruction } of PPT_LAYOUT_ROLES) {
        const { deckBrief, pageSpecs } = compilerModel();
        pageSpecs[0].layoutRole = id;
        const snapshot = compilePptPromptSnapshot(snapshotInput(deckBrief, pageSpecs));
        assert.match(snapshot.prompts[0].finalPrompt, /【页面职责与角色母版】/);
        assert.match(snapshot.prompts[0].finalPrompt, new RegExp(escapeRegExp(instruction)));
        assert.equal(
            snapshot.issues.some((issue) => issue.code === "invalid_layout_role"),
            false,
        );
    }
});

test("缺字段 Contract、未知 preset 和未知 role 都形成 blocking issue", () => {
    for (const mutation of [(deckBrief) => delete deckBrief.styleContract.modelStyle.palette, (deckBrief) => (deckBrief.styleContract.source = undefined), (deckBrief) => (deckBrief.styleContract.source = { kind: "preset", presetId: "unknown" })]) {
        const { deckBrief, pageSpecs } = compilerModel();
        mutation(deckBrief);
        const snapshot = compilePptPromptSnapshot(snapshotInput(deckBrief, pageSpecs));
        assert.ok(snapshot.issues.some((issue) => issue.code === "invalid_style_contract" && issue.severity === "blocking"));
    }
    const { deckBrief, pageSpecs } = compilerModel();
    pageSpecs[0].layoutRole = "unknown";
    const snapshot = compilePptPromptSnapshot(snapshotInput(deckBrief, pageSpecs));
    assert.ok(snapshot.issues.some((issue) => issue.code === "invalid_layout_role" && issue.severity === "blocking"));
});

test("显式覆盖不能删除视觉方向或页面职责", () => {
    const { deckBrief, pageSpecs } = compilerModel();
    const input = snapshotInput(deckBrief, pageSpecs);
    const baseline = compilePptPromptSnapshot(input).prompts[0].finalPrompt;
    const roleInstruction = PPT_LAYOUT_ROLES.find((role) => role.id === pageSpecs[0].layoutRole).instruction;
    const styleInstruction = compilePptStyleContract(deckBrief.styleContract).value.globalInstructions[0];
    for (const override of [baseline.replace(styleInstruction, ""), baseline.replace(roleInstruction, "")]) {
        const snapshot = compilePptPromptSnapshot({ ...input, targets: [{ ...input.targets[0], override, overrideConfirmed: true }] });
        assert.ok(snapshot.issues.some((issue) => issue.code === "missing_required_instruction" && issue.severity === "blocking"));
    }
});

test("CompilationSnapshot 深拷贝冻结完整 Contract 与 PageSpec", () => {
    const { deckBrief, pageSpecs } = compilerModel([{ storageKey: "image:style" }]);
    const input = snapshotInput(deckBrief, pageSpecs);
    const first = compilePptPromptSnapshot(input);
    const second = compilePptPromptSnapshot(input);
    assert.deepEqual(first, second);

    deckBrief.styleContract.modelStyle.mood = ["已篡改"];
    deckBrief.styleContract.references[0].storageKey = "image:changed";
    pageSpecs[0].layoutRole = "close";
    assert.deepEqual(first.deckBrief.styleContract.modelStyle.mood, ["深蓝", "克制", "专业"]);
    assert.equal(first.deckBrief.styleContract.references[0].storageKey, "image:style");
    assert.equal(first.pageSpecs[0].layoutRole, "cover");
});

test("生成计划忽略 style 投影节点，Contract 参考图进入快照但不伪造 inputRefs", () => {
    const contract = customContract("Contract 唯一方向", [{ storageKey: "image:contract-reference" }]);
    const { deckBrief, pageSpecs } = compilerModel([{ storageKey: "image:contract-reference" }], contract);
    const partial = buildPptDeckProject({
        compilePolicy: "structured",
        title: "单一视觉事实源",
        sourceMaterial: "项目结论",
        requirements: "",
        deckBrief,
        pageSpecs,
    });
    const project = {
        id: "contract-plan-project",
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        ...partial,
    };
    const take = project.ppt.pages[0].takes[0];
    const styleText = { id: "legacy-style-text", type: "text", title: "旧风格", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "不应进入提示词", status: "success", pptRole: "style" } };
    const styleImage = {
        id: "legacy-style-image",
        type: "image",
        title: "旧参考图",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: { content: "data:image/png;base64,AA==", storageKey: "image:legacy", status: "success", pptRole: "style" },
    };
    project.nodes.push(styleText, styleImage);
    project.connections.push({ id: "legacy-text-config", fromNodeId: styleText.id, toNodeId: take.configNodeId }, { id: "legacy-image-config", fromNodeId: styleImage.id, toNodeId: take.configNodeId });

    const plan = createGenerationPlan({ kind: "generateSingle", takeId: take.takeId }, { project, effectiveConfig: defaultConfig });
    const request = plan.runs[0].requests[0];
    assert.match(request.prompt, /Contract 唯一方向/);
    assert.doesNotMatch(request.prompt, /不应进入提示词/);
    assert.equal(request.requestType, "imageToImage");
    assert.deepEqual(request.inputRefs, []);
    assert.deepEqual(
        request.referenceSnapshots.map((reference) => reference.storageKey),
        ["image:contract-reference"],
    );

    const missingReference = structuredClone(plan);
    missingReference.runs[0].requests[0].referenceSnapshots = [];
    missingReference.runs[0].requests[0].requestType = "textToImage";
    assert.throws(() => assertGenerationPlanCompilation(missingReference), /Contract 参考图绑定不一致/);
    const fakeInput = structuredClone(plan);
    fakeInput.runs[0].requests[0].inputRefs = [{ nodeId: "ppt-style-contract:image:contract-reference", type: "image" }];
    assert.throws(() => assertGenerationPlanCompilation(fakeInput), /伪造成了画布输入引用/);

    const firstSharedReference = {
        ...styleImage,
        id: "shared-reference-1",
        title: "共享参考图 1",
        metadata: { ...styleImage.metadata, storageKey: "image:contract-reference", pptRole: undefined },
    };
    const secondSharedReference = { ...firstSharedReference, id: "shared-reference-2", title: "共享参考图 2" };
    project.nodes.push(firstSharedReference, secondSharedReference);
    project.connections.push({ id: "shared-1-config", fromNodeId: firstSharedReference.id, toNodeId: take.configNodeId }, { id: "shared-2-config", fromNodeId: secondSharedReference.id, toNodeId: take.configNodeId });
    const dedupedPlan = createGenerationPlan({ kind: "generateSingle", takeId: take.takeId }, { project, effectiveConfig: defaultConfig });
    const dedupedRequest = dedupedPlan.runs[0].requests[0];
    assert.deepEqual(dedupedRequest.inputRefs, [{ nodeId: firstSharedReference.id, type: "image" }]);
    assert.equal(dedupedRequest.referenceSnapshots.length, 1);
    assert.equal(dedupedRequest.referenceSnapshots[0].id, firstSharedReference.id);
    assert.equal(dedupedRequest.referenceSnapshots[0].storageKey, "image:contract-reference");
    assert.doesNotThrow(() => assertGenerationPlanCompilation(dedupedPlan));
});

test("Contract CAS 更新清全部确认但保留候选节点与历史快照；no-op 不升版", () => {
    const project = storeProject();
    useCanvasStore.setState({ projects: [project] });
    const beforeUpdatedAt = project.updatedAt;
    const originalNodes = project.nodes;
    const originalSnapshots = project.ppt.compilationSnapshots;

    useCanvasStore.getState().setDeckStyleContract(project.id, 1, project.ppt.deckBrief.styleContract);
    assert.equal(useCanvasStore.getState().projects[0].ppt.deckBrief.version, 1);
    assert.equal(useCanvasStore.getState().projects[0].updatedAt, beforeUpdatedAt);

    useCanvasStore.getState().setDeckStyleContract(project.id, 1, customContract("视觉叙事", [{ storageKey: "image:new-style" }]));
    const updated = useCanvasStore.getState().projects[0];
    assert.equal(updated.ppt.deckBrief.version, 2);
    assert.ok(updated.ppt.pages.every((page) => page.confirmedNodeId === undefined));
    assert.equal(updated.nodes, originalNodes);
    assert.equal(updated.ppt.compilationSnapshots, originalSnapshots);
    useCanvasStore.getState().setDeckStyleContract(project.id, 2, { ...customContract("视觉叙事", [{ storageKey: " image:new-style " }, { storageKey: "image:new-style" }]) });
    assert.equal(useCanvasStore.getState().projects[0], updated);
    assert.throws(() => useCanvasStore.getState().setDeckStyleContract(project.id, 1, project.ppt.deckBrief.styleContract), /已变更/);
});

test("工作台保存 Contract 前会拦截与已确认业务语义的冲突", () => {
    const project = storeProject();
    const page = project.ppt.pageSpecs[0];
    page.sourceRefs[0].excerpt = "红色表示风险";
    page.contentBlocks[0].text = "红色表示风险";
    page.visualEncoding = [
        {
            id: "risk-color",
            contentBlockIds: [page.contentBlocks[0].id],
            intent: "differentiate",
            channel: "color",
            lockedMapping: [{ contentBlockId: page.contentBlocks[0].id, token: "红色", sourceRefIds: [page.sourceRefs[0].id] }],
        },
    ];
    const conflicting = customContract("专业、克制");
    conflicting.modelStyle.forbiddenRules.push("禁止红色");
    useCanvasStore.setState({ projects: [project] });
    assert.throws(() => useCanvasStore.getState().setDeckStyleContract(project.id, 1, conflicting), /业务语义色映射/);
    assert.equal(useCanvasStore.getState().projects[0].ppt.deckBrief.version, 1);
});

test("layoutRole/layoutIntent 只失效目标页；CAS 过期失败且 no-op 不升版", () => {
    const project = storeProject();
    useCanvasStore.setState({ projects: [project] });
    useCanvasStore.getState().setPptPageLayoutRole(project.id, "page-1", 1, "cover");
    assert.equal(useCanvasStore.getState().projects[0].ppt.pageSpecs[0].version, 1);

    useCanvasStore.getState().setPptPageLayoutRole(project.id, "page-1", 1, "comparison");
    const roleUpdated = useCanvasStore.getState().projects[0];
    assert.equal(roleUpdated.ppt.pageSpecs[0].version, 2);
    assert.equal(roleUpdated.ppt.pages[0].confirmedNodeId, undefined);
    assert.equal(roleUpdated.ppt.pages[1].confirmedNodeId, "candidate-2");
    assert.throws(() => useCanvasStore.getState().setPptPageLayoutRole(project.id, "page-1", 1, "content"), /已变更/);

    const intentUpdated = applyPptPageSpecUpdate(roleUpdated.ppt, "page-2", 1, (pageSpec) => ({ ...pageSpec, layoutIntent: ["双栏排版"] }));
    assert.equal(intentUpdated.pageSpecs.find((pageSpec) => pageSpec.pageId === "page-2").version, 2);
    assert.equal(intentUpdated.pages.find((page) => page.pageId === "page-2").confirmedNodeId, undefined);
    assert.equal(intentUpdated.pages.find((page) => page.pageId === "page-1").confirmedNodeId, undefined);
});

test("参考图 resolver 返回空串或非 data URL 时冻结计划直接失败", async () => {
    let submitCalls = 0;
    const plan = {
        kind: "pageGeneration",
        batchId: "batch",
        createdAt: "2026-07-22T00:00:00.000Z",
        runs: [{ requests: [{ referenceSnapshots: [{ id: "contract", name: "视觉方向参考图", type: "image/png", dataUrl: "", storageKey: "image:missing" }] }] }],
    };
    await assert.rejects(
        freezeGenerationPlanReferences(plan, async () => "").then(() => {
            submitCalls += 1;
        }),
        /无法读取/,
    );
    await assert.rejects(
        freezeGenerationPlanReferences(plan, async () => "https://example.com/image.png"),
        /无法读取/,
    );
    assert.equal(submitCalls, 0);
});

function compilerModel(references = [], contract = customContract("深蓝、克制、专业", references), sourceMaterial = "项目结论") {
    return {
        deckBrief: deckBrief(contract, sourceMaterial),
        pageSpecs: [pageSpec("page-1", "项目结论")],
    };
}

function snapshotInput(deckBrief, pageSpecs) {
    return {
        compilePolicy: "structured",
        snapshotId: "snapshot-style-contract",
        compiledAt: "2026-07-22T00:00:00.000Z",
        deckBrief,
        pageSpecs,
        deckShell: derivePptDeckShellFacts(pageSpecs, "测试整套标题"),
        targets: [{ pageId: "page-1", takeId: "take-1", semanticText: renderPptPageSpecText(pageSpecs[0]), layoutIntent: [], extraTexts: [] }],
    };
}

function storeProject() {
    const brief = deckBrief(createPptVisualDirectionPresetContract(), "第一页\n第二页");
    const pageSpecs = [pageSpec("page-1", "第一页"), pageSpec("page-2", "第二页")];
    const history = compilePptPromptSnapshot({
        compilePolicy: "structured",
        snapshotId: "history",
        compiledAt: "2026-07-22T00:00:00.000Z",
        deckBrief: brief,
        pageSpecs,
        deckShell: derivePptDeckShellFacts(pageSpecs, "测试整套标题"),
        targets: pageSpecs.map((spec, index) => ({ pageId: spec.pageId, takeId: `take-${index + 1}`, semanticText: renderPptPageSpecText(spec), layoutIntent: [], extraTexts: [] })),
    });
    return {
        id: "contract-store-project",
        title: "Contract 测试",
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
        nodes: [{ id: "candidate-1" }, { id: "candidate-2" }],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        ppt: {
            compilePolicy: "structured",
            sourceMaterial: "第一页\n第二页",
            requirements: "",
            pages: [
                { pageId: "page-1", index: 1, confirmedNodeId: "candidate-1", takes: [] },
                { pageId: "page-2", index: 2, confirmedNodeId: "candidate-2", takes: [] },
            ],
            deckBrief: brief,
            pageSpecs,
            compilationSnapshots: [history],
        },
    };
}

function deckBrief(styleContract, sourceMaterial = "", requirements = "") {
    const sourceHash = hashPptContentSource(sourceMaterial, requirements);
    return { version: 1, sourceHash, contentRevision: `${sourceHash}:r1`, audience: "", goal: "", narrative: "", styleContract: structuredClone(styleContract), globalRules: [], forbiddenRules: [], lockedDeckFacts: [] };
}

function customContract(mood, references = []) {
    const contract = createPptVisualDirectionPresetContract("clean-report");
    contract.source = { kind: "custom" };
    contract.modelStyle.mood = mood
        .split(/[、，,\n]/)
        .map((value) => value.trim())
        .filter(Boolean);
    contract.references = references;
    return contract;
}

function pageSpec(pageId, title) {
    const sourceRef = { id: `${pageId}:source`, source: "confirmed_assumption", relation: "verbatim", excerpt: title };
    const spec = {
        pageId,
        version: 1,
        purpose: `讲清${title}`,
        contentForm: "narrative",
        sourceRefs: [sourceRef],
        contentBlocks: [
            { id: `${pageId}:title`, kind: "title", text: title, sourceRefIds: [sourceRef.id] },
            { id: `${pageId}:claim`, kind: "primary_claim", text: title, sourceRefIds: [sourceRef.id] },
        ],
        contentState: { status: "approved", approvedAt: "2026-07-22T00:00:00.000Z" },
        lockedFacts: [],
        layoutRole: "cover",
        layoutIntent: [],
        visualEncoding: [],
        assetRefs: [],
        freedom: "不得新增可见文案或事实；只允许优化视觉组织",
    };
    spec.lockedFacts = derivePptLockedFacts(spec);
    return spec;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
