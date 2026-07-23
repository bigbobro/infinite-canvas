import { derivePptLockedFacts, isPptLayoutIntentSupported, renderPptPageSpecText, validatePptPageSpec } from "@/lib/ppt/content-plan";
import { PPT_PAGE_PROMPT } from "@/lib/ppt/deck-builder";
import { compilePptStyleContract, derivePptVisualDirectionRules, findPptDeckStyleOverrides, isPptLayoutRole, reviewPptStyle } from "@/lib/ppt/style-contract";
import type {
    CanvasProjectPptCompilationIssue,
    CanvasProjectPptCompilationSnapshot,
    CanvasProjectPptCompilationTarget,
    CanvasProjectPptCompiledPrompt,
    CanvasProjectPptDeckBrief,
    CanvasProjectPptDeckShellFacts,
    CanvasProjectPptLockedFact,
    CanvasProjectPptPageSpec,
    CanvasProjectPptVerbatimSpec,
    PptPrincipleDeviation,
} from "@/stores/canvas/use-canvas-store";

export const PPT_COMPILER_VERSION = "4.0.0";

export type PptCompilationTarget = CanvasProjectPptCompilationTarget;

const PPT_REFERENCE_ROLE_INSTRUCTION = "参考图仅用于对齐配色、字体、图形语言与外壳位置；页眉文字、章节标签、页码一律以「本页页面事实」为准，不得照搬参考图中的任何文字、页码、目录或侧栏结构。";
const PPT_LAYOUT_FLEXIBILITY_INSTRUCTION = "正文构图按本页内容形态组织，不得复制参考图或其他页面的正文构图；同套页面允许构图差异。";

/** SHA-30c：理念偏离的承接指令——用户选择偏离时，编译器为该页渲染适配指令，下游仍保持全约束（偏离=修订，不是豁免）。 */
const PPT_PRINCIPLE_DEVIATION_INSTRUCTIONS: Record<PptPrincipleDeviation["principle"], string> = {
    "cover-extra-content": "封面在保持定位语视觉主导的前提下承载少量补充内容；补充内容做极轻量处理，不得挤压留白与开场层级",
    "cover-claim-checklist": "封面核心信息为多点式表述时，以紧凑列点呈现，保持封面级留白，不做正文页密度",
};

type CompilePptPromptSnapshotBase = {
    snapshotId: string;
    compiledAt: string;
    targets: PptCompilationTarget[];
};

export type CompilePptPromptSnapshotInput = CompilePptPromptSnapshotBase &
    (
        | { compilePolicy: "structured"; deckBrief: CanvasProjectPptDeckBrief; pageSpecs: CanvasProjectPptPageSpec[]; deckShell: CanvasProjectPptDeckShellFacts }
        | { compilePolicy: "verbatim"; verbatimSpecs: CanvasProjectPptVerbatimSpec[]; confirmedGlobalSpec?: string }
    );

const FORBIDDEN_PATTERN = /(?:不要|禁止|不得|请勿|严禁|避免|不允许|不使用|不能)/;
const LIST_ITEM_PATTERN = /^\s*(?:[-*•]\s+|\d+[.)、]\s*)/;

export function derivePptStyleRules(requirements: string, direction: string) {
    return derivePptVisualDirectionRules(requirements, direction);
}

/** 从完整 pageSpecs 顺序派生整套外壳事实；不得用过滤后的 targets 列表推导页码。 */
export function derivePptDeckShellFacts(pageSpecs: CanvasProjectPptPageSpec[], deckTitle: string): CanvasProjectPptDeckShellFacts {
    const hasSections = pageSpecs.some((pageSpec) => pageSpec.layoutRole === "section");
    let sectionIndex = 0;
    let currentSectionLabel: string | undefined;
    const pages = pageSpecs.map((pageSpec, index) => {
        if (pageSpec.layoutRole === "section") {
            sectionIndex += 1;
            const title = pageSpec.contentBlocks.find((block) => block.kind === "title")?.text.trim() || "";
            currentSectionLabel = `第 ${sectionIndex} 章 · ${title}`;
        }
        const page: CanvasProjectPptDeckShellFacts["pages"][number] = {
            pageId: pageSpec.pageId,
            pageNumber: index + 1,
        };
        const isCoverOrClose = pageSpec.layoutRole === "cover" || pageSpec.layoutRole === "close" || pageSpec.contentForm === "cover" || pageSpec.contentForm === "closing";
        if (hasSections && !isCoverOrClose && currentSectionLabel) page.sectionLabel = currentSectionLabel;
        return page;
    });
    return { pageCount: pageSpecs.length, deckTitle, pages };
}

