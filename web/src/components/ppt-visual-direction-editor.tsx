import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Input, Segmented, Select, theme as antdTheme } from "antd";
import { Check, ChevronDown, ImagePlus, RefreshCw, ShieldCheck, Sparkles, Trash2 } from "lucide-react";

import { PPT_LAYOUT_ROLES, PPT_VISUAL_DIRECTION_PRESETS, createPptStyleContractDraft, createPptVisualDirectionPresetContract, isPptStyleContractValid } from "@/lib/ppt/style-contract";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { CanvasProjectPptStyleContract } from "@/stores/canvas/use-canvas-store";
import { modelOptionLabel, useEffectiveConfig } from "@/stores/use-config-store";

export type PptVisualDirectionCandidate = {
    id: string;
    label: string;
    rationale: string;
    recommended: boolean;
    contract: CanvasProjectPptStyleContract;
};

export type PptVisualDirectionEditorProps = {
    value: CanvasProjectPptStyleContract;
    onChange: (value: CanvasProjectPptStyleContract) => void;
    candidates?: PptVisualDirectionCandidate[];
    selectedCandidateId?: string;
    onSelectCandidate?: (id: string) => void;
    pageCount?: number;
    loading?: boolean;
    error?: string;
    onRetry?: () => void;
    onUseFallback?: () => void;
    onAddReferences?: (references: Array<{ storageKey: string }>) => void;
    extractedDirectionHint?: string;
    receivedCharacters?: number;
};

type StyleModel = CanvasProjectPptStyleContract["modelStyle"];
type PaletteKey = keyof StyleModel["palette"];
type GraphicLanguageKey = keyof StyleModel["graphicLanguage"];

const BUILT_IN_CANDIDATES: PptVisualDirectionCandidate[] = PPT_VISUAL_DIRECTION_PRESETS.map((preset, index) => ({
    id: preset.id,
    label: preset.label,
    rationale: preset.description,
    recommended: index === 0,
    contract: createPptVisualDirectionPresetContract(preset.id),
}));

const PALETTE_FIELDS: Array<{ key: PaletteKey; label: string }> = [
    { key: "background", label: "背景" },
    { key: "surface", label: "内容表面" },
    { key: "text", label: "正文" },
    { key: "mutedText", label: "次要文字" },
    { key: "primary", label: "主色" },
    { key: "accent", label: "强调色" },
];

const GRAPHIC_FIELDS: Array<{ key: GraphicLanguageKey; label: string; placeholder: string }> = [
    { key: "card", label: "卡片", placeholder: "边框、圆角、层次与阴影规则" },
    { key: "chart", label: "图表", placeholder: "坐标、标注与重点数据的表达规则" },
    { key: "icon", label: "图标", placeholder: "图标风格、线宽与使用边界" },
    { key: "illustration", label: "插画", placeholder: "插画题材、质感与空间层次" },
    { key: "imageTreatment", label: "图片处理", placeholder: "裁切、调色、滤镜与蒙版规则" },
];

const DENSITY_OPTIONS = [
    { label: "疏朗", value: "airy" },
    { label: "均衡", value: "balanced" },
    { label: "紧凑", value: "dense" },
] as const;

const HEADING_OPTIONS = [
    { label: "无衬线", value: "sans" },
    { label: "衬线", value: "serif" },
    { label: "展示型", value: "display" },
] as const;

const BODY_OPTIONS = [
    { label: "无衬线", value: "sans" },
    { label: "衬线", value: "serif" },
] as const;

const HIERARCHY_OPTIONS = [
    { label: "克制", value: "quiet" },
    { label: "均衡", value: "balanced" },
    { label: "强对比", value: "strong" },
] as const;

const SAFE_AREA_OPTIONS = [
    { label: "紧凑", value: "compact" },
    { label: "标准", value: "regular" },
    { label: "宽松", value: "generous" },
] as const;

const TITLE_REGION_OPTIONS = [
    { label: "左上", value: "top-left" },
    { label: "顶部居中", value: "top-center" },
    { label: "画面中央", value: "center" },
] as const;

const HEADER_OPTIONS = [
    { label: "无页眉", value: "none" },
    { label: "整套标题", value: "deck-title" },
    { label: "章节标签", value: "section-label" },
] as const;

