"use client";

import { Select } from "antd";
import { Cpu } from "lucide-react";

import styles from "./model-picker.module.css";
import type { AiConfig } from "@/stores/use-config-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

export function ModelPicker({ config, value, onChange, className, fullWidth = false, placeholder = "选择模型", onMissingConfig }: ModelPickerProps) {
    const options = Array.from(new Set([value, ...config.models].filter(Boolean))).map((model) => ({ value: model, label: <ModelLabel model={model} /> }));
    const width = fullWidth ? "100%" : `min(${Math.max(156, (value || placeholder).length * 8 + 64)}px, 100%)`;

    return (
        <Select
            showSearch
            className={`canvas-control-select ${className || ""}`}
            classNames={{ popup: { root: styles.dropdown } }}
            popupMatchSelectWidth
            popupRender={(menu) => (
                <div onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                    {menu}
                </div>
            )}
            style={{ width, maxWidth: "100%", minWidth: 0, flexShrink: 1 }}
            value={value || undefined}
            placeholder={placeholder}
            options={options}
            notFoundContent="请先到配置里拉取模型列表"
            onChange={onChange}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
                if (!options.length) onMissingConfig?.();
            }}
            filterOption={(input, option) =>
                String(option?.value || "")
                    .toLowerCase()
                    .includes(input.toLowerCase())
            }
        />
    );
}

function ModelLabel({ model }: { model: string }) {
    const icon = resolveModelIcon(model);
    return (
        <span className="model-picker-label flex min-w-0 items-center gap-2">
            {icon ? <img src={icon} alt="" className="size-4 shrink-0" /> : <Cpu className="size-4 shrink-0 opacity-70" />}
            <span className="model-picker-label-text truncate">{model}</span>
        </span>
    );
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    return "";
}