export function compilePptPromptSnapshot(input: CompilePptPromptSnapshotInput): CanvasProjectPptCompilationSnapshot {
    return input.compilePolicy === "structured" ? compileStructuredSnapshot(input) : compileVerbatimSnapshot(input);
}

export function hasBlockingCompilationIssues(snapshot: CanvasProjectPptCompilationSnapshot) {
    return snapshot.issues.some((issue) => issue.severity === "blocking");
}

function compileStructuredSnapshot(input: Extract<CompilePptPromptSnapshotInput, { compilePolicy: "structured" }>): CanvasProjectPptCompilationSnapshot {
    const pageSpecById = new Map(input.pageSpecs.map((pageSpec) => [pageSpec.pageId, pageSpec]));
    const issues: CanvasProjectPptCompilationIssue[] = [];
    const styleReview = reviewPptStyle({
        contract: input.deckBrief.styleContract,
        contentRevision: input.deckBrief.contentRevision,
        reviewedContentRevision: input.deckBrief.contentRevision,
        draftRevision: input.deckBrief.version,
        pageSpecs: input.pageSpecs,
        deckRules: input.deckBrief.globalRules,
        targetLayouts: input.targets.map((target) => ({ pageId: target.pageId, values: target.layoutIntent.filter((value) => value !== PPT_PAGE_PROMPT) })),
    });
    validateUniqueIds(
        input.pageSpecs.map((pageSpec) => pageSpec.pageId),
        input.snapshotId,
        issues,
        "PageSpec",
    );
    const prompts = input.targets.map((target) => {
        const promptIssues: CanvasProjectPptCompilationIssue[] = [];
        const addIssue = issueCollector(input.snapshotId, target, promptIssues, issues);
        const pageSpec = pageSpecById.get(target.pageId);
        if (!pageSpec) addIssue("missing_page_spec", "blocking", `页面 ${target.pageId} 缺少 PageSpec，不能生成`);
        if (typeof input.deckBrief.sourceHash !== "string" || !input.deckBrief.sourceHash.trim()) addIssue("invalid_content_provenance", "blocking", "整套内容定位缺少原始材料版本绑定");
        if (typeof input.deckBrief.contentRevision !== "string" || !input.deckBrief.contentRevision.trim()) addIssue("invalid_content_provenance", "blocking", "整套内容定位缺少已确认内容版本");
        for (const styleIssue of styleReview.issues.filter((issue) => issue.scope === "contract" || issue.pageId === target.pageId)) {
            const code =
                styleIssue.code === "invalid_contract"
                    ? "invalid_style_contract"
                    : styleIssue.code === "page_style_override"
                      ? "visual_direction_outside_contract"
                      : styleIssue.code === "semantic_color_conflict"
                        ? "semantic_visual_conflict"
                        : styleIssue.code === "invalid_visual_encoding"
                          ? "invalid_visual_encoding"
                          : "invalid_content_provenance";
            addIssue(code, styleIssue.severity, `${styleIssue.location}${styleIssue.fragment ? `（${styleIssue.fragment}）` : ""}：${styleIssue.reason}`);
        }
        if (pageSpec && !isPptLayoutRole(pageSpec.layoutRole)) addIssue("invalid_layout_role", "blocking", `页面 ${target.pageId} 的页面职责无效`);
        if (pageSpec) for (const issue of validatePptPageSpec(pageSpec)) addIssue(issue.code, "blocking", issue.message);
        if (pageSpec) for (const instruction of target.layoutIntent.filter((intent) => !isSupportedLayoutInstruction(pageSpec, intent))) addIssue("unreviewed_fact", "blocking", `排版要求包含未经批准的文案或事实：${preview(instruction)}`);

        const compiled = buildStructuredPrompt(input.deckBrief, pageSpec, target, input.deckShell);
        const finalPrompt = target.override === undefined ? compiled.finalPrompt : target.override.trim();
        if (pageSpec) {
            if (normalizedPrompt(target.semanticText) !== normalizedPrompt(renderPptPageSpecText(pageSpec))) addIssue("invalid_content_provenance", "blocking", "画布节点投影与 PageSpec 内容不一致");
            if (target.extraTexts.some((value) => value.trim())) addIssue("unreviewed_fact", "blocking", "存在未纳入 PageSpec 的额外文本输入");
            validateControlledLayouts(pageSpec, target, addIssue);
            validateLockedFacts([...input.deckBrief.lockedDeckFacts, ...derivePptLockedFacts(pageSpec)], finalPrompt, compiled.pageContent, addIssue);
            validateForbiddenRules(input.deckBrief.forbiddenRules, finalPrompt, addIssue);
            if (target.override !== undefined) {
                validateRequiredInstructions(compiled.requiredInstructions, finalPrompt, addIssue);
                if (!target.overrideConfirmed && normalizedPrompt(finalPrompt) !== normalizedPrompt(compiled.finalPrompt)) addIssue("override_review_required", "blocking", "显式覆盖与自动编译结果不一致，需要用户确认");
                validateNoNewFacts(compiled.finalPrompt, finalPrompt, addIssue);
            }
        }
        return compiledPrompt(input.snapshotId, target, finalPrompt, pageSpec?.sourceRefs || [], promptIssues, target.override);
    });
    const snapshotPageSpecs = uniqueTargetSpecs(input.targets, input.pageSpecs);
    return {
        compilePolicy: "structured",
        snapshotId: input.snapshotId,
        compilerVersion: PPT_COMPILER_VERSION,
        createdAt: input.compiledAt,
        inputHash: hashPptCompilerInput({ compilePolicy: input.compilePolicy, deckBrief: input.deckBrief, pageSpecs: snapshotPageSpecs, targets: input.targets, deckShell: input.deckShell }),
        deckBriefVersion: input.deckBrief.version,
        pageSpecsVersion: snapshotPageSpecs.reduce((version, pageSpec) => Math.max(version, pageSpec.version), 0),
        styleFingerprint: styleReview.compiled?.fingerprint || "invalid-style-contract",
        deckBrief: structuredClone(input.deckBrief),
        pageSpecs: structuredClone(snapshotPageSpecs),
        deckShell: structuredClone(input.deckShell),
        targets: structuredClone(input.targets),
        prompts,
        issues,
    };
}

