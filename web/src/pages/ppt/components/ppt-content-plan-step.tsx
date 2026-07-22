import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Popconfirm, Skeleton } from "antd";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, FileText, Merge, Pencil, RefreshCw, Save, Sparkles, Square, Trash2, WandSparkles, X } from "lucide-react";

import type { PptContentAuditAction, PptContentAuditIssue, PptInformationGap } from "@/lib/ppt/content-plan";
import type { CanvasProjectPptContentBlock, CanvasProjectPptPageSpec, CanvasProjectPptSourceRef } from "@/stores/canvas/use-canvas-store";
import type { FinalizedPptContent, PptContentPlanningController } from "@/pages/ppt/use-ppt-content-planning";

type Props = {
    planning: PptContentPlanningController;
    onBack: () => void;
    onConfirmed: (content: FinalizedPptContent) => void;
};

const CONTENT_FORM_LABELS: Record<CanvasProjectPptPageSpec["contentForm"], string> = {
    cover: "封面",
    comparison: "对比",
    architecture: "架构",
    process: "流程",
    timeline: "时间线",
    data: "数据",
    narrative: "叙事",
    closing: "收尾",
};

const BLOCK_LABELS: Record<CanvasProjectPptContentBlock["kind"], string> = {
    title: "标题",
    primary_claim: "核心信息",
    supporting_claim: "支撑观点",
    body: "正文",
    list: "列表",
    table: "表格",
    chart_data: "图表数据",
    placeholder: "待补充",
};

const SOURCE_LABELS: Record<CanvasProjectPptSourceRef["source"], string> = {
    material: "原始材料",
    requirements: "补充要求",
    user_answer: "用户补充",
    confirmed_assumption: "已确认建议",
};

const ENCODING_INTENT_LABELS: Record<CanvasProjectPptPageSpec["visualEncoding"][number]["intent"], string> = {
    differentiate: "区分",
    emphasize: "强调",
    sequence: "表达顺序",
    group: "分组",
    show_relationship: "表达关系",
};

const ENCODING_CHANNEL_LABELS: Record<CanvasProjectPptPageSpec["visualEncoding"][number]["channel"], string> = {
    color: "颜色",
    shape: "形状",
    position: "位置",
    size: "大小",
    line: "连线",
    icon: "图标",
};

