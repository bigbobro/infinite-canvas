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
