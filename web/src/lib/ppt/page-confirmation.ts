import type { CanvasProjectPpt } from "@/stores/canvas/use-canvas-store";

/**
 * 设定/取消某页的最终版确认节点。精修台与终审必须共用这一实现（design §17），
 * 不允许两处各写一套 pages.map 逻辑。
 */
export function setPptPageConfirmedNode(ppt: CanvasProjectPpt, pageId: string, confirmedNodeId: string | undefined): CanvasProjectPpt {
    return {
        ...ppt,
        pages: ppt.pages.map((page) => (page.pageId === pageId ? { ...page, confirmedNodeId } : page)),
    };
}