export function PptContentPlanStep({ planning, onBack, onConfirmed }: Props) {
    const [confirmError, setConfirmError] = useState("");
    const draft = planning.draft;
    const blockingIssues = planning.validation?.issues.filter((issue) => issue.severity === "blocking") ?? [];
    const safeRepairIssueIds = draft?.audit.issues.filter((issue) => issue.repair).map((issue) => issue.id) ?? [];
    const unresolvedGaps = draft?.audit.gaps.filter((gap) => !gap.resolution) ?? [];
    const unresolvedBlockingGaps = unresolvedGaps.filter((gap) => gap.blocking);

    useEffect(() => setConfirmError(""), [draft?.revision]);

    const back = () => {
        planning.cancel();
        onBack();
    };

    const confirm = () => {
        setConfirmError("");
        try {
            onConfirmed(planning.finalize());
        } catch (error) {
            setConfirmError(error instanceof Error ? error.message : "内容方案暂时无法确认");
        }
    };

    if (!draft) {
        return (
            <section className="flex flex-col gap-5" aria-busy={planning.loading}>
                <ContentPlanHeader planning={planning} />
                {planning.error ? <Alert type="error" showIcon message="内容方案未生成" description={planning.error} /> : null}
                {planning.loading ? (
                    <ContentPlanStreamPreview planning={planning} />
                ) : (
                    <div className="flex min-h-56 flex-col items-center justify-center gap-3 border-y border-stone-200 text-center dark:border-stone-800">
                        <FileText className="size-6 text-stone-400" aria-hidden="true" />
                        <p className="text-sm text-stone-500">{planning.error ? "你的材料已保留，可以直接重试。" : "尚未生成内容方案。"}</p>
                        <Button type="primary" icon={<Sparkles className="size-4" />} onClick={() => void planning.generate()}>
                            {planning.error ? "重试生成" : "生成内容方案"}
                        </Button>
                    </div>
                )}
                <div>
                    <Button icon={<ArrowLeft className="size-4" />} onClick={back}>
                        上一步
                    </Button>
                </div>
            </section>
        );
    }

    return (
        <section className="flex flex-col gap-5" aria-busy={planning.loading}>
            <ContentPlanHeader planning={planning} />

            {planning.error ? <Alert type="error" showIcon closable onClose={planning.clearError} message="上次操作未完成" description={`${planning.error}；当前内容方案已保留。`} /> : null}

            <div className="grid grid-cols-3 border-y border-stone-200 py-4 dark:border-stone-800">
                <SummaryValue label="页面" value={draft.pageSpecs.length} />
                <SummaryValue label="可安全处理" value={safeRepairIssueIds.length} />
                <SummaryValue label="需要你决定" value={unresolvedBlockingGaps.length} danger={unresolvedBlockingGaps.length > 0} />
            </div>

            <details className="group border-b border-stone-200 pb-4 dark:border-stone-800">
                <summary className="cursor-pointer list-none text-sm font-medium text-stone-600 marker:hidden dark:text-stone-300">
                    <span className="inline-flex items-center gap-2">
                        <FileText className="size-4" aria-hidden="true" />
                        查看原始材料
                        <span className="text-xs font-normal text-stone-400 group-open:hidden">展开</span>
                    </span>
                </summary>
                <pre className="thin-scrollbar mt-3 max-h-64 overflow-auto whitespace-pre-wrap border-l-2 border-stone-200 pl-4 font-sans text-sm leading-6 text-stone-600 dark:border-stone-700 dark:text-stone-300">{planning.input.sourceMaterial}</pre>
            </details>

            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">逐页内容方案</h2>
                    <p className="mt-1 text-sm text-stone-500">内容与来源在这里定稿，视觉风格会在下一步处理。</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    {safeRepairIssueIds.length ? (
                        <Button icon={<WandSparkles className="size-4" />} onClick={() => planning.previewRepair(safeRepairIssueIds)}>
                            预览安全修复
                        </Button>
                    ) : null}
                    {planning.loading ? (
                        <Button danger icon={<Square className="size-3.5 fill-current" />} onClick={planning.cancel}>
                            取消生成
                        </Button>
                    ) : (
                        <Button icon={<RefreshCw className="size-4" />} onClick={() => void planning.generate({ force: true })}>
                            重新生成全部
                        </Button>
                    )}
                </div>
            </div>

            {planning.loading ? (
                <div className="flex items-center gap-2 border-l-2 border-stone-300 py-1 pl-3 text-sm text-stone-500 dark:border-stone-700">
                    <Sparkles className="size-4 animate-pulse motion-reduce:animate-none" aria-hidden="true" />
                    正在生成新方案，当前版本会保留到新结果完整返回。
                </div>
            ) : null}

            {planning.repairPreview ? <RepairPreview planning={planning} /> : null}

            <div className="flex flex-col gap-4">
                {draft.pageSpecs.map((page, index) => (
                    <ContentPageCard
                        key={page.pageId}
                        page={page}
                        index={index}
                        pageIds={draft.pageSpecs.map((item) => item.pageId)}
                        issues={draft.audit.issues.filter((issue) => issue.pageIds.includes(page.pageId))}
                        gaps={draft.audit.gaps.filter((gap) => gap.pageId === page.pageId)}
                        planning={planning}
                    />
                ))}
            </div>

            {draft.audit.gaps.some((gap) => !gap.pageId) ? (
                <section className="border-y border-stone-200 py-4 dark:border-stone-800">
                    <h3 className="text-sm font-semibold">整套材料仍需确认</h3>
                    <div className="mt-3 space-y-3">
                        {draft.audit.gaps
                            .filter((gap) => !gap.pageId)
                            .map((gap) => (
                                <InformationGapEditor key={gap.id} gap={gap} planning={planning} />
                            ))}
                    </div>
                </section>
            ) : null}

            <div className="border-t border-stone-200 pt-4 dark:border-stone-800">
                {blockingIssues.length ? (
                    <div className="mb-4 border-l-2 border-amber-500 pl-3">
                        <p className="text-sm font-medium text-amber-700 dark:text-amber-300">还有 {blockingIssues.length} 个问题需要处理</p>
                        <ul className="mt-1 space-y-1 text-sm text-stone-600 dark:text-stone-300">
                            {blockingIssues.slice(0, 4).map((issue) => (
                                <li key={issue.id}>· {issue.message}</li>
                            ))}
                        </ul>
                    </div>
                ) : (
                    <div className="mb-4 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
                        <Check className="size-4" aria-hidden="true" />
                        内容方案已具备进入视觉方向的条件
                    </div>
                )}
                {confirmError ? <Alert className="mb-4" type="error" showIcon message={confirmError} /> : null}
                <div className="flex justify-between gap-3">
                    <Button icon={<ArrowLeft className="size-4" />} onClick={back}>
                        上一步
                    </Button>
                    <Button type="primary" icon={<ArrowRight className="size-4" />} iconPosition="end" disabled={planning.loading || Boolean(blockingIssues.length)} onClick={confirm}>
                        确认内容方案，进入视觉方向
                    </Button>
                </div>
            </div>
        </section>
    );
}

