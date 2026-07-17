import { useEffect, useMemo, useState } from "react";
import { App, Button, Modal, theme as antdTheme } from "antd";
import { CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Download, ImageOff, LoaderCircle, Pencil, Presentation, RefreshCw } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { exportPptDeckImages, inspectPptDeckExport } from "@/lib/ppt/deck-export";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";

type Inspection = Awaited<ReturnType<typeof inspectPptDeckExport>>;

export function CanvasPptFinalReview({ open, projectId, onClose, onEditPage }: { open: boolean; projectId: string; onClose: () => void; onEditPage: (pageIndex: number) => void }) {
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const canvasTheme = canvasThemes[useThemeStore((state) => state.theme)];
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const [inspection, setInspection] = useState<Inspection | null>(null);
    const [activePageIndex, setActivePageIndex] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        if (!open) return;
        if (!project) {
            setInspection(null);
            setLoadError("找不到当前 PPT 工程");
            setLoading(false);
            return;
        }

        let cancelled = false;
        setInspection(null);
        setLoadError("");
        setLoading(true);
        void inspectPptDeckExport(project)
            .then((result) => {
                if (cancelled) return;
                setInspection(result);
                setActivePageIndex((current) => {
                    if (result.pages.some((item) => item.page.index === current)) return current;
                    return result.pages.find((item) => item.issues.length)?.page.index ?? result.pages[0]?.page.index ?? null;
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
    }, [open, project, refreshKey]);

    const pages = useMemo(() => [...(inspection?.pages ?? [])].sort((left, right) => left.page.index - right.page.index), [inspection]);
    const activePosition = Math.max(
        0,
        pages.findIndex((item) => item.page.index === activePageIndex),
    );
    const activePage = pages[activePosition];
    const problemCount = pages.filter((item) => item.issues.length > 0).length;

    const changePage = (position: number) => {
        const target = pages[position];
        if (target) setActivePageIndex(target.page.index);
    };

    const handleExport = async () => {
        if (!project || !inspection?.ready) return;
        setExporting(true);
        try {
            await exportPptDeckImages(project);
            message.success("PPT 图片已打包下载");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "打包下载失败");
        } finally {
            setExporting(false);
        }
    };

    return (
        <Modal title="PPT 最终检视" classNames={{ header: "sr-only" }} open={open} onCancel={onClose} footer={null} width="min(96vw, 1600px)" centered destroyOnHidden styles={{ body: { padding: 0 } }}>
            <div className="flex h-[min(88vh,920px)] min-h-0 flex-col overflow-hidden" style={{ background: canvasTheme.node.panel, color: canvasTheme.node.text }} data-canvas-no-zoom onKeyDown={(event) => event.stopPropagation()}>
                <header className="flex shrink-0 items-start justify-between gap-4 px-5 pb-4 pr-14 pt-5">
                    <div className="flex min-w-0 items-start gap-3">
                        <div className="grid size-10 shrink-0 place-items-center rounded-lg border" style={{ background: canvasTheme.node.fill, borderColor: canvasTheme.node.stroke }}>
                            <Presentation className="size-5" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-lg font-semibold leading-6">最终检视</h2>
                            <p className="mt-1 text-sm" style={{ color: canvasTheme.node.muted }}>
                                {loading ? "正在检查每页已确认版本…" : inspection?.ready ? `全部 ${pages.length} 页已就绪，可以打包下载` : problemCount ? `还有 ${problemCount} 页需要处理` : "请先完成每页确认"}
                            </p>
                        </div>
                    </div>
                    <Button icon={<RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />} disabled={loading || exporting} onClick={() => setRefreshKey((value) => value + 1)}>
                        重新检查
                    </Button>
                </header>

                <nav className="thin-scrollbar flex shrink-0 gap-2 overflow-x-auto border-y px-5 py-3" style={{ borderColor: canvasTheme.node.stroke }} aria-label="PPT 页面终检导航">
                    {pages.map((item) => {
                        const selected = item.page.index === activePage?.page.index;
                        const ready = item.issues.length === 0;
                        return (
                            <button
                                key={item.page.index}
                                type="button"
                                className="w-40 shrink-0 rounded-lg border p-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2"
                                style={{
                                    background: selected ? canvasTheme.toolbar.activeBg : canvasTheme.node.fill,
                                    borderColor: selected ? canvasTheme.node.activeStroke : ready ? token.colorSuccessBorder : token.colorErrorBorder,
                                    boxShadow: selected ? `0 0 0 1px ${canvasTheme.node.activeStroke}` : undefined,
                                    outlineColor: canvasTheme.node.activeStroke,
                                }}
                                aria-current={selected ? "page" : undefined}
                                aria-label={`第 ${item.page.index} 页，${ready ? "已就绪" : "需要处理"}`}
                                onClick={() => setActivePageIndex(item.page.index)}
                            >
                                <span className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-md" style={{ background: canvasTheme.canvas.background }} aria-hidden="true">
                                    {item.previewUrl ? <img src={item.previewUrl} alt="" className="size-full object-contain" /> : <ImageOff className="size-5" style={{ color: canvasTheme.node.faint }} />}
                                </span>
                                <span className="mt-2 flex min-w-0 items-center gap-1.5">
                                    {ready ? <CheckCircle2 className="size-3.5 shrink-0" style={{ color: token.colorSuccess }} aria-hidden="true" /> : <CircleAlert className="size-3.5 shrink-0" style={{ color: token.colorError }} aria-hidden="true" />}
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-xs font-semibold">第 {item.page.index} 页</span>
                                        <span className="block truncate text-[11px]" style={{ color: canvasTheme.node.muted }}>
                                            {selected ? "正在查看" : ready ? "已就绪" : `${item.issues.length} 项问题`}
                                        </span>
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </nav>

                <main className="thin-scrollbar grid min-h-0 flex-1 gap-4 overflow-y-auto p-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:overflow-hidden">
                    <section className="flex min-h-[320px] min-w-0 items-center justify-center overflow-hidden rounded-xl border p-3 lg:min-h-0" style={{ background: canvasTheme.canvas.background, borderColor: canvasTheme.node.stroke }} aria-label="已确认页面大图预览">
                        {loading ? (
                            <div className="flex flex-col items-center gap-3" role="status" style={{ color: canvasTheme.node.muted }}>
                                <LoaderCircle className="size-7 animate-spin" aria-hidden="true" />
                                <span className="text-sm">正在读取已确认图片</span>
                            </div>
                        ) : activePage?.previewUrl ? (
                            <div className="flex aspect-video max-h-full w-full max-w-full items-center justify-center overflow-hidden rounded-lg lg:h-full lg:w-auto" style={{ background: canvasTheme.node.fill }}>
                                <img src={activePage.previewUrl} alt={`第 ${activePage.page.index} 页：${activePage.page.title}（已确认版本）`} className="size-full object-contain" />
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-3 text-center" style={{ color: canvasTheme.node.muted }}>
                                <ImageOff className="size-10" aria-hidden="true" />
                                <div>
                                    <div className="text-sm font-semibold" style={{ color: canvasTheme.node.text }}>暂无可预览的确认页</div>
                                    <div className="mt-1 text-xs">请返回精修并确认这一页</div>
                                </div>
                            </div>
                        )}
                    </section>

                    <aside className="flex min-h-0 flex-col gap-4 lg:overflow-y-auto" aria-label="当前页交付状态">
                        {loadError ? (
                            <div className="rounded-xl border p-4 text-sm" style={{ background: token.colorErrorBg, borderColor: token.colorErrorBorder, color: token.colorErrorText }} role="alert">
                                {loadError}
                            </div>
                        ) : activePage ? (
                            <>
                                <div>
                                    <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: canvasTheme.node.faint }}>
                                        第 {activePage.page.index} 页 / 共 {pages.length} 页
                                    </div>
                                    <h3 className="mt-2 text-xl font-semibold leading-7">{activePage.page.title}</h3>
                                    <div className="mt-2 text-xs" style={{ color: canvasTheme.node.muted }}>
                                        {activePage.node ? `确认节点：${activePage.node.title}` : "未找到有效的确认节点"}
                                    </div>
                                </div>

                                {activePage.issues.length ? (
                                    <section className="rounded-xl border p-4" style={{ background: token.colorErrorBg, borderColor: token.colorErrorBorder }} aria-labelledby="ppt-review-issues-title">
                                        <div id="ppt-review-issues-title" className="flex items-center gap-2 text-sm font-semibold" style={{ color: token.colorErrorText }}>
                                            <CircleAlert className="size-4" aria-hidden="true" />
                                            本页暂不能交付
                                        </div>
                                        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm" style={{ color: token.colorErrorText }}>
                                            {activePage.issues.map((issue) => (
                                                <li key={issue}>{issue}</li>
                                            ))}
                                        </ul>
                                    </section>
                                ) : (
                                    <div className="rounded-xl border p-4" style={{ background: token.colorSuccessBg, borderColor: token.colorSuccessBorder, color: token.colorSuccessText }} role="status">
                                        <div className="flex items-center gap-2 text-sm font-semibold">
                                            <CheckCircle2 className="size-4" aria-hidden="true" />
                                            已确认，图片文件完整
                                        </div>
                                    </div>
                                )}

                                <Button icon={<Pencil className="size-4" />} onClick={() => onEditPage(activePage.page.index)}>
                                    返回精修第 {activePage.page.index} 页
                                </Button>
                            </>
                        ) : loading ? null : (
                            <div className="rounded-xl border p-4 text-sm" style={{ borderColor: canvasTheme.node.stroke, color: canvasTheme.node.muted }}>
                                当前工程没有可检视的 PPT 页面。
                            </div>
                        )}
                    </aside>
                </main>

                <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-4" style={{ borderColor: canvasTheme.node.stroke }}>
                    <div className="flex items-center gap-2">
                        <Button icon={<ChevronLeft className="size-4" />} disabled={!activePage || activePosition === 0} onClick={() => changePage(activePosition - 1)}>
                            上一页
                        </Button>
                        <Button icon={<ChevronRight className="size-4" />} iconPosition="end" disabled={!activePage || activePosition >= pages.length - 1} onClick={() => changePage(activePosition + 1)}>
                            下一页
                        </Button>
                    </div>
                    <Button
                        type="primary"
                        icon={exporting ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
                        disabled={!inspection?.ready || loading || exporting || !project}
                        onClick={() => void handleExport()}
                    >
                        {exporting ? "正在打包" : "打包下载"}
                    </Button>
                </footer>
            </div>
        </Modal>
    );
}
