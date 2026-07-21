import { useEffect, useRef, useState } from "react";
import { App, Button, Input, theme as antdTheme } from "antd";
import { ChevronDown, ImagePlus, Trash2 } from "lucide-react";

import { PPT_VISUAL_DIRECTION_PRESETS, createPptStyleContractDraft, getPptVisualDirectionPreset, isPptStyleContractValid } from "@/lib/ppt/style-contract";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { CanvasProjectPptStyleContract, PptVisualDirectionPresetId } from "@/stores/canvas/use-canvas-store";

type Props = {
    value: CanvasProjectPptStyleContract;
    onChange: (value: CanvasProjectPptStyleContract) => void;
    extractedDirectionHint?: string;
};

export function PptVisualDirectionEditor({ value, onChange, extractedDirectionHint }: Props) {
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const validValue = isPptStyleContractValid(value);
    const draft = createPptStyleContractDraft(value);
    const [advancedOpen, setAdvancedOpen] = useState(!validValue || draft.source.kind === "custom" || draft.references.length > 0);
    const [uploading, setUploading] = useState(false);

    const selectPreset = (presetId: PptVisualDirectionPresetId) => {
        const preset = getPptVisualDirectionPreset(presetId);
        onChange({ source: { kind: "preset", presetId }, direction: preset.direction, references: draft.references });
    };

    const addReferences = async (files: FileList | null) => {
        const images = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!images.length) return;
        setUploading(true);
        try {
            const results = await Promise.allSettled(images.map((file) => uploadImage(file)));
            const uploaded = results.flatMap((result) => (result.status === "fulfilled" ? [{ storageKey: result.value.storageKey }] : []));
            const failedNames = results.flatMap((result, index) => (result.status === "rejected" ? [images[index].name] : []));
            if (uploaded.length) {
                const seen = new Set(draft.references.map((reference) => reference.storageKey));
                onChange({ ...draft, references: [...draft.references, ...uploaded.filter((reference) => !seen.has(reference.storageKey))] });
            }
            if (failedNames.length) {
                const detail = failedNames.join("、");
                if (uploaded.length) message.warning(`${failedNames.length} 张上传失败：${detail}`);
                else message.error(`参考图上传失败：${detail}`);
            }
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="视觉方向">
                {PPT_VISUAL_DIRECTION_PRESETS.map((preset) => {
                    const selected = validValue && draft.source.kind === "preset" && draft.source.presetId === preset.id;
                    return (
                        <button
                            key={preset.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className="group rounded-xl border p-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{
                                borderColor: selected ? token.colorPrimary : token.colorBorderSecondary,
                                background: selected ? token.colorPrimaryBg : token.colorBgContainer,
                                outlineColor: token.colorPrimary,
                            }}
                            onClick={() => selectPreset(preset.id)}
                        >
                            <DirectionPreview presetId={preset.id} />
                            <span className="mt-2.5 block text-sm font-medium" style={{ color: token.colorText }}>
                                {preset.label}
                            </span>
                            <span className="mt-0.5 block text-xs leading-5" style={{ color: token.colorTextSecondary }}>
                                {preset.description}
                            </span>
                        </button>
                    );
                })}
            </div>

            <details open={advancedOpen} className="rounded-xl border" style={{ borderColor: token.colorBorderSecondary, background: token.colorBgContainer }} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
                <summary
                    className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ color: token.colorText, outlineColor: token.colorPrimary }}
                >
                    <span>
                        高级设置
                        <span className="ml-2 text-xs font-normal" style={{ color: token.colorTextSecondary }}>
                            自定义方向与参考图
                        </span>
                    </span>
                    <ChevronDown className={`size-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`} aria-hidden="true" />
                </summary>

                <div className="space-y-4 border-t px-3.5 py-4" style={{ borderColor: token.colorBorderSecondary }}>
                    <label className="grid gap-1.5">
                        <span className="text-sm font-medium" style={{ color: token.colorText }}>
                            自定义方向
                        </span>
                        {extractedDirectionHint ? (
                            <span className="text-xs leading-5" style={{ color: token.colorTextSecondary }}>
                                已从原稿未占用内容中带入候选说明，请确认后再建图。
                            </span>
                        ) : null}
                        <Input.TextArea
                            value={draft.direction}
                            autoSize={{ minRows: 3, maxRows: 10 }}
                            placeholder="说明配色、信息层级、图形语言和画面气质"
                            onChange={(event) => onChange({ ...draft, source: { kind: "custom" }, direction: event.target.value })}
                        />
                        <span className="text-xs" style={{ color: token.colorTextSecondary }}>
                            修改后会作为整套 PPT 的视觉方向，不会覆盖单页内容。
                        </span>
                    </label>

                    <div>
                        <div className="mb-2 flex items-center justify-between gap-3">
                            <div>
                                <div className="text-sm font-medium" style={{ color: token.colorText }}>
                                    参考图
                                </div>
                                <div className="mt-0.5 text-xs" style={{ color: token.colorTextSecondary }}>
                                    作为整套 deck 的视觉参考，本地保存。
                                </div>
                            </div>
                            <Button type="text" size="small" icon={<ImagePlus className="size-3.5" />} loading={uploading} onClick={() => fileInputRef.current?.click()}>
                                添加
                            </Button>
                        </div>

                        {draft.references.length ? (
                            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                                {draft.references.map((reference, index) => (
                                    <ReferenceThumbnail
                                        key={reference.storageKey}
                                        storageKey={reference.storageKey}
                                        index={index}
                                        onRemove={() => onChange({ ...draft, references: draft.references.filter((item) => item.storageKey !== reference.storageKey) })}
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className="flex min-h-20 items-center justify-center rounded-lg border border-dashed text-xs" style={{ borderColor: token.colorBorderSecondary, color: token.colorTextSecondary }}>
                                暂无参考图
                            </div>
                        )}

                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            onChange={(event) => {
                                void addReferences(event.target.files);
                                event.target.value = "";
                            }}
                        />
                    </div>
                </div>
            </details>
        </div>
    );
}

function DirectionPreview({ presetId }: { presetId: PptVisualDirectionPresetId }) {
    const { token } = antdTheme.useToken();
    const baseStyle = { background: token.colorBgLayout, borderColor: token.colorBorderSecondary };
    if (presetId === "visual-story") {
        return (
            <span className="relative block aspect-video overflow-hidden rounded-lg border" style={baseStyle} aria-hidden="true">
                <span className="absolute -bottom-5 -right-3 size-24 rounded-full opacity-70" style={{ background: token.colorPrimary }} />
                <span className="absolute left-3 top-3 h-1.5 w-8 rounded-full" style={{ background: token.colorText }} />
                <span className="absolute left-3 top-7 h-1 w-14 rounded-full opacity-50" style={{ background: token.colorTextSecondary }} />
                <span className="absolute bottom-3 left-3 text-[9px] font-semibold" style={{ color: token.colorText }}>
                    ONE IDEA
                </span>
            </span>
        );
    }
    if (presetId === "brand-led") {
        return (
            <span className="relative block aspect-video overflow-hidden rounded-lg border" style={{ ...baseStyle, background: token.colorPrimary }} aria-hidden="true">
                <span className="absolute left-0 top-0 h-full w-[38%]" style={{ background: token.colorPrimaryActive }} />
                <span className="absolute left-3 top-3 size-4 rounded-full" style={{ background: token.colorBgContainer }} />
                <span className="absolute bottom-3 left-3 h-1.5 w-10 rounded-full" style={{ background: token.colorBgContainer }} />
                <span className="absolute right-3 top-3 h-12 w-20 rounded-md border opacity-80" style={{ borderColor: token.colorBgContainer }} />
            </span>
        );
    }
    return (
        <span className="relative block aspect-video overflow-hidden rounded-lg border" style={baseStyle} aria-hidden="true">
            <span className="absolute left-3 top-3 h-1.5 w-12 rounded-full" style={{ background: token.colorPrimary }} />
            <span className="absolute left-3 top-7 h-1 w-20 rounded-full" style={{ background: token.colorTextSecondary }} />
            <span className="absolute bottom-3 left-3 right-3 grid h-10 grid-cols-3 gap-1.5">
                {[0, 1, 2].map((item) => (
                    <span key={item} className="rounded border" style={{ borderColor: token.colorBorder, background: token.colorBgContainer }} />
                ))}
            </span>
        </span>
    );
}

function ReferenceThumbnail({ storageKey, index, onRemove }: { storageKey: string; index: number; onRemove: () => void }) {
    const { token } = antdTheme.useToken();
    const [url, setUrl] = useState("");

    useEffect(() => {
        let active = true;
        void resolveImageUrl(storageKey, "").then((nextUrl) => {
            if (active) setUrl(nextUrl);
        });
        return () => {
            active = false;
        };
    }, [storageKey]);

    return (
        <div className="group relative aspect-square overflow-hidden rounded-lg border" style={{ borderColor: token.colorBorderSecondary, background: token.colorBgLayout }}>
            {url ? (
                <img src={url} alt={`视觉参考图 ${index + 1}`} className="size-full object-cover" />
            ) : (
                <span className="flex size-full items-center justify-center text-[10px]" style={{ color: token.colorTextSecondary }}>
                    读取中
                </span>
            )}
            <button
                type="button"
                className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-md bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
                aria-label={`移除视觉参考图 ${index + 1}`}
                onClick={onRemove}
            >
                <Trash2 className="size-3.5" />
            </button>
        </div>
    );
}
