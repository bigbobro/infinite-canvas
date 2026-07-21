import type {
    CanvasProjectPptCompilationIssue,
    CanvasProjectPptCompilationSnapshot,
    CanvasProjectPptCompilationTarget,
    CanvasProjectPptCompiledPrompt,
    CanvasProjectPptDeckBrief,
    CanvasProjectPptLockedFact,
    CanvasProjectPptPageSpec,
    CanvasProjectPptSourceRef,
} from "@/stores/canvas/use-canvas-store";

export const PPT_COMPILER_VERSION = "1.0.0";

export type PptCompilerPageInput = {
    pageId: string;
    title: string;
    outline: string;
    visualHint: string;
    sourceRange?: { startLine: number; endLine: number };
};

export type PptCompilerModelInput = {
    mode: "outline" | "extract";
    sourceMaterial: string;
    requirements: string;
    styleDescription: string;
    pages: PptCompilerPageInput[];
};

export type PptCompilationTarget = CanvasProjectPptCompilationTarget;

export type CompilePptPromptSnapshotInput = {
    snapshotId: string;
    compiledAt: string;
    deckBrief: CanvasProjectPptDeckBrief;
    pageSpecs: CanvasProjectPptPageSpec[];
    targets: PptCompilationTarget[];
};

const FORBIDDEN_PATTERN = /(?:不要|禁止|不得|请勿|严禁|避免|不允许|不使用|不能)/;
const NEGATION_PATTERN = /(?:尚未|尚无|并非|不是|没有|未|无|不)/;
const LAYOUT_LABEL_PATTERN = /^(?:布局|排版|构图|视觉(?:建议)?|画面|对齐|位置|图表|风格|配色|字体|背景|留白|图标|材质|比例|尺寸|页面级禁止项|禁止项)\s*[:：]/;
const LIST_ITEM_PATTERN = /^\s*(?:[-*•]\s+|\d+[.)、]\s*)/;
const NUMBER_PATTERN = /(?:[$¥€£]\s*)?\d(?:[\d,]*\d)?(?:\.\d+)?\s*(?:亿元|万元|百分点|个月|小时|分钟|%|％|倍|万|亿|元|人|家|台|页|年|天|秒|个|项|条|点)?/g;
const ASCII_TERM_PATTERN = /\b[A-Z][A-Z0-9-]{1,}\b/g;
const TABLE_PATTERN = /(?:表格|表头|行列|矩阵|三列|两列|双列)/;
const LAYOUT_INTENT_PATTERN = /(?:整页|文字|内容).*(?:左对齐|右对齐|居中)|(?:左侧|右侧|顶部|底部|上下|左右).*(?:排列|布局|放置|展示)|(?:柱状图|折线图|饼图|表格).*(?:排列|布局|并排)/;

export function buildPptCompilerModel(input: PptCompilerModelInput): { deckBrief: CanvasProjectPptDeckBrief; pageSpecs: CanvasProjectPptPageSpec[] } {
    const requirementLines = meaningfulLines(input.requirements);
    const styleRules = derivePptStyleRules(input.requirements, input.styleDescription);
    const globalRules = unique(requirementLines.filter((line) => !FORBIDDEN_PATTERN.test(line) && !isDeckBriefLabel(line)));
    const deckBrief: CanvasProjectPptDeckBrief = {
        version: 1,
        audience: labeledValue(input.requirements, ["受众", "面向对象", "目标用户"]),
        goal: labeledValue(input.requirements, ["目标", "目的"]),
        narrative: labeledValue(input.requirements, ["叙事", "叙事主线", "主线", "结构"]),
        visualLanguage: styleRules.visualLanguage,
        globalRules,
        forbiddenRules: styleRules.forbiddenRules,
        lockedDeckFacts: extractLockedFacts(requirementLines.filter((line) => !FORBIDDEN_PATTERN.test(line)).join("\n"), "deck").filter((fact) => fact.kind !== "point_count"),
    };
    const pageSpecs = input.pages.map((page) => buildPptPageSpec({ mode: input.mode, sourceMaterial: input.sourceMaterial, page }));
    return { deckBrief, pageSpecs };
}

