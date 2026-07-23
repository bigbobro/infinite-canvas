import { jsonrepair } from "jsonrepair";

import { renderPptLayoutVocabularyHint, requirePptPageRewriteSpec, type PptPageRewriteSpec } from "@/lib/ppt/content-plan";
import { requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import type { CanvasProjectPptContentBlock } from "@/stores/canvas/use-canvas-store";
import type { AiConfig } from "@/stores/use-config-store";

export type PptContentPlanRequest = {
    title: string;
    sourceMaterial: string;
    requirements: string;
};

export type PptContentPageRegenerationRequest = PptContentPlanRequest & {
    draftRevision: number;
    targetPageNumber: number;
    targetPage: { title: string; purpose: string; primaryClaim: string; contentBlocks: Array<{ kind: CanvasProjectPptContentBlock["kind"]; text: string }> };
    authoringInstructions: string[];
    confirmedInputs: Array<{ source: "user_answer" | "confirmed_assumption"; kind: CanvasProjectPptContentBlock["kind"]; text: string }>;
    unresolvedGaps: Array<{ question: string; reason: string; proposedAnswer?: string }>;
    auditIssues: Array<{ code: string; message: string; field?: string; value?: string }>;
    otherPageTitles: string[];
};

export type PptTextRequester = typeof requestImageQuestion;
export type PptContentStreamPage = { ordinal: number; title: string; primaryClaim?: string; blockCount: number };
export type PptContentStreamProgress = { completedPages: PptContentStreamPage[]; pendingPageOrdinal?: number };
type PptContentResponseKind = "plan" | "page";
type JsonObjectCandidate = { text: string; start: number; end: number };
type ParsedJsonCandidate = JsonObjectCandidate & { value: unknown; repaired: boolean; score: number; fenceIndex: number };

const MAX_CONTENT_PLAN_RESPONSE_CHARS = 1_000_000;

const CONTENT_PLAN_SYSTEM_PROMPT = `你是 PPT 内容规划师。你的任务不是只拆页，也不是替用户虚构业务细节，而是把材料整理成可审查、可直接约束后续图片模型的逐页内容方案。

必须先提炼 Deck Brief（整套标题、受众、目标、叙事主线与视觉线索），再生成观众会看到的 pages。材料里的创作意图必须与观众可见正文分开：“我想做一份……”、“这份材料要让……”、“希望回答……”等元话语用于提炼 brief，不得直接复制到 title、primaryClaim 或 blocks。要回答的问题是整套 PPT 的覆盖清单，不默认生成一页“这份材料要讲什么”；只有用户明确要求目录时才生成目录页。

先规划整套叙事，再用最少的非重复页面承载独立观点、证据、流程或行动；不按原文段落机械拆页，重复职责必须合并。

只输出 JSON，不要输出解释或代码块。格式：
{"brief":{"title":"","audience":"","goal":"","narrative":"","visualSignals":[]},"pages":[{"title":"","purpose":"","primaryClaim":"","contentForm":"comparison","contentFormNote":"","titleSource":{"source":"material","relation":"verbatim","startLine":1,"endLine":1},"primaryClaimSource":{"source":"material","relation":"derived","startLine":2,"endLine":3},"blocks":[{"key":"b1","kind":"body","text":"原文事实","source":{"source":"material","relation":"verbatim","startLine":1,"endLine":2}},{"key":"b2","kind":"body","text":"AI 建议初稿","gapKey":"g1"}],"layoutIntent":["左右双栏"],"visualEncoding":[{"contentKeys":["b1"],"intent":"differentiate","channel":"shape"}],"gaps":[{"key":"g1","kind":"missing_detail","question":"是否采用该建议？","reason":"原材料未提供细节","blocking":true,"proposedAnswer":"AI 建议初稿"}]}]}

硬规则：
1. contentForm 只能是 cover、comparison、architecture、process、timeline、data、narrative、closing；它表达语义结构。layoutIntent 是纯排版表述，请从以下词汇族中选词或组合来描述版式（词表外的修饰词入库时会被自动整理）：${renderPptLayoutVocabularyHint()}不写配色、字体、背景、材质或气质。
2. title 和 primaryClaim 单独输出；blocks 的 kind 只能是 supporting_claim、body、list、table、chart_data、placeholder，不能重复 title 或 primary_claim。
3. 每段来自用户输入的可见文案必须标注 material 或 requirements 的准确起止行号，并声明 relation：verbatim（页面文案可在引用行中逐字定位）或 derived（基于引用行压缩/归纳/改写）。禁止在未声明 derived 时改写后仍声称来自原文。
4. derived 引用必须覆盖支撑该段的最小连续行；不得引入引用行中不存在的数字、大写术语、型号、金额或既成结论。brief.audience/goal/narrative 是整套作者侧归纳，允许改写，不必逐字。
5. 先交付可用初稿。对不依赖用户私有信息、可以凭通用知识或专业判断给出的信息缺口，proposedAnswer 必须提供具体、可采纳的建议稿；不得只写“待补充”“请补充”“这里介绍”或把提问改写一遍。
6. 材料没有给出的真实供应商选择、参数、型号、容量、金额、合作条件、里程碑或既成结论不得冒充事实，也不得用 derived 伪装。应在 proposedAnswer 给出推荐选项、判断框架、计算方法或明确标注的待验证假设；需要先在页面展示的建议全文可写入 block，但必须用 gapKey 绑定同 key 的 gap，等待用户采纳后才能批准。
7. “请你给建议”“帮我补充”等是创作指令，不是页面正文。应据此生成建议稿，不得逐字放进 title、primaryClaim 或 blocks。
8. 发现主题重复时不要机械保留两页；优先合并，并通过页面 purpose 说明它为什么存在。无法判断时保留并在 gap 中询问。
9. visualEncoding 只描述内容关系如何映射为颜色、形状、位置、大小、连线或图标，contentKeys 必须引用本页 blocks；不得借此新增可见文案。整套审美风格只放 brief.visualSignals，不进入页面字段。
10. 第一页必须使用 contentForm=cover。封面只需具体标题和一句简短定位语，blocks 可以为空，不得为满足通用规则而添加目标清单或正文块。除封面外，每页都要有可直接审阅的具体标题、核心信息和至少一段正文或结构化建议；不得把“组件对比分析”“资源投入”等空泛目录词当作完成内容。
11. 输出必须是适合 16:9 投影片的可见文案，不是文章。title 只写本页主题，不与整套名称用“|”拼接；primaryClaim 为一句核心结论；每个 block 只承载一个可独立排版的信息单元。出现多个判断维度时拆成短块、列表或表格，禁止输出连续长段落；整页文案过多时优先压缩或拆页，不得删除用户明确要求保留的事实。
12. 用户在补充要求中明确写出“最多 N 页”或“N 页以内”时，pages 数量不得超过该上限，并通过合并重复职责来压缩，不得截断或丢弃用户事实。没有明确页数时，不得设置统一的固定上限。`;

const PAGE_REWRITE_SYSTEM_PROMPT = `你是 PPT 页面规格编辑器。根据用户要求，把当前页面重写为可直接做信息设计的 slide-ready 结构。

只返回 JSON，不要解释或代码块。格式：
{"title":"本页标题","primaryClaim":"一句核心结论","contentForm":"comparison","blocks":[{"key":"b1","kind":"body","text":"短标签：简明说明"}],"visualEncoding":[{"contentKeys":["b1"],"intent":"group","channel":"shape"}]}

硬规则：
1. title 只保留本页主题，不重复整套 PPT 名称，不用“|”拼接双标题；primaryClaim 是一句核心结论。
2. contentForm 只能是 cover、comparison、architecture、process、timeline、data、narrative、closing。
3. blocks.kind 只能是 supporting_claim、body、list、table、chart_data。每个 block 只表达一个可独立排版的维度，key 页内唯一。
4. visualEncoding 必须把内容关系映射到颜色、形状、位置、大小、连线或图标；contentKeys 必须引用 blocks.key，不得新增可见文案。intent 只能是 differentiate、emphasize、sequence、group、show_relationship；channel 只能是 color、shape、position、size、line、icon。
5. 这是 16:9 投影片，不是文章。禁止连续长段落；通常保持 4–8 个可见信息块，单块尽量不超过 100 字，整页尽量不超过 280 字。
6. 保留用户未要求删除的事实和约束，可以压缩、拆分和重排；不得新增数字、厂商、组件、参数、型号、成本或结论。`;

export function buildPptContentPlanMessages(input: PptContentPlanRequest): AiTextMessage[] {
    return [
        { role: "system", content: CONTENT_PLAN_SYSTEM_PROMPT },
        {
            role: "user",
            content: `PPT 标题：${input.title.trim() || "未命名"}\n\n材料（行号|原文）：\n${numberLines(input.sourceMaterial)}\n\n补充要求（行号|原文）：\n${numberLines(input.requirements) || "1|无特殊要求"}`,
        },
    ];
}

export function buildPptPageRewriteMessages(currentPage: string, instruction: string, contentForm?: string): AiTextMessage[] {
    return [
        { role: "system", content: PAGE_REWRITE_SYSTEM_PROMPT },
        { role: "user", content: `当前页面内容形态：${contentForm || "请根据内容判断"}\n\n当前页面规格：\n${currentPage}\n\n修改要求：\n${instruction.trim()}` },
    ];
}

export function requirePptPageRewriteResult(value: string): PptPageRewriteSpec {
    if (value.includes("```")) throw new Error("AI 改写结果不应包含代码块");
    const parsed = asRecord(parsePptContentPlanResponse(value, "page"));
    const page = Array.isArray(parsed?.pages) && parsed.pages.length === 1 ? asRecord(parsed.pages[0]) : asRecord(parsed?.page) || parsed;
    return requirePptPageRewriteSpec(page);
}

export async function requestPptContentPlan(config: AiConfig, input: PptContentPlanRequest, onDelta: (text: string) => void, options?: { signal?: AbortSignal; requester?: PptTextRequester }): Promise<unknown> {
    const requestConfig: AiConfig = { ...config, model: config.textModel || config.model };
    const answer = await (options?.requester ?? requestImageQuestion)(requestConfig, buildPptContentPlanMessages(input), onDelta, { signal: options?.signal });
    return requireContentPlanEnvelope(parsePptContentPlanResponse(answer));
}

export function buildPptContentPageRegenerationMessages(input: PptContentPageRegenerationRequest): AiTextMessage[] {
    const pageRoleRule = input.targetPageNumber === 1 ? "目标是整套第 1 页，必须使用 cover，只保留标题和一句定位语。" : `目标是整套第 ${input.targetPageNumber} 页；唯一返回页不代表整套第一页，不得使用 cover，请根据本页内容选择其他 contentForm。`;
    return [
        {
            role: "system",
            content: `${CONTENT_PLAN_SYSTEM_PROMPT}\n\n这次只重新生成用户指定的一页。pages 必须且只能返回 1 页；${pageRoleRule}不要改写其他页，不要输出页面 ID。必须逐项消除 auditIssues 列出的审核问题，不得原样保留其中指明的失败字段或只改写无关字段。已经确认的内容必须逐字复用，不要伪造 material/requirements 行号，客户端会恢复其用户确认来源。confirmedInputs 中每一项的 text 与 kind 都必须原样保留；不得把 title、primary_claim、supporting_claim、body、list、table 或 chart_data 迁移成另一种 kind。`,
        },
        {
            role: "user",
            content: `PPT 标题：${input.title.trim() || "未命名"}\n当前内容版本：${input.draftRevision}\n\n材料（行号|原文）：\n${numberLines(input.sourceMaterial)}\n\n补充要求（行号|原文）：\n${numberLines(input.requirements) || "1|无特殊要求"}\n\n只重新生成第 ${input.targetPageNumber} 页：\n${JSON.stringify(input.targetPage)}\n\n用户希望 AI 执行的创作指令（执行但不得写进页面）：\n${JSON.stringify(input.authoringInstructions)}\n\n本页已经由用户确认、不得改写的内容：\n${JSON.stringify(input.confirmedInputs)}\n\n本页尚未解决的信息缺口：\n${JSON.stringify(input.unresolvedGaps)}\n\n本页必须修复的审核问题：\n${JSON.stringify(input.auditIssues)}\n\n其他页标题已锁定，不得输出或改写：\n${input.otherPageTitles.map((title, index) => `${index + 1}. ${title}`).join("\n") || "无"}`,
        },
    ];
}

export async function requestPptContentPageRegeneration(config: AiConfig, input: PptContentPageRegenerationRequest, onDelta: (text: string) => void, options?: { signal?: AbortSignal; requester?: PptTextRequester }): Promise<unknown> {
    const requestConfig: AiConfig = { ...config, model: config.textModel || config.model };
    const answer = await (options?.requester ?? requestImageQuestion)(requestConfig, buildPptContentPageRegenerationMessages(input), onDelta, { signal: options?.signal });
    return requireSinglePageEnvelope(parsePptContentPlanResponse(answer, "page"));
}

/**
 * 只投影已经严格闭合的页面对象，用于生成中的只读预览。
 * 半份响应不会在这里修复、规范化或获得 PageSpec 身份；最终结果仍走完整解析门禁。
 */
export function previewPptContentPlanStream(raw: string): PptContentStreamProgress {
    const scan = extractLatestPagesArrayObjects(raw);
    const completedPages = scan.objects
        .flatMap((candidate) => {
            try {
                const page = asRecord(JSON.parse(candidate));
                const title = typeof page?.title === "string" ? page.title.trim() : "";
                const primaryClaim = typeof page?.primaryClaim === "string" ? page.primaryClaim.trim() : "";
                const purpose = typeof page?.purpose === "string" ? page.purpose.trim() : "";
                const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
                if (!title || (!primaryClaim && !purpose && !blocks.length)) return [];
                return [{ title, ...(primaryClaim ? { primaryClaim } : {}), blockCount: blocks.length }];
            } catch {
                return [];
            }
        })
        .map((page, index) => ({ ordinal: index + 1, ...page }));
    return {
        completedPages,
        ...(scan.pendingPageObject ? { pendingPageOrdinal: completedPages.length + 1 } : {}),
    };
}

export function parsePptContentPlanResponse(raw: string, responseKind: PptContentResponseKind = "plan"): unknown {
    const value = raw.trim();
    if (!value.includes("{")) throw new Error("生成的内容方案不是有效的 JSON，请重试");
    if (value.length > MAX_CONTENT_PLAN_RESPONSE_CHARS) throw new Error("生成的内容方案过长，请缩短材料后重试");

    const scan = extractJsonObjectCandidates(value);
    const fences = extractJsonFenceRanges(value);
    let selected: ParsedJsonCandidate | undefined;
    let strictFallback: ParsedJsonCandidate | undefined;

    for (const candidate of scan.candidates) {
        const parsed = parseJsonCandidate(candidate.text);
        if (!parsed) continue;
        const current: ParsedJsonCandidate = {
            ...candidate,
            ...parsed,
            score: contentResponseCandidateScore(parsed.value, responseKind),
            fenceIndex: fences.findLastIndex((fence) => candidate.start >= fence.start && candidate.end <= fence.end),
        };
        if (current.score && isPreferredCandidate(current, selected)) selected = current;
        if (responseKind === "plan" && !current.repaired && isPreferredCandidate(current, strictFallback)) strictFallback = current;
    }

    const result = selected || strictFallback;
    if (result && !isSupersededByIncompleteObject(value, result, scan.incompleteStarts)) return result.value;
    if (scan.incompleteStarts.length) throw new Error("生成的内容方案返回不完整，请缩短材料或调整文本模型后重试");
    throw new Error("生成的内容方案解析失败，请重试");
}

function extractLatestPagesArrayObjects(raw: string) {
    const stack: Array<"object" | "array"> = [];
    let inString = false;
    let escaped = false;
    let stringStart = -1;
    let currentRootStart = -1;
    let pagesArrayDepth = -1;
    let pageObjectStart = -1;
    let expectingPagesValue = false;
    let currentRootObjects: string[] = [];
    let latestRootObjects: string[] = [];

    for (let index = 0; index < raw.length; index++) {
        const character = raw[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') {
                inString = false;
                if (currentRootStart >= 0 && stack.length === 1 && stack[0] === "object") {
                    let next = index + 1;
                    while (/\s/.test(raw[next] || "")) next += 1;
                    if (raw[next] === ":") {
                        try {
                            expectingPagesValue = JSON.parse(raw.slice(stringStart, index + 1)) === "pages";
                        } catch {
                            expectingPagesValue = false;
                        }
                    }
                }
            }
            continue;
        }
        const openingPagesArray = expectingPagesValue && character === "[" && currentRootStart >= 0 && stack.length === 1 && stack[0] === "object";
        if (expectingPagesValue && !/\s/.test(character) && character !== ":") expectingPagesValue = false;
        if (character === '"') {
            inString = true;
            stringStart = index;
            continue;
        }
        if (character === "{") {
            if (!stack.length) {
                currentRootStart = index;
                currentRootObjects = [];
                pagesArrayDepth = -1;
                pageObjectStart = -1;
                expectingPagesValue = false;
            } else if (pagesArrayDepth === stack.length && stack.at(-1) === "array") {
                pageObjectStart = index;
            }
            stack.push("object");
            continue;
        }
        if (character === "[") {
            if (!stack.length) continue;
            stack.push("array");
            if (openingPagesArray) pagesArrayDepth = stack.length;
            continue;
        }
        if (character === "}" && stack.at(-1) === "object") {
            if (pageObjectStart >= 0 && pagesArrayDepth > 0 && stack.length === pagesArrayDepth + 1) {
                currentRootObjects.push(raw.slice(pageObjectStart, index + 1));
                pageObjectStart = -1;
            }
            stack.pop();
            if (stack.length) continue;
            latestRootObjects = currentRootObjects;
            currentRootStart = -1;
            pagesArrayDepth = -1;
            expectingPagesValue = false;
            continue;
        }
        if (character === "]" && stack.at(-1) === "array") {
            const closingPagesArray = pagesArrayDepth === stack.length;
            stack.pop();
            if (closingPagesArray) pagesArrayDepth = -1;
        }
    }

    return {
        objects: currentRootStart >= 0 ? currentRootObjects : latestRootObjects,
        pendingPageObject: currentRootStart >= 0 && pageObjectStart >= 0,
    };
}

