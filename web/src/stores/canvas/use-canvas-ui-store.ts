import { create } from "zustand";

type CanvasUiStore = {
    editingProjectId: string | null;
    editingProjectTitle: string;
    selectedProjectIds: string[];
    deleteProjectIds: string[];
    /** PPT 精修台/最终检视是否打开（#34）：打开期间画布节点悬浮工具条不得渲染，避免误点删除底层节点。 */
    pptOverlayOpen: boolean;
    startEditingProject: (id: string, title: string) => void;
    setEditingProjectTitle: (title: string) => void;
    stopEditingProject: () => void;
    toggleSelectedProjectId: (id: string, selected: boolean) => void;
    setDeleteProjectIds: (ids: string[]) => void;
    removeSelectedProjectIds: (ids: string[]) => void;
    setPptOverlayOpen: (open: boolean) => void;
};

export const useCanvasUiStore = create<CanvasUiStore>((set) => ({
    editingProjectId: null,
    editingProjectTitle: "",
    selectedProjectIds: [],
    deleteProjectIds: [],
    pptOverlayOpen: false,
    startEditingProject: (editingProjectId, editingProjectTitle) => set({ editingProjectId, editingProjectTitle }),
    setEditingProjectTitle: (editingProjectTitle) => set({ editingProjectTitle }),
    stopEditingProject: () => set({ editingProjectId: null }),
    toggleSelectedProjectId: (id, selected) => set((state) => ({ selectedProjectIds: selected ? [...new Set([...state.selectedProjectIds, id])] : state.selectedProjectIds.filter((item) => item !== id) })),
    setDeleteProjectIds: (deleteProjectIds) => set({ deleteProjectIds }),
    removeSelectedProjectIds: (ids) => set((state) => ({ selectedProjectIds: state.selectedProjectIds.filter((id) => !ids.includes(id)) })),
    setPptOverlayOpen: (pptOverlayOpen) => set({ pptOverlayOpen }),
}));