export function derivePptStyleRules(requirements: string, styleDescription: string) {
    const requirementLines = meaningfulLines(requirements);
    const styleLines = meaningfulLines(styleDescription);
    return {
        visualLanguage: styleLines.filter((line) => !FORBIDDEN_PATTERN.test(line)).join("\n"),
        forbiddenRules: unique([...requirementLines, ...styleLines].filter((line) => FORBIDDEN_PATTERN.test(line))),
    };
}

export function compilePptPromptSnapshot(input: CompilePptPromptSnapshotInput): CanvasProjectPptCompilationSnapshot {
    const pageSpecById = new Map(input.pageSpecs.map((spec) => [spec.pageId, spec]));
    const snapshotPageSpecs = uniqueTargetPageSpecs(input.targets, input.pageSpecs);
    const issues: CanvasProjectPptCompilationIssue[] = [];
    const prompts = input.targets.map((target) => {
        const promptIssues: CanvasProjectPptCompilationIssue[] = [];
        const addIssue = issueCollector(input.snapshotId, target, promptIssues, issues);
        const pageSpec = pageSpecById.get(target.pageId);
        if (!pageSpec) addIssue("missing_page_spec", "blocking", `页面 ${target.pageId} 缺少 PageSpec，不能生成`);
        if (pageSpec?.requiresReview && !pageSpec.reviewedAt) addIssue("review_required", "blocking", pageSpec.reviewReason || "该页规格需要人工确认");

        const compiled = buildFinalPrompt(input.deckBrief, pageSpec, target);
        compiled.duplicateInstructions.forEach((instruction) => addIssue("duplicate_instruction", "warning", `重复指令已去重：${instruction}`));
        if (compiled.layoutConflict) addIssue("layout_conflict", "warning", compiled.layoutConflict);

        const finalPrompt = target.override === undefined ? compiled.finalPrompt : clean(target.override);
        if (pageSpec) {
            for (const copy of pageSpec.lockedCopy) {
                if (!containsFragment(finalPrompt, copy)) addIssue("missing_locked_copy", "blocking", `最终提示词缺少锁定正文：${preview(copy)}`);
            }
            const pageContent = target.override === undefined ? compiled.pageContent : promptSection(finalPrompt, "本页内容") || finalPrompt;
            validateLockedFacts([...input.deckBrief.lockedDeckFacts, ...pageSpec.lockedFacts], finalPrompt, pageContent, addIssue);
            validateTargetFacts(input.deckBrief, pageSpec, target.semanticText, addIssue);
            validateTargetStatements(pageSpec, target.semanticText, addIssue);
            validateControlledInputs(input.deckBrief, pageSpec, target, addIssue);
            target.extraTexts.forEach((text) => addIssue("unreviewed_fact", "blocking", `存在未纳入页面规格的额外文本输入：${preview(text)}`));
            validateForbiddenRules(input.deckBrief.forbiddenRules, target.override === undefined ? compiled.userInstructions : finalPrompt, addIssue);
            if (target.override !== undefined) {
                validateRequiredInstructions(compiled.requiredInstructions, finalPrompt, addIssue);
                validateOverrideFacts(compiled.finalPrompt, finalPrompt, addIssue);
                validateOverrideStatements(compiled.finalPrompt, finalPrompt, Boolean(target.overrideConfirmed), addIssue);
            }
        }

        return {
            promptId: `${input.snapshotId}:${target.pageId}:${target.takeId}`,
            pageId: target.pageId,
            takeId: target.takeId,
            finalPrompt,
            sourceRefs: pageSpec?.sourceRefs.map((sourceRef) => ({ ...sourceRef })) || [],
            ...(target.override === undefined ? {} : { override: clean(target.override) }),
            issueIds: promptIssues.map((issue) => issue.id),
        } satisfies CanvasProjectPptCompiledPrompt;
    });

    return {
        snapshotId: input.snapshotId,
        compilerVersion: PPT_COMPILER_VERSION,
        createdAt: input.compiledAt,
        deckBriefVersion: input.deckBrief.version,
        pageSpecsVersion: snapshotPageSpecs.reduce((version, pageSpec) => Math.max(version, pageSpec.version), 0),
        deckBrief: cloneDeckBrief(input.deckBrief),
        pageSpecs: snapshotPageSpecs.map(clonePageSpec),
        targets: input.targets.map(cloneTarget),
        prompts,
        issues,
    };
}