function extractJsonObjectCandidates(value: string) {
    const candidates: JsonObjectCandidate[] = [];
    const openings: Array<{ character: "{" | "["; start: number }> = [];
    let quoteEnd = "";
    let lineComment = false;
    let blockComment = false;

    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        const next = value[index + 1];
        if (lineComment) {
            if (character === "\n") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === "*" && next === "/") {
                blockComment = false;
                index++;
            }
            continue;
        }
        if (quoteEnd) {
            if (character === "\\") index++;
            else if (character === quoteEnd) quoteEnd = "";
            continue;
        }
        if (openings.length) {
            if (character === "/" && next === "/") {
                lineComment = true;
                index++;
                continue;
            }
            if (character === "/" && next === "*") {
                blockComment = true;
                index++;
                continue;
            }
            quoteEnd = closingQuote(character);
            if (quoteEnd) continue;
        }
        if (character === "{" || character === "[") openings.push({ character, start: index });
        else if ((character === "}" || character === "]") && openings.length) {
            const expected = character === "}" ? "{" : "[";
            const opening = openings.at(-1);
            if (opening?.character !== expected) continue;
            openings.pop();
            if (opening.character === "{") {
                const text = value.slice(opening.start, index + 1);
                if (hasBalancedJsonStructure(text)) candidates.push({ text, start: opening.start, end: index });
            }
        }
    }

    return { candidates, incompleteStarts: openings.map((opening) => opening.start) };
}

