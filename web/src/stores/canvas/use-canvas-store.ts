import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { assertPptStyleContract, derivePptVisualDirectionRules, isPptLayoutRole, normalizePptStyleContract, reviewPptStyle, samePptStyleContract } from "@/lib/ppt/style-contract";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type PptVisualDirectionPresetId = "clean-report" | "visual-story" | "brand-led";

export type PptVisualDirectionSource = { kind: "preset"; presetId: PptVisualDirectionPresetId } | { kind: "generated"; candidateId: string } | { kind: "custom" };

export type CanvasProjectPptStyleContract = {
    schemaVersion: 1;
    source: PptVisualDirectionSource;
    modelStyle: {
        mood: string[];
        density: "airy" | "balanced" | "dense";
        palette: {
            background: string;
            surface: string;
            text: string;
            mutedText: string;
            primary: string;
            accent: string;
        };
        typography: {
            headingClass: "sans" | "serif" | "display";
            bodyClass: "sans" | "serif";
            hierarchy: "quiet" | "balanced" | "strong";
            brandFontHint?: string;
        };
        shell: {
            safeArea: "compact" | "regular" | "generous";
            titleRegion: "top-left" | "top-center" | "center";
            header: "none" | "deck-title" | "section-label";
            footer: "none" | "page-number" | "deck-title-and-page-number";
        };
        graphicLanguage: {
            card: string;
            chart: string;
            icon: string;
            illustration: string;
            imageTreatment: string;
        };
        roleMasters: Record<PptLayoutRole, string>;
        forbiddenRules: string[];
    };
    references: { storageKey: string }[];
};

export type PptLayoutRole = "cover" | "section" | "content" | "evidence" | "comparison" | "close";

export type CanvasProjectPptTake = {
    takeId: string;
    anchorNodeId: string;
    configNodeId: string;
};

export type CanvasProjectPptPage = {
    pageId: string;
    index: number;
    confirmedNodeId?: string;
    takes: CanvasProjectPptTake[];
};

export type CanvasProjectPptSourceRef = {
    id: string;
    source: "material" | "requirements" | "user_answer" | "confirmed_assumption";
    /** verbatim = 页面文案可在 excerpt 中逐字定位；derived = 基于 excerpt 归纳/压缩，硬事实须仍落在 excerpt 内 */
    relation: "verbatim" | "derived";
    excerpt: string;
    startLine?: number;
    endLine?: number;
    gapId?: string;
};

export type CanvasProjectPptLockedFact = {
    id: string;
    kind: "number" | "term" | "point_count" | "table";
    value: string;
    sourceExcerpt: string;
};

export type CanvasProjectPptDeckBrief = {
    version: number;
    sourceHash: string;
    contentRevision: string;
    audience: string;
    goal: string;
    narrative: string;
    styleContract: CanvasProjectPptStyleContract;
    globalRules: string[];
    forbiddenRules: string[];
    lockedDeckFacts: CanvasProjectPptLockedFact[];
};

export type PptContentBrief = {
    version: number;
    sourceHash: string;
    title: string;
    audience: string;
    goal: string;
    narrative: string;
    visualSignals: string[];
};

export type PptContentForm = "cover" | "comparison" | "architecture" | "process" | "timeline" | "data" | "narrative" | "closing";

export type CanvasProjectPptContentBlock = {
    id: string;
    kind: "title" | "primary_claim" | "supporting_claim" | "body" | "list" | "table" | "chart_data" | "placeholder";
    text: string;
    sourceRefIds: string[];
    gapId?: string;
};

export type CanvasProjectPptVisualEncoding = {
    id: string;
    contentBlockIds: string[];
    intent: "differentiate" | "emphasize" | "sequence" | "group" | "show_relationship";
    channel: "color" | "shape" | "position" | "size" | "line" | "icon";
    lockedMapping?: Array<{ contentBlockId: string; token: string; sourceRefIds: string[] }>;
};

export type PptContentState = { status: "blocked"; gapIds: string[] } | { status: "reviewable" } | { status: "approved"; approvedAt: string };