function compileVerbatimSnapshot(input: Extract<CompilePptPromptSnapshotInput, { compilePolicy: "verbatim" }>): CanvasProjectPptCompilationSnapshot {
    const issues: CanvasProjectPptCompilationIssue[] = [];
    const specById = new Map(input.verbatimSpecs.map((spec) => [spec.pageId, spec]));
    validateUniqueIds(
        input.verbatimSpecs.map((spec) => spec.pageId),
        input.snapshotId,
        issues,
        "VerbatimSpec",
    );
    const prompts = input.targets.map((target) => {
        const promptIssues: CanvasProjectPptCompilationIssue[] = [];
        const addIssue = issueCollector(input.snapshotId, target, promptIssues, issues);
        const spec = specById.get(target.pageId);
        if (!spec) addIssue("missing_page_spec", "blocking", `页面 ${target.pageId} 缺少 VerbatimSpec，不能生成`);
        if (spec) validateVerbatimSpec(spec, addIssue);
        if (target.override !== undefined || target.extraTexts.some((value) => value.trim()) || target.layoutIntent.some((value) => value.trim()))
            addIssue("invalid_verbatim_spec", "blocking", "逐字规格模式只允许编辑 canonical VerbatimSpec，不接受节点或方案覆盖");
        const finalPrompt = spec ? appendConfirmedGlobalSpec(spec.exactText, input.confirmedGlobalSpec) : "";
        return compiledPrompt(input.snapshotId, target, finalPrompt, [], promptIssues);
    });
    const targetIds = new Set(input.targets.map((target) => target.pageId));
    const verbatimSpecs = input.verbatimSpecs.filter((spec) => targetIds.has(spec.pageId));
    return {
        compilePolicy: "verbatim",
        snapshotId: input.snapshotId,
        compilerVersion: PPT_COMPILER_VERSION,
        createdAt: input.compiledAt,
        inputHash: hashPptCompilerInput({ compilePolicy: input.compilePolicy, verbatimSpecs, confirmedGlobalSpec: input.confirmedGlobalSpec, targets: input.targets }),
        verbatimSpecs: structuredClone(verbatimSpecs),
        ...(input.confirmedGlobalSpec === undefined ? {} : { confirmedGlobalSpec: input.confirmedGlobalSpec }),
        targets: structuredClone(input.targets),
        prompts,
        issues,
    };
}