const FOOTER_OPTIONS = [
    { label: "无页脚", value: "none" },
    { label: "页码", value: "page-number" },
    { label: "整套标题 + 页码", value: "deck-title-and-page-number" },
] as const;

export function PptVisualDirectionEditor({
    value,
    onChange,
    candidates,
    selectedCandidateId,
    onSelectCandidate,
    pageCount,
    loading = false,
    error,
    onRetry,
    onUseFallback,
    onAddReferences,
    extractedDirectionHint,
    receivedCharacters = 0,
}: PptVisualDirectionEditorProps) {
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const effectiveConfig = useEffectiveConfig();
    const modelValue = effectiveConfig.textModel || effectiveConfig.model;
    const modelLabel = modelValue ? modelOptionLabel(effectiveConfig, modelValue) : "";
    const fileInputRef = useRef<HTMLInputElement>(null);
    const valueRef = useRef(value);
    const onChangeRef = useRef(onChange);
    const onAddReferencesRef = useRef(onAddReferences);
    const [uploading, setUploading] = useState(false);
    valueRef.current = value;
    onChangeRef.current = onChange;
    onAddReferencesRef.current = onAddReferences;
    const validValue = isPptStyleContractValid(value);
    const draft = hasEditableContractShape(value) ? value : createPptStyleContractDraft(value);
    const displayedCandidates = candidates === undefined ? BUILT_IN_CANDIDATES : candidates;
    const inferredCandidateId = draft.source.kind === "preset" ? draft.source.presetId : draft.source.kind === "generated" ? draft.source.candidateId : undefined;
    const activeCandidateId = selectedCandidateId ?? inferredCandidateId;
    const extractedHint = extractedDirectionHint?.trim() || "";
    const extractedMood = splitList(extractedHint);
    const extractedHintApplied = Boolean(extractedMood.length && extractedMood.every((item) => draft.modelStyle.mood.includes(item)));

    const updateModel = (modelStyle: StyleModel) => onChange({ ...draft, source: { kind: "custom" }, modelStyle });
    const selectCandidate = (candidate: PptVisualDirectionCandidate) => {
        if (!isPptStyleContractValid(candidate.contract)) return;
        const next = createPptStyleContractDraft(candidate.contract);
        if (onSelectCandidate) onSelectCandidate(candidate.id);
        else onChange({ ...next, references: draft.references });
    };
    const useFallback = () => {
        const fallback = BUILT_IN_CANDIDATES[0];
        if (onUseFallback) onUseFallback();
        else selectCandidate(fallback);
    };
    const adoptExtractedHint = () => {
        if (!extractedMood.length || extractedHintApplied) return;
        updateModel({ ...draft.modelStyle, mood: unique([...draft.modelStyle.mood, ...extractedMood]) });
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
                if (onAddReferencesRef.current) onAddReferencesRef.current(uploaded);
                else {
                    const latest = createPptStyleContractDraft(valueRef.current);
                    const seen = new Set(latest.references.map((reference) => reference.storageKey));
                    onChangeRef.current({ ...latest, references: [...latest.references, ...uploaded.filter((reference) => !seen.has(reference.storageKey))] });
                }
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
        <div className="space-y-5">
            <section className="overflow-hidden rounded-2xl border" style={{ borderColor: token.colorBorderSecondary, background: token.colorBgContainer }}>
                <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="max-w-2xl">
                        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-[0.18em]" style={{ color: token.colorPrimary }}>
                            <ShieldCheck className="size-3.5" aria-hidden="true" />
                            DECK STYLE CONTRACT
                        </div>
                        <h2 className="text-lg font-semibold tracking-tight" style={{ color: token.colorText }}>
                            整套视觉系统 · {typeof pageCount === "number" ? `应用于全部 ${pageCount} 页` : "应用于全部页面"}
                        </h2>
                        <p className="mt-1.5 text-sm leading-6" style={{ color: token.colorTextSecondary }}>
                            先确定一套全局规则，再让封面、内容页与证据页在同一系统内变化。
                        </p>
                    </div>
                    <span
                        className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-xs font-medium"
                        style={{
                            borderColor: validValue ? token.colorSuccessBorder : token.colorWarningBorder,
                            background: validValue ? token.colorSuccessBg : token.colorWarningBg,
                            color: validValue ? token.colorSuccessText : token.colorWarningText,
                        }}
                    >
                        {validValue ? <Check className="size-3.5" aria-hidden="true" /> : null}
                        {validValue ? "Contract 可用" : "需要修复"}
                    </span>
                </div>
                <div className="h-px" style={{ background: token.colorBorderSecondary }} />
                <ContractSummary contract={draft} />
            </section>

            {!validValue ? (
                <Alert
                    type="warning"
                    showIcon
                    title="当前视觉 Contract 不完整"
                    description="已展示一套可继续编辑的安全草稿。你可以选择候选方向，或直接使用稳妥方案继续。"
                    action={
                        <Button size="small" onClick={useFallback}>
                            使用稳妥方案
                        </Button>
                    }
                />
            ) : null}

            <section>
                <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                    <div>
                        <h3 className="text-sm font-semibold" style={{ color: token.colorText }}>
                            选择视觉方向
                        </h3>
                        <p className="mt-1 text-xs leading-5" style={{ color: token.colorTextSecondary }}>
                            三类页面同时预览，避免只凭风格名称做决定。
                        </p>
                    </div>
                    {loading ? (
                        <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: token.colorTextSecondary }}>
                            <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                            {modelLabel ? `正在使用 ${modelLabel} 匹配视觉方向 · 已接收 ${receivedCharacters} 字符` : "正在匹配视觉方向"}
                        </span>
                    ) : null}
                </div>

                {error ? (
                    <div className="mb-3 flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between" role="alert" style={{ borderColor: token.colorErrorBorder, background: token.colorErrorBg }}>
                        <div>
                            <div className="text-sm font-medium" style={{ color: token.colorErrorText }}>
                                视觉方向推荐失败
                            </div>
                            <div className="mt-1 text-xs leading-5" style={{ color: token.colorTextSecondary }}>
                                {error}
                            </div>
                            {modelLabel ? (
                                <div className="mt-1 text-xs leading-5" style={{ color: token.colorTextTertiary }}>
                                    本次使用模型：{modelLabel}
                                </div>
                            ) : null}
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                            {onRetry ? (
                                <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={onRetry}>
                                    重试推荐
                                </Button>
                            ) : null}
                            <Button size="small" type="primary" onClick={useFallback}>
                                使用稳妥方案
                            </Button>
                        </div>
                    </div>
                ) : null}

                {loading && displayedCandidates.length === 0 ? (
                    <div className="grid gap-3 lg:grid-cols-3" aria-label="正在生成视觉方向候选">
                        {[0, 1, 2].map((item) => (
                            <LoadingCandidate key={item} />
                        ))}
                    </div>
                ) : displayedCandidates.length ? (
                    <div className="grid gap-3 lg:grid-cols-3" role="radiogroup" aria-label="视觉方向候选">
                        {displayedCandidates.map((candidate) => {
                            const selected = activeCandidateId === candidate.id;
                            const validCandidate = isPptStyleContractValid(candidate.contract);
                            return (
                                <button
                                    key={candidate.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    disabled={!validCandidate}
                                    className="group min-w-0 overflow-hidden rounded-2xl border text-left transition-[border-color,box-shadow,transform] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-55"
                                    style={{
                                        borderColor: selected ? token.colorPrimary : token.colorBorderSecondary,
                                        background: token.colorBgContainer,
                                        boxShadow: selected ? `0 0 0 2px ${token.colorPrimaryBg}` : "none",
                                        outlineColor: token.colorPrimary,
                                    }}
                                    onClick={() => selectCandidate(candidate)}
                                >
                                    <div className="p-2.5">
                                        <ContractPreviewSuite contract={candidate.contract} />
                                    </div>
                                    <div className="border-t px-3.5 py-3" style={{ borderColor: token.colorBorderSecondary }}>
                                        <div className="flex items-start justify-between gap-3">
                                            <span className="text-sm font-semibold" style={{ color: token.colorText }}>
                                                {candidate.label}
                                            </span>
                                            {selected ? (
                                                <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: token.colorPrimary }}>
                                                    <Check className="size-3" aria-hidden="true" /> 已选择
                                                </span>
                                            ) : candidate.recommended ? (
                                                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color: token.colorSuccessText, background: token.colorSuccessBg }}>
                                                    <Sparkles className="size-3" aria-hidden="true" /> 推荐
                                                </span>
                                            ) : null}
                                        </div>
                                        <span className="mt-1.5 block text-xs leading-5" style={{ color: token.colorTextSecondary }}>
                                            {validCandidate ? candidate.rationale : "该候选数据不完整，请重新推荐。"}
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                ) : (
                    <div className="flex min-h-32 flex-col items-center justify-center rounded-xl border border-dashed px-5 py-6 text-center" style={{ borderColor: token.colorBorderSecondary }}>
                        <div className="text-sm font-medium" style={{ color: token.colorText }}>
                            暂时没有可用候选
                        </div>
                        <div className="mt-1 text-xs" style={{ color: token.colorTextSecondary }}>
                            可以重试推荐，也可以先使用通用方案继续。
                        </div>
                        <div className="mt-3 flex gap-2">
                            {onRetry ? (
                                <Button size="small" onClick={onRetry}>
                                    重试
                                </Button>
                            ) : null}
                            <Button size="small" type="primary" onClick={useFallback}>
                                使用稳妥方案
                            </Button>
                        </div>
                    </div>
                )}
            </section>

            <details id="ppt-style-contract-advanced" className="group rounded-2xl border" style={{ borderColor: token.colorBorderSecondary, background: token.colorBgContainer }}>
                <summary
                    className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ color: token.colorText, outlineColor: token.colorPrimary }}
                >
                    <span>
                        高级设置
                        <span className="ml-2 text-xs font-normal" style={{ color: token.colorTextSecondary }}>
                            精确编辑整套 Contract
                        </span>
                    </span>
                    <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>

                <div className="space-y-6 border-t px-4 py-5" style={{ borderColor: token.colorBorderSecondary }}>
                    {extractedHint ? (
                        <div className="rounded-xl border px-3.5 py-3" style={{ borderColor: token.colorPrimaryBorder, background: token.colorPrimaryBg }}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-xs font-semibold" style={{ color: token.colorText }}>
                                    从客户输入提取的视觉线索
                                </span>
                                <Button type="text" size="small" disabled={extractedHintApplied} onClick={adoptExtractedHint}>
                                    {extractedHintApplied ? "已纳入视觉基调" : "纳入视觉基调"}
                                </Button>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap text-xs leading-5" style={{ color: token.colorTextSecondary }}>
                                {extractedHint}
                            </p>
                        </div>
                    ) : null}

                    <AdvancedSection title="视觉基调" description="定义整套气质与单页承载量。">
                        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
                            <Field label="气质关键词">
                                <Input value={draft.modelStyle.mood.join("、")} placeholder="例如：清晰、专业、可信" onChange={(event) => updateModel({ ...draft.modelStyle, mood: splitList(event.target.value) })} />
                            </Field>
                            <Field label="信息密度">
                                <Segmented block value={draft.modelStyle.density} options={[...DENSITY_OPTIONS]} onChange={(density) => updateModel({ ...draft.modelStyle, density: density as StyleModel["density"] })} />
                            </Field>
                        </div>
                    </AdvancedSection>

                    <AdvancedSection title="全局色板" description="六个角色贯穿所有页面；业务语义色仍可在正文安全区内使用。">
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {PALETTE_FIELDS.map((field) => (
                                <ColorField key={field.key} label={field.label} value={draft.modelStyle.palette[field.key]} onChange={(color) => updateModel({ ...draft.modelStyle, palette: { ...draft.modelStyle.palette, [field.key]: color } })} />
                            ))}
                        </div>
                    </AdvancedSection>

                    <AdvancedSection title="字体系统" description="控制标题气质、正文气质和层级强度。">
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            <Field label="标题字体气质">
                                <Select
                                    className="w-full"
                                    value={draft.modelStyle.typography.headingClass}
                                    options={[...HEADING_OPTIONS]}
                                    onChange={(headingClass) => updateModel({ ...draft.modelStyle, typography: { ...draft.modelStyle.typography, headingClass } })}
                                />
                            </Field>
                            <Field label="正文字体气质">
                                <Select
                                    className="w-full"
                                    value={draft.modelStyle.typography.bodyClass}
                                    options={[...BODY_OPTIONS]}
                                    onChange={(bodyClass) => updateModel({ ...draft.modelStyle, typography: { ...draft.modelStyle.typography, bodyClass } })}
                                />
                            </Field>
                            <Field label="层级强度">
                                <Select
                                    className="w-full"
                                    value={draft.modelStyle.typography.hierarchy}
                                    options={[...HIERARCHY_OPTIONS]}
                                    onChange={(hierarchy) => updateModel({ ...draft.modelStyle, typography: { ...draft.modelStyle.typography, hierarchy } })}
                                />
                            </Field>
                            <Field label="品牌字体提示（可选）">
                                <Input
                                    value={draft.modelStyle.typography.brandFontHint || ""}
                                    placeholder="例如：思源黑体"
                                    onChange={(event) => {
                                        const brandFontHint = event.target.value;
                                        const typography = { ...draft.modelStyle.typography };
                                        if (brandFontHint) typography.brandFontHint = brandFontHint;
                                        else delete typography.brandFontHint;
                                        updateModel({ ...draft.modelStyle, typography });
                                    }}
                                />
                            </Field>
                        </div>
                    </AdvancedSection>

                    <AdvancedSection title="版面外壳" description="固定标题区、页眉页脚与安全边距，让多页保持同一秩序。">
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            <Field label="安全边距">
                                <Select className="w-full" value={draft.modelStyle.shell.safeArea} options={[...SAFE_AREA_OPTIONS]} onChange={(safeArea) => updateModel({ ...draft.modelStyle, shell: { ...draft.modelStyle.shell, safeArea } })} />
                            </Field>
                            <Field label="标题区">
                                <Select
                                    className="w-full"
                                    value={draft.modelStyle.shell.titleRegion}
                                    options={[...TITLE_REGION_OPTIONS]}
                                    onChange={(titleRegion) => updateModel({ ...draft.modelStyle, shell: { ...draft.modelStyle.shell, titleRegion } })}
                                />
                            </Field>
                            <Field label="页眉">
                                <Select className="w-full" value={draft.modelStyle.shell.header} options={[...HEADER_OPTIONS]} onChange={(header) => updateModel({ ...draft.modelStyle, shell: { ...draft.modelStyle.shell, header } })} />
                            </Field>
                            <Field label="页脚">
                                <Select className="w-full" value={draft.modelStyle.shell.footer} options={[...FOOTER_OPTIONS]} onChange={(footer) => updateModel({ ...draft.modelStyle, shell: { ...draft.modelStyle.shell, footer } })} />
                            </Field>
                        </div>
                    </AdvancedSection>

                    <AdvancedSection title="图形语言" description="约束卡片、图表、图标、插画与图片处理，避免逐页漂移。">
                        <div className="grid gap-4 md:grid-cols-2">
                            {GRAPHIC_FIELDS.map((field) => (
                                <Field key={field.key} label={field.label}>
                                    <Input.TextArea
                                        value={draft.modelStyle.graphicLanguage[field.key]}
                                        autoSize={{ minRows: 2, maxRows: 5 }}
                                        placeholder={field.placeholder}
                                        onChange={(event) =>
                                            updateModel({
                                                ...draft.modelStyle,
                                                graphicLanguage: { ...draft.modelStyle.graphicLanguage, [field.key]: event.target.value },
                                            })
                                        }
                                    />
                                </Field>
                            ))}
                        </div>
                    </AdvancedSection>

                    <AdvancedSection title="页面角色母版" description="每种页面职责使用自己的构图规则，但共享同一色板、字体与外壳。">
                        <div className="grid gap-4 md:grid-cols-2">
                            {PPT_LAYOUT_ROLES.map((role) => (
                                <Field key={role.id} label={role.label}>
                                    <Input.TextArea
                                        value={draft.modelStyle.roleMasters[role.id]}
                                        autoSize={{ minRows: 2, maxRows: 6 }}
                                        onChange={(event) =>
                                            updateModel({
                                                ...draft.modelStyle,
                                                roleMasters: { ...draft.modelStyle.roleMasters, [role.id]: event.target.value },
                                            })
                                        }
                                    />
                                </Field>
                            ))}
                        </div>
                    </AdvancedSection>

                    <AdvancedSection title="视觉禁止项" description="一行一条，明确整套 PPT 不应出现的表达。">
                        <Input.TextArea
                            value={draft.modelStyle.forbiddenRules.join("\n")}
                            autoSize={{ minRows: 3, maxRows: 8 }}
                            placeholder="例如：禁止大段正文直接堆叠"
                            onChange={(event) => updateModel({ ...draft.modelStyle, forbiddenRules: splitLines(event.target.value) })}
                        />
                    </AdvancedSection>

                    <AdvancedSection title="参考图" description="作为整套 deck 的视觉参考，仅保存在本地。">
                        <div className="mb-3 flex justify-end">
                            <Button type="text" size="small" icon={<ImagePlus className="size-3.5" />} loading={uploading} onClick={() => fileInputRef.current?.click()}>
                                添加参考图
                            </Button>
                        </div>
                        {draft.references.length ? (
                            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
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
                            <button
                                type="button"
                                className="flex min-h-24 w-full items-center justify-center rounded-xl border border-dashed text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
                                style={{ borderColor: token.colorBorderSecondary, color: token.colorTextSecondary, outlineColor: token.colorPrimary }}
                                onClick={() => fileInputRef.current?.click()}
                            >
                                添加能代表配色、字体或版式的参考图
                            </button>
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
                    </AdvancedSection>
                </div>
            </details>
        </div>
    );
}

