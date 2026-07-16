import { create } from "zustand";

// 二开：PPT Annotate（图节点上点位标注改图）的宿主状态，仅记录当前正在标注的节点 id。
// 不持久化——标注是一次性交互，刷新页面无需恢复。
type AnnotateStore = {
    annotateNodeId: string | null;
    open: (id: string) => void;
    close: () => void;
};

export const useAnnotateStore = create<AnnotateStore>((set) => ({
    annotateNodeId: null,
    open: (id) => set({ annotateNodeId: id }),
    close: () => set({ annotateNodeId: null }),
}));