function buildStructuredPrompt(deckBrief: CanvasProjectPptDeckBrief, pageSpec: CanvasProjectPptPageSpec | undefined, target: PptCompilationTarget, deckShell: CanvasProjectPptDeckShellFacts) {
    const pageContent = pageSpec ? renderPptPageSpecText(pageSpec) : "";
    const promptPageContent = pageSpec ? renderPptPromptBlocks(pageSpec) : "";
    const globalRules = deckBrief.globalRules.filter((instruction) => !findPptDeckStyleOverrides(instruction).length);
    const layoutInstructions = unique([...(pageSpec?.layoutIntent || []), ...target.layoutIntent].filter((instruction) => !findPptDeckStyleOverrides(instruction).length && Boolean(pageSpec && isSupportedLayoutInstruction(pageSpec, instruction))));
    const style = compilePptStyleContract(deckBrief.styleContract);
    const styleInstructions = style.ok ? style.value.globalInstructions : [];
    const deviationInstructions = (pageSpec?.principleDeviations || []).map((deviation) => PPT_PRINCIPLE_DEVIATION_INSTRUCTIONS[deviation.principle]);
    const roleInstructions = [...(pageSpec && isPptLayoutRole(pageSpec.layoutRole) && style.ok ? style.value.roleInstructions[pageSpec.layoutRole] : []), ...deviationInstructions];
    const structureInstructions = pageSpec ? pptContentStructureInstructions(pageSpec) : [];
    const encodingInstructions = pageSpec ? pageSpec.visualEncoding.map((encoding) => visualEncodingInstruction(encoding, pageSpec)) : [];
    const pageFactInstructions = buildPageShellFactInstructions(deckBrief.styleContract.modelStyle.shell, deckShell, target.pageId);
    const shellConstraintInstructions = pageFactInstructions.length ? [PPT_REFERENCE_ROLE_INSTRUCTION, PPT_LAYOUT_FLEXIBILITY_INSTRUCTION] : [];
    const visibleDeckBlocks = [deckBrief.audience, deckBrief.goal, deckBrief.narrative, ...globalRules];
    const globalFactLines = unique(deckBrief.lockedDeckFacts.filter((fact) => !visibleDeckBlocks.some((block) => containsFragment(block, fact.value))).map((fact) => fact.sourceExcerpt || fact.value));
    const sections: Array<[string, string[]]> = [
        ["受众", [deckBrief.audience]],
        ["整套目标", [deckBrief.goal]],
        ["叙事主线", [deckBrief.narrative]],
        ["全局规则", globalRules],
        ["全局锁定事实", globalFactLines],
        ["禁止项", deckBrief.forbiddenRules],
        ["本页内容", [promptPageContent]],
        ["内容结构", structureInstructions],
        ["页面职责与角色母版", roleInstructions],
        ["信息表达", encodingInstructions],
        ["本页布局", layoutInstructions],
        ["本页页面事实", pageFactInstructions],
        ["整套视觉系统", [...styleInstructions, ...shellConstraintInstructions]],
        ["允许自由发挥", [pageSpec?.freedom || ""]],
    ];
    const finalPrompt = sections
        .flatMap(([title, values]) => (unique(values).length ? [`【${title}】\n${unique(values).join("\n")}`] : []))
        .join("\n\n")
        .trim();
    return {
        finalPrompt,
        pageContent,
        requiredInstructions: unique([
            ...visibleDeckBlocks,
            ...deckBrief.forbiddenRules,
            ...roleInstructions,
            ...structureInstructions,
            ...encodingInstructions,
            ...layoutInstructions,
            ...pageFactInstructions,
            ...styleInstructions,
            ...shellConstraintInstructions,
            pageSpec?.freedom || "",
        ]),
    };
}

