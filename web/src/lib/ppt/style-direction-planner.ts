import { compilePptStyleContract, createPptVisualDirectionPresetContract, getPptVisualDirectionPreset, PPT_VISUAL_DIRECTION_PRESETS } from "@/lib/ppt/style-contract";
import { requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import type { CanvasProjectPptPageSpec, CanvasProjectPptStyleContract, PptContentBrief, PptVisualDirectionPresetId } from "@/stores/canvas/use-canvas-store";
import type { AiConfig } from "@/stores/use-config-store";

export type PptStyleDirectionPlannerInput = {
    brief: Pick<PptContentBrief, "title" | "audience" | "goal" | "narrative" | "visualSignals">;
    pageSpecs: CanvasProjectPptPageSpec[];
    contentRevision: string;
    visualSignals?: string[];
    referenceKeys?: string[];
};

export type PptStyleDirectionCandidate = {
    id: string;
    label: string;
    rationale: string;
    recommended: boolean;
    basedOnContentRevision: string;
    contract: CanvasProjectPptStyleContract;
};

export type PptStyleTextRequester = typeof requestImageQuestion;

const STYLE_DIRECTION_SYSTEM_PROMPT = `你是 PPT 视觉系统设计师。请基于已经批准的内容结构，为同一套 16:9 PPT 提出 3 个彼此有明显取舍、但都适配当前材料的完整视觉方向。

只输出一个严格 JSON 对象，不要解释、不要 Markdown、不要代码块。格式：
{"candidates":[{"label":"方向名称","rationale":"为什么适合这份材料","recommended":true,"contract":{"schemaVersion":1,"source":{"kind":"generated","candidateId":"模型临时值"},"modelStyle":{"mood":["关键词"],"density":"balanced","palette":{"background":"#F8FAFC","surface":"#FAFAF8","text":"#10233F","mutedText":"#64748B","primary":"#1D4ED8","accent":"#0F9F8F"},"typography":{"headingClass":"sans","bodyClass":"sans","hierarchy":"strong"},"shell":{"safeArea":"regular","titleRegion":"top-left","header":"section-label","footer":"deck-title-and-page-number"},"graphicLanguage":{"card":"完整规则","chart":"完整规则","icon":"完整规则","illustration":"完整规则","imageTreatment":"完整规则"},"roleMasters":{"cover":"完整规则","section":"完整规则","content":"完整规则","evidence":"完整规则","comparison":"完整规则","close":"完整规则"},"forbiddenRules":["明确禁止项"]},"references":[]}}]}

硬规则：
1. candidates 必须且只能有 3 项，必须且只能有 1 项 recommended=true；label 和 rationale 不能为空。
2. 每项 contract 必须完整包含示例中的全部字段。颜色必须是六位十六进制；枚举只能使用示例所示语义：density=airy|balanced|dense，headingClass=sans|serif|display，bodyClass=sans|serif，hierarchy=quiet|balanced|strong，safeArea=compact|regular|generous，titleRegion=top-left|top-center|center，header=none|deck-title|section-label，footer=none|page-number|deck-title-and-page-number。
3. 六类 roleMasters 必须共享同一套 palette、typography、shell 与 graphicLanguage，只描述受控的角色差异；页面正文构图不能改写全局标题区、页眉页脚、页码、安全边距、字体或背景。
4. 每条 rationale 都要结合当前受众、目标、叙事和页面类型解释取舍，不能只写“科技感”“商务风”等空泛标签。
5. 客户视觉信号必须被吸收到 contract 内，不要作为 contract 之外的另一份规则。功能性 visualEncoding 只说明信息关系，不等同于审美配色。
6. 不新增业务事实、数字、厂商、参数、成本或结论。模型输出的 candidateId 和 references 不会被客户端信任。
7. 主色与强调色避免“紫色到蓝色”渐变一类高识别度的 AI 默认配色组合，配色需能说明与受众、行业或内容气质的关联。
8. 背景与表面色不使用纯黑 #000000 或纯白 #FFFFFF，改用近黑（如 #1A1A1A 档）或暖白/冷白（如 #FAFAF8 档）替代。`;

export function buildPptStyleDirectionMessages(input: PptStyleDirectionPlannerInput): AiTextMessage[] {
    const visualSignals = unique([...(input.brief.visualSignals || []), ...(input.visualSignals || [])]);
    const pageSummaries = input.pageSpecs.map((page, index) => ({
        page: index + 1,
        purpose: page.purpose,
        contentForm: page.contentForm,
        layoutRole: page.layoutRole,
        visualEncoding: page.visualEncoding.map((encoding) => ({ intent: encoding.intent, channel: encoding.channel, mappingTokens: encoding.lockedMapping?.map((mapping) => mapping.token) || [] })),
    }));
    return [
        { role: "system", content: STYLE_DIRECTION_SYSTEM_PROMPT },
        {
            role: "user",
            content: JSON.stringify({
                deck: {
                    title: input.brief.title,
                    audience: input.brief.audience,
                    goal: input.brief.goal,
                    narrative: input.brief.narrative,
                    visualSignals,
                    contentRevision: input.contentRevision,
                },
                pages: pageSummaries,
                references: { present: Boolean(input.referenceKeys?.length), count: input.referenceKeys?.length || 0 },
            }),
        },
    ];
}

export async function requestPptStyleDirections(
    config: AiConfig,
    input: PptStyleDirectionPlannerInput,
    onDelta: (text: string) => void = () => undefined,
    options?: { signal?: AbortSignal; requester?: PptStyleTextRequester },
): Promise<PptStyleDirectionCandidate[]> {
    const requestConfig: AiConfig = { ...config, model: config.textModel || config.model };
    const answer = await (options?.requester ?? requestImageQuestion)(requestConfig, buildPptStyleDirectionMessages(input), onDelta, { signal: options?.signal });
    return parsePptStyleDirectionResponse(answer, input);
}

export function parsePptStyleDirectionResponse(raw: string, input: PptStyleDirectionPlannerInput): PptStyleDirectionCandidate[] {
    const value = parseTolerantJsonResponse(raw);
    if (value === undefined) throw new Error("生成的视觉方向不是严格 JSON，请重试或使用通用方向");
    if (!isRecord(value) || !Array.isArray(value.candidates) || value.candidates.length !== 3) throw new Error("视觉方向必须完整返回 3 个候选");
    const recommendedCount = value.candidates.filter((candidate) => isRecord(candidate) && candidate.recommended === true).length;
    if (recommendedCount !== 1) throw new Error("视觉方向必须且只能标记 1 个推荐项");

    const inputKey = createPptStyleDirectionInputKey(input);
    const referenceKeys = unique(input.referenceKeys || []);
    const candidates = value.candidates.map((candidate, index) => normalizeCandidate(candidate, index, input, inputKey, referenceKeys));
    if (new Set(candidates.map((candidate) => candidate.label)).size !== candidates.length) throw new Error("视觉方向名称不能重复");
    return candidates;
}

export function createPptStyleFallbackCandidates(input: PptStyleDirectionPlannerInput): PptStyleDirectionCandidate[] {
    const deck = input.brief.title.trim() || "这套 PPT";
    const audience = input.brief.audience.trim() || "目标受众";
    const goal = input.brief.goal.trim() || "清楚传达核心方案";
    const narrative = input.brief.narrative.trim() || "当前叙事主线";
    const forms = unique(input.pageSpecs.map((page) => page.contentForm));
    const formSummary = forms.length ? forms.join("、") : "内容";
    const rationales: Record<PptVisualDirectionPresetId, string> = {
        "clean-report": `${deck}包含${formSummary}等页面；这一方向用稳定网格与清晰证据层级建立技术可信度，帮助${audience}围绕“${goal}”作出判断。`,
        "visual-story": `围绕“${narrative}”建立连续视觉节奏，把复杂方案、合作价值与未来空间串成一条易理解的叙事，适合向${audience}讲解与 Pitching。`,
        "brand-led": `以统一识别系统强化${deck}的记忆点，同时保留方案信息的可读性，适合在“${goal}”过程中用于伙伴招募和对外展示。`,
    };
    return PPT_VISUAL_DIRECTION_PRESETS.map((preset, index) => {
        const presetContract = createPptVisualDirectionPresetContract(preset.id);
        const compiled = compilePptStyleContract({ ...presetContract, references: unique(input.referenceKeys || []).map((storageKey) => ({ storageKey })) });
        if (!compiled.ok) throw new Error("通用视觉方向 Contract 无效");
        return {
            id: `style-fallback-${preset.id}`,
            label: getPptVisualDirectionPreset(preset.id).label,
            rationale: rationales[preset.id],
            recommended: index === 0,
            basedOnContentRevision: input.contentRevision,
            contract: compiled.value.canonical,
        };
    });
}

export function createPptStyleDirectionInputKey(input: PptStyleDirectionPlannerInput) {
    return stableHash({
        contentRevision: input.contentRevision,
        brief: {
            title: input.brief.title,
            audience: input.brief.audience,
            goal: input.brief.goal,
            narrative: input.brief.narrative,
            visualSignals: unique([...(input.brief.visualSignals || []), ...(input.visualSignals || [])]),
        },
        pages: input.pageSpecs.map((page) => ({
            pageId: page.pageId,
            purpose: page.purpose,
            contentForm: page.contentForm,
            layoutRole: page.layoutRole,
            visualEncoding: page.visualEncoding.map((encoding) => ({ intent: encoding.intent, channel: encoding.channel, mapping: encoding.lockedMapping?.map((item) => item.token) || [] })),
        })),
        referenceKeys: unique(input.referenceKeys || []).sort(),
    });
}

export function isPptStyleDirectionCandidateStale(candidate: PptStyleDirectionCandidate, contentRevision: string) {
    return candidate.basedOnContentRevision !== contentRevision;
}

function normalizeCandidate(candidate: unknown, index: number, input: PptStyleDirectionPlannerInput, inputKey: string, referenceKeys: string[]): PptStyleDirectionCandidate {
    if (!isRecord(candidate) || !nonEmpty(candidate.label) || !nonEmpty(candidate.rationale) || typeof candidate.recommended !== "boolean" || !isRecord(candidate.contract)) {
        throw new Error(`第 ${index + 1} 个视觉方向字段不完整`);
    }
    if (candidate.contract.schemaVersion !== 1 || !isRecord(candidate.contract.source) || candidate.contract.source.kind !== "generated" || !nonEmpty(candidate.contract.source.candidateId) || !Array.isArray(candidate.contract.references)) {
        throw new Error(`第 ${index + 1} 个视觉方向 Contract 不完整`);
    }
    const id = `style-generated-${stableHash({ inputKey, index, label: candidate.label, modelStyle: candidate.contract.modelStyle }).slice(-8)}`;
    const proposed = {
        ...candidate.contract,
        schemaVersion: 1,
        source: { kind: "generated", candidateId: id },
        references: referenceKeys.map((storageKey) => ({ storageKey })),
    };
    const compiled = compilePptStyleContract(proposed);
    if (!compiled.ok) throw new Error(`第 ${index + 1} 个视觉方向 Contract 无效：${compiled.issues.map((issue) => issue.message).join("；")}`);
    return {
        id,
        label: candidate.label.trim(),
        rationale: candidate.rationale.trim(),
        recommended: candidate.recommended,
        basedOnContentRevision: input.contentRevision,
        contract: compiled.value.canonical,
    };
}

/**
 * Tolerant JSON parsing for model responses: raw parse → strip a markdown code fence wrapping the
 * whole response → extract the first balanced `{...}`/`[...]` substring. Returns `undefined` only
 * once every attempt fails (never retries the network request).
 */
function parseTolerantJsonResponse(raw: string): unknown {
    const trimmed = raw.trim();
    const direct = tryParseJson(trimmed);
    if (direct !== undefined) return direct;

    const unfenced = stripMarkdownFence(trimmed);
    if (unfenced !== trimmed) {
        const fromFence = tryParseJson(unfenced);
        if (fromFence !== undefined) return fromFence;
    }

    const extracted = extractBalancedJson(unfenced);
    if (extracted !== undefined) return tryParseJson(extracted);

    return undefined;
}

function tryParseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function stripMarkdownFence(text: string): string {
    const match = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    return match ? match[1].trim() : text;
}

/** Finds the first `{`/`[` and returns the matching balanced substring, respecting string literals. */
function extractBalancedJson(text: string): string | undefined {
    const startIndex = text.search(/[{[]/);
    if (startIndex === -1) return undefined;
    const openChar = text[startIndex];
    const closeChar = openChar === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    for (let index = startIndex; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escapeNext) escapeNext = false;
            else if (char === "\\") escapeNext = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === openChar) depth += 1;
        else if (char === closeChar) {
            depth -= 1;
            if (depth === 0) return text.slice(startIndex, index + 1);
        }
    }
    return undefined;
}

function nonEmpty(value: unknown): value is string {
    return typeof value === "string" && Boolean(value.trim());
}

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unique(values: readonly string[]) {
    const seen = new Set<string>();
    return values.flatMap((value) => {
        const cleaned = value.trim();
        if (!cleaned || seen.has(cleaned)) return [];
        seen.add(cleaned);
        return [cleaned];
    });
}

function stableHash(value: unknown) {
    const input = stableStringify(value);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
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
