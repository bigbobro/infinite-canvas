import { Alert, Typography, theme as antdTheme } from "antd";

import type { GenerationPlan } from "@/lib/ppt/generation-plan";

export function planHasBlockingCompilationIssues(plan?: GenerationPlan) {
    return Boolean(plan?.compilation?.issues.some((issue) => issue.severity === "blocking"));
}

export function PptGenerationPlanSummary({ plan, repeatBillingRiskCount = 0 }: { plan: GenerationPlan; repeatBillingRiskCount?: number }) {
    const { token } = antdTheme.useToken();
    const blockingIssues = plan.compilation?.issues.filter((issue) => issue.severity === "blocking") || [];
    const warnings = plan.compilation?.issues.filter((issue) => issue.severity === "warning") || [];
    const missingConfigCount = plan.excludedPages.filter((page) => page.reason === "缺少生成配置").length;

    return (
        <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
                <Typography.Text type="secondary" className="block">
                    实际生成 {plan.pageCount} 页，共 {plan.callCount} 次图片生成 API 调用。
                </Typography.Text>
                <Typography.Text type="secondary" className="block text-xs">
                    文生图 {plan.callBreakdown.textToImage} 次 · 图生图 {plan.callBreakdown.imageToImage} 次
                </Typography.Text>
                {repeatBillingRiskCount ? (
                    <Typography.Text type="warning" className="block text-xs">
                        其中 {repeatBillingRiskCount} 页的上一次请求可能已产生费用且结果无法取回，继续生成可能重复计费。
                    </Typography.Text>
                ) : null}
                {missingConfigCount ? (
                    <Typography.Text type="warning" className="block text-xs">
                        {missingConfigCount} 页缺少生成配置，已跳过。
                    </Typography.Text>
                ) : null}
            </div>

            {blockingIssues.length ? <Alert type="error" showIcon message={`最终提示词有 ${blockingIssues.length} 项必须处理`} description={blockingIssues.map((issue) => issue.message).join("；")} /> : null}
            {warnings.length ? <Alert type="warning" showIcon message={`最终提示词有 ${warnings.length} 项提醒`} description={`${warnings.map((issue) => issue.message).join("；")}。继续生成即表示已确认。`} /> : null}

            {plan.compilation?.prompts.length ? (
                <details className="rounded-lg border px-3 py-2" style={{ borderColor: token.colorBorderSecondary }}>
                    <summary className="cursor-pointer text-sm font-medium">查看真正发送的提示词（{plan.compilation.prompts.length} 页）</summary>
                    <div className="thin-scrollbar mt-3 max-h-[42vh] space-y-4 overflow-y-auto pr-1">
                        {plan.compilation.prompts.map((prompt) => {
                            const run = plan.runs.find((item) => item.pageId === prompt.pageId && item.takeId === prompt.takeId);
                            const promptIssues = plan.compilation?.issues.filter((issue) => prompt.issueIds.includes(issue.id)) || [];
                            return (
                                <section key={prompt.promptId} className="space-y-2">
                                    <div className="flex items-center justify-between gap-2 text-xs">
                                        <span className="font-medium">
                                            第 {run?.pageIndex ?? "-"} 页{prompt.override !== undefined ? " · 显式覆盖已启用" : ""}
                                        </span>
                                        <span className="font-mono opacity-60">{plan.compilation?.snapshotId}</span>
                                    </div>
                                    {promptIssues.length ? (
                                        <div className="text-xs" style={{ color: token.colorWarningText }}>
                                            {promptIssues.map((issue) => issue.message).join("；")}
                                        </div>
                                    ) : null}
                                    <pre className="whitespace-pre-wrap break-words rounded-lg p-3 text-xs leading-5" style={{ background: token.colorFillTertiary }}>
                                        {prompt.finalPrompt}
                                    </pre>
                                    {prompt.sourceRefs.length ? <div className="text-[11px] opacity-60">来源：{prompt.sourceRefs.map((source) => source.excerpt.slice(0, 48)).join(" · ")}</div> : null}
                                </section>
                            );
                        })}
                    </div>
                </details>
            ) : null}
        </div>
    );
}