export function hasBlockingCompilationIssues(snapshot: CanvasProjectPptCompilationSnapshot) {
    return snapshot.issues.some((issue) => issue.severity === "blocking");
}

export function buildPptPageSpec({ mode, sourceMaterial, page, version = 1 }: { mode: PptCompilerModelInput["mode"]; sourceMaterial: string; page: PptCompilerPageInput; version?: number }): CanvasProjectPptPageSpec {
    const outlineLines = meaningfulLines(page.outline);
    const explicitTitle = labeledValue(page.outline, ["标题"]);
    const contentLines = outlineLines.filter((line) => !/^标题\s*[:：]/.test(line));
    const explicitLayout = contentLines.filter(isLayoutLine);
    const semanticLines = contentLines.filter((line) => !isLayoutLine(line));
    const lockedCopy = unique([mode === "outline" ? explicitTitle || clean(page.title) : "", ...semanticLines]);
    const lockedFacts = extractLockedFacts(lockedCopy.join("\n"), page.pageId);
    const sourceRefs = locatePageSourceRefs(mode, sourceMaterial, page, lockedCopy, lockedFacts);
    const unsourcedFacts = mode === "outline" ? lockedFacts.filter((fact) => fact.kind !== "point_count" && !containsFragment(sourceMaterial, fact.value)) : [];
    const unsourcedCopy = mode === "extract" ? lockedCopy.filter((copy) => !containsFragment(sourceMaterial, copy)) : [];
    const unsourcedStatements = mode === "outline" ? lockedCopy.filter((line) => !sourceSupportsLine(sourceMaterial, line)) : [];
    const requiresReview = semanticLines.length === 0 || unsourcedFacts.length > 0 || unsourcedCopy.length > 0 || unsourcedStatements.length > 0;
    const reviewReason =
        semanticLines.length === 0
            ? "未识别出可锁定的页面正文，请先确认内容与布局的划分"
            : unsourcedCopy.length
              ? `以下正文未在导入规格中定位到：${unsourcedCopy.map(preview).join("、")}`
              : unsourcedStatements.length
                ? `以下结论未在原材料中定位到：${unsourcedStatements.map(preview).join("、")}`
                : `以下数字或术语未在原材料中定位到：${unsourcedFacts.map((fact) => fact.value).join("、")}`;
    return {
        pageId: page.pageId,
        version,
        sourceRefs,
        lockedCopy,
        lockedFacts,
        message: explicitTitle || clean(page.title) || semanticLines[0] || page.pageId,
        layoutIntent: unique([...explicitLayout, clean(page.visualHint)]),
        assetRefs: extractAssetRefs(page.outline),
        freedom: mode === "extract" ? "只允许补充未锁定的视觉细节，不得改写锁定正文与事实" : "可在不改变锁定事实、术语和点数的前提下优化表达与视觉组织",
        requiresReview,
        ...(requiresReview ? { reviewReason } : {}),
    };
}