function buildPageShellFactInstructions(shell: CanvasProjectPptDeckBrief["styleContract"]["modelStyle"]["shell"], deckShell: CanvasProjectPptDeckShellFacts, pageId: string) {
    if (shell.header === "none" && shell.footer === "none") return [];
    const page = deckShell.pages.find((item) => item.pageId === pageId);
    if (!page) return [];
    const lines: string[] = [];
    if (shell.footer === "page-number" || shell.footer === "deck-title-and-page-number") {
        lines.push(`本页页码 ${page.pageNumber}，总页数 ${deckShell.pageCount}；页脚页码必须显示为 ${page.pageNumber}/${deckShell.pageCount}`);
    }
    if (shell.header === "deck-title" || shell.footer === "deck-title-and-page-number") {
        lines.push(`整套标题：${deckShell.deckTitle}`);
    }
    if (shell.header === "section-label") {
        if (page.sectionLabel) lines.push(`本页章节标签：${page.sectionLabel}`);
        else if (!deckShell.pages.some((item) => item.sectionLabel)) lines.push("本套无章节分组，页眉不得出现章节编号");
    }
    return lines;
}

function renderPptPromptBlocks(pageSpec: CanvasProjectPptPageSpec) {
    return pageSpec.contentBlocks
        .filter((block) => block.kind !== "placeholder")
        .map((block, index) => `[B${index + 1} · ${pptBlockRole(block.kind)}] ${block.text}`)
        .join("\n");
}

function pptBlockRole(kind: CanvasProjectPptPageSpec["contentBlocks"][number]["kind"]) {
    return {
        title: "标题",
        primary_claim: "核心信息",
        supporting_claim: "支持判断",
        body: "正文",
        list: "要点列表",
        table: "表格内容",
        chart_data: "图表数据",
        placeholder: "占位",
    }[kind];
}

function pptContentStructureInstructions(pageSpec: CanvasProjectPptPageSpec) {
    const formInstruction = {
        cover: "以主标题和核心信息建立开场层级，不把封面做成正文页。",
        comparison: "按可对齐的维度并列表达差异与取舍，不用连续段落代替对比关系。",
        architecture: "用节点、分层与连线表达系统组成和交互关系。",
        process: "按时序或因果将已批准步骤组织成连续流程。",
        timeline: "沿单一时间轴组织里程碑，保持先后关系清晰。",
        data: "以关键数据为视觉主体，使用图表或指标层级表达数值关系。",
        narrative: "采用标题—核心信息—支持内容的主张与依据结构，将正文拆成独立信息块。",
        closing: "用核心结论和行动信息收束，不在收尾页堆叠新正文。",
    }[pageSpec.contentForm];
    return ["结构编号 B1、B2等只用于标识内容块，不作为可见文案。", formInstruction, "先做信息设计，不得只把各段文字上下堆成大文本卡片。", "允许新增不含文字的图标、形状、连线、分区和图表容器来表达已批准内容；不得新增事实或可见标签。"];
}