/** SHA-30c：理念层违规被用户明确选择保留时的承接记录；随 pageSpec 持久化、参与编译确定性。 */
export type PptPrincipleDeviation = {
    principle: "cover-extra-content" | "cover-claim-checklist";
    acknowledgedAt: string;
};

export type CanvasProjectPptPageSpec = {
    pageId: string;
    version: number;
    purpose: string;
    contentForm: PptContentForm;
    contentFormNote?: string;
    sourceRefs: CanvasProjectPptSourceRef[];
    contentBlocks: CanvasProjectPptContentBlock[];
    contentState: PptContentState;
    lockedFacts: CanvasProjectPptLockedFact[];
    layoutRole: PptLayoutRole;
    layoutIntent: string[];
    visualEncoding: CanvasProjectPptVisualEncoding[];
    assetRefs: string[];
    freedom: string;
    /** SHA-30b：本次解析自动整理的人话记录（不从 previousPageSpec 继承，重跑即重算）。 */
    autoTidy?: string[];
    /** SHA-30c：已确认承接的理念偏离；normalizePage 显式从 previousPageSpec 继承。 */
    principleDeviations?: PptPrincipleDeviation[];
};

export type CanvasProjectPptVerbatimSpec = {
    pageId: string;
    version: number;
    title: string;
    exactText: string;
    origin: { kind: "source_slice"; sourceHash: string; startLine: number; endLine: number } | { kind: "user_edited" };
};

export type CanvasProjectPptCompilationIssue = {
    id: string;
    severity: "blocking" | "warning";
    code:
        | "missing_page_spec"
        | "review_required"
        | "override_review_required"
        | "missing_locked_copy"
        | "missing_locked_fact"
        | "unreviewed_fact"
        | "missing_required_instruction"
        | "point_count_mismatch"
        | "forbidden_conflict"
        | "layout_conflict"
        | "duplicate_instruction"
        | "invalid_style_contract"
        | "invalid_layout_role"
        | "visual_direction_outside_contract"
        | "semantic_visual_conflict"
        | "content_spec_not_approved"
        | "unresolved_information_gap"
        | "invalid_content_provenance"
        | "invalid_content_structure"
        | "invalid_visual_encoding"
        | "invalid_verbatim_spec";
    message: string;
    pageId?: string;
    takeId?: string;
};

export type CanvasProjectPptCompiledPrompt = {
    promptId: string;
    pageId: string;
    takeId: string;
    finalPrompt: string;
    sourceRefs: CanvasProjectPptSourceRef[];
    override?: string;
    issueIds: string[];
};

export type CanvasProjectPptCompilationTarget = {
    pageId: string;
    takeId: string;
    semanticText: string;
    layoutIntent: string[];
    layoutConfirmed?: boolean;
    extraTexts: string[];
    override?: string;
    overrideConfirmed?: boolean;
};

/** 整套外壳事实：页码/总页数/章节标签/整套标题。作为编译显式输入存进快照，禁止从过滤后的 pageSpecs 位置隐式推导。 */
export type CanvasProjectPptDeckShellFacts = {
    pageCount: number;
    deckTitle: string;
    pages: Array<{
        pageId: string;
        pageNumber: number;
        sectionLabel?: string;
    }>;
};

type CanvasProjectPptCompilationSnapshotBase = {
    snapshotId: string;
    compilerVersion: string;
    createdAt: string;
    inputHash: string;
    targets: CanvasProjectPptCompilationTarget[];
    prompts: CanvasProjectPptCompiledPrompt[];
    issues: CanvasProjectPptCompilationIssue[];
};

export type CanvasProjectPptCompilationSnapshot = CanvasProjectPptCompilationSnapshotBase &
    (
        | {
              compilePolicy: "structured";
              deckBriefVersion: number;
              pageSpecsVersion: number;
              styleFingerprint: string;
              deckBrief: CanvasProjectPptDeckBrief;
              pageSpecs: CanvasProjectPptPageSpec[];
              deckShell: CanvasProjectPptDeckShellFacts;
          }
        | {
              compilePolicy: "verbatim";
              verbatimSpecs: CanvasProjectPptVerbatimSpec[];
              confirmedGlobalSpec?: string;
          }
    );

