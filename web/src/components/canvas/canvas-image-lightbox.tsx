import { useEffect, useState } from "react";
import { Modal } from "antd";
import { Maximize2, ScanSearch } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type Props = {
    src: string | null;
    alt?: string;
    onClose: () => void;
};

/**
 * 图片看大弹层：精修台候选大图、终审主图共用（#19）。画布图片节点自带的「查看大图」
 * 只是无缩放的定宽 Modal，没有「适应屏幕/1:1」切换，不满足需求，这里单独抽一份最小实现，
 * 不去改造 project.tsx 里那份（各自场景独立，互不依赖）。
 * Esc 关闭、点击遮罩关闭均由 antd Modal 默认行为提供（keyboard/maskClosable 默认 true）。
 */
export function CanvasImageLightbox({ src, alt, onClose }: Props) {
    const canvasTheme = canvasThemes[useThemeStore((state) => state.theme)];
    const [fitScreen, setFitScreen] = useState(true);

    useEffect(() => {
        setFitScreen(true);
    }, [src]);

    if (!src) return null;

    return (
        <Modal open onCancel={onClose} footer={null} closable width="auto" centered destroyOnHidden title={null} classNames={{ header: "sr-only" }} styles={{ body: { padding: 0 }, container: { background: canvasTheme.node.panel, padding: 12 } }}>
            <div className="flex max-h-[86vh] max-w-[90vw] flex-col gap-2">
                <div className="flex items-center justify-end gap-1 px-1">
                    <button
                        type="button"
                        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition"
                        style={{ background: fitScreen ? canvasTheme.toolbar.activeBg : "transparent", color: fitScreen ? canvasTheme.toolbar.activeText : canvasTheme.node.muted }}
                        onClick={() => setFitScreen(true)}
                    >
                        <ScanSearch className="size-3.5" aria-hidden="true" />
                        适应屏幕
                    </button>
                    <button
                        type="button"
                        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition"
                        style={{ background: !fitScreen ? canvasTheme.toolbar.activeBg : "transparent", color: !fitScreen ? canvasTheme.toolbar.activeText : canvasTheme.node.muted }}
                        onClick={() => setFitScreen(false)}
                    >
                        <Maximize2 className="size-3.5" aria-hidden="true" />
                        1:1
                    </button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto rounded-lg" style={{ background: canvasTheme.canvas.background }}>
                    {fitScreen ? <img src={src} alt={alt || ""} className="block max-h-[78vh] max-w-[86vw] object-contain" /> : <img src={src} alt={alt || ""} className="block" style={{ maxWidth: "none", maxHeight: "none" }} />}
                </div>
            </div>
        </Modal>
    );
}