function visualEncodingInstruction(encoding: CanvasProjectPptPageSpec["visualEncoding"][number], pageSpec: CanvasProjectPptPageSpec) {
    const channel = { color: "颜色", shape: "形状", position: "位置", size: "大小", line: "连线", icon: "图标" }[encoding.channel];
    const intent = { differentiate: "区分内容类别", emphasize: "强调重点", sequence: "表达顺序", group: "表达分组", show_relationship: "表达关系" }[encoding.intent];
    const mapping = unique((encoding.lockedMapping || []).map((item) => item.token)).join("、");
    const visibleBlocks = pageSpec.contentBlocks.filter((block) => block.kind !== "placeholder");
    const targets = encoding.contentBlockIds.flatMap((blockId) => {
        const index = visibleBlocks.findIndex((block) => block.id === blockId);
        return index < 0 ? [] : [`B${index + 1}`];
    });
    return `对 ${targets.join("、") || "已引用内容块"} 使用${channel}${intent}${mapping ? `，保留已确认映射：${mapping}` : ""}`;
}

function isSupportedLayoutInstruction(pageSpec: CanvasProjectPptPageSpec, instruction: string) {
    return instruction === PPT_PAGE_PROMPT || isPptLayoutIntentSupported(pageSpec, instruction);
}

function validateVerbatimSpec(spec: CanvasProjectPptVerbatimSpec, addIssue: IssueAdder) {
    if (!spec.pageId.trim() || !spec.title.trim() || !spec.exactText) addIssue("invalid_verbatim_spec", "blocking", "VerbatimSpec 缺少页面身份、标题或逐字正文");
    if (spec.origin.kind === "source_slice" && (!spec.origin.sourceHash.trim() || !Number.isInteger(spec.origin.startLine) || !Number.isInteger(spec.origin.endLine) || spec.origin.startLine < 1 || spec.origin.endLine < spec.origin.startLine)) {
        addIssue("invalid_verbatim_spec", "blocking", "VerbatimSpec 的原文切片血缘无效");
    }
}

function appendConfirmedGlobalSpec(exactText: string, confirmedGlobalSpec?: string) {
    if (!confirmedGlobalSpec?.trim() || exactText.includes(confirmedGlobalSpec)) return exactText;
    return `${exactText}\n\n${confirmedGlobalSpec}`;
}

function validateControlledLayouts(pageSpec: CanvasProjectPptPageSpec, target: PptCompilationTarget, addIssue: IssueAdder) {
    const approved = new Set(pageSpec.layoutIntent.flatMap(meaningfulLines).map(normalize));
    for (const layout of target.layoutIntent.flatMap(meaningfulLines)) if (!approved.has(normalize(layout)) && !target.layoutConfirmed) addIssue("review_required", "blocking", `排版要求未经显式确认：${preview(layout)}`);
}

function validateLockedFacts(facts: CanvasProjectPptLockedFact[], finalPrompt: string, pageContent: string, addIssue: IssueAdder) {
    for (const fact of facts) {
        if (fact.kind === "point_count") {
            const actual = readPointCount(pageContent);
            const expected = Number(fact.value);
            if (actual === undefined) addIssue("missing_locked_fact", "blocking", `最终提示词缺少锁定点数：${fact.value}`);
            else if (actual !== expected) addIssue("point_count_mismatch", "blocking", `本页必须保持 ${expected} 点，当前为 ${actual} 点`);
        } else if (!containsFragment(finalPrompt, fact.value)) addIssue("missing_locked_fact", "blocking", `最终提示词缺少锁定事实：${fact.value}`);
    }
}

function validateRequiredInstructions(instructions: string[], finalPrompt: string, addIssue: IssueAdder) {
    for (const instruction of instructions) if (!containsFragment(finalPrompt, instruction)) addIssue("missing_required_instruction", "blocking", `显式覆盖缺少必要约束：${preview(instruction)}`);
}

function validateNoNewFacts(compiled: string, override: string, addIssue: IssueAdder) {
    const compiledFacts = extractFacts(compiled);
    for (const fact of extractFacts(override)) if (!compiledFacts.has(normalize(fact))) addIssue("unreviewed_fact", "blocking", `显式覆盖包含未确认事实：${fact}`);
}

function validateForbiddenRules(rules: string[], text: string, addIssue: IssueAdder) {
    for (const rule of rules) {
        const core = rule
            .replace(FORBIDDEN_PATTERN, "")
            .replace(/^[:：、，,\s]+/, "")
            .trim();
        if (core.length < 2) continue;
        const withoutRule = text.replaceAll(rule, "");
        if (withoutRule.includes(core)) addIssue("forbidden_conflict", "blocking", `页面指令与禁止项冲突：${rule}`);
    }
}

