import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProjectPptTake = {
    takeId: string;
    anchorNodeId: string;
    configNodeId: string;
};

export type CanvasProjectPptPage = {
    pageId: string;
    index: number;
    title: string;
    outline: string;
    visualHint: string;
    confirmedNodeId?: string;
    takes: CanvasProjectPptTake[];
};

export type CanvasProjectPptSourceRef = {
    source: "material" | "imported_spec";
    excerpt: string;
    startLine?: number;
    endLine?: number;
};

export type CanvasProjectPptLockedFact = {
    id: string;
    kind: "number" | "term" | "point_count" | "table";
    value: string;
    sourceExcerpt: string;
};

export type CanvasProjectPptDeckBrief = {
    version: number;
    audience: string;
    goal: string;
    narrative: string;
    visualLanguage: string;
    globalRules: string[];
    forbiddenRules: string[];
    lockedDeckFacts: CanvasProjectPptLockedFact[];
};

export type CanvasProjectPptPageSpec = {
    pageId: string;
    version: number;
    sourceRefs: CanvasProjectPptSourceRef[];
    lockedCopy: string[];
    lockedFacts: CanvasProjectPptLockedFact[];
    message: string;
    layoutIntent: string[];
    assetRefs: string[];
    freedom: string;
    requiresReview: boolean;
    reviewReason?: string;
    reviewedAt?: string;
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
        | "duplicate_instruction";
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
    styleTexts: string[];
    extraTexts: string[];
    override?: string;
    overrideConfirmed?: boolean;
};

export type CanvasProjectPptCompilationSnapshot = {
    snapshotId: string;
    compilerVersion: string;
    createdAt: string;
    deckBriefVersion: number;
    pageSpecsVersion: number;
    deckBrief: CanvasProjectPptDeckBrief;
    pageSpecs: CanvasProjectPptPageSpec[];
    targets: CanvasProjectPptCompilationTarget[];
    prompts: CanvasProjectPptCompiledPrompt[];
    issues: CanvasProjectPptCompilationIssue[];
};

export type CanvasProjectPpt = {
    sourceMaterial: string;
    requirements: string;
    style: { description: string; references: { storageKey: string }[] };
    pages: CanvasProjectPptPage[];
    deckBrief: CanvasProjectPptDeckBrief;
    pageSpecs: CanvasProjectPptPageSpec[];
    compilationSnapshots: CanvasProjectPptCompilationSnapshot[];
    anchorConfirmed?: boolean;
    mode?: "outline" | "extract";
    /** 批量生成确认弹窗记住的选择：true=直接生成全部、false=先锚定首页（07-17-ppt-ux-fixes #18）。 */
    skipAnchor?: boolean;
};

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