function buildFinalPrompt(deckBrief: CanvasProjectPptDeckBrief, pageSpec: CanvasProjectPptPageSpec | undefined, target: PptCompilationTarget) {
    const semanticText = withoutLayoutLines(target.semanticText, pageSpec?.layoutIntent || []);
    const contentBlocks = uniqueCovered([semanticText, ...(pageSpec?.lockedCopy || [])]);
    const layoutInstructions = uniqueCovered([...(pageSpec?.layoutIntent || []), ...target.layoutIntent]);
    const rawStyleInstructions = (target.styleTexts.length ? target.styleTexts : [clean(deckBrief.visualLanguage)]).flatMap(meaningfulLines);
    const forbiddenStyleInstructions = new Set(deckBrief.forbiddenRules.flatMap(meaningfulLines).map(normalize));
    const styleInstructions = unique(rawStyleInstructions.filter((instruction) => !forbiddenStyleInstructions.has(normalize(instruction))));
    const extraInstructions = unique(target.extraTexts);
    const visibleDeckBlocks = [deckBrief.audience, deckBrief.goal, deckBrief.narrative, ...deckBrief.globalRules];
    const globalFactLines = unique(deckBrief.lockedDeckFacts.filter((fact) => !visibleDeckBlocks.some((block) => containsFragment(block, fact.value))).map((fact) => fact.sourceExcerpt || fact.value));
    const sections: Array<[string, string[]]> = [
        ["受众", [deckBrief.audience]],
        ["整套目标", [deckBrief.goal]],
        ["叙事主线", [deckBrief.narrative]],
        ["全局规则", deckBrief.globalRules],
        ["全局锁定事实", globalFactLines],
        ["禁止项", deckBrief.forbiddenRules],
        ["本页内容", contentBlocks],
        ["本页布局", layoutInstructions],
        ["视觉语言", styleInstructions],
        ["其他受控输入", extraInstructions],
        ["允许自由发挥", [pageSpec?.freedom || ""]],
    ];
    const finalPrompt = sections
        .flatMap(([title, values]) => {
            const uniqueValues = unique(values);
            return uniqueValues.length ? [`【${title}】\n${uniqueValues.join("\n")}`] : [];
        })
        .join("\n\n")
        .trim();
    const duplicateInstructions = findDuplicateInstructions([...deckBrief.globalRules, ...deckBrief.forbiddenRules, ...(pageSpec?.layoutIntent || []), ...target.layoutIntent, ...styleInstructions, ...target.extraTexts]);
    const layoutConflict = findLayoutConflict([...deckBrief.globalRules, ...(pageSpec?.layoutIntent || []), ...target.layoutIntent]);
    const requiredInstructions = unique([...visibleDeckBlocks, ...deckBrief.forbiddenRules, ...layoutInstructions, ...styleInstructions, ...extraInstructions]);
    return {
        finalPrompt,
        pageContent: contentBlocks.join("\n"),
        userInstructions: [target.semanticText, ...(pageSpec?.layoutIntent || []), ...target.layoutIntent, ...target.styleTexts, ...target.extraTexts].join("\n"),
        requiredInstructions,
        duplicateInstructions,
        layoutConflict,
    };
}

function validateTargetFacts(
    deckBrief: CanvasProjectPptDeckBrief,
    pageSpec: CanvasProjectPptPageSpec,
    semanticText: string,
    addIssue: (code: CanvasProjectPptCompilationIssue["code"], severity: CanvasProjectPptCompilationIssue["severity"], message: string) => void,
) {
    const allowed = [...deckBrief.lockedDeckFacts, ...pageSpec.lockedFacts];
    const targetFacts = extractLockedFacts(withoutLayoutLines(semanticText, pageSpec.layoutIntent), `${pageSpec.pageId}:target`);
    for (const fact of targetFacts) {
        if (allowed.some((item) => item.kind === fact.kind && normalize(item.value) === normalize(fact.value))) continue;
        addIssue("unreviewed_fact", "blocking", `页面规格含有未经确认的${factLabel(fact.kind)}：${fact.value}`);
    }
}

function validateRequiredInstructions(instructions: string[], finalPrompt: string, addIssue: (code: CanvasProjectPptCompilationIssue["code"], severity: CanvasProjectPptCompilationIssue["severity"], message: string) => void) {
    for (const instruction of instructions) {
        if (!containsFragment(finalPrompt, instruction)) addIssue("missing_required_instruction", "blocking", `显式覆盖缺少必要约束：${preview(instruction)}`);
    }
}

function validateOverrideFacts(compiledPrompt: string, override: string, addIssue: (code: CanvasProjectPptCompilationIssue["code"], severity: CanvasProjectPptCompilationIssue["severity"], message: string) => void) {
    const compiledFacts = extractLockedFacts(compiledPrompt, "compiled");
    const overrideFacts = extractLockedFacts(override, "override");
    for (const fact of overrideFacts) {
        if (compiledFacts.some((item) => item.kind === fact.kind && normalize(item.value) === normalize(fact.value))) continue;
        addIssue("unreviewed_fact", "blocking", `显式覆盖含有未经确认的${factLabel(fact.kind)}：${fact.value}`);
    }
}