function ContractSummary({ contract }: { contract: CanvasProjectPptStyleContract }) {
    const { token } = antdTheme.useToken();
    const { modelStyle } = contract;
    const summary = [
        { label: "字体气质", value: `${fontClassLabel(modelStyle.typography.headingClass)}标题 · ${fontClassLabel(modelStyle.typography.bodyClass)}正文` },
        { label: "视觉基调", value: modelStyle.mood.join(" / ") },
        { label: "背景", value: modelStyle.palette.background.toUpperCase() },
        { label: "标题区", value: titleRegionLabel(modelStyle.shell.titleRegion) },
        { label: "页脚", value: footerLabel(modelStyle.shell.footer) },
    ];
    return (
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-[minmax(180px,1.2fr)_repeat(5,minmax(0,1fr))]">
            <div>
                <div className="text-[10px] font-semibold tracking-[0.14em]" style={{ color: token.colorTextTertiary }}>
                    PALETTE
                </div>
                <div className="mt-2 flex gap-1.5" aria-label="当前色板">
                    {PALETTE_FIELDS.map((field) => (
                        <span
                            key={field.key}
                            className="h-7 min-w-5 flex-1 rounded-md border"
                            title={`${field.label} ${modelStyle.palette[field.key]}`}
                            style={{ background: safeHex(modelStyle.palette[field.key], "#64748B"), borderColor: token.colorBorderSecondary }}
                        />
                    ))}
                </div>
            </div>
            {summary.map((item) => (
                <div key={item.label} className="min-w-0">
                    <div className="text-[10px] font-semibold tracking-[0.12em]" style={{ color: token.colorTextTertiary }}>
                        {item.label}
                    </div>
                    <div className="mt-1.5 truncate text-xs font-medium" title={item.value} style={{ color: token.colorText }}>
                        {item.value}
                    </div>
                </div>
            ))}
        </div>
    );
}