function ContentPlanHeader({ planning }: { planning: PptContentPlanningController }) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-stone-400">第一轮 · 内容定稿</p>
                <h2 className="mt-2 text-lg font-semibold">内容方案</h2>
                <p className="mt-1 text-sm text-stone-500">检查每页要讲什么，信息是否有来源，还缺哪些决定。</p>
            </div>
            {planning.loading ? <span className="shrink-0 font-mono text-xs tabular-nums text-stone-400">{planning.receivedCharacters.toLocaleString()} chars</span> : null}
        </div>
    );
}

function ContentPlanStreamPreview({ planning }: { planning: PptContentPlanningController }) {
    const pages = planning.streamProgress.completedPages;
    const pendingOrdinal = planning.streamProgress.pendingPageOrdinal ?? pages.length + 1;
    return (
        <section className="border-y border-stone-200 py-5 dark:border-stone-800" data-testid="ppt-content-stream-preview" aria-live="polite">
            <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                    <p className="text-sm font-medium">生成中预览</p>
                    <p className="mt-1 text-xs text-stone-500">完整页面会依次出现；来源与内容检查完成后才能编辑。</p>
                </div>
                <span className="font-mono text-xs tabular-nums text-stone-400">已接收 {pages.length} 页</span>
            </div>
            <div className="space-y-3">
                {pages.map((page) => (
                    <article key={`${page.ordinal}:${page.title}`} className="grid gap-3 border border-stone-200 px-4 py-4 sm:grid-cols-[44px_minmax(0,1fr)_auto] dark:border-stone-800" data-testid="ppt-content-stream-page">
                        <span className="font-mono text-xs tabular-nums text-stone-400">{String(page.ordinal).padStart(2, "0")}</span>
                        <div className="min-w-0">
                            <h3 className="truncate text-sm font-semibold">{page.title}</h3>
                            {page.primaryClaim ? <p className="mt-1 line-clamp-2 text-sm leading-6 text-stone-500">{page.primaryClaim}</p> : null}
                        </div>
                        <span className="text-xs text-emerald-700 dark:text-emerald-300">已接收 · {page.blockCount} 块</span>
                    </article>
                ))}
                <article className="grid gap-3 border border-dashed border-stone-200 px-4 py-4 sm:grid-cols-[44px_minmax(0,1fr)] dark:border-stone-800" data-testid="ppt-content-stream-pending">
                    <span className="font-mono text-xs tabular-nums text-stone-400">{String(pendingOrdinal).padStart(2, "0")}</span>
                    <div>
                        <Skeleton active title={{ width: "34%" }} paragraph={{ rows: pages.length ? 1 : 3 }} />
                        <p className="mt-1 text-xs text-stone-500">{planning.receivedCharacters ? "正在整理下一页内容与信息缺口…" : "正在理解材料…"}</p>
                    </div>
                </article>
            </div>
        </section>
    );
}

