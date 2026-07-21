import type { CanvasProjectPptStyleContract, PptLayoutRole, PptVisualDirectionPresetId } from "@/stores/canvas/use-canvas-store";

export const PPT_VISUAL_DIRECTION_PRESETS = [
    {
        id: "clean-report",
        label: "清晰专业",
        description: "克制、清楚，优先保证文字与图表可读。",
        direction: "清晰专业的报告视觉，使用克制配色、明确的信息层级、充足留白与稳定网格，优先保证文字和图表可读性。",
    },
    {
        id: "visual-story",
        label: "视觉叙事",
        description: "以画面推进故事，减少装饰性信息。",
        direction: "以视觉叙事推进内容，使用有明确焦点的大画面、节奏化构图与简洁文字，让每页只传达一个核心信息。",
    },
    {
        id: "brand-led",
        label: "品牌优先",
        description: "强化品牌识别，同时保持内容清晰。",
        direction: "以品牌识别为主导，稳定使用品牌色、标志性图形语言与一致版式，同时保持正文和数据清晰可读。",
    },
] as const satisfies readonly { id: PptVisualDirectionPresetId; label: string; description: string; direction: string }[];

export const PPT_LAYOUT_ROLES = [
    { id: "cover", label: "封面", instruction: "封面页：建立主题与第一视觉印象，只保留必要的标题和识别信息。" },
    { id: "section", label: "章节页", instruction: "章节页：清楚标记叙事转折，以简洁构图承上启下。" },
    { id: "content", label: "内容页", instruction: "内容页：围绕单一核心信息组织正文与视觉元素，保持层级清楚。" },
    { id: "evidence", label: "证据页", instruction: "证据页：突出数据、事实或案例，并让证据与结论的对应关系一目了然。" },
    { id: "comparison", label: "对比页", instruction: "对比页：使用统一维度并列呈现差异，让比较关系可以快速扫描。" },
    { id: "close", label: "收尾页", instruction: "收尾页：收束核心结论或行动号召，形成明确、克制的结束感。" },
] as const satisfies readonly { id: PptLayoutRole; label: string; instruction: string }[];

const FORBIDDEN_PATTERN = /(?:不要|禁止|不得|请勿|严禁|避免|不允许|不使用|不能)/;
const VISUAL_DIRECTION_LABEL_PATTERN = /^(?:视觉方向|风格|配色|色彩|字体|背景|留白|图标|材质|质感)\s*[:：]/;
const VISUAL_DIRECTION_PATTERN =
    /(?:视觉语言|画面气质|风格|配色|色彩|主色|辅助色|品牌色|颜色|材质|质感|渐变|赛博朋克|极简|扁平|写实|手绘|电影感|杂志感|海报感|科技感|未来感|复古感|清新感|插画风|摄影风|(?:红|蓝|绿|紫|黑|白|金|银|橙|黄|灰)(?:色)?(?:背景|底色|基调|为主)|(?:报告|咨询|品牌|商务|专业|科技|未来|复古|清新|手绘|卡通|写实|电影|杂志|海报)风)/;
const presetIds = new Set<string>(PPT_VISUAL_DIRECTION_PRESETS.map((preset) => preset.id));
const layoutRoles = new Set<string>(PPT_LAYOUT_ROLES.map((role) => role.id));

export function getPptVisualDirectionPreset(presetId: PptVisualDirectionPresetId) {
    return PPT_VISUAL_DIRECTION_PRESETS.find((preset) => preset.id === presetId)!;
}

export function getPptVisualDirectionLabel(value: unknown) {
    if (!isPptStyleContractValid(value)) return "待修复";
    const source = value.source;
    if (source.kind === "custom") return "自定义";
    return PPT_VISUAL_DIRECTION_PRESETS.find((preset) => preset.id === source.presetId)?.label ?? "待修复";
}

export function createPptVisualDirectionPresetContract(presetId: PptVisualDirectionPresetId = "clean-report"): CanvasProjectPptStyleContract {
    return {
        source: { kind: "preset", presetId },
        direction: getPptVisualDirectionPreset(presetId).direction,
        references: [],
    };
}

