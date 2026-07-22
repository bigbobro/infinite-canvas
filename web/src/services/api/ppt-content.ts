import { requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";

export type PptContentPlanRequest = {
    title: string;
    sourceMaterial: string;
    requirements: string;
};

export type PptContentPageRegenerationRequest = PptContentPlanRequest & {
    draftRevision: number;
    targetPageNumber: number;
    targetPage: { title: string; purpose: string; primaryClaim: string; contentBlocks: string[] };
    unresolvedGaps: Array<{ question: string; reason: string; proposedAnswer?: string }>;
    otherPageTitles: string[];
};

export type PptTextRequester = typeof requestImageQuestion;

const CONTENT_PLAN_SYSTEM_PROMPT = `你是 PPT 内容规划师。你的任务不是只拆页，也不是替用户虚构业务细节，而是把材料整理成可审查、可直接约束后续图片模型的逐页内容方案。

只输出 JSON，不要输出解释或代码块。格式：
{"brief":{"title":"","audience":"","goal":"","narrative":"","visualSignals":[]},"pages":[{"title":"","purpose":"","primaryClaim":"","contentForm":"comparison","contentFormNote":"","titleSource":{"source":"material","startLine":1,"endLine":1},"primaryClaimSource":{"source":"material","startLine":1,"endLine":1},"blocks":[{"key":"b1","kind":"body","text":"","source":{"source":"material","startLine":1,"endLine":2}}],"layoutIntent":["左右双栏"],"visualEncoding":[{"contentKeys":["b1"],"intent":"differentiate","channel":"shape"}],"gaps":[{"key":"g1","kind":"missing_detail","question":"","reason":"","blocking":true,"proposedAnswer":""}]}]}

硬规则：
1. contentForm 只能是 cover、comparison、architecture、process、timeline、data、narrative、closing；它表达语义结构。layoutIntent 只写左右、上下、网格等几何关系，不写配色、字体、背景、材质或气质。
2. title 和 primaryClaim 单独输出；blocks 的 kind 只能是 supporting_claim、body、list、table、chart_data、placeholder，不能重复 title 或 primary_claim。
3. 每段来自用户输入的可见文案必须标注 material 或 requirements 的准确起止行号。不要复述为一个新事实后仍声称来自原文。
4. 材料没有给出的组件名、参数、型号、容量、成本、合作条件、里程碑或结论，不得写入 blocks；改为 gap。proposedAnswer 只能是待用户确认的建议，不能混入页面正文。
5. 发现主题重复时不要机械保留两页；优先合并，并通过页面 purpose 说明它为什么存在。无法判断时保留并在 gap 中询问。
6. visualEncoding 只描述内容关系如何映射为颜色、形状、位置、大小、连线或图标，contentKeys 必须引用本页 blocks；不得借此新增可见文案。整套审美风格只放 brief.visualSignals，不进入页面字段。
7. 内容要足以制作页面：把材料已有的事实展开成清楚的标题、核心信息和正文块；不得把“组件对比分析”“资源投入”等空泛目录词当作完成的页面内容。`;

export function buildPptContentPlanMessages(input: PptContentPlanRequest): AiTextMessage[] {
    return [
        { role: "system", content: CONTENT_PLAN_SYSTEM_PROMPT },
        {
            role: "user",
            content: `PPT 标题：${input.title.trim() || "未命名"}\n\n材料（行号|原文）：\n${numberLines(input.sourceMaterial)}\n\n补充要求（行号|原文）：\n${numberLines(input.requirements) || "1|无特殊要求"}`,
        },
    ];
}

export async function requestPptContentPlan(config: AiConfig, input: PptContentPlanRequest, onDelta: (text: string) => void, options?: { signal?: AbortSignal; requester?: PptTextRequester }): Promise<unknown> {
    const requestConfig: AiConfig = { ...config, model: config.textModel || config.model };
    const answer = await (options?.requester ?? requestImageQuestion)(requestConfig, buildPptContentPlanMessages(input), onDelta, { signal: options?.signal });
    return parsePptContentPlanResponse(answer);
}

export function buildPptContentPageRegenerationMessages(input: PptContentPageRegenerationRequest): AiTextMessage[] {
    return [
        { role: "system", content: `${CONTENT_PLAN_SYSTEM_PROMPT}\n\n这次只重新生成用户指定的一页。pages 必须且只能返回 1 页；不要改写其他页，不要输出页面 ID。` },
        {
            role: "user",
            content: `PPT 标题：${input.title.trim() || "未命名"}\n当前内容版本：${input.draftRevision}\n\n材料（行号|原文）：\n${numberLines(input.sourceMaterial)}\n\n补充要求（行号|原文）：\n${numberLines(input.requirements) || "1|无特殊要求"}\n\n只重新生成第 ${input.targetPageNumber} 页：\n${JSON.stringify(input.targetPage)}\n\n本页尚未解决的信息缺口：\n${JSON.stringify(input.unresolvedGaps)}\n\n其他页标题已锁定，不得输出或改写：\n${input.otherPageTitles.map((title, index) => `${index + 1}. ${title}`).join("\n") || "无"}`,
        },
    ];
}

export async function requestPptContentPageRegeneration(config: AiConfig, input: PptContentPageRegenerationRequest, onDelta: (text: string) => void, options?: { signal?: AbortSignal; requester?: PptTextRequester }): Promise<unknown> {
    const requestConfig: AiConfig = { ...config, model: config.textModel || config.model };
    const answer = await (options?.requester ?? requestImageQuestion)(requestConfig, buildPptContentPageRegenerationMessages(input), onDelta, { signal: options?.signal });
    return parsePptContentPlanResponse(answer);
}

export function parsePptContentPlanResponse(raw: string): unknown {
    const stripped = raw
        .replace(/```json/gi, "```")
        .replace(/```/g, "")
        .trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end < start) throw new Error("生成的内容方案不是有效的 JSON，请重试");
    try {
        return JSON.parse(stripped.slice(start, end + 1)) as unknown;
    } catch {
        throw new Error("生成的内容方案解析失败，请重试");
    }
}

function numberLines(value: string) {
    if (!value.trim()) return "";
    return value
        .split("\n")
        .map((line, index) => `${index + 1}|${line}`)
        .join("\n")
        .trim();
}