function SummaryValue({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
    return (
        <div className="border-r border-stone-200 px-4 first:pl-0 last:border-r-0 last:pr-0 dark:border-stone-800">
            <div className={`font-mono text-2xl tabular-nums ${danger ? "text-amber-600 dark:text-amber-300" : "text-stone-900 dark:text-stone-100"}`}>{String(value).padStart(2, "0")}</div>
            <div className="mt-1 text-xs text-stone-500">{label}</div>
        </div>
    );
}

function RepairPreview({ planning }: { planning: PptContentPlanningController }) {
    const preview = planning.repairPreview!;
    const pageNumberById = new Map(planning.draft?.pageSpecs.map((page, index) => [page.pageId, index + 1]) ?? []);
    return (
        <section className="border-y border-stone-300 py-4 dark:border-stone-700">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h3 className="text-sm font-semibold">修复预览</h3>
                    <p className="mt-1 text-xs text-stone-500">预览基于内容版本 {preview.draftRevision}；内容变更后旧预览会失效。</p>
                </div>
                <div className="flex gap-2">
                    <Button size="small" type="text" onClick={planning.dismissRepair}>
                        取消
                    </Button>
                    <Button size="small" type="primary" icon={<Check className="size-3.5" />} onClick={planning.applyRepair}>
                        应用修复
                    </Button>
                </div>
            </div>
            <ul className="mt-3 space-y-1 text-sm text-stone-600 dark:text-stone-300">
                {preview.operations.map((operation, index) => (
                    <li key={`${operation.pageId}:${operation.value}:${index}`}>
                        · 第 {pageNumberById.get(operation.pageId) ?? "?"} 页：从页面构图中移出「{operation.value}」，留到视觉方向阶段处理
                    </li>
                ))}
            </ul>
        </section>
    );
}

function ContentPageCard({ page, index, pageIds, issues, gaps, planning }: { page: CanvasProjectPptPageSpec; index: number; pageIds: string[]; issues: PptContentAuditIssue[]; gaps: PptInformationGap[]; planning: PptContentPlanningController }) {
    const title = page.contentBlocks.find((block) => block.kind === "title");
    const primaryClaim = page.contentBlocks.find((block) => block.kind === "primary_claim");
    const contentBlocks = page.contentBlocks.filter((block) => block.kind !== "title" && block.kind !== "primary_claim");
    const sourceById = useMemo(() => new Map(page.sourceRefs.map((source) => [source.id, source])), [page.sourceRefs]);
    const unresolvedCount = gaps.filter((gap) => !gap.resolution).length;
    const suggestionCount = gaps.filter((gap) => !gap.resolution && gap.proposedAnswer?.trim()).length;
    const pageRequest = planning.pageRequest.pageId === page.pageId ? planning.pageRequest : null;
    const nextPageId = pageIds[index + 1];
    const move = (offset: -1 | 1) => {
        const targetIndex = index + offset;
        if (targetIndex < 0 || targetIndex >= pageIds.length) return;
        const nextIds = [...pageIds];
        [nextIds[index], nextIds[targetIndex]] = [nextIds[targetIndex], nextIds[index]];
        planning.reorderPages(nextIds);
    };

    return (
        <article className="border border-stone-200 bg-card dark:border-stone-800">
            <header className="grid gap-3 border-b border-stone-200 px-4 py-4 sm:grid-cols-[44px_minmax(0,1fr)] dark:border-stone-800">
                <span className="font-mono text-xs tabular-nums text-stone-400">{String(index + 1).padStart(2, "0")}</span>
                <div className="min-w-0">
                    <EditableText value={title?.text || `第 ${index + 1} 页`} className="text-base font-semibold leading-6" ariaLabel="编辑页标题" onSave={(value) => title && planning.editBlock(page.pageId, title.id, value)} />
                    <EditableText value={page.purpose || "本页目的待补充"} className="mt-1 text-sm text-stone-500" ariaLabel="编辑本页目的" onSave={(value) => planning.editPurpose(page.pageId, value)} />
                    <div className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-stone-500">
                        <span className="mr-2">
                            {CONTENT_FORM_LABELS[page.contentForm]} · {unresolvedCount ? `${unresolvedCount} 项待决定` : "可确认"}
                        </span>
                        {pageRequest?.loading ? (
                            <Button size="small" type="text" danger icon={<Square className="size-3 fill-current" />} onClick={planning.cancel}>
                                取消本页生成
                            </Button>
                        ) : (
                            <Button size="small" type="text" icon={<WandSparkles className="size-3.5" />} onClick={() => void planning.regeneratePage(page.pageId)}>
                                让 AI 补全本页
                            </Button>
                        )}
                        {suggestionCount ? (
                            <Popconfirm title={`采纳本页 ${suggestionCount} 条 AI 建议？`} description="建议会作为已确认内容写入本页，之后仍可继续编辑。" okText="采纳" cancelText="取消" onConfirm={() => planning.acceptPageSuggestions(page.pageId)}>
                                <Button size="small" type="text" icon={<Check className="size-3.5" />}>
                                    采纳本页建议
                                </Button>
                            </Popconfirm>
                        ) : null}
                        <Button size="small" type="text" icon={<ArrowUp className="size-3.5" />} disabled={index === 0} aria-label="上移一页" onClick={() => move(-1)} />
                        <Button size="small" type="text" icon={<ArrowDown className="size-3.5" />} disabled={index === pageIds.length - 1} aria-label="下移一页" onClick={() => move(1)} />
                        {nextPageId ? (
                            <Popconfirm title="将下一页内容合并到本页？" description="该操作会移除下一页，不会自动接受新事实。" okText="合并" cancelText="取消" onConfirm={() => planning.mergePages([page.pageId, nextPageId])}>
                                <Button size="small" type="text" icon={<Merge className="size-3.5" />}>
                                    合并下一页
                                </Button>
                            </Popconfirm>
                        ) : null}
                        <Popconfirm title="删除该页内容？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => planning.removePage(page.pageId)}>
                            <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />}>
                                删除
                            </Button>
                        </Popconfirm>
                    </div>
                </div>
            </header>

            <div className="space-y-5 px-4 py-4">
                {pageRequest?.error ? <Alert type="error" showIcon message="本页重新生成失败" description={`${pageRequest.error}；原页内容已保留。`} /> : null}
                <section>
                    <p className="text-xs font-medium text-stone-400">核心信息</p>
                    <EditableText value={primaryClaim?.text || "待补充"} className="mt-2 text-[15px] font-medium leading-6" ariaLabel="编辑核心信息" multiline onSave={(value) => primaryClaim && planning.editBlock(page.pageId, primaryClaim.id, value)} />
                    {primaryClaim ? <BlockSources block={primaryClaim} sourceById={sourceById} /> : null}
                </section>

                {contentBlocks.length ? (
                    <section>
                        <p className="text-xs font-medium text-stone-400">页面内容</p>
                        <div className="mt-2 divide-y divide-stone-100 border-y border-stone-100 dark:divide-stone-800 dark:border-stone-800">
                            {contentBlocks.map((block) => (
                                <div key={block.id} className="grid gap-2 py-3 sm:grid-cols-[88px_minmax(0,1fr)]">
                                    <span className={`text-xs ${block.kind === "placeholder" ? "text-amber-600 dark:text-amber-300" : "text-stone-400"}`}>{BLOCK_LABELS[block.kind]}</span>
                                    <div>
                                        <EditableText
                                            value={block.text || "待补充"}
                                            className="whitespace-pre-wrap text-sm leading-6 text-stone-700 dark:text-stone-200"
                                            ariaLabel={`编辑${BLOCK_LABELS[block.kind]}`}
                                            multiline
                                            onSave={(value) => planning.editBlock(page.pageId, block.id, value)}
                                        />
                                        <BlockSources block={block} sourceById={sourceById} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                ) : null}

                <section className="grid gap-4 sm:grid-cols-2">
                    <div>
                        <p className="text-xs font-medium text-stone-400">几何布局</p>
                        <p className="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-300">{page.layoutIntent.length ? page.layoutIntent.join(" · ") : "交由视觉阶段确定"}</p>
                    </div>
                    <div>
                        <p className="text-xs font-medium text-stone-400">信息表达</p>
                        <p className="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-300">
                            {page.visualEncoding.length ? page.visualEncoding.map((encoding) => `${ENCODING_INTENT_LABELS[encoding.intent]} · ${ENCODING_CHANNEL_LABELS[encoding.channel]}`).join(" / ") : "无额外结构化编码"}
                        </p>
                    </div>
                </section>

                {issues.some((issue) => issue.code !== "unresolved_gap") ? <PageIssues issues={issues.filter((issue) => issue.code !== "unresolved_gap")} planning={planning} /> : null}

                {gaps.length ? (
                    <section className="border-t border-stone-200 pt-4 dark:border-stone-800">
                        <h4 className="text-sm font-semibold">信息缺口</h4>
                        <div className="mt-3 space-y-3">
                            {gaps.map((gap) => (
                                <InformationGapEditor key={gap.id} gap={gap} planning={planning} />
                            ))}
                        </div>
                    </section>
                ) : null}

                {page.sourceRefs.length ? (
                    <details className="border-t border-stone-100 pt-3 text-sm dark:border-stone-800">
                        <summary className="cursor-pointer text-xs text-stone-500">查看 {page.sourceRefs.length} 条来源依据</summary>
                        <div className="mt-3 space-y-3">
                            {page.sourceRefs.map((source) => (
                                <div key={source.id} className="border-l-2 border-stone-200 pl-3 dark:border-stone-700">
                                    <p className="text-xs text-stone-400">{sourceLabel(source)}</p>
                                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-stone-600 dark:text-stone-300">{source.excerpt}</p>
                                </div>
                            ))}
                        </div>
                    </details>
                ) : null}
            </div>
        </article>
    );
}

function EditableText({ value, className, ariaLabel, multiline = false, onSave }: { value: string; className?: string; ariaLabel: string; multiline?: boolean; onSave: (value: string) => void }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);
    const start = () => {
        setDraft(value);
        setEditing(true);
    };
    const save = () => {
        const next = draft.trim();
        if (!next) return;
        onSave(next);
        setEditing(false);
    };
    if (editing) {
        return (
            <div className="flex items-start gap-2">
                {multiline ? <Input.TextArea value={draft} autoSize={{ minRows: 2, maxRows: 8 }} onChange={(event) => setDraft(event.target.value)} /> : <Input value={draft} onChange={(event) => setDraft(event.target.value)} onPressEnter={save} />}
                <div className="flex shrink-0 gap-1">
                    <Button size="small" type="text" icon={<Save className="size-3.5" />} aria-label="保存" disabled={!draft.trim()} onClick={save} />
                    <Button size="small" type="text" icon={<X className="size-3.5" />} aria-label="取消" onClick={() => setEditing(false)} />
                </div>
            </div>
        );
    }
    return (
        <div className="group/edit flex items-start gap-2">
            <p className={`min-w-0 flex-1 ${className || ""}`}>{value}</p>
            <Button size="small" type="text" icon={<Pencil className="size-3.5" />} className="shrink-0 opacity-0 transition-opacity group-hover/edit:opacity-100 group-focus-within/edit:opacity-100" aria-label={ariaLabel} onClick={start} />
        </div>
    );
}

function BlockSources({ block, sourceById }: { block: CanvasProjectPptContentBlock; sourceById: Map<string, CanvasProjectPptSourceRef> }) {
    const sources = block.sourceRefIds.map((id) => sourceById.get(id)).filter((source): source is CanvasProjectPptSourceRef => Boolean(source));
    if (!sources.length) return <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-300">{block.kind === "placeholder" ? "等待你补充" : "来源待确认"}</p>;
    return <p className="mt-1 text-[11px] text-stone-400">{sources.map(sourceLabel).join(" · ")}</p>;
}

function sourceLabel(source: CanvasProjectPptSourceRef) {
    const range = source.startLine ? ` L${source.startLine}${source.endLine && source.endLine !== source.startLine ? `–${source.endLine}` : ""}` : "";
    return `${SOURCE_LABELS[source.source]}${range}`;
}

function PageIssues({ issues, planning }: { issues: PptContentAuditIssue[]; planning: PptContentPlanningController }) {
    return (
        <section className="border-l-2 border-amber-400 pl-3">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">内容检查</p>
            <div className="mt-2 space-y-2">
                {issues.map((issue) => (
                    <div key={issue.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="text-stone-600 dark:text-stone-300">{issue.message}</span>
                        <PageIssueAction issue={issue} planning={planning} />
                    </div>
                ))}
            </div>
        </section>
    );
}

function PageIssueAction({ issue, planning }: { issue: PptContentAuditIssue; planning: PptContentPlanningController }) {
    const action = issue.actions.find((item) => item.kind === "merge_pages" || item.kind === "regenerate_pages" || item.kind === "preview_safe_patch") as PptContentAuditAction | undefined;
    if (action?.kind === "merge_pages" && action.pageIds.length === 2) {
        return (
            <Popconfirm title="将这两页合并？" description="合并不会自动接受新事实。" okText="合并" cancelText="取消" onConfirm={() => planning.mergePages([action.pageIds[0], action.pageIds[1]])}>
                <Button size="small" type="text" icon={<Merge className="size-3.5" />}>
                    合并这两页
                </Button>
            </Popconfirm>
        );
    }
    if (action?.kind === "regenerate_pages" && action.pageIds[0]) {
        return (
            <Button size="small" type="text" icon={<RefreshCw className="size-3.5" />} onClick={() => void planning.regeneratePage(action.pageIds[0])}>
                重新生成本页
            </Button>
        );
    }
    if (issue.repair) {
        return (
            <Button size="small" type="text" icon={<WandSparkles className="size-3.5" />} onClick={() => planning.previewRepair([issue.id])}>
                预览修复
            </Button>
        );
    }
    return null;
}

function InformationGapEditor({ gap, planning }: { gap: PptInformationGap; planning: PptContentPlanningController }) {
    const [answer, setAnswer] = useState("");
    const resolved = gap.resolution;
    const boundPage = gap.pageId ? planning.draft?.pageSpecs.find((page) => page.pageId === gap.pageId) : undefined;
    const requiresConcreteContent = Boolean(gap.briefField || boundPage?.contentBlocks.some((block) => block.gapId === gap.id && (block.kind === "title" || block.kind === "primary_claim")));
    if (resolved) {
        return (
            <div id={`ppt-gap-${gap.id}`} className="border-l-2 border-emerald-500 pl-3">
                <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                    <Check className="size-3.5" aria-hidden="true" />
                    {gap.question}
                </p>
                <p className="mt-1 text-xs text-stone-500">
                    {resolutionLabel(resolved.kind)}
                    {resolved.kind === "omit" ? "" : `：${resolved.text}`}
                </p>
            </div>
        );
    }

    const submitAnswer = () => {
        const text = answer.trim();
        if (!text) return;
        planning.resolveGap(gap.id, { kind: "user_answer", text, resolvedAt: new Date().toISOString() });
    };

    return (
        <div id={`ppt-gap-${gap.id}`} className={`border-l-2 pl-3 ${gap.blocking ? "border-amber-500" : "border-stone-300 dark:border-stone-700"}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <p className="text-sm font-medium">{gap.question}</p>
                    <p className="mt-1 text-xs leading-5 text-stone-500">{gap.reason}</p>
                </div>
                <span className={`text-[11px] ${gap.blocking ? "text-amber-600 dark:text-amber-300" : "text-stone-400"}`}>{gap.blocking ? "需要决定" : "可选"}</span>
            </div>
            {gap.proposedAnswer ? (
                <div className="mt-3 border-y border-stone-100 py-2 text-sm dark:border-stone-800">
                    <p className="text-xs text-stone-400">AI 建议，尚未采纳</p>
                    <p className="mt-1 leading-6 text-stone-600 dark:text-stone-300">{gap.proposedAnswer}</p>
                </div>
            ) : null}
            <div className="mt-3 flex gap-2">
                <Input.TextArea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="填写你确认的正文或事实" autoSize={{ minRows: 1, maxRows: 4 }} />
                <Button type="primary" disabled={!answer.trim()} onClick={submitAnswer}>
                    采用为正文
                </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-1 gap-y-1">
                {gap.proposedAnswer ? (
                    <Button size="small" type="text" onClick={() => planning.resolveGap(gap.id, { kind: "confirmed_assumption", text: gap.proposedAnswer!, resolvedAt: new Date().toISOString() })}>
                        采纳 AI 建议
                    </Button>
                ) : null}
                {!gap.proposedAnswer && gap.pageId ? (
                    <Button size="small" type="text" icon={<WandSparkles className="size-3.5" />} loading={planning.pageRequest.loading && planning.pageRequest.pageId === gap.pageId} onClick={() => void planning.regeneratePage(gap.pageId!)}>
                        让 AI 给建议
                    </Button>
                ) : null}
                {!requiresConcreteContent ? (
                    <>
                        <Button size="small" type="text" onClick={() => planning.resolveGap(gap.id, { kind: "placeholder", text: answer.trim() || "待补充", resolvedAt: new Date().toISOString() })}>
                            保留待补充
                        </Button>
                        <Popconfirm title="确定不在本页呈现这项内容？" okText="不呈现" cancelText="取消" onConfirm={() => planning.resolveGap(gap.id, { kind: "omit", resolvedAt: new Date().toISOString() })}>
                            <Button size="small" type="text">
                                不在本页呈现
                            </Button>
                        </Popconfirm>
                    </>
                ) : null}
            </div>
        </div>
    );
}

function resolutionLabel(kind: NonNullable<PptInformationGap["resolution"]>["kind"]) {
    if (kind === "user_answer") return "已采用用户补充";
    if (kind === "confirmed_assumption") return "已确认建议";
    if (kind === "placeholder") return "已保留待补充位";
    return "已确认不呈现";
}