type CanvasProjectPptBase = {
    sourceMaterial: string;
    requirements: string;
    pages: CanvasProjectPptPage[];
    compilationSnapshots: CanvasProjectPptCompilationSnapshot[];
    anchorConfirmed?: boolean;
    styleProofPageId?: string;
    styleProof?: {
        pageId: string;
        candidateNodeId: string;
        styleFingerprint: string;
        contentRevision: string;
    };
    styleProofCandidateIds?: string[];
    /** 批量生成确认弹窗记住的选择：true=直接生成全部、false=先锚定首页（07-17-ppt-ux-fixes #18）。 */
    skipAnchor?: boolean;
};

export type CanvasProjectPpt = CanvasProjectPptBase &
    ({ compilePolicy: "structured"; deckBrief: CanvasProjectPptDeckBrief; pageSpecs: CanvasProjectPptPageSpec[] } | { compilePolicy: "verbatim"; verbatimSpecs: CanvasProjectPptVerbatimSpec[]; confirmedGlobalSpec?: string });

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    ppt?: CanvasProjectPpt;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport" | "ppt">>) => void;
    setDeckStyleContract: (projectId: string, expectedDeckBriefVersion: number, nextContract: CanvasProjectPptStyleContract) => void;
    setPptPageLayoutRole: (projectId: string, pageId: string, expectedPageSpecVersion: number, nextRole: PptLayoutRole) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let pendingWrite: { name: string; value: StorageValue<CanvasStore> } | null = null;
let activeWrite: Promise<void> = Promise.resolve();

function writePendingNow() {
    const write = pendingWrite;
    pendingWrite = null;
    if (!write) return activeWrite;
    const nextWrite = activeWrite
        .catch(() => undefined)
        .then(async () => {
            await localForageStorage.setItem(write.name, JSON.stringify(write.value));
        });
    activeWrite = nextWrite;
    return nextWrite;
}

/**
 * 立即落盘待写入的画布状态，绕过 400ms 防抖。
 * 防抖是「每次写入都重置计时器」，连续写入会把落盘一路推迟；异步生图的 task 句柄
 * 一旦丢失就再也找不回远端任务，故提交任务后须显式 flush。
 */
export async function flushCanvasStore() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    await writePendingNow();
    while (pendingWrite) await writePendingNow();
}