function validateOverrideStatements(compiledPrompt: string, override: string, confirmed: boolean, addIssue: (code: CanvasProjectPptCompilationIssue["code"], severity: CanvasProjectPptCompilationIssue["severity"], message: string) => void) {
    if (confirmed || normalizedPrompt(compiledPrompt) === normalizedPrompt(override)) return;
    addIssue("override_review_required", "blocking", "显式覆盖与自动编译结果不一致，需要用户确认全部新增、删减、改写或重排内容");
}

function validateTargetStatements(pageSpec: CanvasProjectPptPageSpec, semanticText: string, addIssue: (code: CanvasProjectPptCompilationIssue["code"], severity: CanvasProjectPptCompilationIssue["severity"], message: string) => void) {
    const allowed = pageSpec.lockedCopy.flatMap(meaningfulLines).map(normalize);
    const statements = meaningfulLines(withoutLayoutLines(semanticText, pageSpec.layoutIntent)).map((line) => normalize(line.replace(/^标题\s*[:：]\s*/, "")));
    if (JSON.stringify(statements) !== JSON.stringify(allowed)) addIssue("unreviewed_fact", "blocking", "页面文本的内容或顺序与 PageSpec 不一致，需要重新确认");
}

function validateControlledInputs(
    deckBrief: CanvasProjectPptDeckBrief,
    pageSpec: CanvasProjectPptPageSpec,
    target: PptCompilationTarget,
    addIssue: (code: CanvasProjectPptCompilationIssue["code"], severity: CanvasProjectPptCompilationIssue["severity"], message: string) => void,
) {
    const reviewedLayouts = new Set(pageSpec.layoutIntent.flatMap(meaningfulLines).map(normalize));
    for (const layout of target.layoutIntent.flatMap(meaningfulLines)) {
        if (reviewedLayouts.has(normalize(layout)) || target.layoutConfirmed) continue;
        addIssue("review_required", "blocking", `排版要求未经显式确认：${preview(layout)}`);
    }
    const reviewedStyle = new Set([...meaningfulLines(deckBrief.visualLanguage), ...deckBrief.forbiddenRules.flatMap(meaningfulLines)].map(normalize));
    for (const style of target.styleTexts.flatMap(meaningfulLines)) {
        if (reviewedStyle.has(normalize(style))) continue;
        addIssue("review_required", "blocking", `风格文本与 DeckBrief 不一致：${preview(style)}`);
    }
}

function validateLockedFacts(facts: CanvasProjectPptLockedFact[], finalPrompt: string, pageContent: string, addIssue: (code: CanvasProjectPptCompilationIssue["code"], severity: CanvasProjectPptCompilationIssue["severity"], message: string) => void) {
    for (const fact of facts) {
        if (fact.kind === "point_count") {
            const actual = readPointCount(pageContent);
            const expected = Number(fact.value);
            if (actual === undefined) addIssue("missing_locked_fact", "blocking", `最终提示词缺少锁定点数：${fact.value}`);
            else if (actual !== expected) addIssue("point_count_mismatch", "blocking", `本页必须保持 ${expected} 点，当前为 ${actual} 点`);
            continue;
        }
        if (!containsFragment(finalPrompt, fact.value)) addIssue("missing_locked_fact", "blocking", `最终提示词缺少锁定${factLabel(fact.kind)}：${fact.value}`);
    }
}

function validateForbiddenRules(forbiddenRules: string[], userInstructions: string, addIssue: (code: CanvasProjectPptCompilationIssue["code"], severity: CanvasProjectPptCompilationIssue["severity"], message: string) => void) {
    for (const rule of forbiddenRules) {
        const core = clean(rule.replace(FORBIDDEN_PATTERN, "").replace(/^[:：、，,\s]+/, ""));
        if (core.length < 2) continue;
        const withoutRule = userInstructions.replaceAll(rule, "");
        let cursor = withoutRule.indexOf(core);
        while (cursor >= 0) {
            const prefix = withoutRule.slice(Math.max(0, cursor - 8), cursor);
            if (!FORBIDDEN_PATTERN.test(prefix)) {
                addIssue("forbidden_conflict", "blocking", `页面指令与禁止项冲突：${rule}`);
                break;
            }
            cursor = withoutRule.indexOf(core, cursor + core.length);
        }
    }
}

