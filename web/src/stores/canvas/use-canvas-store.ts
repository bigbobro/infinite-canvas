import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProjectPptTake = {
    anchorNodeId: string;
    configNodeId: string;
};

export type CanvasProjectPptPage = {
    index: number;
    title: string;
    outline: string;
    visualHint: string;
    confirmedNodeId?: string;
    takes?: CanvasProjectPptTake[];
    /** @deprecated 用 takes；存量数据读时经 pageTakes() 视作 takes[0] */
    anchorNodeId?: string;
    /** @deprecated 用 takes；存量数据读时经 pageTakes() 视作 takes[0] */
    configNodeId?: string;
};

/**
 * 归一读取某页的全部线路（take）。存量数据只有单值 anchorNodeId/configNodeId，
 * 读时视作单元素数组；不写迁移脚本、不做一次性升级（design §2.1，纯前端 localforage，
 * 存量 PPT 工程躺在用户浏览器里，不可破坏）。
 */
export function pageTakes(page: CanvasProjectPptPage): CanvasProjectPptTake[] {
    if (page.takes?.length) return page.takes;
    if (page.anchorNodeId && page.configNodeId) return [{ anchorNodeId: page.anchorNodeId, configNodeId: page.configNodeId }];
    return [];
}

export type CanvasProjectPpt = {
    sourceMaterial: string;
    requirements: string;
    style: { description: string; references: { storageKey: string }[] };
    pages: CanvasProjectPptPage[];
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

function writePendingNow() {
    const write = pendingWrite;
    pendingWrite = null;
    if (!write) return Promise.resolve();
    return localForageStorage.setItem(write.name, JSON.stringify(write.value));
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