function extractJsonFenceRanges(value: string) {
    return Array.from(value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi), (match) => {
        const contentOffset = match[0].indexOf(match[1]);
        const start = (match.index || 0) + contentOffset;
        return { start, end: start + match[1].length };
    });
}

function hasBalancedJsonStructure(value: string) {
    const stack: string[] = [];
    let quoteEnd = "";
    let lineComment = false;
    let blockComment = false;
    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        const next = value[index + 1];
        if (lineComment) {
            if (character === "\n") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (character === "*" && next === "/") {
                blockComment = false;
                index++;
            }
            continue;
        }
        if (quoteEnd) {
            if (character === "\\") index++;
            else if (character === quoteEnd) quoteEnd = "";
            continue;
        }
        if (character === "/" && next === "/") {
            lineComment = true;
            index++;
            continue;
        }
        if (character === "/" && next === "*") {
            blockComment = true;
            index++;
            continue;
        }
        quoteEnd = closingQuote(character);
        if (quoteEnd) continue;
        if (character === "{" || character === "[") stack.push(character);
        else if (character === "}" || character === "]") {
            const expected = character === "}" ? "{" : "[";
            if (stack.pop() !== expected) return false;
        }
    }
    return !quoteEnd && !blockComment && stack.length === 0;
}

function closingQuote(value: string) {
    if (value === '"' || value === "'") return value;
    if (value === "“") return "”";
    if (value === "‘") return "’";
    return "";
}

