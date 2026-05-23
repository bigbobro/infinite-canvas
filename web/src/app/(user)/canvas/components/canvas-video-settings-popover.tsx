"use client";

import { type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { Button, Popover } from "antd";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasImageSettingsTheme } from "./canvas-image-settings-popover";

const qualityOptions = [
    { value: "auto", label: "自动" },
    { value: "high", label: "高" },
    { value: "medium", label: "中" },
    { value: "low", label: "低" },
];
const sizeOptions = [
    { value: "1280x720", label: "横屏" },
    { value: "720x1280", label: "竖屏" },
];
const secondOptions = [6, 10, 12, 16, 20];

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

export function CanvasVideoSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft" }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const seconds = Math.max(1, Math.min(60, Math.floor(Math.abs(Number(config.videoSeconds)) || 6)));
    const size = normalizeVideoSize(config.size);
    const vquality = config.vquality || "auto";

    return (
        <Popover
            trigger="click"
            placement={placement}
            arrow={false}
            overlayClassName="canvas-image-settings-popover"
            color={theme.toolbar.panel}
            getPopupContainer={(triggerNode) => triggerNode.parentElement || document.body}
            content={
                <CanvasImageSettingsTheme theme={theme}>
                    <div className="w-[320px] space-y-5 rounded-3xl px-1 py-0.5" style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                        <div className="text-xl font-semibold">视频设置</div>
                        <SettingGroup title="质量" color={theme.node.muted}>
                            <div className="grid grid-cols-4 gap-3">
                                {qualityOptions.map((item) => (
                                    <OptionPill key={item.value} selected={vquality === item.value} theme={theme} onClick={() => onConfigChange("vquality", item.value)}>
                                        {item.label}
                                    </OptionPill>
                                ))}
                            </div>
                        </SettingGroup>
                        <SettingGroup title="尺寸" color={theme.node.muted}>
                            <div className="grid grid-cols-2 gap-3">
                                {sizeOptions.map((item) => (
                                    <OptionPill key={item.value} selected={size === item.value} theme={theme} onClick={() => onConfigChange("size", item.value)}>
                                        {item.label}
                                    </OptionPill>
                                ))}
                            </div>
                        </SettingGroup>
                        <SettingGroup title="秒数" color={theme.node.muted}>
                            <div className="grid grid-cols-5 gap-2">
                                {secondOptions.map((value) => (
                                    <OptionPill key={value} selected={seconds === value} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>
                                        {value}s
                                    </OptionPill>
                                ))}
                                <input
                                    type="number"
                                    min={1}
                                    max={60}
                                    className="col-span-2 h-10 rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                    style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                                    value={seconds}
                                    onChange={(event) => onConfigChange("videoSeconds", String(Number(event.target.value) || 6))}
                                    onMouseDown={(event) => event.stopPropagation()}
                                />
                            </div>
                        </SettingGroup>
                    </div>
                </CanvasImageSettingsTheme>
            }
        >
            <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />}>
                <span className="truncate">
                    {qualityLabel(vquality)} · {sizeLabel(size)} · {seconds}s
                </span>
            </Button>
        </Popover>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" className="h-10 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-3">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function normalizeVideoSize(value: string) {
    if (/^\d+x\d+$/.test(value || "")) return value;
    return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
}

function qualityLabel(value: string) {
    return ({ auto: "自动", high: "高", medium: "中", low: "低" } as Record<string, string>)[value] || value;
}

function sizeLabel(value: string) {
    return value === "720x1280" ? "竖屏" : "横屏";
}
