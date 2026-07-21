import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, ConfigProvider, Modal, theme as antdTheme } from "antd";
import { CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Download, ImageOff, LoaderCircle, Pencil, Presentation } from "lucide-react";

import { CanvasImageLightbox } from "@/components/canvas/canvas-image-lightbox";
import { exportPptDeckImages, exportPptDeckPptx, inspectPptDeckExport, type PptDeckExportProgress } from "@/lib/ppt/deck-export";
import { setPptPageConfirmedNode } from "@/lib/ppt/page-confirmation";
import { buildPptPageWorkspace } from "@/lib/ppt/page-workspace";
import { cn } from "@/lib/utils";
import { flushCanvasStore, useCanvasStore } from "@/stores/canvas/use-canvas-store";

type Inspection = Awaited<ReturnType<typeof inspectPptDeckExport>>;
type ExportState = PptDeckExportProgress & { kind: "pptx" | "zip" };

/** 放映室：终审唯一深色场域，两主题一致，靠嵌套 ConfigProvider（darkAlgorithm）驱动 antd 内建组件（Button/Modal 关闭态）跟随。 */
const CINEMA_THEME = {
    algorithm: antdTheme.darkAlgorithm,
    token: {
        colorBgContainer: "var(--surface-cinema)",
        colorBgElevated: "var(--surface-cinema)",
        colorBorder: "rgba(255,255,255,0.14)",
        colorPrimary: "#fafafa",
        colorPrimaryHover: "rgba(255,255,255,0.85)",
        colorPrimaryActive: "rgba(255,255,255,0.7)",
        colorTextLightSolid: "#0a0a0a",
    },
};

function pad2(value: number) {
    return String(value).padStart(2, "0");
}

