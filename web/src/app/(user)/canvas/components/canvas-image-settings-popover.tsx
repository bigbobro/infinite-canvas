"use client";

import { Settings2 } from "lucide-react";
import { Button, Popover } from "antd";

import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onOpenChange, buttonClassName, getPopupContainer, placement = "topLeft" }: CanvasImageSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const quality = config.quality || "auto";
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";

    return (
        <Popover
            trigger="click"
            placement={placement}
            arrow={false}
            overlayClassName="canvas-image-settings-popover"
            color={theme.toolbar.panel}
            getPopupContainer={getPopupContainer || ((triggerNode) => triggerNode.parentElement || document.body)}
            onOpenChange={onOpenChange}
            content={<ImageSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} />}
        >
            <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[180px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />}>
                <span className="truncate">
                    {imageQualityLabel(quality)} · {imageSizeLabel(activeSize)} · {count} 张
                </span>
            </Button>
        </Popover>
    );
}