export function normalizePptStyleContract(contract: CanvasProjectPptStyleContract): CanvasProjectPptStyleContract {
    const seen = new Set<string>();
    const references = contract.references.flatMap((reference) => {
        const storageKey = reference.storageKey.trim();
        if (!storageKey || seen.has(storageKey)) return [];
        seen.add(storageKey);
        return [{ storageKey }];
    });
    return {
        source: contract.source.kind === "preset" ? { kind: "preset", presetId: contract.source.presetId } : { kind: "custom" },
        direction: contract.direction.trim(),
        references,
    };
}

export function validatePptStyleContract(value: unknown): string[] {
    if (!value || typeof value !== "object") return ["视觉方向 Contract 缺失"];
    const contract = value as Partial<CanvasProjectPptStyleContract>;
    const issues: string[] = [];
    if (!contract.source || typeof contract.source !== "object") issues.push("视觉方向来源缺失");
    else if (contract.source.kind === "preset") {
        if (!presetIds.has(String(contract.source.presetId || ""))) issues.push("视觉方向使用了未知 preset");
    } else if (contract.source.kind !== "custom") issues.push("视觉方向来源无效");
    if (typeof contract.direction !== "string" || !contract.direction.trim()) issues.push("视觉方向内容为空");
    if (!Array.isArray(contract.references)) issues.push("视觉方向参考图列表无效");
    else if (contract.references.some((reference) => !reference || typeof reference !== "object" || typeof reference.storageKey !== "string" || !reference.storageKey.trim())) issues.push("视觉方向参考图缺少 storageKey");
    return issues;
}

export function assertPptStyleContract(value: unknown): asserts value is CanvasProjectPptStyleContract {
    const issue = validatePptStyleContract(value)[0];
    if (issue) throw new Error(issue);
}

export function isPptStyleContractValid(value: unknown): value is CanvasProjectPptStyleContract {
    return validatePptStyleContract(value).length === 0;
}

export function samePptStyleContract(left: CanvasProjectPptStyleContract, right: CanvasProjectPptStyleContract) {
    if (!isPptStyleContractValid(left) || !isPptStyleContractValid(right)) return false;
    return JSON.stringify(normalizePptStyleContract(left)) === JSON.stringify(normalizePptStyleContract(right));
}

export function createPptStyleContractDraft(value: unknown): CanvasProjectPptStyleContract {
    if (isPptStyleContractValid(value)) return normalizePptStyleContract(value);
    const candidate = value && typeof value === "object" ? (value as Partial<CanvasProjectPptStyleContract>) : {};
    const references = Array.isArray(candidate.references) ? candidate.references.flatMap((reference) => (reference && typeof reference.storageKey === "string" && reference.storageKey.trim() ? [{ storageKey: reference.storageKey.trim() }] : [])) : [];
    return {
        source: { kind: "custom" },
        direction: typeof candidate.direction === "string" ? candidate.direction : "",
        references,
    };
}

export function findPptVisualDirectionInstructions(values: string | string[]) {
    const lines = (Array.isArray(values) ? values : meaningfulLines(values)).flatMap(meaningfulLines);
    return unique(
        lines.filter((line) => {
            if (FORBIDDEN_PATTERN.test(line)) return false;
            return VISUAL_DIRECTION_LABEL_PATTERN.test(line) || VISUAL_DIRECTION_PATTERN.test(line.replace(/^(?:视觉建议|布局|排版|构图|画面|对齐|位置|图表|比例|尺寸)\s*[:：]\s*/, ""));
        }),
    );
}

export function derivePptVisualDirectionRules(requirements: string, direction: string) {
    const requirementLines = meaningfulLines(requirements);
    const directionLines = meaningfulLines(direction);
    return {
        direction: directionLines.filter((line) => !FORBIDDEN_PATTERN.test(line)).join("\n"),
        forbiddenRules: unique([...requirementLines, ...directionLines].filter((line) => FORBIDDEN_PATTERN.test(line))),
    };
}

export function isPptLayoutRole(value: unknown): value is PptLayoutRole {
    return typeof value === "string" && layoutRoles.has(value);
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

function meaningfulLines(value: string) {
    return value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function unique(values: string[]) {
    const seen = new Set<string>();
    return values.flatMap((value) => {
        const cleaned = value.trim();
        const key = cleaned.replace(/\s+/g, " ");
        if (!cleaned || seen.has(key)) return [];
        seen.add(key);
        return [cleaned];
    });
}
