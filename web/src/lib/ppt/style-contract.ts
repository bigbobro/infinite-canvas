import type { CanvasProjectPptPageSpec, CanvasProjectPptStyleContract, PptLayoutRole, PptVisualDirectionPresetId } from "@/stores/canvas/use-canvas-store";

export const PPT_LAYOUT_ROLES = [
    { id: "cover", label: "封面", instruction: "封面页：建立主题与第一视觉印象，只保留必要的标题和识别信息。" },
    { id: "section", label: "章节页", instruction: "章节页：清楚标记叙事转折，以简洁构图承上启下。" },
    { id: "content", label: "内容页", instruction: "内容页：围绕单一核心信息组织正文与视觉元素，保持层级清楚。" },
    { id: "evidence", label: "证据页", instruction: "证据页：突出数据、事实或案例，并让证据与结论的对应关系一目了然。" },
    { id: "comparison", label: "对比页", instruction: "对比页：使用统一维度并列呈现差异，让比较关系可以快速扫描。" },
    { id: "close", label: "收尾页", instruction: "收尾页：收束核心结论或行动号召，形成明确、克制的结束感。" },
] as const satisfies readonly { id: PptLayoutRole; label: string; instruction: string }[];

const ROLE_IDS = PPT_LAYOUT_ROLES.map((role) => role.id);
const ROLE_SET = new Set<string>(ROLE_IDS);
const DENSITIES = new Set(["airy", "balanced", "dense"]);
const HEADING_CLASSES = new Set(["sans", "serif", "display"]);
const BODY_CLASSES = new Set(["sans", "serif"]);
const HIERARCHIES = new Set(["quiet", "balanced", "strong"]);
const SAFE_AREAS = new Set(["compact", "regular", "generous"]);
const TITLE_REGIONS = new Set(["top-left", "top-center", "center"]);
const HEADERS = new Set(["none", "deck-title", "section-label"]);
const FOOTERS = new Set(["none", "page-number", "deck-title-and-page-number"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FORBIDDEN_PATTERN = /(?:不要|禁止|不得|请勿|严禁|避免|不允许|不使用|不能)/;

type PptStyleModel = CanvasProjectPptStyleContract["modelStyle"];

const PRESET_MODELS: Record<PptVisualDirectionPresetId, PptStyleModel> = {
    "clean-report": {
        mood: ["清晰", "专业", "可信"],
        density: "balanced",
        palette: { background: "#F8FAFC", surface: "#FFFFFF", text: "#10233F", mutedText: "#64748B", primary: "#1D4ED8", accent: "#0F9F8F" },
        typography: { headingClass: "sans", bodyClass: "sans", hierarchy: "strong" },
        shell: { safeArea: "regular", titleRegion: "top-left", header: "section-label", footer: "deck-title-and-page-number" },
        graphicLanguage: {
            card: "轻描边、低阴影、稳定网格",
            chart: "克制坐标与直接标注，突出关键比较",
            icon: "统一线性图标，避免装饰性堆叠",
            illustration: "简化的技术示意图与结构图",
            imageTreatment: "自然比例裁切，弱化滤镜并保持信息可读",
        },
        roleMasters: {
            cover: "大标题与一句核心定位形成主焦点，可用单一技术意象辅助，不放正文卡片。",
            section: "章节标签、标题和短引导语形成清晰转场，保持大面积留白。",
            content: "标题区固定，正文安全区使用一到两个信息层级，优先图文或模块化布局。",
            evidence: "结论先行，数据或证据成为主体，来源与解释保持次级层级。",
            comparison: "所有选项共享列宽、对齐基线和比较维度，推荐项只用强调色标记。",
            close: "用结论或行动号召收束，减少信息量，保留明确的下一步。",
        },
        forbiddenRules: ["禁止大段正文直接堆叠", "避免无意义装饰和过度渐变"],
    },
    "visual-story": {
        mood: ["叙事", "聚焦", "有节奏"],
        density: "airy",
        palette: { background: "#F5F1E8", surface: "#FFFDF8", text: "#22201D", mutedText: "#716B63", primary: "#C34A36", accent: "#E7A93B" },
        typography: { headingClass: "display", bodyClass: "sans", hierarchy: "strong" },
        shell: { safeArea: "generous", titleRegion: "top-left", header: "none", footer: "page-number" },
        graphicLanguage: {
            card: "少量无阴影分区，让画面主角保持完整",
            chart: "大数字、少坐标、用单一对比讲清一个判断",
            icon: "简洁实心符号，只用于引导阅读",
            illustration: "具有明确主角和空间层次的编辑插画",
            imageTreatment: "大画幅裁切、自然质感、保留主体周围留白",
        },
        roleMasters: {
            cover: "主视觉占据主要画面，标题与副标题形成单一叙事入口。",
            section: "以章节编号和一句转折判断切换节奏，不重复正文结构。",
            content: "每页只强调一个主张，以主视觉和少量支持信息推进故事。",
            evidence: "用一个关键数字或事实作画面主角，解释信息退居次级。",
            comparison: "用两个清晰阵营或连续光谱表达差异，保持比较维度一致。",
            close: "回到整套故事的核心意象，以一句行动或愿景结束。",
        },
        forbiddenRules: ["禁止同页出现多个视觉焦点", "避免密集小卡片和长段落"],
    },
    "brand-led": {
        mood: ["鲜明", "现代", "品牌化"],
        density: "balanced",
        palette: { background: "#0B1020", surface: "#15213B", text: "#F8FAFC", mutedText: "#A7B3C9", primary: "#4F7CFF", accent: "#38D6C5" },
        typography: { headingClass: "sans", bodyClass: "sans", hierarchy: "strong" },
        shell: { safeArea: "regular", titleRegion: "top-left", header: "deck-title", footer: "deck-title-and-page-number" },
        graphicLanguage: {
            card: "深色分层面板、清晰描边与受控高光",
            chart: "品牌主色作主序列，强调色只标记关键节点",
            icon: "几何线性图标，统一线宽和圆角",
            illustration: "品牌色几何结构与抽象技术场景",
            imageTreatment: "冷色统一调色，叠加轻微品牌色蒙版",
        },
        roleMasters: {
            cover: "品牌识别和主题标题并列成为主焦点，背景只保留一个标志性图形。",
            section: "使用品牌色块或几何边界标记章节切换，标题位置保持稳定。",
            content: "沿固定标题区与正文网格展开，用品牌色建立阅读层级。",
            evidence: "指标与结论使用品牌主色，证据细节放在深色 surface 内。",
            comparison: "采用一致的品牌化比较框架，强调色只突出推荐项或关键差异。",
            close: "强化品牌识别与下一步行动，保留简洁联系或行动区域。",
        },
        forbiddenRules: ["禁止任意更换品牌色", "避免霓虹堆叠和无关光效"],
    },
};

export const PPT_VISUAL_DIRECTION_PRESETS = [
    { id: "clean-report", label: "清晰专业", description: "技术可信与信息可读优先，适合方案说明和决策沟通。" },
    { id: "visual-story", label: "视觉叙事", description: "用明确焦点和节奏推进故事，适合愿景与 Pitching。" },
    { id: "brand-led", label: "品牌优先", description: "强化统一识别和记忆点，适合伙伴招募与对外展示。" },
] as const satisfies readonly { id: PptVisualDirectionPresetId; label: string; description: string }[];

const PRESET_IDS = new Set<string>(PPT_VISUAL_DIRECTION_PRESETS.map((preset) => preset.id));

export type PptStyleContractValidationIssue = { code: "invalid_style_contract"; path: string; message: string };

export type PptCompiledStyleContract = {
    canonical: CanvasProjectPptStyleContract;
    fingerprint: string;
    globalInstructions: string[];
    roleInstructions: Record<PptLayoutRole, string[]>;
    roleFingerprints: Record<PptLayoutRole, string>;
    referenceKeys: string[];
};

export type PptStyleCompileResult = { ok: true; value: PptCompiledStyleContract } | { ok: false; issues: PptStyleContractValidationIssue[] };

export type PptPagePresentationClassification = { kind: "layout" | "visual_encoding" | "deck_style_override"; category?: "palette" | "typography" | "shell" | "graphic_language" | "mood" };

export type PptStyleOverride = { text: string; fragment: string; category: NonNullable<PptPagePresentationClassification["category"]> };

export type PptStyleRepairAction = {
    id: string;
    kind:
        | "restore_role_master"
        | "move_to_global"
        | "regenerate_page_presentation"
        | "focus_content_field"
        | "remove_reference"
        | "replace_reference"
        | "retry_candidates"
        | "use_preset"
        | "recheck_current_contract"
        | "regenerate_candidates"
        | "keep_semantic_encoding"
        | "change_contract"
        | "use_non_color_encoding";
    label: string;
    deterministic: boolean;
    pageId?: string;
    referenceKey?: string;
};

export type PptStyleReviewIssue = {
    id: string;
    code: "invalid_contract" | "page_style_override" | "invalid_visual_encoding" | "semantic_color_conflict" | "stale_content_revision" | "reference_unreadable";
    severity: "blocking" | "warning";
    scope: "contract" | "page" | "reference" | "content_revision";
    location: string;
    pageId?: string;
    layoutIndex?: number;
    visualEncodingId?: string;
    fragment?: string;
    reason: string;
    suggestion: string;
    actions: PptStyleRepairAction[];
};

export type PptStyleReviewInput = {
    contract: unknown;
    contentRevision: string;
    reviewedContentRevision: string;
    draftRevision: number;
    pageSpecs: CanvasProjectPptPageSpec[];
    deckRules?: string[];
    targetLayouts?: Array<{ pageId: string; values: string[] }>;
    brokenReferenceKeys?: string[];
};

export type PptStyleReview = {
    contentRevision: string;
    draftRevision: number;
    reviewFingerprint: string;
    compiled?: PptCompiledStyleContract;
    issues: PptStyleReviewIssue[];
    blocking: boolean;
};

type PptStyleRepairOperation = { kind: "replace_layout_intent"; pageId: string; index: number; before: string; after: string } | { kind: "remove_reference"; storageKey: string };

export type PptStyleRepairPatch = {
    contentRevision: string;
    draftRevision: number;
    reviewFingerprint: string;
    actionIds: string[];
    operations: PptStyleRepairOperation[];
    diff: Array<{ location: string; before: string; after: string }>;
};

export function getPptVisualDirectionPreset(presetId: PptVisualDirectionPresetId) {
    return PPT_VISUAL_DIRECTION_PRESETS.find((preset) => preset.id === presetId)!;
}

export function createPptVisualDirectionPresetContract(presetId: PptVisualDirectionPresetId = "clean-report"): CanvasProjectPptStyleContract {
    return normalizePptStyleContract({ schemaVersion: 1, source: { kind: "preset", presetId }, modelStyle: structuredClone(PRESET_MODELS[presetId]), references: [] });
}

export function getPptVisualDirectionLabel(value: unknown) {
    const compiled = compilePptStyleContract(value);
    if (!compiled.ok) return "待修复";
    const source = compiled.value.canonical.source;
    if (source.kind === "preset") return getPptVisualDirectionPreset(source.presetId).label;
    if (source.kind === "generated") return "专属方向";
    return "自定义";
}

export function normalizePptStyleContract(contract: CanvasProjectPptStyleContract): CanvasProjectPptStyleContract {
    const model = contract.modelStyle;
    const seen = new Set<string>();
    const references = (contract.references || []).flatMap((reference) => {
        const storageKey = reference.storageKey.trim();
        if (!storageKey || seen.has(storageKey)) return [];
        seen.add(storageKey);
        return [{ storageKey }];
    });
    const source =
        contract.source.kind === "preset"
            ? ({ kind: "preset", presetId: contract.source.presetId } as const)
            : contract.source.kind === "generated"
              ? ({ kind: "generated", candidateId: contract.source.candidateId.trim() } as const)
              : ({ kind: "custom" } as const);
    return {
        schemaVersion: 1,
        source,
        modelStyle: {
            mood: unique(model.mood),
            density: model.density,
            palette: mapRecord(model.palette, clean),
            typography: {
                headingClass: model.typography.headingClass,
                bodyClass: model.typography.bodyClass,
                hierarchy: model.typography.hierarchy,
                ...(model.typography.brandFontHint?.trim() ? { brandFontHint: model.typography.brandFontHint.trim() } : {}),
            },
            shell: { ...model.shell },
            graphicLanguage: mapRecord(model.graphicLanguage, clean),
            roleMasters: mapRecord(model.roleMasters, clean),
            forbiddenRules: unique(model.forbiddenRules),
        },
        references,
    };
}

export function validatePptStyleContract(value: unknown): string[] {
    return validatePptStyleContractDetailed(value).map((issue) => issue.message);
}

export function validatePptStyleContractDetailed(value: unknown): PptStyleContractValidationIssue[] {
    if (!isRecord(value)) return [invalid("styleContract", "视觉方向 Contract 缺失")];
    const issues: PptStyleContractValidationIssue[] = [];
    if (value.schemaVersion !== 1) issues.push(invalid("schemaVersion", "视觉方向 Contract schemaVersion 必须为 1"));
    if (!isRecord(value.source)) issues.push(invalid("source", "视觉方向来源缺失"));
    else if (value.source.kind === "preset") {
        if (!PRESET_IDS.has(String(value.source.presetId || ""))) issues.push(invalid("source.presetId", "视觉方向使用了未知 preset"));
    } else if (value.source.kind === "generated") {
        if (!nonEmpty(value.source.candidateId)) issues.push(invalid("source.candidateId", "专属视觉方向缺少候选身份"));
    } else if (value.source.kind !== "custom") issues.push(invalid("source.kind", "视觉方向来源无效"));
    if (!isRecord(value.modelStyle)) issues.push(invalid("modelStyle", "视觉系统内容缺失"));
    else validateModelStyle(value.modelStyle, issues);
    if (!Array.isArray(value.references)) issues.push(invalid("references", "视觉方向参考图列表无效"));
    else if (value.references.some((reference) => !isRecord(reference) || !nonEmpty(reference.storageKey))) issues.push(invalid("references", "视觉方向参考图缺少 storageKey"));
    return issues;
}

export function compilePptStyleContract(value: unknown): PptStyleCompileResult {
    const issues = validatePptStyleContractDetailed(value);
    if (issues.length) return { ok: false, issues };
    const canonical = normalizePptStyleContract(value as CanvasProjectPptStyleContract);
    const { modelStyle } = canonical;
    const globalInstructions = [
        `视觉基调：${modelStyle.mood.join("、")}；信息密度：${densityLabel(modelStyle.density)}。`,
        `全局色板固定：背景 ${modelStyle.palette.background}，内容表面 ${modelStyle.palette.surface}，正文 ${modelStyle.palette.text}，次要文字 ${modelStyle.palette.mutedText}，主色 ${modelStyle.palette.primary}，强调色 ${modelStyle.palette.accent}；功能性语义编码除外。`,
        `字体系统固定：标题采用${fontClassLabel(modelStyle.typography.headingClass)}气质，正文采用${fontClassLabel(modelStyle.typography.bodyClass)}气质，层级${hierarchyLabel(modelStyle.typography.hierarchy)}${modelStyle.typography.brandFontHint ? `，字体参考 ${modelStyle.typography.brandFontHint}` : ""}。`,
        `版面外壳固定：${safeAreaLabel(modelStyle.shell.safeArea)}安全边距，标题区位于${titleRegionLabel(modelStyle.shell.titleRegion)}，页眉${headerLabel(modelStyle.shell.header)}，页脚${footerLabel(modelStyle.shell.footer)}。`,
        `图形语言固定：卡片 ${modelStyle.graphicLanguage.card}；图表 ${modelStyle.graphicLanguage.chart}；图标 ${modelStyle.graphicLanguage.icon}；插画 ${modelStyle.graphicLanguage.illustration}；图片 ${modelStyle.graphicLanguage.imageTreatment}。`,
        ...(modelStyle.forbiddenRules.length ? [`视觉禁止项：${modelStyle.forbiddenRules.join("；")}。`] : []),
        "以上全局色板、字体、背景、标题区、页眉页脚和安全边距应用于整套 PPT；单页只可在正文安全区内调整信息构图。",
    ];
    const fingerprint = stableHash({ schemaVersion: canonical.schemaVersion, modelStyle: canonical.modelStyle, referenceKeys: canonical.references.map((reference) => reference.storageKey).sort() });
    const roleInstructions = Object.fromEntries(ROLE_IDS.map((role) => [role, [getPptLayoutRoleInstruction(role), `角色母版：${modelStyle.roleMasters[role]}`]])) as Record<PptLayoutRole, string[]>;
    const roleFingerprints = Object.fromEntries(ROLE_IDS.map((role) => [role, stableHash({ fingerprint, instructions: roleInstructions[role] })])) as Record<PptLayoutRole, string>;
    return { ok: true, value: { canonical, fingerprint, globalInstructions, roleInstructions, roleFingerprints, referenceKeys: canonical.references.map((reference) => reference.storageKey) } };
}

export function assertPptStyleContract(value: unknown): asserts value is CanvasProjectPptStyleContract {
    const result = compilePptStyleContract(value);
    if (!result.ok) throw new Error(result.issues[0].message);
}

export function isPptStyleContractValid(value: unknown): value is CanvasProjectPptStyleContract {
    return compilePptStyleContract(value).ok;
}

export function samePptStyleContract(left: CanvasProjectPptStyleContract, right: CanvasProjectPptStyleContract) {
    const leftCompiled = compilePptStyleContract(left);
    const rightCompiled = compilePptStyleContract(right);
    return leftCompiled.ok && rightCompiled.ok && JSON.stringify(leftCompiled.value.canonical) === JSON.stringify(rightCompiled.value.canonical);
}

export function createPptStyleContractDraft(value: unknown): CanvasProjectPptStyleContract {
    const compiled = compilePptStyleContract(value);
    if (compiled.ok) return compiled.value.canonical;
    return { ...createPptVisualDirectionPresetContract(), source: { kind: "custom" } };
}

export function classifyPptPagePresentationInstruction(text: string): PptPagePresentationClassification {
    const value = normalize(text);
    if (!value) return { kind: "layout" };
    const category = styleOverrideCategory(value);
    if (category) return { kind: "deck_style_override", category };
    return isFunctionalEncoding(value) ? { kind: "visual_encoding" } : { kind: "layout" };
}

export function findPptDeckStyleOverrides(values: string | string[]): PptStyleOverride[] {
    const lines = (Array.isArray(values) ? values : [values]).flatMap(meaningfulLines);
    const found: PptStyleOverride[] = [];
    for (const line of lines) {
        const fragments = line
            .split(/(?<=[，,；;。·・])/)
            .map((fragment) => fragment.trim())
            .filter(Boolean);
        for (const fragment of fragments.length ? fragments : [line]) {
            const classification = classifyPptPagePresentationInstruction(fragment);
            if (classification.kind === "deck_style_override") found.push({ text: line, fragment: trimPunctuation(fragment), category: classification.category! });
        }
    }
    return dedupeBy(found, (item) => `${item.text}\u0000${item.fragment}`);
}

export function stripPptDeckStyleOverrides(value: string) {
    return stripPptDeckStyleOverridesDetailed(value).remainder;
}

function stripPptDeckStyleOverridesDetailed(value: string) {
    const fragments = value
        .split(/[，,；;。·・]/)
        .map((fragment) => fragment.trim())
        .filter(Boolean);
    let unresolved = false;
    const signals: string[] = [];
    const remainder = fragments
        .flatMap((fragment) => {
            if (classifyPptPagePresentationInstruction(fragment).kind !== "deck_style_override") return [fragment];
            const layout = stripKnownDeckStylePhrases(fragment);
            if (normalize(layout) === normalize(fragment) || (layout && classifyPptPagePresentationInstruction(layout).kind === "deck_style_override")) {
                unresolved = true;
                return [];
            }
            const signal = trimPunctuation(layout ? fragment.replace(layout, "") : fragment)
                .replace(/^(?:并|且|同时|以及|和|与)/, "")
                .trim();
            if (signal) signals.push(signal);
            return layout && classifyPptPagePresentationInstruction(layout).kind !== "deck_style_override" ? [layout] : [];
        })
        .join("；");
    return { remainder, unresolved, signals: unique(signals) };
}

export function extractPptDeckStyleSignals(value: string) {
    const result = stripPptDeckStyleOverridesDetailed(value);
    return result.unresolved ? [] : result.signals;
}

export function previewPptStyleClauseRepair(value: string): { safe: true; remainder: string } | { safe: false; remainder: string } {
    const { remainder, unresolved } = stripPptDeckStyleOverridesDetailed(value);
    if (unresolved) return { safe: false, remainder };
    if (findPptDeckStyleOverrides(remainder).length || /(?:使用|采用|保持|固定|显示|设为|设置为|并|且|和|与)$/.test(remainder)) return { safe: false, remainder };
    const layoutSignals = value.match(/(?:左右双栏|上下双栏|左图右文|左文右图|上图下文|上文下图|图文并排|上方标题下方正文|左右|上下|双栏|多栏|网格|居中|左侧|右侧|上方|下方|时间线|流程|并排|对齐|环形|放射)/g) || [];
    if (layoutSignals.some((signal) => !remainder.includes(signal))) return { safe: false, remainder };
    return { safe: true, remainder };
}

/** 仅供内容阶段路由禁止项；视觉正向约束必须被完整吸收进结构化 Contract。 */
export function derivePptVisualDirectionRules(requirements: string, legacyDirection = "") {
    return {
        direction: meaningfulLines(legacyDirection)
            .filter((line) => !FORBIDDEN_PATTERN.test(line))
            .join("\n"),
        forbiddenRules: unique([...meaningfulLines(requirements), ...meaningfulLines(legacyDirection)].filter((line) => FORBIDDEN_PATTERN.test(line))),
    };
}

export function reviewPptStyle(input: PptStyleReviewInput): PptStyleReview {
    const issues: PptStyleReviewIssue[] = [];
    const compiled = compilePptStyleContract(input.contract);
    if (!compiled.ok) {
        for (const problem of compiled.issues) {
            issues.push(
                withActions({
                    id: `style:contract:${stableHash(problem)}`,
                    code: "invalid_contract",
                    severity: "blocking",
                    scope: "contract",
                    location: problem.path,
                    fragment: problem.path,
                    reason: problem.message,
                    suggestion: "补全结构化视觉系统，或直接使用一个通用方向。",
                }),
            );
        }
    }
    if (input.reviewedContentRevision !== input.contentRevision) {
        issues.push(
            withActions({
                id: `style:stale:${stableHash([input.reviewedContentRevision, input.contentRevision])}`,
                code: "stale_content_revision",
                severity: "blocking",
                scope: "content_revision",
                location: "内容版本",
                reason: "当前视觉方向基于旧内容，页面结构或目标已经变化。",
                suggestion: "保留当前 Contract 重新检查，或按新内容重新推荐。",
            }),
        );
    }
    for (const rule of input.deckRules || []) {
        for (const override of findPptDeckStyleOverrides(rule)) {
            issues.push(
                withActions(
                    {
                        id: `style:deck-rule:${stableHash(override.fragment)}`,
                        code: "page_style_override",
                        severity: "blocking",
                        scope: "contract",
                        location: "整套内容规则",
                        fragment: override.fragment,
                        reason: "该规则绕过了结构化 Style Contract，形成了第二套全局视觉事实源。",
                        suggestion: "从内容规则中移除，并在整套 Contract 的对应字段中明确设置。",
                    },
                    { restore: false },
                ),
            );
        }
    }
    for (const page of input.pageSpecs) {
        page.layoutIntent.forEach((value, index) => {
            for (const override of findPptDeckStyleOverrides(value)) {
                issues.push(
                    withActions(
                        {
                            id: `style:page:${page.pageId}:${index}:${stableHash(override.fragment)}`,
                            code: "page_style_override",
                            severity: "blocking",
                            scope: "page",
                            pageId: page.pageId,
                            layoutIndex: index,
                            location: `页面 ${page.pageId} · layoutIntent[${index}]`,
                            fragment: override.fragment,
                            reason: "该描述覆盖了整套 PPT 的视觉系统，页面字段只能安排正文安全区内的构图。",
                            suggestion: "恢复角色母版并保留纯构图；如确需全局采用，请在整套视觉系统中调整。",
                        },
                        { restore: previewPptStyleClauseRepair(value).safe },
                    ),
                );
            }
        });
        for (const layout of input.targetLayouts?.find((target) => target.pageId === page.pageId)?.values || []) {
            for (const override of findPptDeckStyleOverrides(layout)) {
                issues.push(
                    withActions(
                        {
                            id: `style:take:${page.pageId}:${stableHash(override.fragment)}`,
                            code: "page_style_override",
                            severity: "blocking",
                            scope: "page",
                            pageId: page.pageId,
                            location: `页面 ${page.pageId} · 当前方案构图`,
                            fragment: override.fragment,
                            reason: "当前方案试图覆盖全局视觉外壳。",
                            suggestion: "恢复角色母版，或把这项要求移到整套视觉系统。",
                        },
                        { restore: false },
                    ),
                );
            }
        }
        for (const message of validatePptPageVisualEncoding(page)) {
            issues.push(
                withActions({
                    id: `style:encoding:${page.pageId}:${stableHash(message)}`,
                    code: "invalid_visual_encoding",
                    severity: "blocking",
                    scope: "page",
                    pageId: page.pageId,
                    location: `页面 ${page.pageId} · visualEncoding`,
                    reason: message,
                    suggestion: "返回内容方案修复引用、来源或新增文案。",
                }),
            );
        }
        if (compiled.ok) {
            for (const encoding of page.visualEncoding.filter((item) => item.channel === "color" && item.lockedMapping?.length)) {
                const mappings = encoding.lockedMapping || [];
                const conflict = mappings.find((mapping) => compiled.value.canonical.modelStyle.forbiddenRules.some((rule) => colorRuleConflicts(rule, mapping.token)));
                if (!conflict) continue;
                issues.push(
                    withActions({
                        id: `style:semantic:${page.pageId}:${encoding.id}`,
                        code: "semantic_color_conflict",
                        severity: "blocking",
                        scope: "page",
                        pageId: page.pageId,
                        visualEncodingId: encoding.id,
                        location: `页面 ${page.pageId} · visualEncoding.${encoding.id}`,
                        fragment: conflict.token,
                        reason: "已确认的业务语义色映射与整套 Contract 的禁止项冲突。",
                        suggestion: "明确选择保留业务语义、调整 Contract，或改用形状等非颜色通道。",
                    }),
                );
            }
        }
    }
    const activeReferenceKeys = new Set(compiled.ok ? compiled.value.referenceKeys : []);
    for (const storageKey of unique(input.brokenReferenceKeys || []).filter((key) => activeReferenceKeys.has(key))) {
        issues.push(
            withActions({
                id: `style:reference:${stableHash(storageKey)}`,
                code: "reference_unreadable",
                severity: "blocking",
                scope: "reference",
                location: "整套视觉系统 · 参考图",
                fragment: storageKey,
                reason: "参考图在本地存储中无法读取。",
                suggestion: "移除损坏参考图，或重新上传替换。",
            }),
        );
    }
    const compact = issues.map(({ actions: _actions, ...issue }) => issue);
    const reviewFingerprint = stableHash({
        contentRevision: input.contentRevision,
        draftRevision: input.draftRevision,
        contract: input.contract,
        deckRules: input.deckRules || [],
        pageLayouts: input.pageSpecs.map((page) => [page.pageId, page.layoutIntent]),
        targetLayouts: input.targetLayouts || [],
        issues: compact,
    });
    if (issues.some((issue) => issue.severity === "blocking" && !issue.actions.length)) throw new Error("视觉检查产生了无恢复动作的阻断项");
    return { contentRevision: input.contentRevision, draftRevision: input.draftRevision, reviewFingerprint, ...(compiled.ok ? { compiled: compiled.value } : {}), issues, blocking: issues.some((issue) => issue.severity === "blocking") };
}

export function previewPptStyleRepair(input: PptStyleReviewInput, actionIds?: string[]): PptStyleRepairPatch {
    const review = reviewPptStyle(input);
    const selected = new Set(actionIds || review.issues.flatMap((issue) => issue.actions.filter((action) => action.deterministic).map((action) => action.id)));
    const operations: PptStyleRepairOperation[] = [];
    const appliedActionIds: string[] = [];
    for (const issue of review.issues) {
        const action = issue.actions.find((candidate) => selected.has(candidate.id) && candidate.deterministic);
        if (!action) continue;
        const operationCount = operations.length;
        if (action.kind === "restore_role_master" && issue.pageId && issue.layoutIndex !== undefined) {
            const page = input.pageSpecs.find((candidate) => candidate.pageId === issue.pageId);
            const before = page?.layoutIntent[issue.layoutIndex];
            if (before !== undefined) {
                const preview = previewPptStyleClauseRepair(before);
                if (preview.safe) operations.push({ kind: "replace_layout_intent", pageId: issue.pageId, index: issue.layoutIndex, before, after: preview.remainder });
            }
        }
        if (action.kind === "remove_reference" && action.referenceKey) operations.push({ kind: "remove_reference", storageKey: action.referenceKey });
        if (operations.length > operationCount) appliedActionIds.push(action.id);
    }
    const uniqueOperations = dedupeBy(operations, (operation) => JSON.stringify(operation));
    return {
        contentRevision: input.contentRevision,
        draftRevision: input.draftRevision,
        reviewFingerprint: review.reviewFingerprint,
        actionIds: unique(appliedActionIds),
        operations: uniqueOperations,
        diff: uniqueOperations.map((operation) =>
            operation.kind === "replace_layout_intent"
                ? { location: `页面 ${operation.pageId} · layoutIntent[${operation.index}]`, before: operation.before, after: operation.after || "（移除整套视觉覆盖）" }
                : { location: "整套视觉系统 · 参考图", before: operation.storageKey, after: "（移除损坏参考图）" },
        ),
    };
}

export function applyPptStyleRepair(input: PptStyleReviewInput, patch: PptStyleRepairPatch): { contract: CanvasProjectPptStyleContract; pageSpecs: CanvasProjectPptPageSpec[]; draftRevision: number } {
    const currentReview = reviewPptStyle(input);
    if (patch.contentRevision !== input.contentRevision || patch.draftRevision !== input.draftRevision || patch.reviewFingerprint !== currentReview.reviewFingerprint) throw new Error("视觉修复预览已过期，请重新检查后再应用");
    const expectedPatch = previewPptStyleRepair(input, patch.actionIds);
    if (stableStringify(patch) !== stableStringify(expectedPatch)) throw new Error("视觉修复预览已被篡改，请重新生成预览");
    const compiled = compilePptStyleContract(input.contract);
    if (!compiled.ok) throw new Error("当前 Contract 无效，不能应用局部修复");
    const contract = structuredClone(compiled.value.canonical);
    const pageSpecs = structuredClone(input.pageSpecs);
    const protectedContent = pageSpecs.map(protectedPageContent);
    for (const operation of patch.operations) {
        if (operation.kind !== "replace_layout_intent") continue;
        const page = pageSpecs.find((candidate) => candidate.pageId === operation.pageId);
        if (!page || page.layoutIntent[operation.index] !== operation.before) throw new Error("视觉修复目标已变更，未应用任何修改");
    }
    for (const operation of patch.operations) {
        if (operation.kind === "remove_reference") contract.references = contract.references.filter((reference) => reference.storageKey !== operation.storageKey);
        else pageSpecs.find((candidate) => candidate.pageId === operation.pageId)!.layoutIntent[operation.index] = operation.after;
    }
    for (const page of pageSpecs) page.layoutIntent = page.layoutIntent.filter(Boolean);
    if (JSON.stringify(pageSpecs.map(protectedPageContent)) !== JSON.stringify(protectedContent)) throw new Error("视觉修复不能改写页面事实或来源");
    return { contract: normalizePptStyleContract(contract), pageSpecs, draftRevision: input.draftRevision + 1 };
}

export function applyPptStyleReviewChoice(
    input: PptStyleReviewInput,
    issueId: string,
    kind: "keep_semantic_encoding" | "use_non_color_encoding",
    expectedReviewFingerprint: string,
): { contract: CanvasProjectPptStyleContract; pageSpecs: CanvasProjectPptPageSpec[]; draftRevision: number } {
    const review = reviewPptStyle(input);
    if (review.reviewFingerprint !== expectedReviewFingerprint) throw new Error("视觉处理动作已过期，请重新检查");
    const issue = review.issues.find((candidate) => candidate.id === issueId);
    if (!issue || issue.code !== "semantic_color_conflict" || !issue.actions.some((action) => action.kind === kind)) throw new Error("视觉处理动作已过期，请重新检查");
    const compiled = compilePptStyleContract(input.contract);
    if (!compiled.ok) throw new Error("当前 Contract 无效，不能处理语义冲突");
    const contract = structuredClone(compiled.value.canonical);
    const pageSpecs = structuredClone(input.pageSpecs);
    if (kind === "keep_semantic_encoding") {
        const before = contract.modelStyle.forbiddenRules.length;
        contract.modelStyle.forbiddenRules = contract.modelStyle.forbiddenRules.filter((rule) => !colorRuleConflicts(rule, issue.fragment || ""));
        if (contract.modelStyle.forbiddenRules.length === before) throw new Error("没有找到可移除的冲突禁止项");
    } else {
        const encoding = pageSpecs.find((page) => page.pageId === issue.pageId)?.visualEncoding.find((item) => item.id === issue.visualEncodingId);
        if (!encoding || encoding.channel !== "color") throw new Error("颜色编码已变化，请重新检查");
        encoding.channel = "shape";
    }
    return { contract: normalizePptStyleContract(contract), pageSpecs, draftRevision: input.draftRevision + 1 };
}

export function validatePptPageVisualEncoding(page: CanvasProjectPptPageSpec) {
    const issues: string[] = [];
    const sourceById = new Map(page.sourceRefs.map((source) => [source.id, source]));
    const blockById = new Map(page.contentBlocks.map((block) => [block.id, block]));
    const ids = page.visualEncoding.map((encoding) => encoding.id);
    if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) issues.push("功能性视觉编码身份缺失或重复");
    for (const encoding of page.visualEncoding) {
        const runtime = encoding as typeof encoding & Record<string, unknown>;
        const visibleText = ["text", "label", "copy", "caption"].some((key) => typeof runtime[key] === "string" && String(runtime[key]).trim());
        const validIds = encoding.contentBlockIds.length > 0 && encoding.contentBlockIds.every((id) => blockById.has(id) && blockById.get(id)?.kind !== "placeholder");
        const validMapping = (encoding.lockedMapping || []).every((mapping) => {
            const block = blockById.get(mapping.contentBlockId);
            const sources = mapping.sourceRefIds.map((id) => sourceById.get(id));
            return Boolean(
                block &&
                encoding.contentBlockIds.includes(mapping.contentBlockId) &&
                mapping.sourceRefIds.length &&
                sources.every(Boolean) &&
                sources.every((source) => block.sourceRefIds.includes(source!.id)) &&
                sourceSupportsToken(block.text, mapping.token) &&
                sourceSupportsToken(sources.map((source) => source!.excerpt).join("\n"), mapping.token),
            );
        });
        if (visibleText || !validIds || !validMapping) issues.push("功能性视觉编码引用了未批准内容、无效来源或新增文案");
    }
    return unique(issues);
}

export function isPptLayoutRole(value: unknown): value is PptLayoutRole {
    return typeof value === "string" && ROLE_SET.has(value);
}

export function getPptLayoutRoleInstruction(role: PptLayoutRole) {
    return PPT_LAYOUT_ROLES.find((item) => item.id === role)!.instruction;
}

export function deriveDefaultPptLayoutRole(page: { title?: string; outline?: string; visualHint?: string }, pageIndex = 0, pageCount = 1): PptLayoutRole {
    const text = `${page.title || ""}\n${page.outline || ""}\n${page.visualHint || ""}`;
    if (pageIndex === 0) return "cover";
    if (/(?:章节|篇章|部分|目录|过渡)/i.test(text)) return "section";
    if (/(?:对比|比较|差异|竞品|\bvs\.?\b)/i.test(text)) return "comparison";
    if (/(?:数据|证据|指标|案例|结果|事实|验证)/i.test(text)) return "evidence";
    if (/(?:谢谢|致谢|问答|Q&A|结束|总结|下一步|行动)/i.test(text) || pageIndex === pageCount - 1) return "close";
    return "content";
}

function validateModelStyle(model: Record<string, unknown>, issues: PptStyleContractValidationIssue[]) {
    if (!Array.isArray(model.mood) || !model.mood.length || model.mood.some((item) => !nonEmpty(item))) issues.push(invalid("modelStyle.mood", "视觉基调至少需要一项"));
    if (!DENSITIES.has(String(model.density))) issues.push(invalid("modelStyle.density", "信息密度无效"));
    validateStringRecord(model.palette, ["background", "surface", "text", "mutedText", "primary", "accent"], "modelStyle.palette", issues, true);
    if (!isRecord(model.typography)) issues.push(invalid("modelStyle.typography", "字体系统缺失"));
    else {
        if (!HEADING_CLASSES.has(String(model.typography.headingClass))) issues.push(invalid("modelStyle.typography.headingClass", "标题字体气质无效"));
        if (!BODY_CLASSES.has(String(model.typography.bodyClass))) issues.push(invalid("modelStyle.typography.bodyClass", "正文字体气质无效"));
        if (!HIERARCHIES.has(String(model.typography.hierarchy))) issues.push(invalid("modelStyle.typography.hierarchy", "字体层级无效"));
        if (model.typography.brandFontHint !== undefined && !nonEmpty(model.typography.brandFontHint)) issues.push(invalid("modelStyle.typography.brandFontHint", "品牌字体提示不能为空"));
    }
    if (!isRecord(model.shell)) issues.push(invalid("modelStyle.shell", "版面外壳缺失"));
    else {
        if (!SAFE_AREAS.has(String(model.shell.safeArea))) issues.push(invalid("modelStyle.shell.safeArea", "全局安全边距无效"));
        if (!TITLE_REGIONS.has(String(model.shell.titleRegion))) issues.push(invalid("modelStyle.shell.titleRegion", "标题区无效"));
        if (!HEADERS.has(String(model.shell.header))) issues.push(invalid("modelStyle.shell.header", "页眉规则无效"));
        if (!FOOTERS.has(String(model.shell.footer))) issues.push(invalid("modelStyle.shell.footer", "页脚规则无效"));
    }
    validateStringRecord(model.graphicLanguage, ["card", "chart", "icon", "illustration", "imageTreatment"], "modelStyle.graphicLanguage", issues);
    validateStringRecord(model.roleMasters, ROLE_IDS, "modelStyle.roleMasters", issues);
    if (!Array.isArray(model.forbiddenRules) || model.forbiddenRules.some((item) => !nonEmpty(item))) issues.push(invalid("modelStyle.forbiddenRules", "视觉禁止项必须是字符串列表"));
}

function validateStringRecord(value: unknown, keys: readonly string[], path: string, issues: PptStyleContractValidationIssue[], colors = false) {
    if (!isRecord(value)) {
        issues.push(invalid(path, `${path.split(".").at(-1)} 缺失`));
        return;
    }
    for (const key of keys) {
        if (!nonEmpty(value[key])) issues.push(invalid(`${path}.${key}`, `${path}.${key} 缺失`));
        else if (colors && !HEX_COLOR.test(String(value[key]).trim())) issues.push(invalid(`${path}.${key}`, `${path}.${key} 必须是六位十六进制颜色`));
    }
}

function withActions(issue: Omit<PptStyleReviewIssue, "actions">, options: { restore?: boolean; deterministicRestore?: boolean } = {}): PptStyleReviewIssue {
    const make = (kind: PptStyleRepairAction["kind"], label: string, deterministic = false, extra: Partial<PptStyleRepairAction> = {}): PptStyleRepairAction => ({
        id: `${issue.id}:${kind}`,
        kind,
        label,
        deterministic,
        ...(issue.pageId ? { pageId: issue.pageId } : {}),
        ...extra,
    });
    const actions: Record<PptStyleReviewIssue["code"], PptStyleRepairAction[]> = {
        invalid_contract: [make("use_preset", "使用通用方向")],
        page_style_override: [
            ...(options.restore === false ? [] : [make("restore_role_master", "恢复母版并保留构图", options.deterministicRestore !== false)]),
            make("move_to_global", "在整套 Contract 中调整"),
            ...(issue.pageId ? [make("regenerate_page_presentation", "重新生成本页呈现建议"), make("focus_content_field", "返回内容字段")] : []),
        ],
        invalid_visual_encoding: [make("focus_content_field", "返回内容方案修复")],
        semantic_color_conflict: [make("keep_semantic_encoding", "保留业务语义"), make("change_contract", "调整整套 Contract"), make("use_non_color_encoding", "改用非颜色通道")],
        stale_content_revision: [make("recheck_current_contract", "保留当前方向并重新检查"), make("regenerate_candidates", "按新内容重新推荐")],
        reference_unreadable: [make("remove_reference", "移除损坏参考图", true, { referenceKey: issue.fragment }), make("replace_reference", "打开参考图设置", false, { referenceKey: issue.fragment })],
    };
    return { ...issue, actions: actions[issue.code] };
}

function styleOverrideCategory(value: string): PptStyleOverride["category"] | undefined {
    if (/(?:字体|字型|字号|无衬线|衬线|黑体|宋体|标题字体|正文字体|数字字体|字体层级)/i.test(value)) return "typography";
    if (/(?:标题区|标题位置|页眉|页脚|页码|安全边距|全局边距|固定(?:头部|底部)|标题.*(?:左上|顶部|居中))/i.test(value)) return "shell";
    if (/(?:配色|色板|主色|辅助色|强调色|品牌色|背景色|底色|深蓝(?:色)?(?:背景|基调)|浅色背景|深色背景|白色背景|黑色背景|红色基调|蓝色基调|(?:简洁|淡化|透明|品牌化|抽象|纹理)背景)/i.test(value)) return "palette";
    if (/(?:材质|质感|纹理|渐变|阴影|描边风格|圆角风格|插画风|摄影风|图标风格|图片处理)/i.test(value)) return "graphic_language";
    if (/(?:视觉方向|画面气质|科技感|科技风|未来感|商务风|咨询风|报告风|品牌风|赛博朋克|极简风|复古风|清新风|电影感|杂志感|海报感|手绘风|写实风)/i.test(value)) return "mood";
    return undefined;
}

function stripKnownDeckStylePhrases(value: string) {
    return value
        .replace(/(?:并|且|同时|以及|和|与)?(?:页眉|页脚)(?:固定)?(?:显示)?(?:整套标题|章节标签|页码|标题和页码)?/gi, " ")
        .replace(/(?:并|且|同时|以及)?(?:全局|统一|整套)?(?:使用|采用|保持|设为|设置为)?(?:无衬线|衬线|黑体|宋体|标题字体|正文字体|数字字体|字体层级|定制字体|品牌字体|大字号|小字号|较大字号|较小字号)(?:字体|字型|风格|气质)?/gi, " ")
        .replace(
            /(?:并|且|同时|以及|和|与)?(?:全局|统一|整套)?(?:使用|采用|保持|设为|设置为)?(?:深蓝(?:色)?(?:背景|基调)|浅色背景|深色背景|白色背景|黑色背景|红色基调|蓝色基调|(?:简洁|淡化|透明|品牌化|抽象|纹理)背景|品牌色|强调色|主色|辅助色|配色|色板|背景色|底色)/gi,
            " ",
        )
        .replace(
            /(?:并|且|同时|以及)?(?:全局|统一|整套)?(?:使用|采用|保持|呈现|营造)?(?:深蓝|红色|蓝色|黑色|白色)?(?:科技感|科技风|未来感|商务风|咨询风|报告风|品牌风|赛博朋克(?:风)?|极简风|复古风|清新风|电影感|杂志感|海报感|手绘风|写实风|专业咨询报告风格)(?:背景|风格|气质)?/gi,
            " ",
        )
        .replace(/(?:并|且|同时|以及)?(?:全局|统一|整套)?(?:使用|采用|保持)?(?:渐变|阴影|纹理|材质|质感|描边风格|圆角风格|插画风|摄影风|图标风格|图片处理)/gi, " ")
        .replace(/(?:并|且|同时|以及)?(?:全局|统一|整套)?(?:使用|采用|保持|固定|显示)?(?:标题区|标题位置|页眉|页脚|页码|安全边距|全局边距)(?:位于|放在|显示在)?(?:左上|顶部|居中|头部|底部)?/gi, " ")
        .replace(/(?:并|且|同时|以及|和|与|and|with)\s*$/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}

function isFunctionalEncoding(value: string) {
    if (/(?:颜色|色彩|红色|绿色|黄色|蓝色|橙色).{0,12}(?:区分|映射|标记|表示|对应|强调)(?:优劣|风险|正常|状态|类别|等级|重点|内容)?/i.test(value)) return true;
    if (/(?:优劣|风险|正常|状态|类别|等级).{0,12}(?:颜色|色彩|红色|绿色|黄色|蓝色|橙色)/i.test(value)) return true;
    if (/(?:图标|形状|位置|大小|连线).{0,12}(?:区分|映射|标记|表示|对应|强调|分组|顺序|关系)/i.test(value)) return true;
    if (/(?:红色|绿色|黄色|蓝色|橙色)\s*[=＝:：]\s*[^，,；;。]+/i.test(value)) return true;
    return false;
}

function colorRuleConflicts(rule: string, token: string) {
    const normalizedRule = normalize(rule);
    const normalizedToken = normalize(token);
    if (!normalizedToken) return false;
    if (FORBIDDEN_PATTERN.test(normalizedRule) && normalizedRule.includes(normalizedToken)) return true;
    return /(?:单色|仅使用|只使用)/.test(normalizedRule) && /(?:红|绿|黄|蓝|橙|紫|金|银|黑|白|灰)色/.test(normalizedToken) && !normalizedRule.includes(normalizedToken);
}

function protectedPageContent(page: CanvasProjectPptPageSpec) {
    return { pageId: page.pageId, purpose: page.purpose, contentForm: page.contentForm, contentBlocks: page.contentBlocks, sourceRefs: page.sourceRefs, lockedFacts: page.lockedFacts, visualEncoding: page.visualEncoding };
}

function sourceSupportsToken(source: string, token: string) {
    return normalize(source).includes(normalize(token));
}

function densityLabel(value: PptStyleModel["density"]) {
    return { airy: "疏朗", balanced: "均衡", dense: "紧凑" }[value];
}

function fontClassLabel(value: PptStyleModel["typography"]["headingClass"] | PptStyleModel["typography"]["bodyClass"]) {
    return { sans: "无衬线", serif: "衬线", display: "展示型" }[value];
}

function hierarchyLabel(value: PptStyleModel["typography"]["hierarchy"]) {
    return { quiet: "克制", balanced: "均衡", strong: "鲜明" }[value];
}

function safeAreaLabel(value: PptStyleModel["shell"]["safeArea"]) {
    return { compact: "紧凑", regular: "标准", generous: "宽松" }[value];
}

function titleRegionLabel(value: PptStyleModel["shell"]["titleRegion"]) {
    return { "top-left": "左上", "top-center": "顶部居中", center: "画面中央" }[value];
}

function headerLabel(value: PptStyleModel["shell"]["header"]) {
    return { none: "不设置", "deck-title": "显示整套标题", "section-label": "显示章节标签" }[value];
}

function footerLabel(value: PptStyleModel["shell"]["footer"]) {
    return { none: "不设置", "page-number": "显示页码", "deck-title-and-page-number": "显示整套标题与页码" }[value];
}

function invalid(path: string, message: string): PptStyleContractValidationIssue {
    return { code: "invalid_style_contract", path, message };
}

function nonEmpty(value: unknown): value is string {
    return typeof value === "string" && Boolean(value.trim());
}

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapRecord<T extends Record<string, string>>(value: T, map: (item: string) => string): T {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, map(item)])) as T;
}

function meaningfulLines(value: string) {
    return value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function clean(value: string) {
    return value.trim();
}

function normalize(value: string) {
    return value.trim().replace(/\s+/g, " ");
}

function trimPunctuation(value: string) {
    return value.replace(/[，,；;。]+$/g, "").trim();
}

function unique(values: readonly string[]) {
    const seen = new Set<string>();
    return values.flatMap((value) => {
        const cleaned = value.trim();
        const key = normalize(cleaned);
        if (!cleaned || seen.has(key)) return [];
        seen.add(key);
        return [cleaned];
    });
}

function dedupeBy<T>(values: readonly T[], key: (value: T) => string) {
    const seen = new Set<string>();
    return values.filter((value) => {
        const id = key(value);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

function stableHash(value: unknown) {
    const input = stableStringify(value);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `style-v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (isRecord(value))
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(",")}}`;
    return JSON.stringify(value);
}