export function CanvasPptFinalReview({ open, projectId, onClose, onEditPage }: { open: boolean; projectId: string; onClose: () => void; onEditPage: (pageId: string) => void }) {
    const { message } = App.useApp();
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const updateProject = useCanvasStore((state) => state.updateProject);
    const [inspection, setInspection] = useState<Inspection | null>(null);
    const [activePageId, setActivePageId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [exporting, setExporting] = useState<ExportState | null>(null);
    const [loadError, setLoadError] = useState("");
    const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
    const exportLock = useRef(false);

    // #17+#27：不再依赖手动「重新检查」，effect 依赖 project 引用——store 更新（选定/取消确认）后引用变化即自动重算。
    useEffect(() => {
        if (!open) return;
        if (!project) {
            setInspection(null);
            setLoadError("找不到当前 PPT 工程");
            setLoading(false);
            return;
        }

        let cancelled = false;
        setLoadError("");
        setLoading(true);
        void inspectPptDeckExport(project)
            .then((result) => {
                if (cancelled) return;
                setInspection(result);
                setActivePageId((current) => {
                    if (result.pages.some((item) => item.page.pageId === current)) return current;
                    return result.pages.find((item) => item.issues.length)?.page.pageId ?? result.pages[0]?.page.pageId ?? null;
                });
            })
            .catch((error) => {
                if (!cancelled) setLoadError(error instanceof Error ? error.message : "无法检查 PPT 页面");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [open, project]);

    useEffect(() => {
        if (!open) setLightboxSrc(null);
    }, [open]);

    const pages = useMemo(() => [...(inspection?.pages ?? [])].sort((left, right) => left.page.index - right.page.index), [inspection]);
    const pageWorkspaces = useMemo(() => {
        if (!project?.ppt) return [];
        return [...project.ppt.pages].sort((left, right) => left.index - right.index).map((page) => buildPptPageWorkspace(project, page));
    }, [project]);
    const activePosition = Math.max(
        0,
        pages.findIndex((item) => item.page.pageId === activePageId),
    );
    const activePage = pages[activePosition];
    const activeWorkspace = activePage ? pageWorkspaces.find((item) => item.page.pageId === activePage.page.pageId) : undefined;
    const problemCount = pages.filter((item) => item.issues.length > 0).length;
    const pptxIssuePages = pages.filter((item) => item.pptxIssues.length > 0);

    const changePage = (position: number) => {
        const target = pages[position];
        if (target) setActivePageId(target.page.pageId);
    };

    const advanceToNextUnconfirmed = (currentPageId: string) => {
        const currentPos = pages.findIndex((item) => item.page.pageId === currentPageId);
        const rotated = [...pages.slice(currentPos + 1), ...pages.slice(0, currentPos + 1)];
        const next = rotated.find((item) => item.page.pageId !== currentPageId && item.issues.length > 0);
        if (next) setActivePageId(next.page.pageId);
    };

    const selectCandidate = async (pageId: string, nodeId: string) => {
        if (!project?.ppt) return;
        updateProject(project.id, { ppt: setPptPageConfirmedNode(project.ppt, pageId, nodeId) });
        try {
            await flushCanvasStore();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "确认状态保存失败");
            return;
        }
        advanceToNextUnconfirmed(pageId);
    };

    const cancelConfirm = async (pageId: string) => {
        if (!project?.ppt) return;
        updateProject(project.id, { ppt: setPptPageConfirmedNode(project.ppt, pageId, undefined) });
        try {
            await flushCanvasStore();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "确认状态保存失败");
        }
    };

    const handleExport = async (kind: "pptx" | "zip") => {
        if (!project || exportLock.current || (kind === "pptx" ? !inspection?.pptxReady : !inspection?.ready)) return;
        exportLock.current = true;
        setExporting({ kind, current: 0, total: pages.length, message: kind === "pptx" ? "正在准备 PPT…" : "正在准备图片…" });
        try {
            const onProgress = (progress: PptDeckExportProgress) => setExporting({ kind, ...progress });
            if (kind === "pptx") {
                await exportPptDeckPptx(project, { onProgress });
                message.success("图片版 PPT 已下载");
            } else {
                await exportPptDeckImages(project, { onProgress });
                message.success("页面图片 ZIP 已下载");
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : kind === "pptx" ? "PPT 下载失败" : "ZIP 下载失败");
        } finally {
            exportLock.current = false;
            setExporting(null);
        }
    };

    // #21：终审 ←/→ 翻页；lightbox 打开时交给 lightbox 自身处理 Esc，这里只在未打开 lightbox 时响应方向键。
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        // 恢复原有的阻止冒泡（此前为无条件 stopPropagation），避免终审打开时方向键之外的按键
        // （如 Delete/Ctrl+Z）冒泡到底层画布的全局快捷键监听（project.tsx window keydown）。
        event.stopPropagation();
        if (lightboxSrc) return;
        const target = event.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
        // 容器聚焦后 stopPropagation 会拦掉 antd 的 Esc 关闭,须在此显式处理。
        if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key === "ArrowLeft" && activePosition > 0) {
            event.preventDefault();
            changePage(activePosition - 1);
        } else if (event.key === "ArrowRight" && activePosition < pages.length - 1) {
            event.preventDefault();
            changePage(activePosition + 1);
        }
    };

    return (
        <>
            <ConfigProvider theme={CINEMA_THEME}>
                <Modal
                    title="PPT 最终检视"
                    classNames={{ header: "sr-only" }}
                    open={open}
                    onCancel={onClose}
                    maskClosable
                    footer={null}
                    width="min(96vw, 1600px)"
                    centered
                    destroyOnHidden
                    transitionName=""
                    styles={{ body: { padding: 0 }, container: { background: "var(--surface-cinema)" } }}
                >
                    <div
                        className="flex h-[min(94vh,980px)] min-h-0 flex-col overflow-hidden outline-none bg-[var(--surface-cinema)] text-white/85 duration-200 ease-out animate-in fade-in-0 zoom-in-98 motion-reduce:animate-none"
                        data-canvas-no-zoom
                        onKeyDown={handleKeyDown}
                        // 打开即聚焦容器:焦点落在 body 时容器级 onKeyDown 收不到 ←/→(实测),tabIndex+autofocus 保证键盘直达。
                        tabIndex={-1}
                        ref={(node) => {
                            if (node && open) node.focus({ preventScroll: true });
                        }}
                    >
                        <header className="flex h-[72px] shrink-0 items-center gap-4 border-b border-white/10 px-4 pr-14">
                            <div className="flex w-56 shrink-0 items-center gap-2.5">
                                <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/15 bg-white/5 text-white/85">
                                    <Presentation className="size-4" aria-hidden="true" />
                                </div>
                                <div className="min-w-0">
                                    <h2 className="text-sm font-semibold leading-5 text-white/90">最终检视</h2>
                                    <p className="truncate text-xs leading-4 text-white/70">
                                        {loading
                                            ? "正在检查每页最终版…"
                                            : inspection?.pptxReady
                                              ? `全部 ${pages.length} 页已定稿，可以下载交付文件`
                                              : inspection?.ready
                                                ? `页面图片已就绪，还有 ${pptxIssuePages.length} 页不能生成 PPT`
                                                : problemCount
                                                  ? `还有 ${problemCount} 页需要处理`
                                                  : "请先完成每页确认"}
                                    </p>
                                </div>
                            </div>
                            <nav className="thin-scrollbar flex min-w-0 flex-1 gap-2 overflow-x-auto py-1" aria-label="PPT 页面终检导航">
                                {pages.map((item) => {
                                    const selected = item.page.pageId === activePage?.page.pageId;
                                    const ready = item.issues.length === 0;
                                    const pptxReady = item.pptxIssues.length === 0;
                                    return (
                                        <button
                                            key={item.page.pageId}
                                            type="button"
                                            className={cn(
                                                "w-[88px] shrink-0 rounded-md border border-white/10 bg-white/5 p-1 text-left transition-all duration-150 hover:bg-white/10",
                                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-cinema)]",
                                                selected && "bg-white/10 ring-2 ring-white/80",
                                            )}
                                            aria-current={selected ? "page" : undefined}
                                            aria-label={`第 ${item.page.index} 页，${!ready ? "需要处理" : pptxReady ? "已定稿" : "不能生成 PPT"}`}
                                            onClick={() => setActivePageId(item.page.pageId)}
                                        >
                                            <span className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded bg-black/40" aria-hidden="true">
                                                {item.previewUrl ? <img src={item.previewUrl} alt="" className="size-full object-contain" /> : <ImageOff className="size-4 text-white/30" />}
                                                <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 font-mono text-[9px] font-semibold leading-4 tabular-nums text-white/85">{pad2(item.page.index)}</span>
                                                <span className={cn("absolute right-1 top-1 size-2 rounded-full ring-1 ring-black/50", !ready ? "bg-red-400" : pptxReady ? "bg-green-400" : "bg-amber-400")} />
                                            </span>
                                        </button>
                                    );
                                })}
                            </nav>
                        </header>

                        <main className="thin-scrollbar grid min-h-0 flex-1 gap-3 overflow-y-auto px-4 py-3.5 lg:grid-cols-[minmax(0,1fr)_320px] lg:overflow-hidden">
                            <section className="relative flex min-h-[320px] min-w-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black p-2 lg:min-h-0" aria-label="已确认页面大图预览">
                                {loading ? (
                                    <div className="flex flex-col items-center gap-3 text-white/70" role="status">
                                        <LoaderCircle className="size-7 animate-spin" aria-hidden="true" />
                                        <span className="text-sm">正在读取已确认图片</span>
                                    </div>
                                ) : activePage?.previewUrl ? (
                                    <div
                                        key={activePage.page.pageId}
                                        className="relative flex aspect-video h-full max-h-full w-fit max-w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-lg shadow-artwork duration-150 ease-out animate-in fade-in-0 motion-reduce:animate-none"
                                        onClick={() => setLightboxSrc(activePage.previewUrl || null)}
                                    >
                                        <img src={activePage.previewUrl} alt={`第 ${activePage.page.index} 页：${activePage.page.title}（已确认最终版）`} className="size-full object-contain" />
                                        <span className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-black/55 px-2 py-1 font-mono text-xs tabular-nums text-white/75">
                                            {pad2(activePosition + 1)} / {pad2(pages.length)}
                                        </span>
                                    </div>
                                ) : (
                                    <div key={activePage?.page.pageId ?? "empty"} className="flex flex-col items-center gap-3 text-center text-white/70 duration-150 ease-out animate-in fade-in-0 motion-reduce:animate-none">
                                        <ImageOff className="size-10" aria-hidden="true" />
                                        <div>
                                            <div className="text-sm font-semibold text-white/85">暂无可预览的确认页</div>
                                            <div className="mt-1 text-xs">从右侧候选中选定，或返回精修生成</div>
                                        </div>
                                    </div>
                                )}
                            </section>

                            <aside className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto" aria-label="当前页交付状态与候选">
                                {loadError ? (
                                    <div className="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-300" role="alert">
                                        {loadError}
                                    </div>
                                ) : activePage ? (
                                    <>
                                        <div>
                                            <div className="font-mono text-xs font-semibold uppercase tracking-wider tabular-nums text-white/70">
                                                第 {pad2(activePage.page.index)} 页 / 共 {pad2(pages.length)} 页
                                            </div>
                                            <h3 className="mt-2 text-xl font-semibold leading-7 text-white/90">{activePage.page.title}</h3>
                                        </div>

                                        {activePage.issues.length ? (
                                            <section className="rounded-xl border border-red-400/25 bg-red-500/10 p-4" aria-labelledby="ppt-review-issues-title">
                                                <div id="ppt-review-issues-title" className="flex items-center gap-2 text-sm font-semibold text-red-300">
                                                    <CircleAlert className="size-4" aria-hidden="true" />
                                                    本页暂不能交付
                                                </div>
                                                <ul className="mt-3 space-y-1.5 text-sm text-red-200/90">
                                                    {activePage.issues.map((issue) => (
                                                        <li key={issue} className="flex items-start gap-2">
                                                            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-red-400" aria-hidden="true" />
                                                            <span>{issue}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </section>
                                        ) : (
                                            <div className="rounded-xl border border-green-400/25 bg-green-500/10 p-4 text-green-300" role="status">
                                                <div className="flex items-center gap-2 text-sm font-semibold">
                                                    <CheckCircle2 className="size-4" aria-hidden="true" />
                                                    已定稿，图片文件完整
                                                </div>
                                            </div>
                                        )}

                                        {activePage.pptxIssues.length ? (
                                            <section className="rounded-xl border border-amber-300/25 bg-amber-400/10 p-4" aria-labelledby="ppt-review-pptx-issues-title">
                                                <div id="ppt-review-pptx-issues-title" className="flex items-center gap-2 text-sm font-semibold text-amber-200">
                                                    <CircleAlert className="size-4" aria-hidden="true" />
                                                    本页暂不能生成图片版 PPT
                                                </div>
                                                <ul className="mt-3 space-y-1.5 text-sm text-amber-100/90">
                                                    {activePage.pptxIssues.map((issue) => (
                                                        <li key={issue} className="flex items-start gap-2">
                                                            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-300" aria-hidden="true" />
                                                            <span>{issue}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </section>
                                        ) : null}

                                        {activeWorkspace ? (
                                            <section aria-label="全部候选稿">
                                                <div className="mb-1.5 flex items-center justify-between gap-2">
                                                    <span className="text-xs font-semibold text-white/70">全部候选稿（跨方案）</span>
                                                    {activeWorkspace.resolvedConfirmedNodeId ? (
                                                        <button
                                                            type="button"
                                                            className="rounded text-[11px] text-white/70 underline underline-offset-2 hover:text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                                                            onClick={() => cancelConfirm(activePage.page.pageId)}
                                                        >
                                                            取消确认
                                                        </button>
                                                    ) : null}
                                                </div>
                                                {activeWorkspace.takes.some((take) => take.candidates.length) ? (
                                                    <div className="grid grid-cols-3 gap-2">
                                                        {activeWorkspace.takes.flatMap((take) =>
                                                            take.candidates.map((node, versionIndex) => {
                                                                const confirmed = node.id === activeWorkspace.resolvedConfirmedNodeId;
                                                                return (
                                                                    <button
                                                                        key={node.id}
                                                                        type="button"
                                                                        className={cn(
                                                                            "overflow-hidden rounded-lg border border-white/10 bg-white/5 p-1 text-left transition-all duration-150 hover:bg-white/10",
                                                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-cinema)]",
                                                                            confirmed && "ring-2 ring-green-400/80",
                                                                        )}
                                                                        aria-pressed={confirmed}
                                                                        aria-label={`第 ${activePage.page.index} 页，方案 ${take.index + 1}，第 ${versionIndex + 1} 稿${confirmed ? "，已选为最终版" : "，选定为最终版"}`}
                                                                        onClick={() => selectCandidate(activePage.page.pageId, node.id)}
                                                                    >
                                                                        <span className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-black/40">
                                                                            {node.metadata?.content ? <img src={node.metadata.content} alt="" className="size-full object-contain" /> : <ImageOff className="size-4 text-white/30" aria-hidden="true" />}
                                                                        </span>
                                                                        <span className="mt-1 flex items-center gap-1 px-0.5 text-[10px]">
                                                                            {confirmed ? <CheckCircle2 className="size-3 shrink-0 text-green-400" aria-hidden="true" /> : null}
                                                                            <span className="truncate text-white/70">
                                                                                第<span className="font-mono tabular-nums">{activePage.page.index}</span>页 · 方案
                                                                                <span className="font-mono tabular-nums">{take.index + 1}</span> · 第<span className="font-mono tabular-nums">{versionIndex + 1}</span>稿
                                                                            </span>
                                                                        </span>
                                                                    </button>
                                                                );
                                                            }),
                                                        )}
                                                    </div>
                                                ) : (
                                                    <div className="rounded-lg border border-dashed border-white/15 p-3 text-center text-xs text-white/70">这一页还没有候选稿</div>
                                                )}
                                            </section>
                                        ) : null}

                                        <Button ghost icon={<Pencil className="size-4" />} onClick={() => onEditPage(activePage.page.pageId)}>
                                            返回精修第 {activePage.page.index} 页
                                        </Button>
                                    </>
                                ) : loading ? null : (
                                    <div className="rounded-xl border border-white/10 p-4 text-sm text-white/70">当前工程没有可检视的 PPT 页面。</div>
                                )}
                            </aside>
                        </main>

                        <footer className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-white/10 px-4 py-2">
                            <div className="flex items-center gap-2">
                                <Button ghost icon={<ChevronLeft className="size-4" />} disabled={!activePage || activePosition === 0} onClick={() => changePage(activePosition - 1)}>
                                    上一页
                                </Button>
                                <Button ghost icon={<ChevronRight className="size-4" />} iconPosition="end" disabled={!activePage || activePosition >= pages.length - 1} onClick={() => changePage(activePosition + 1)}>
                                    下一页
                                </Button>
                                <span className="ml-1 hidden select-none font-mono text-[10px] text-white/70 sm:inline" aria-hidden="true">
                                    ← → 翻页
                                </span>
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-3">
                                {!loading && !inspection?.ready && problemCount > 0 ? <span className="text-xs text-white/70">还有 {problemCount} 页未定稿</span> : null}
                                {!loading && inspection?.ready && !inspection.pptxReady ? (
                                    <span className="max-w-72 text-right text-xs text-amber-200/90">第 {pptxIssuePages.map((item) => item.page.index).join("、")} 页暂不能生成 PPT，仍可下载 ZIP</span>
                                ) : null}
                                <Button
                                    type="text"
                                    className="hover:!bg-white/10"
                                    style={{ color: "rgba(255,255,255,0.82)" }}
                                    icon={exporting?.kind === "zip" ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
                                    disabled={!inspection?.ready || loading || Boolean(exporting) || !project}
                                    onClick={() => void handleExport("zip")}
                                >
                                    {exporting?.kind === "zip" ? exporting.message : "下载页面图片（ZIP）"}
                                </Button>
                                <div className="flex flex-col items-start gap-0.5">
                                    <Button
                                        type="primary"
                                        icon={exporting?.kind === "pptx" ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
                                        disabled={!inspection?.pptxReady || loading || Boolean(exporting) || !project}
                                        onClick={() => void handleExport("pptx")}
                                    >
                                        {exporting?.kind === "pptx" ? exporting.message : "下载图片版 PPT"}
                                    </Button>
                                    <span className="pl-1 text-[11px] leading-4 text-white/70">每页为整张图片，文字不可编辑</span>
                                </div>
                            </div>
                        </footer>
                    </div>
                </Modal>
            </ConfigProvider>
            <CanvasImageLightbox src={lightboxSrc} alt={activePage ? `第 ${activePage.page.index} 页：${activePage.page.title}` : undefined} onClose={() => setLightboxSrc(null)} />
        </>
    );
}