function parseJsonCandidate(candidate: string): { value: unknown; repaired: boolean } | null {
    try {
        return { value: JSON.parse(candidate) as unknown, repaired: false };
    } catch {
        try {
            return { value: JSON.parse(jsonrepair(candidate)) as unknown, repaired: true };
        } catch {
            return null;
        }
    }
}

function contentResponseCandidateScore(value: unknown, responseKind: PptContentResponseKind) {
    const record = asRecord(value);
    if (!record) return 0;
    if (Array.isArray(record.pages)) return 300;
    if (responseKind === "plan") return 0;
    if (asRecord(record.page)) return 200;
    const title = typeof record.title === "string" && record.title.trim();
    const substantiveFields = [record.purpose, record.primaryClaim].filter((field) => typeof field === "string" && field.trim()).length + (Array.isArray(record.blocks) && record.blocks.length ? 1 : 0);
    return title && substantiveFields ? 100 + substantiveFields : 0;
}

function isPreferredCandidate(candidate: ParsedJsonCandidate, current: ParsedJsonCandidate | undefined) {
    if (!current) return true;
    const candidateFenced = candidate.fenceIndex >= 0;
    const currentFenced = current.fenceIndex >= 0;
    if (candidateFenced !== currentFenced) return candidateFenced;
    if (candidateFenced && candidate.fenceIndex !== current.fenceIndex) return candidate.fenceIndex > current.fenceIndex;
    if (candidate.score !== current.score) return candidate.score > current.score;
    return candidate.start > current.start;
}