function ContractPreviewSuite({ contract }: { contract: CanvasProjectPptStyleContract }) {
    return (
        <span className="grid min-w-0 grid-cols-3 gap-1.5" aria-hidden="true">
            <MicroSlide role="cover" contract={contract} />
            <MicroSlide role="content" contract={contract} />
            <MicroSlide role="evidence" contract={contract} />
        </span>
    );
}

function MicroSlide({ role, contract }: { role: "cover" | "content" | "evidence"; contract: CanvasProjectPptStyleContract }) {
    const { modelStyle } = createPptStyleContractDraft(contract);
    const palette = {
        background: safeHex(modelStyle.palette.background, "#F8FAFC"),
        surface: safeHex(modelStyle.palette.surface, "#FFFFFF"),
        text: safeHex(modelStyle.palette.text, "#10233F"),
        mutedText: safeHex(modelStyle.palette.mutedText, "#64748B"),
        primary: safeHex(modelStyle.palette.primary, "#1D4ED8"),
        accent: safeHex(modelStyle.palette.accent, "#0F9F8F"),
    };
    const padding = modelStyle.shell.safeArea === "generous" ? "10%" : modelStyle.shell.safeArea === "compact" ? "5%" : "7%";
    const titlePosition = modelStyle.shell.titleRegion;
    const centered = titlePosition !== "top-left";
    const titleStyle = {
        color: palette.text,
        fontFamily: headingFontFamily(modelStyle.typography.headingClass),
        fontWeight: modelStyle.typography.hierarchy === "quiet" ? 600 : 800,
    };
    const shellHeader = modelStyle.shell.header === "deck-title" ? "PROJECT / SYSTEM" : modelStyle.shell.header === "section-label" ? "01 / OVERVIEW" : "";
    const shellFooter = modelStyle.shell.footer === "page-number" ? "01" : modelStyle.shell.footer === "deck-title-and-page-number" ? "SYSTEM · 01" : "";

    return (
        <span className="block min-w-0">
            <span className="relative block aspect-video overflow-hidden rounded-md border" style={{ background: palette.background, borderColor: palette.surface, padding, fontFamily: bodyFontFamily(modelStyle.typography.bodyClass) }}>
                {shellHeader ? (
                    <span className="absolute left-[7%] right-[7%] top-[5%] truncate text-[3px] font-semibold tracking-[0.12em]" style={{ color: palette.mutedText }}>
                        {shellHeader}
                    </span>
                ) : null}
                {role === "cover" ? (
                    <span className={`relative flex size-full flex-col ${titlePosition === "center" ? "justify-center" : "justify-start"} ${centered ? "items-center text-center" : "items-start"}`}>
                        <span className="mb-1 h-[3px] w-5 rounded-full" style={{ background: palette.accent }} />
                        <span className="text-[6px] leading-tight" style={titleStyle}>
                            一个清晰的主张
                        </span>
                        <span className="mt-1 h-[2px] w-8 rounded-full opacity-55" style={{ background: palette.mutedText }} />
                        <span className="absolute -bottom-[28%] -right-[14%] size-12 rotate-12 rounded-[28%] opacity-90" style={{ background: palette.primary }} />
                        <span className="absolute -bottom-[8%] right-[18%] size-5 rounded-full opacity-90" style={{ background: palette.accent }} />
                    </span>
                ) : role === "content" ? (
                    <span className="flex size-full flex-col">
                        <span className={`text-[5px] leading-tight ${centered ? "text-center" : "text-left"}`} style={titleStyle}>
                            内容结构
                        </span>
                        <span className="mt-1 grid flex-1 grid-cols-[1.2fr_0.8fr] gap-1">
                            <span className="rounded-sm p-1" style={{ background: palette.surface }}>
                                <span className="block h-[3px] w-4/5 rounded-full" style={{ background: palette.primary }} />
                                <span className="mt-1 block h-[2px] w-full rounded-full opacity-45" style={{ background: palette.mutedText }} />
                                <span className="mt-0.5 block h-[2px] w-3/4 rounded-full opacity-35" style={{ background: palette.mutedText }} />
                            </span>
                            <span className="grid gap-1">
                                <span className="rounded-sm" style={{ background: palette.primary }} />
                                <span className="rounded-sm" style={{ background: palette.accent }} />
                            </span>
                        </span>
                    </span>
                ) : (
                    <span className="flex size-full flex-col">
                        <span className={`text-[5px] leading-tight ${centered ? "text-center" : "text-left"}`} style={titleStyle}>
                            证据先行
                        </span>
                        <span className="mt-1 flex flex-1 items-end gap-1 rounded-sm p-1" style={{ background: palette.surface }}>
                            {[36, 62, 48, 82].map((height, index) => (
                                <span key={height} className="flex-1 rounded-t-[1px]" style={{ height: `${height}%`, background: index === 3 ? palette.accent : palette.primary, opacity: index === 3 ? 1 : 0.72 }} />
                            ))}
                        </span>
                    </span>
                )}
                {shellFooter ? (
                    <span className="absolute bottom-[4%] left-[7%] right-[7%] truncate text-right text-[3px] font-medium" style={{ color: palette.mutedText }}>
                        {shellFooter}
                    </span>
                ) : null}
            </span>
            <span className="mt-1 block text-center text-[9px] font-medium" style={{ color: palette.mutedText }}>
                {role === "cover" ? "封面" : role === "content" ? "内容" : "证据"}
            </span>
        </span>
    );
}

function AdvancedSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
    const { token } = antdTheme.useToken();
    return (
        <section className="grid gap-4 lg:grid-cols-[180px_minmax(0,1fr)]">
            <div>
                <h4 className="text-sm font-semibold" style={{ color: token.colorText }}>
                    {title}
                </h4>
                <p className="mt-1 text-xs leading-5" style={{ color: token.colorTextSecondary }}>
                    {description}
                </p>
            </div>
            <div>{children}</div>
        </section>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    const { token } = antdTheme.useToken();
    return (
        <label className="grid min-w-0 gap-1.5">
            <span className="text-xs font-medium" style={{ color: token.colorTextSecondary }}>
                {label}
            </span>
            {children}
        </label>
    );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
    const { token } = antdTheme.useToken();
    return (
        <Field label={label}>
            <div className="flex items-center gap-2 rounded-lg border px-2" style={{ borderColor: token.colorBorder, background: token.colorBgContainer }}>
                <input type="color" value={safeHex(value, "#64748B")} className="h-8 w-8 cursor-pointer border-0 bg-transparent p-0" aria-label={`${label}取色器`} onChange={(event) => onChange(event.target.value.toUpperCase())} />
                <Input variant="borderless" value={value} maxLength={7} className="font-mono text-xs" aria-label={`${label}色值`} onChange={(event) => onChange(event.target.value.toUpperCase())} />
            </div>
        </Field>
    );
}