function issueCollector(snapshotId: string, target: PptCompilationTarget, local: CanvasProjectPptCompilationIssue[], all: CanvasProjectPptCompilationIssue[]) {
    const counts = new Map<CanvasProjectPptCompilationIssue["code"], number>();
    return (code: CanvasProjectPptCompilationIssue["code"], severity: CanvasProjectPptCompilationIssue["severity"], message: string) => {
        const ordinal = (counts.get(code) || 0) + 1;
        counts.set(code, ordinal);
        const issue: CanvasProjectPptCompilationIssue = {
            id: `${snapshotId}:${target.pageId}:${target.takeId}:${code}:${ordinal}`,
            severity,
            code,
            message,
            pageId: target.pageId,
            takeId: target.takeId,
        };
        local.push(issue);
        all.push(issue);
    };
}

function extractLockedFacts(text: string, scopeId: string): CanvasProjectPptLockedFact[] {
    const semanticLines = meaningfulLines(text).map((line) => line.replace(LIST_ITEM_PATTERN, ""));
    const candidates: Array<Omit<CanvasProjectPptLockedFact, "id">> = [];
    for (const line of semanticLines) {
        for (const match of line.matchAll(NUMBER_PATTERN)) {
            const value = clean(match[0]);
            if (value) candidates.push({ kind: "number", value, sourceExcerpt: line });
        }
        for (const match of line.matchAll(ASCII_TERM_PATTERN)) candidates.push({ kind: "term", value: match[0], sourceExcerpt: line });
        for (const value of extractQuotedTerms(line)) candidates.push({ kind: "term", value, sourceExcerpt: line });
        if (TABLE_PATTERN.test(line)) candidates.push({ kind: "table", value: line, sourceExcerpt: line });
    }
    const pointCount = readPointCount(text);
    if (pointCount !== undefined && pointCount > 1) candidates.push({ kind: "point_count", value: String(pointCount), sourceExcerpt: pointCountExcerpt(text) });
    const seen = new Set<string>();
    return candidates.flatMap((fact) => {
        const key = `${fact.kind}\u0000${normalize(fact.value)}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ ...fact, id: `${scopeId}:fact:${fact.kind}:${seen.size}` }];
    });
}

function extractQuotedTerms(line: string) {
    const terms: string[] = [];
    for (const match of line.matchAll(/[「『“"]([^」』”"]{2,30})[」』”"]/g)) terms.push(clean(match[1]));
    const explicit = line.match(/(?:术语|关键词|专有名词)\s*[:：]\s*(.+)$/);
    if (explicit) terms.push(...explicit[1].split(/[、，,;；/]/).map(clean));
    return unique(terms);
}

function readPointCount(text: string): number | undefined {
    const lines = text.split(/\r?\n/);
    const bulletCount = lines.filter((line) => LIST_ITEM_PATTERN.test(line)).length;
    const declared = [...text.matchAll(/(\d+)\s*(?:个)?(?:要点|点|项|条)/g)].map((match) => Number(match[1]));
    const ordinals = [...text.matchAll(/第\s*(\d+)\s*点/g)].map((match) => Number(match[1]));
    const counts = [...(bulletCount >= 2 ? [bulletCount] : []), ...declared, ...ordinals].filter((value) => Number.isFinite(value) && value > 0);
    return counts.length ? Math.max(...counts) : undefined;
}

function pointCountExcerpt(text: string) {
    const lines = meaningfulLines(text);
    return lines.find((line) => /(\d+)\s*(?:个)?(?:要点|点|项|条)/.test(line)) || lines.filter((line) => LIST_ITEM_PATTERN.test(line)).join("\n");
}

function locateSourceRef(mode: PptCompilerModelInput["mode"], sourceMaterial: string, excerptInput: string): CanvasProjectPptSourceRef {
    const excerpt = clean(excerptInput);
    const source: CanvasProjectPptSourceRef["source"] = mode === "extract" ? "imported_spec" : "material";
    const startOffset = excerpt ? sourceMaterial.indexOf(excerpt) : -1;
    if (startOffset < 0) return { source, excerpt };
    const startLine = sourceMaterial.slice(0, startOffset).split("\n").length;
    return { source, excerpt, startLine, endLine: startLine + excerpt.split("\n").length - 1 };
}

function locatePageSourceRefs(mode: PptCompilerModelInput["mode"], sourceMaterial: string, page: PptCompilerPageInput, lockedCopy: string[], facts: CanvasProjectPptLockedFact[]) {
    if (mode === "extract" && page.sourceRange) {
        return [{ source: "imported_spec" as const, excerpt: clean(page.outline), startLine: page.sourceRange.startLine, endLine: page.sourceRange.endLine }];
    }
    const exact = locateSourceRef(mode, sourceMaterial, page.outline || page.title);
    if (exact.startLine !== undefined) return [exact];
    const lines = sourceMaterial.split(/\r?\n/);
    const matched = new Map<number, CanvasProjectPptSourceRef>();
    for (const copy of lockedCopy) {
        const index = lines.findIndex((line) => containsFragment(line, copy));
        if (index >= 0) matched.set(index, { source: mode === "extract" ? "imported_spec" : "material", excerpt: clean(lines[index]), startLine: index + 1, endLine: index + 1 });
    }
    for (const fact of facts) {
        const index = lines.findIndex((line) => containsFragment(line, fact.value));
        if (index >= 0) matched.set(index, { source: mode === "extract" ? "imported_spec" : "material", excerpt: clean(lines[index]), startLine: index + 1, endLine: index + 1 });
    }
    const titleIndex = lines.findIndex((line) => containsFragment(line, page.title));
    if (titleIndex >= 0) matched.set(titleIndex, { source: mode === "extract" ? "imported_spec" : "material", excerpt: clean(lines[titleIndex]), startLine: titleIndex + 1, endLine: titleIndex + 1 });
    const source: CanvasProjectPptSourceRef["source"] = mode === "extract" ? "imported_spec" : "material";
    return matched.size ? [...matched.values()] : [{ source, excerpt: "（未定位到原文片段）" }];
}

function promptSection(prompt: string, title: string) {
    const marker = `【${title}】`;
    const start = prompt.indexOf(marker);
    if (start < 0) return "";
    const contentStart = start + marker.length;
    const nextSection = prompt.indexOf("\n\n【", contentStart);
    return prompt.slice(contentStart, nextSection < 0 ? undefined : nextSection).trim();
}

function uniqueTargetPageSpecs(targets: PptCompilationTarget[], pageSpecs: CanvasProjectPptPageSpec[]) {
    const targetIds = new Set(targets.map((target) => target.pageId));
    return pageSpecs.filter((pageSpec) => targetIds.has(pageSpec.pageId));
}

function cloneDeckBrief(deckBrief: CanvasProjectPptDeckBrief): CanvasProjectPptDeckBrief {
    return {
        ...deckBrief,
        globalRules: [...deckBrief.globalRules],
        forbiddenRules: [...deckBrief.forbiddenRules],
        lockedDeckFacts: deckBrief.lockedDeckFacts.map((fact) => ({ ...fact })),
    };
}

function clonePageSpec(pageSpec: CanvasProjectPptPageSpec): CanvasProjectPptPageSpec {
    return {
        ...pageSpec,
        sourceRefs: pageSpec.sourceRefs.map((sourceRef) => ({ ...sourceRef })),
        lockedCopy: [...pageSpec.lockedCopy],
        lockedFacts: pageSpec.lockedFacts.map((fact) => ({ ...fact })),
        layoutIntent: [...pageSpec.layoutIntent],
        assetRefs: [...pageSpec.assetRefs],
    };
}

function cloneTarget(target: PptCompilationTarget): PptCompilationTarget {
    return {
        ...target,
        layoutIntent: [...target.layoutIntent],
        styleTexts: [...target.styleTexts],
        extraTexts: [...target.extraTexts],
    };
}

function extractAssetRefs(text: string) {
    return unique([...text.matchAll(/@\[node:([^\]]+)\]/g)].map((match) => match[1]));
}

function findDuplicateInstructions(values: string[]) {
    const firstByNormalized = new Map<string, string>();
    const duplicates: string[] = [];
    for (const value of values.map(clean).filter(Boolean)) {
        const key = normalize(value);
        if (firstByNormalized.has(key)) duplicates.push(firstByNormalized.get(key)!);
        else firstByNormalized.set(key, value);
    }
    return unique(duplicates);
}

function findLayoutConflict(values: string[]) {
    const text = values.join("\n");
    const left = /(?:整页|文字|内容)?\s*左对齐/.test(text);
    const center = /(?:整页|文字|内容)?\s*(?:居中|中心对齐)/.test(text);
    const right = /(?:整页|文字|内容)?\s*右对齐/.test(text);
    if (left && (center || right)) return "本页同时要求左对齐和其他对齐方式，请确认布局";
    if (center && right) return "本页同时要求居中和右对齐，请确认布局";
    return undefined;
}

function labeledValue(text: string, labels: string[]) {
    for (const line of meaningfulLines(text)) {
        for (const label of labels) {
            const match = line.match(new RegExp(`^${label}\\s*[:：]\\s*(.+)$`));
            if (match) return clean(match[1]);
        }
    }
    return "";
}

function isDeckBriefLabel(line: string) {
    return /^(?:受众|面向对象|目标用户|目标|目的|叙事|叙事主线|主线|结构)\s*[:：]/.test(line);
}

function isLayoutLine(line: string) {
    return LAYOUT_LABEL_PATTERN.test(line) || LAYOUT_INTENT_PATTERN.test(line) || new RegExp(`^${FORBIDDEN_PATTERN.source}`).test(line);
}

function withoutLayoutLines(text: string, excluded: string[]) {
    const excludedLines = new Set(excluded.flatMap(meaningfulLines).map(normalize));
    return text
        .split(/\r?\n/)
        .filter((line) => !excludedLines.has(normalize(line)) && !isLayoutLine(clean(line)))
        .join("\n")
        .trim();
}

function uniqueCovered(values: string[]) {
    const result: string[] = [];
    for (const value of values.map(clean).filter(Boolean)) {
        if (result.some((existing) => containsFragment(existing, value) || containsFragment(value, existing))) {
            if (result.some((existing) => containsFragment(existing, value))) continue;
            const coveredIndex = result.findIndex((existing) => containsFragment(value, existing));
            if (coveredIndex >= 0) result.splice(coveredIndex, 1, value);
            continue;
        }
        result.push(value);
    }
    return result;
}

function unique(values: string[]) {
    const seen = new Set<string>();
    return values.flatMap((value) => {
        const cleaned = clean(value);
        const key = normalize(cleaned);
        if (!cleaned || seen.has(key)) return [];
        seen.add(key);
        return [cleaned];
    });
}

function meaningfulLines(text: string) {
    return text.split(/\r?\n/).map(clean).filter(Boolean);
}

function containsFragment(text: string, fragment: string) {
    return normalize(text).includes(normalize(fragment));
}

function sourceSupportsLine(sourceMaterial: string, line: string) {
    const semantic = clean(line.replace(LIST_ITEM_PATTERN, ""));
    if (!semantic) return false;
    return meaningfulLines(sourceMaterial).some((sourceLine) => {
        if (!containsFragment(sourceLine, semantic)) return false;
        return !NEGATION_PATTERN.test(sourceLine) || NEGATION_PATTERN.test(semantic);
    });
}

function clean(value: string) {
    return value.trim();
}

function normalize(value: string) {
    return clean(value).replace(/\s+/g, " ");
}

function normalizedPrompt(value: string) {
    return meaningfulLines(value).map(normalize).join("\n");
}

function preview(value: string) {
    const cleaned = normalize(value);
    return cleaned.length > 48 ? `${cleaned.slice(0, 48)}…` : cleaned;
}

function factLabel(kind: CanvasProjectPptLockedFact["kind"]) {
    if (kind === "number") return "数字";
    if (kind === "term") return "术语";
    if (kind === "table") return "表格语义";
    return "事实";
}