function isSupersededByIncompleteObject(value: string, candidate: ParsedJsonCandidate, incompleteStarts: number[]) {
    return incompleteStarts.some(
        (start) => start > candidate.end || (start < candidate.start && (/["']?(?:brief|pages?)["']?\s*:/i.test(value.slice(start, candidate.start)) || isJsonLikeUnclosedAncestor(value.slice(start, candidate.start), candidate.text))),
    );
}

function isJsonLikeUnclosedAncestor(prefix: string, candidate: string) {
    const value = prefix + candidate;
    const stack: string[] = [];
    let inString = false;
    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if (inString) {
            if (character === "\\") index++;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') {
            inString = true;
            continue;
        }
        if (character === "{" || character === "[") stack.push(character);
        else if (character === "}" || character === "]") {
            const expected = character === "}" ? "{" : "[";
            if (stack.pop() !== expected) return false;
        }
    }
    if (inString || !stack.length) return false;
    const suffix = [...stack]
        .reverse()
        .map((opening) => (opening === "{" ? "}" : "]"))
        .join("");
    try {
        JSON.parse(value + suffix);
        return true;
    } catch {
        try {
            JSON.parse(jsonrepair(value + suffix));
            return true;
        } catch {
            return /(?:^|[\s,{}[\]])(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z_$][\w$-]*)\s*:/.test(prefix);
        }
    }
}

function requireContentPlanEnvelope(value: unknown) {
    const record = asRecord(value);
    if (!Array.isArray(record?.pages) || !record.pages.length || record.pages.some((page) => !asRecord(page) || !looksLikePage(page as Record<string, unknown>))) throw new Error("生成的内容方案缺少页面内容，请重试");
    return record;
}

function requireSinglePageEnvelope(value: unknown) {
    const record = asRecord(value);
    if (!record) throw new Error("本页生成结果缺少页面内容，请重试");
    if (Array.isArray(record.pages)) {
        if (!record.pages.length) throw new Error("本页生成结果缺少页面内容，请重试");
        if (record.pages.length !== 1) throw new Error("本页生成结果只能包含一个页面，请重试");
        if (!asRecord(record.pages[0]) || !looksLikePage(record.pages[0] as Record<string, unknown>)) throw new Error("本页生成结果缺少页面内容，请重试");
        return record;
    }
    const nestedPage = asRecord(record.page);
    const page = nestedPage && looksLikePage(nestedPage) ? nestedPage : looksLikePage(record) ? record : null;
    if (!page) throw new Error("本页生成结果缺少页面内容，请重试");
    return { ...(asRecord(record.brief) ? { brief: record.brief } : {}), pages: [page] };
}

function looksLikePage(value: Record<string, unknown>) {
    return ["title", "purpose", "primaryClaim", "blocks", "gaps"].some((key) => key in value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberLines(value: string) {
    if (!value.trim()) return "";
    return value
        .split("\n")
        .map((line, index) => `${index + 1}|${line}`)
        .join("\n")
        .trim();
}
