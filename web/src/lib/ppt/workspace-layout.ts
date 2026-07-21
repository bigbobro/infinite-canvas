export const PPT_WORKSPACE_UPPER_MIN_HEIGHT = 200;
export const PPT_WORKSPACE_LOWER_MIN_HEIGHT = 160;
export const PPT_WORKSPACE_SPLITTER_SIZE = 8;
export const PPT_WORKSPACE_SPLITTER_KEY_STEP = 24;

export function canEnablePptWorkspaceSplitter(containerHeight: number) {
    return Number.isFinite(containerHeight) && containerHeight >= PPT_WORKSPACE_UPPER_MIN_HEIGHT + PPT_WORKSPACE_SPLITTER_SIZE + PPT_WORKSPACE_LOWER_MIN_HEIGHT;
}

export function clampPptWorkspaceUpperHeight(upperHeight: number, containerHeight: number) {
    const safeContainerHeight = Number.isFinite(containerHeight) ? Math.max(0, containerHeight) : 0;
    const maxUpperHeight = Math.max(PPT_WORKSPACE_UPPER_MIN_HEIGHT, safeContainerHeight - PPT_WORKSPACE_SPLITTER_SIZE - PPT_WORKSPACE_LOWER_MIN_HEIGHT);
    const safeUpperHeight = Number.isFinite(upperHeight) ? upperHeight : PPT_WORKSPACE_UPPER_MIN_HEIGHT;
    return Math.min(Math.max(safeUpperHeight, PPT_WORKSPACE_UPPER_MIN_HEIGHT), maxUpperHeight);
}

export function resizePptWorkspaceByDrag(upperHeight: number, deltaY: number, containerHeight: number) {
    return clampPptWorkspaceUpperHeight(upperHeight + (Number.isFinite(deltaY) ? deltaY : 0), containerHeight);
}

export function resizePptWorkspaceByKey(upperHeight: number, key: "ArrowUp" | "ArrowDown", containerHeight: number) {
    return clampPptWorkspaceUpperHeight(upperHeight + (key === "ArrowUp" ? -PPT_WORKSPACE_SPLITTER_KEY_STEP : PPT_WORKSPACE_SPLITTER_KEY_STEP), containerHeight);
}