function LoadingCandidate() {
    const { token } = antdTheme.useToken();
    return (
        <div className="animate-pulse rounded-2xl border p-2.5" style={{ borderColor: token.colorBorderSecondary, background: token.colorBgContainer }}>
            <div className="aspect-[16/5] rounded-lg" style={{ background: token.colorFillTertiary }} />
            <div className="mt-3 h-3 w-2/5 rounded-full" style={{ background: token.colorFillSecondary }} />
            <div className="mt-2 h-2.5 w-4/5 rounded-full" style={{ background: token.colorFillTertiary }} />
        </div>
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

function splitList(value: string) {
    return value
        .split(/[\n,，、;；]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function splitLines(value: string) {
    return value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
}

function unique(values: string[]) {
    return [...new Set(values)];
}

function safeHex(value: string, fallback: string) {
    return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : fallback;
}

function hasEditableContractShape(value: unknown): value is CanvasProjectPptStyleContract {
    if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.modelStyle) || !Array.isArray(value.references)) return false;
    const model = value.modelStyle;
    return (
        Array.isArray(model.mood) &&
        model.mood.every((item) => typeof item === "string") &&
        typeof model.density === "string" &&
        hasStringFields(
            model.palette,
            PALETTE_FIELDS.map((field) => field.key),
        ) &&
        hasStringFields(model.typography, ["headingClass", "bodyClass", "hierarchy"]) &&
        hasStringFields(model.shell, ["safeArea", "titleRegion", "header", "footer"]) &&
        hasStringFields(
            model.graphicLanguage,
            GRAPHIC_FIELDS.map((field) => field.key),
        ) &&
        hasStringFields(
            model.roleMasters,
            PPT_LAYOUT_ROLES.map((role) => role.id),
        ) &&
        Array.isArray(model.forbiddenRules) &&
        model.forbiddenRules.every((item) => typeof item === "string")
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasStringFields(value: unknown, keys: readonly string[]) {
    return isRecord(value) && keys.every((key) => typeof value[key] === "string");
}

function headingFontFamily(value: StyleModel["typography"]["headingClass"]) {
    if (value === "serif") return '"Songti SC", "Noto Serif CJK SC", Georgia, serif';
    if (value === "display") return '"DIN Alternate", "Arial Narrow", "PingFang SC", sans-serif';
    return '"PingFang SC", "Microsoft YaHei", sans-serif';
}

function bodyFontFamily(value: StyleModel["typography"]["bodyClass"]) {
    return value === "serif" ? '"Songti SC", "Noto Serif CJK SC", Georgia, serif' : '"PingFang SC", "Microsoft YaHei", sans-serif';
}

function fontClassLabel(value: StyleModel["typography"]["headingClass"] | StyleModel["typography"]["bodyClass"]) {
    if (value === "serif") return "衬线";
    if (value === "display") return "展示型";
    return "无衬线";
}

function titleRegionLabel(value: StyleModel["shell"]["titleRegion"]) {
    if (value === "top-center") return "顶部居中";
    if (value === "center") return "画面中央";
    return "左上";
}

function footerLabel(value: StyleModel["shell"]["footer"]) {
    if (value === "page-number") return "仅页码";
    if (value === "deck-title-and-page-number") return "整套标题 + 页码";
    return "无页脚";
}
