import { Alert, Button } from "antd";
import { ArrowLeft, RefreshCw, SlidersHorizontal, WandSparkles } from "lucide-react";

import type { PptStyleRepairAction, PptStyleReviewIssue } from "@/lib/ppt/style-contract";
import type { PptStylePlanningController } from "@/pages/ppt/use-ppt-style-planning";

type Props = {
    planning: PptStylePlanningController;
    onReturnToContent: (pageId?: string, regenerate?: boolean) => void;
    onOpenContract: (issue?: PptStyleReviewIssue) => void;
};

export function PptStyleReviewPanel({ planning, onReturnToContent, onOpenContract }: Props) {
    const handleAction = (issue: PptStyleReviewIssue, action: PptStyleRepairAction) => {
        if (action.deterministic) {
            planning.previewRepair([action.id]);
            return;
        }
        if (action.kind === "use_preset") planning.useFallback();
        else if (action.kind === "recheck_current_contract") planning.recheck();
        else if (action.kind === "regenerate_candidates" || action.kind === "retry_candidates") void planning.generate({ force: true });
        else if (action.kind === "focus_content_field") onReturnToContent(action.pageId);
        else if (action.kind === "regenerate_page_presentation") onReturnToContent(action.pageId, true);
        else if (action.kind === "keep_semantic_encoding" || action.kind === "use_non_color_encoding") planning.applyReviewChoice(issue.id, action.kind, planning.review.reviewFingerprint);
        else onOpenContract(issue);
    };

    if (!planning.review.issues.length) {
        return <Alert type="success" showIcon title="视觉 Contract 已通过检查" description="整套规则与逐页内容职责一致，可以生成画布。" />;
    }

    return (
        <section className="space-y-3" aria-label="视觉 Contract 检查">
            <Alert
                type={planning.review.blocking ? "warning" : "info"}
                showIcon
                title={planning.review.blocking ? `发现 ${planning.review.issues.length} 项需要处理` : "视觉检查建议"}
                description="每项问题都可在这里恢复、重新检查，或返回对应内容页处理。"
            />

            {planning.repairPreview ? (
                <div className="border-y border-stone-200 py-4 dark:border-stone-800">
                    <div className="text-sm font-medium">修复预览</div>
                    <div className="mt-3 space-y-3">
                        {planning.repairPreview.diff.map((item) => (
                            <div key={`${item.location}:${item.before}`} className="border-l-2 border-stone-300 pl-3 text-xs leading-5 dark:border-stone-700">
                                <div className="font-medium text-stone-600 dark:text-stone-300">{item.location}</div>
                                <div className="mt-1 text-red-600 line-through dark:text-red-300">{item.before}</div>
                                <div className="text-emerald-700 dark:text-emerald-300">{item.after}</div>
                            </div>
                        ))}
                    </div>
                    <div className="mt-4 flex gap-2">
                        <Button type="primary" size="small" icon={<WandSparkles className="size-3.5" />} onClick={planning.applyRepair}>
                            应用修复
                        </Button>
                        <Button size="small" onClick={planning.dismissRepair}>
                            取消
                        </Button>
                    </div>
                </div>
            ) : null}

            <div className="space-y-3">
                {planning.review.issues.map((issue) => (
                    <article key={issue.id} className="border border-stone-200 p-4 dark:border-stone-800">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                                <div className="text-xs text-stone-400">{issue.location}</div>
                                <div className="mt-1 text-sm font-medium">{issue.reason}</div>
                            </div>
                            <span className="text-xs text-amber-600 dark:text-amber-300">需处理</span>
                        </div>
                        {issue.fragment ? <div className="mt-2 border-l-2 border-stone-300 pl-3 text-xs text-stone-500 dark:border-stone-700">{issue.fragment}</div> : null}
                        <p className="mt-2 text-xs leading-5 text-stone-500">{issue.suggestion}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                            {issue.actions.map((action) => (
                                <Button
                                    key={action.id}
                                    size="small"
                                    type={action.deterministic || action.kind === "keep_semantic_encoding" ? "primary" : "default"}
                                    icon={
                                        action.kind.includes("regenerate") || action.kind === "retry_candidates" ? (
                                            <RefreshCw className="size-3.5" />
                                        ) : action.kind === "focus_content_field" ? (
                                            <ArrowLeft className="size-3.5" />
                                        ) : action.kind === "move_to_global" || action.kind === "change_contract" || action.kind === "replace_reference" ? (
                                            <SlidersHorizontal className="size-3.5" />
                                        ) : undefined
                                    }
                                    onClick={() => handleAction(issue, action)}
                                >
                                    {action.label}
                                </Button>
                            ))}
                        </div>
                    </article>
                ))}
            </div>
        </section>
    );
}