/** 从与 Zustand persist 相同的 adapter 读回已落盘工程，供付费请求前做 durable gate。 */
export async function readPersistedCanvasProject(projectId: string): Promise<CanvasProject | null> {
    const value = await localForageStorage.getItem(CANVAS_STORE_KEY);
    if (!value) return null;
    const persisted = JSON.parse(value) as StorageValue<CanvasStore>;
    return (persisted.state as PersistedCanvasState).projects.find((project) => project.id === projectId) || null;
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects) return;
        queuedPersistState = nextState;
        pendingWrite = { name, value };
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void writePendingNow();
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = "未命名画布") => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || "导入画布",
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                    ppt: source.ppt,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const projects = state.projects.filter((project) => !ids.includes(project.id));
                    return { projects };
                }),
            replaceProjects: (projects) => set({ projects }),
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                })),
            setDeckStyleContract: (projectId, expectedDeckBriefVersion, nextContract) => {
                assertPptStyleContract(nextContract);
                const normalized = normalizePptStyleContract(nextContract);
                set((state) => {
                    const project = state.projects.find((item) => item.id === projectId);
                    if (!project?.ppt) throw new Error("当前工程不是 PPT 工作台工程");
                    if (project.ppt.compilePolicy !== "structured") throw new Error("逐字规格工程不使用视觉 Contract");
                    if (project.ppt.deckBrief.version !== expectedDeckBriefVersion) throw new Error("PPT 全局规格已变更，请刷新后重试");
                    if (samePptStyleContract(project.ppt.deckBrief.styleContract, normalized)) return state;
                    const styleReview = reviewPptStyle({
                        contract: normalized,
                        contentRevision: project.ppt.deckBrief.contentRevision,
                        reviewedContentRevision: project.ppt.deckBrief.contentRevision,
                        draftRevision: project.ppt.deckBrief.version + 1,
                        pageSpecs: project.ppt.pageSpecs,
                        deckRules: project.ppt.deckBrief.globalRules,
                    });
                    const blocker = styleReview.issues.find((issue) => issue.severity === "blocking");
                    if (blocker) throw new Error(`视觉系统尚未通过检查：${blocker.location}，${blocker.reason}`);
                    const styleRules = derivePptVisualDirectionRules(project.ppt.requirements);
                    const ppt: CanvasProjectPpt = {
                        ...project.ppt,
                        anchorConfirmed: false,
                        styleProofPageId: undefined,
                        styleProof: undefined,
                        deckBrief: {
                            ...project.ppt.deckBrief,
                            version: project.ppt.deckBrief.version + 1,
                            styleContract: normalized,
                            forbiddenRules: styleRules.forbiddenRules,
                        },
                        pages: project.ppt.pages.map((page) => (page.confirmedNodeId ? { ...page, confirmedNodeId: undefined } : page)),
                    };
                    return {
                        projects: state.projects.map((item) => (item.id === projectId ? { ...item, ppt, updatedAt: new Date().toISOString() } : item)),
                    };
                });
            },
            setPptPageLayoutRole: (projectId, pageId, expectedPageSpecVersion, nextRole) => {
                if (!isPptLayoutRole(nextRole)) throw new Error("页面职责无效");
                set((state) => {
                    const project = state.projects.find((item) => item.id === projectId);
                    if (!project?.ppt) throw new Error("当前工程不是 PPT 工作台工程");
                    if (project.ppt.compilePolicy !== "structured") throw new Error("逐字规格工程不使用页面职责");
                    const ppt = applyPptPageSpecUpdate(project.ppt, pageId, expectedPageSpecVersion, (pageSpec) => ({ ...pageSpec, layoutRole: nextRole }));
                    if (ppt === project.ppt) return state;
                    return {
                        projects: state.projects.map((item) => (item.id === projectId ? { ...item, ppt, updatedAt: new Date().toISOString() } : item)),
                    };
                });
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);

export function applyPptPageSpecUpdate(ppt: CanvasProjectPpt, pageId: string, expectedPageSpecVersion: number, update: (pageSpec: CanvasProjectPptPageSpec) => CanvasProjectPptPageSpec): CanvasProjectPpt {
    if (ppt.compilePolicy !== "structured") throw new Error("逐字规格工程不存在 PageSpec");
    const current = ppt.pageSpecs.find((pageSpec) => pageSpec.pageId === pageId);
    if (!current) throw new Error(`页面 ${pageId} 缺少 PageSpec`);
    if (current.version !== expectedPageSpecVersion) throw new Error(`页面 ${pageId} 的规格已变更，请刷新后重试`);
    const candidate = update(structuredClone(current));
    if (candidate.pageId !== current.pageId) throw new Error("PageSpec 更新不能改变页面身份");
    const comparable = { ...candidate, version: current.version };
    if (JSON.stringify(comparable) === JSON.stringify(current)) return ppt;
    const next = { ...candidate, version: current.version + 1 };
    const invalidatesProof = pageId === ppt.styleProofPageId;
    return {
        ...ppt,
        ...(invalidatesProof ? { anchorConfirmed: false, styleProof: undefined } : {}),
        pageSpecs: ppt.pageSpecs.map((pageSpec) => (pageSpec.pageId === pageId ? next : pageSpec)),
        pages: ppt.pages.map((page) => (page.pageId === pageId && page.confirmedNodeId ? { ...page, confirmedNodeId: undefined } : page)),
    };
}