function compiledPrompt(snapshotId: string, target: PptCompilationTarget, finalPrompt: string, sourceRefs: CanvasProjectPptCompiledPrompt["sourceRefs"], issues: CanvasProjectPptCompilationIssue[], override?: string) {
    return {
        promptId: `${snapshotId}:${target.pageId}:${target.takeId}`,
        pageId: target.pageId,
        takeId: target.takeId,
        finalPrompt,
        sourceRefs: structuredClone(sourceRefs),
        ...(override === undefined ? {} : { override: override.trim() }),
        issueIds: issues.map((issue) => issue.id),
    } satisfies CanvasProjectPptCompiledPrompt;
}

type IssueAdder = (code: CanvasProjectPptCompilationIssue["code"], severity: CanvasProjectPptCompilationIssue["severity"], message: string) => void;

function issueCollector(snapshotId: string, target: PptCompilationTarget, local: CanvasProjectPptCompilationIssue[], all: CanvasProjectPptCompilationIssue[]): IssueAdder {
    const counts = new Map<CanvasProjectPptCompilationIssue["code"], number>();
    return (code, severity, message) => {
        const ordinal = (counts.get(code) || 0) + 1;
        counts.set(code, ordinal);
        const issue = { id: `${snapshotId}:${target.pageId}:${target.takeId}:${code}:${ordinal}`, severity, code, message, pageId: target.pageId, takeId: target.takeId } satisfies CanvasProjectPptCompilationIssue;
        local.push(issue);
        all.push(issue);
    };
}

function validateUniqueIds(ids: string[], snapshotId: string, issues: CanvasProjectPptCompilationIssue[], label: string) {
    if (ids.length === new Set(ids).size) return;
    issues.push({ id: `${snapshotId}:duplicate-spec-id`, severity: "blocking", code: "invalid_content_structure", message: `${label} 存在重复页面身份` });
}

function uniqueTargetSpecs(targets: PptCompilationTarget[], pageSpecs: CanvasProjectPptPageSpec[]) {
    const targetIds = new Set(targets.map((target) => target.pageId));
    return pageSpecs.filter((pageSpec) => targetIds.has(pageSpec.pageId));
}

function hashPptCompilerInput(value: unknown) {
    const input = JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function extractFacts(value: string) {
    return new Set([...value.matchAll(/(?:[$¥€£]\s*)?\d(?:[\d,]*\d)?(?:\.\d+)?\s*(?:亿元|万元|百分点|个月|小时|分钟|%|％|倍|万|亿|元|人|家|台|页|年|天|秒|个|项|条|点)?|\b[A-Z][A-Z0-9-]{1,}\b/g)].map((match) => match[0].trim()).filter(Boolean));
}

function readPointCount(value: string) {
    const bullets = value.split(/\r?\n/).filter((line) => LIST_ITEM_PATTERN.test(line)).length;
    const declared = [...value.matchAll(/(\d+)\s*(?:个)?(?:要点|点|项|条)/g)].map((match) => Number(match[1]));
    const counts = [...(bullets >= 2 ? [bullets] : []), ...declared].filter((count) => count > 0);
    return counts.length ? Math.max(...counts) : undefined;
}

function unique(values: string[]) {
    const seen = new Set<string>();
    return values.flatMap((value) => {
        const cleaned = value.trim();
        const key = normalize(cleaned);
        if (!cleaned || seen.has(key)) return [];
        seen.add(key);
        return [cleaned];
    });
}

function meaningfulLines(value: string) {
    return value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function containsFragment(text: string, fragment: string) {
    return normalize(text).includes(normalize(fragment));
}

function normalize(value: string) {
    return value.trim().replace(/\s+/g, " ");
}

function normalizedPrompt(value: string) {
    return meaningfulLines(value).map(normalize).join("\n");
}

function preview(value: string) {
    const normalized = normalize(value);
    return normalized.length > 48 ? `${normalized.slice(0, 48)}…` : normalized;
}
