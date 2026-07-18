import { requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";

export type PptOutlinePage = {
    title: string;
    outline: string;
    visualHint: string;
};

export type PptOutlineResult = {
    pages: PptOutlinePage[];
};

const OUTLINE_SYSTEM_PROMPT = `你是 PPT 大纲策划专家。根据用户提供的材料与要求，规划分页大纲。
只输出 JSON，不要输出解释文字或代码块标记，JSON 格式如下：
{"pages":[{"title":"页标题","outline":"该页要点，简洁短句，可用分号分隔","visualHint":"该页配图的视觉建议"}]}
页数需覆盖材料核心内容，标题精炼，每页要点不超过 3 条。`;

export async function generatePptOutline(config: AiConfig, material: string, requirements: string, onDelta: (text: string) => void, options?: { signal?: AbortSignal }): Promise<PptOutlineResult> {
    const messages: AiTextMessage[] = [
        { role: "system", content: OUTLINE_SYSTEM_PROMPT },
        { role: "user", content: `材料：\n${material.trim()}\n\nPPT 要求：\n${requirements.trim() || "无特殊要求"}` },
    ];
    // config.model 是旧版全局字段（默认落在图片模型上），必须显式覆盖成 textModel，
    // 否则 requestImageQuestion 内部 `config.model || config.textModel` 永远命中前者，
    // 大纲生成会错误地打到图片生成模型（对齐 project.tsx buildGenerationConfig 的既有模式）。
    const requestConfig: AiConfig = { ...config, model: config.textModel || config.model };
    const answer = await requestImageQuestion(requestConfig, messages, onDelta, options);
    return parseOutlineJson(answer);
}

type RawOutlinePage = { title?: unknown; outline?: unknown; visualHint?: unknown };
type RawOutlineResult = { pages?: unknown };

function parseOutlineJson(raw: string): PptOutlineResult {
    const stripped = raw
        .replace(/```json/gi, "```")
        .replace(/```/g, "")
        .trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) throw new Error("生成的大纲不是有效的 JSON，请重试");

    let parsed: RawOutlineResult;
    try {
        parsed = JSON.parse(stripped.slice(start, end + 1)) as RawOutlineResult;
    } catch {
        throw new Error("生成的大纲解析失败，请重试");
    }

    if (!Array.isArray(parsed.pages) || !parsed.pages.length) throw new Error("生成的大纲缺少页面数据，请重试");

    const pages = (parsed.pages as RawOutlinePage[]).map((page, index) => ({
        title: String(page?.title ?? `第${index + 1}页`).trim() || `第${index + 1}页`,
        outline: String(page?.outline ?? "").trim(),
        visualHint: String(page?.visualHint ?? "").trim(),
    }));
    return { pages };
}

// ---------------------------------------------------------------------------
// 生图模式：extractPptPages —— 按原稿展开，零改写
//
// 与 generatePptOutline 的根本区别：模型不复述内容，只定位行号；正文由代码
// 从原始材料逐字切片。零改写靠这个构造保证，不靠 prompt 叮嘱或事后校验。
// ---------------------------------------------------------------------------

export type PptExtractResult = {
    pages: PptOutlinePage[]; // outline 为原文逐字切片，visualHint 恒为 ""
    globalStyle: string; // 公共前缀检测的产物：命中则为 ""，未命中则为文档中未被任何页面占用的内容
    droppedCount: number; // 因越界/倒置/空白被丢弃的页数，供调用方告警
    droppedTitles: string[]; // 被丢弃各页的标题（模型未给标题时退化为「第N段」），供调用方点名具体哪几页
};

// 内部中间产物：模型只回这个形状（无正文），不出模块
type PptPageRange = {
    title: string;
    startLine: number;
    endLine: number;
};

const EXTRACT_SYSTEM_PROMPT = `你是文档分页定位器，不是策划、不是改写者。用户会提供一份已经写好的完整生图提示词材料，每行前面带行号（格式为"行号|该行内容"）。
你的任务只是找出材料中"最终要发给生图模型的每页提示词"分别位于原文的第几行到第几行，不判断内容好坏，不复述、不改写、不总结任何正文。

只输出 JSON，不要输出解释文字或代码块标记，格式如下：
{"pages":[{"title":"页标题","startLine":13,"endLine":45}]}

规则：
1. 每一项只给出该页在原文中的起止行号（含首尾），绝不在 title 之外输出任何正文内容。
2. 目标是定位"最终要发给生图模型的每页提示词"：如果材料中同一页内容出现了多次（例如先有分页详细设计草稿，后面又有一份可直接复制发给生图模型的总提示词），取最适合直接复制发给生图模型的那一份。
3. 不设页数上限，不设每页内容长度上限——原文有多长、多详细就保留多长，绝不因为篇幅而摘要、精简或删减。`;

type RawExtractPage = { title?: unknown; startLine?: unknown; endLine?: unknown };
type RawExtractResult = { pages?: unknown };

const FENCE_LINE_PATTERN = /^```[\w-]*\s*$/;
const COMMON_PREFIX_MIN_LINES = 1;
const COMMON_PREFIX_MIN_CHARS = 30;

export async function extractPptPages(config: AiConfig, material: string, onDelta: (text: string) => void, options?: { signal?: AbortSignal }): Promise<PptExtractResult> {
    const lines = material.split("\n");
    const numberedMaterial = lines.map((line, index) => `${index + 1}|${line}`).join("\n");
    const messages: AiTextMessage[] = [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: numberedMaterial },
    ];
    // 同 generatePptOutline：config.model 默认落在图片模型上，必须显式覆盖成 textModel，
    // 否则 requestImageQuestion 内部 `config.model || config.textModel` 永远命中前者。
    const requestConfig: AiConfig = { ...config, model: config.textModel || config.model };
    const answer = await requestImageQuestion(requestConfig, messages, onDelta, options);
    return buildExtractResult(answer, lines);
}

function buildExtractResult(raw: string, lines: string[]): PptExtractResult {
    const ranges = parseExtractJson(raw);
    const totalLines = lines.length;
    const coveredLines = new Set<number>();
    let droppedCount = 0;
    const droppedTitles: string[] = [];
    const dropRange = (range: PptPageRange, index: number) => {
        droppedCount++;
        droppedTitles.push(range.title || `第${index + 1}段`);
    };

    const pages: PptOutlinePage[] = [];
    ranges.forEach((range, index) => {
        if (!Number.isFinite(range.startLine) || !Number.isFinite(range.endLine)) {
            dropRange(range, index);
            return;
        }
        // 倒置判定须用原始值：若先各自钳制到 [1, totalLines] 再比较，两端同向越界的
        // 倒置区间（如 startLine=999 > endLine=900，totalLines=300）会被一起钳制到
        // totalLines，变成 startLine === endLine，倒置检测因此失效。
        if (Math.round(range.startLine) > Math.round(range.endLine)) {
            dropRange(range, index);
            return;
        }
        const startLine = clamp(Math.round(range.startLine), 1, totalLines);
        const endLine = clamp(Math.round(range.endLine), 1, totalLines);
        const outline = stripFenceLines(lines.slice(startLine - 1, endLine))
            .join("\n")
            .trim();
        if (!outline) {
            dropRange(range, index);
            return;
        }
        for (let line = startLine; line <= endLine; line++) coveredLines.add(line);
        pages.push({ title: range.title || `第${index + 1}页`, outline, visualHint: "" });
    });

    if (!pages.length) throw new Error("未能在材料中识别出分页结构，请确认材料已按页组织，或改用老模式");

    const globalStyle = resolveGlobalStyle(pages, lines, coveredLines);
    return { pages, globalStyle, droppedCount, droppedTitles };
}

function parseExtractJson(raw: string): PptPageRange[] {
    const stripped = raw
        .replace(/```json/gi, "```")
        .replace(/```/g, "")
        .trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) throw new Error("展开分页失败：返回内容不是有效的 JSON，请重试");

    let parsed: RawExtractResult;
    try {
        parsed = JSON.parse(stripped.slice(start, end + 1)) as RawExtractResult;
    } catch {
        throw new Error("展开分页失败：JSON 解析失败，请重试");
    }

    if (!Array.isArray(parsed.pages) || !parsed.pages.length) throw new Error("未能在材料中识别出分页结构，请确认材料已按页组织，或改用老模式");

    return (parsed.pages as RawExtractPage[]).map((page, index) => ({
        title: String(page?.title ?? `第${index + 1}页`).trim() || `第${index + 1}页`,
        startLine: Number(page?.startLine),
        endLine: Number(page?.endLine),
    }));
}

// 剥除切片首尾的围栏标记行（``` 或 ```text 等），不改动围栏内部内容
function stripFenceLines(sliceLines: string[]): string[] {
    let start = 0;
    let end = sliceLines.length;
    if (start < end && FENCE_LINE_PATTERN.test(sliceLines[start].trim())) start++;
    if (end > start && FENCE_LINE_PATTERN.test(sliceLines[end - 1].trim())) end--;
    return sliceLines.slice(start, end);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

// 公共前缀检测（纯代码，不问模型）：各页 outline 是否共享一段逐字相同的开头。
// 命中 → 全局模板已内嵌每页，globalStyle 留空；未命中 → 从未被任何页面占用的
// 原文内容里取素材，预填风格步（允许用户整理，保真度要求低于页面正文）。
function resolveGlobalStyle(pages: PptOutlinePage[], lines: string[], coveredLines: Set<number>): string {
    if (hasCommonStylePrefix(pages)) return "";
    return lines
        .filter((_, index) => !coveredLines.has(index + 1))
        .join("\n")
        .trim();
}

function hasCommonStylePrefix(pages: PptOutlinePage[]): boolean {
    if (pages.length < 2) return false;
    const lineArrays = pages.map((page) => page.outline.split("\n"));
    const minLines = Math.min(...lineArrays.map((arr) => arr.length));

    const commonLines: string[] = [];
    for (let i = 0; i < minLines; i++) {
        const candidate = lineArrays[0][i];
        if (lineArrays.every((arr) => arr[i] === candidate)) {
            commonLines.push(candidate);
        } else {
            break;
        }
    }
    // 整页都是前缀属于退化情形（页面之间没有各自的内容），不算命中
    if (commonLines.length >= minLines) return false;
    if (commonLines.length < COMMON_PREFIX_MIN_LINES) return false;
    return commonLines.join("\n").trim().length >= COMMON_PREFIX_MIN_CHARS;
}

// ---------------------------------------------------------------------------
// 流式增量预览（向导「大纲逐页浮现」，design.md「2. 向导」）
//
// requestImageQuestion 的 onDelta 契约是"累计全文"而非增量片段（见 image.ts
// consumeResponseStreamBlock/consumeGeminiStreamBlock：state.text += delta 后整段回调），
// 所以每次都从头扫描一次即可——大纲/展开的输出通常几 KB，重扫描成本可忽略。
//
// 两种输出格式（generatePptOutline 的 {title,outline,visualHint} 与 extractPptPages 的
// {title,startLine,endLine}）都是同一种壳：{"pages":[{...},{...}]}，页对象都在花括号深度 2。
// 用字符串/转义感知的花括号计数定位已经闭合的深度 2 对象，不要求整体 JSON 已经合法。
//
// 这只是生成过程中的 UI 预览：请求结束后仍以 generatePptOutline/extractPptPages 的权威结果
// 覆盖 pages，预览阶段的容错（如展开模式跳过越界 range）不影响最终结果的正确性。
// ---------------------------------------------------------------------------

function extractDepth2JsonObjects(raw: string): string[] {
    const objects: string[] = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let objectStart = -1;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === "{") {
            depth++;
            if (depth === 2) objectStart = i;
            continue;
        }
        if (ch === "}") {
            if (depth === 2 && objectStart !== -1) {
                objects.push(raw.slice(objectStart, i + 1));
                objectStart = -1;
            }
            depth--;
        }
    }
    return objects;
}

function tryParseJson<T>(text: string): T | null {
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

/** 大纲模式（generatePptOutline）流式预览：每有一个完整页对象闭合就映射成一页。 */
export function previewOutlinePages(raw: string): PptOutlinePage[] {
    return extractDepth2JsonObjects(raw)
        .map((slice) => tryParseJson<RawOutlinePage>(slice))
        .filter((page): page is RawOutlinePage => page !== null)
        .map((page, index) => ({
            title: String(page?.title ?? `第${index + 1}页`).trim() || `第${index + 1}页`,
            outline: String(page?.outline ?? "").trim(),
            visualHint: String(page?.visualHint ?? "").trim(),
        }));
}

/** 展开模式（extractPptPages）流式预览：range 一闭合就立即按行号切片出正文；越界/倒置/空白的
 * range 静默跳过（不影响预览之外的任何状态），最终仍由 extractPptPages 权威处理与告警。 */
export function previewExtractPages(raw: string, material: string): PptOutlinePage[] {
    const lines = material.split("\n");
    const totalLines = lines.length;
    return extractDepth2JsonObjects(raw)
        .map((slice) => tryParseJson<RawExtractPage>(slice))
        .filter((range): range is RawExtractPage => range !== null)
        .map((range, index) => previewExtractPage(range, index, lines, totalLines))
        .filter((page): page is PptOutlinePage => page !== null);
}

function previewExtractPage(range: RawExtractPage, index: number, lines: string[], totalLines: number): PptOutlinePage | null {
    const startLine = Number(range?.startLine);
    const endLine = Number(range?.endLine);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || Math.round(startLine) > Math.round(endLine)) return null;
    const clampedStart = clamp(Math.round(startLine), 1, totalLines);
    const clampedEnd = clamp(Math.round(endLine), 1, totalLines);
    const outline = stripFenceLines(lines.slice(clampedStart - 1, clampedEnd))
        .join("\n")
        .trim();
    if (!outline) return null;
    return { title: String(range?.title ?? `第${index + 1}页`).trim() || `第${index + 1}页`, outline, visualHint: "" };
}
