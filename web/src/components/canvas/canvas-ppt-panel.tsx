import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { App, Button, Checkbox, Tooltip, theme as antdTheme } from "antd";
import { CheckCircle2, ChevronRight, CircleAlert, ImageOff, Layers, LoaderCircle, Presentation, Sparkles, X } from "lucide-react";

import { CanvasPptFinalReview } from "@/components/canvas/canvas-ppt-final-review";
import { CanvasPptPageWorkspace } from "@/components/canvas/canvas-ppt-page-workspace";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { PPT_PAGE_PROMPT } from "@/lib/ppt/deck-builder";
import { resolvePageImageNode } from "@/lib/ppt/deck-export";
import { buildPptPageWorkspace, type PptPageWorkspace } from "@/lib/ppt/page-workspace";
import { pageTakes, useCanvasStore, type CanvasProject, type CanvasProjectPptPage } from "@/stores/canvas/use-canvas-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasPptPanel() {
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const params = useParams<{ id: string }>();
    const projectId = params.id || "";
    const canvasTheme = canvasThemes[useThemeStore((state) => state.theme)];
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const updateProject = useCanvasStore((state) => state.updateProject);
    const canvasContext = useAgentStore((state) => state.canvasContext);
    const [panelOpen, setPanelOpen] = useState(true);
    const [surface, setSurface] = useState<"workbench" | "structure">("workbench");
    const [skipAnchorOverride, setSkipAnchorOverride] = useState<boolean | null>(null);
    const [focusPageIndex, setFocusPageIndex] = useState<number | null>(null);
    const [finalReviewOpen, setFinalReviewOpen] = useState(false);

    useEffect(() => {
        setPanelOpen(true);
        setSurface("workbench");
        setSkipAnchorOverride(null);
        setFocusPageIndex(null);
        setFinalReviewOpen(false);
    }, [projectId]);

    const nodeById = useMemo(() => new Map((currentProject?.nodes || []).map((node) => [node.id, node])), [currentProject?.nodes]);
    const pageWorkspaces = useMemo(() => {
        if (!currentProject?.ppt) return [];
        return [...currentProject.ppt.pages]
            .sort((left, right) => left.index - right.index)
            .map((page) => buildPptPageWorkspace(currentProject, page));
    }, [currentProject]);

    const ppt = currentProject?.ppt;
    if (!ppt || !currentProject) return null;

    const pages = ppt.pages;
    const isExtractMode = ppt.mode === "extract";
    const styleNodeIds = currentProject.nodes.filter((node) => node.metadata?.pptRole === "style").map((node) => node.id);
    const skipAnchor = skipAnchorOverride ?? (isExtractMode && styleNodeIds.length === 0);
    const confirmedCount = pageWorkspaces.filter((item) => item.confirmationIssues.length === 0).length;
    const firstPageIndex = pageWorkspaces[0]?.page.index ?? pages[0]?.index ?? 1;
    const activePageIndex = focusPageIndex != null && pageWorkspaces.some((item) => item.page.index === focusPageIndex) ? focusPageIndex : firstPageIndex;

    const buildRunGenerationOp = (configNodeId: string): CanvasAgentOp =>
        isExtractMode
            ? { type: "run_generation", nodeId: configNodeId, mode: "image" }
            : { type: "run_generation", nodeId: configNodeId, mode: "image", prompt: PPT_PAGE_PROMPT };

    const runGeneration = (page: CanvasProjectPptPage) => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        const configNodeId = pageTakes(page).at(-1)?.configNodeId;
        if (!configNodeId || !nodeById.has(configNodeId)) {
            message.warning(`第 ${page.index} 页结构缺失，请先新建方案分支`);
            return;
        }
        canvasContext.applyOps([buildRunGenerationOp(configNodeId)]);
    };

    const generateAll = (targetPages: CanvasProjectPptPage[]) => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        const ops = targetPages
            .map((page) => pageTakes(page).at(-1)?.configNodeId)
            .filter((configNodeId): configNodeId is string => configNodeId != null && nodeById.has(configNodeId))
            .map((configNodeId) => buildRunGenerationOp(configNodeId));
        if (!ops.length) {
            message.warning("没有可生成的页面");
            return;
        }
        canvasContext.applyOps(ops);
    };

    const firstPage = pages.find((page) => page.index === 1) || pages[0];
    const firstWorkspace = pageWorkspaces.find((item) => item.page.index === firstPage?.index);
    const firstConfirmed = Boolean(firstWorkspace && firstWorkspace.confirmationIssues.length === 0);
    const anchorPending = !skipAnchor && pages.length > 1 && !ppt.anchorConfirmed;

    const confirmAnchorAndGenerateRest = () => {
        if (!canvasContext || !firstPage?.confirmedNodeId) return;
        const restConfigNodeIds = pages
            .filter((page) => page.index !== firstPage.index)
            .map((page) => pageTakes(page).at(-1)?.configNodeId)
            .filter((configNodeId): configNodeId is string => configNodeId != null && nodeById.has(configNodeId));
        if (!restConfigNodeIds.length) return;
        const ops: CanvasAgentOp[] = [
            ...restConfigNodeIds.map((configNodeId): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId: firstPage.confirmedNodeId!, toNodeId: configNodeId })),
            ...restConfigNodeIds.map((configNodeId) => buildRunGenerationOp(configNodeId)),
        ];
        canvasContext.applyOps(ops);
        updateProject(projectId, { ppt: { ...ppt, anchorConfirmed: true } });
    };

    const showStructure = (nodeId?: string) => {
        setPanelOpen(true);
        setSurface("structure");
        const node = nodeId ? nodeById.get(nodeId) : undefined;
        if (!canvasContext || !node) return;
        const scale = canvasContext.snapshot.viewport?.k || 1;
        // [二开] 上游 v0.9 引入可调宽/收起的左侧面板，main 已不等于画布可视区；
        // 改读 project.tsx 画布 section 上标记的 data-canvas-viewport。
        const containerRect = document.querySelector("[data-canvas-viewport]")?.getBoundingClientRect();
        const panelWidth = 392;
        const width = Math.max((containerRect?.width || window.innerWidth) - panelWidth, 320);
        const height = containerRect?.height || window.innerHeight;
        canvasContext.applyOps([
            {
                type: "set_viewport",
                viewport: {
                    x: width / 2 - scale * (node.position.x + node.width / 2),
                    y: height / 2 - scale * (node.position.y + node.height / 2),
                    k: scale,
                },
            },
            { type: "select_nodes", ids: [node.id] },
        ]);
    };

    const showWorkbench = () => {
        const selectedNodeId = canvasContext?.snapshot.selectedNodeIds.at(-1);
        const selectedPage = selectedNodeId
            ? pageWorkspaces.find((item) =>
                  item.takes.some((take) => {
                      if (take.anchorNode?.id === selectedNodeId || take.configNode?.id === selectedNodeId) return true;
                      return take.candidates.some((candidate) => candidate.id === selectedNodeId);
                  }),
              )
            : undefined;
        if (selectedPage) setFocusPageIndex(selectedPage.page.index);
        setSurface("workbench");
    };

    let batchLabel = "全部生成";
    let batchAction = () => generateAll(pages);
    if (anchorPending && firstPage) {
        if (!firstConfirmed) {
            batchLabel = "生成第 1 页（锚定）";
            batchAction = () => runGeneration(firstPage);
        } else {
            batchLabel = "确认后生成其余页";
            batchAction = confirmAnchorAndGenerateRest;
        }
    }

    return (
        <>
            {surface === "structure" ? (
                panelOpen ? (
                    <aside
                        className="absolute right-4 top-20 z-40 flex max-h-[calc(100%-140px)] w-[360px] flex-col overflow-hidden rounded-xl border shadow-2xl backdrop-blur"
                        style={{ background: canvasTheme.toolbar.panel, borderColor: canvasTheme.toolbar.border, color: canvasTheme.node.text }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label="PPT 结构画布导航"
                    >
                        <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5" style={{ borderColor: canvasTheme.toolbar.border }}>
                            <div className="flex min-w-0 items-center gap-2">
                                <Layers className="size-4 shrink-0" aria-hidden="true" />
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold">结构画布</div>
                                    <div className="truncate text-[11px]" style={{ color: canvasTheme.node.muted }}>节点与连线 · {confirmedCount}/{pages.length} 页已确认</div>
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                <Button size="small" type="text" icon={<Presentation className="size-3.5" />} onClick={showWorkbench}>返回工作台</Button>
                                <button type="button" className="grid size-7 place-items-center rounded-md" style={{ color: canvasTheme.node.muted }} onClick={() => setPanelOpen(false)} aria-label="收起 PPT 结构面板">
                                    <X className="size-4" aria-hidden="true" />
                                </button>
                            </div>
                        </header>

                        <div className="flex items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: canvasTheme.toolbar.border }}>
                            <Checkbox checked={!skipAnchor} disabled={pages.length <= 1} onChange={(event) => setSkipAnchorOverride(!event.target.checked)}>
                                <span className="text-xs" style={{ color: canvasTheme.node.muted }}>首页锚定</span>
                            </Checkbox>
                            <Button size="small" type="primary" icon={<Sparkles className="size-3.5" />} disabled={!canvasContext} onClick={batchAction}>{batchLabel}</Button>
                        </div>

                        <div className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                            {pageWorkspaces.map((workspace) => (
                                <PptPageRow
                                    key={workspace.page.index}
                                    workspace={workspace}
                                    project={currentProject}
                                    canvasTheme={canvasTheme}
                                    successColor={token.colorSuccess}
                                    errorColor={token.colorError}
                                    onOpen={() => {
                                        setFocusPageIndex(workspace.page.index);
                                        setSurface("workbench");
                                    }}
                                />
                            ))}
                        </div>

                        <footer className="border-t px-3 py-2.5" style={{ borderColor: canvasTheme.toolbar.border }}>
                            <Button block icon={<Presentation className="size-3.5" />} onClick={() => setFinalReviewOpen(true)}>最终检视</Button>
                        </footer>
                    </aside>
                ) : (
                    <Tooltip title="展开 PPT 结构面板" placement="left">
                        <button
                            type="button"
                            className="absolute right-4 top-20 z-40 grid size-10 place-items-center rounded-full border shadow-lg backdrop-blur transition hover:scale-105"
                            style={{ background: canvasTheme.toolbar.panel, borderColor: canvasTheme.toolbar.border, color: canvasTheme.node.text }}
                            onClick={() => setPanelOpen(true)}
                            aria-label="展开 PPT 结构面板"
                        >
                            <Layers className="size-4" aria-hidden="true" />
                        </button>
                    </Tooltip>
                )
            ) : null}

            <CanvasPptPageWorkspace
                key={projectId}
                open={surface === "workbench"}
                projectId={projectId}
                pageIndex={activePageIndex}
                onPageChange={setFocusPageIndex}
                controls={{
                    anchorEnabled: !skipAnchor,
                    anchorDisabled: pages.length <= 1,
                    batchLabel,
                    batchDisabled: !canvasContext,
                    onAnchorEnabledChange: (enabled) => setSkipAnchorOverride(!enabled),
                    onBatchAction: batchAction,
                    onOpenFinalReview: () => setFinalReviewOpen(true),
                    onShowCanvas: showStructure,
                }}
            />
            <CanvasPptFinalReview
                open={finalReviewOpen}
                projectId={projectId}
                onClose={() => setFinalReviewOpen(false)}
                onEditPage={(pageIndex) => {
                    setFinalReviewOpen(false);
                    setFocusPageIndex(pageIndex);
                    setSurface("workbench");
                }}
            />
        </>
    );
}

function PptPageRow({
    workspace,
    project,
    canvasTheme,
    successColor,
    errorColor,
    onOpen,
}: {
    workspace: PptPageWorkspace;
    project: CanvasProject;
    canvasTheme: (typeof canvasThemes)[keyof typeof canvasThemes];
    successColor: string;
    errorColor: string;
    onOpen: () => void;
}) {
    const { page, takes, confirmationIssues } = workspace;
    const imageNode = resolvePageImageNode(project, page);
    const candidateCount = takes.reduce((total, take) => total + take.candidates.length, 0);
    const generating = takes.some((take) => take.generating);
    const confirmed = confirmationIssues.length === 0;

    return (
        <button
            type="button"
            className="flex w-full gap-3 rounded-lg border p-2 text-left transition hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ borderColor: confirmed ? successColor : canvasTheme.node.stroke, outlineColor: canvasTheme.node.activeStroke }}
            onClick={onOpen}
            aria-label={`精修第 ${page.index} 页，${confirmed ? "已确认" : "待确认"}`}
        >
            <span className="flex h-[68px] w-[120px] shrink-0 items-center justify-center overflow-hidden rounded-md" style={{ background: canvasTheme.node.fill }} aria-hidden="true">
                {imageNode?.metadata?.content ? <img src={imageNode.metadata.content} alt="" className="size-full object-contain" /> : generating ? <LoaderCircle className="size-5 animate-spin" style={{ color: canvasTheme.node.muted }} /> : <ImageOff className="size-5" style={{ color: canvasTheme.node.faint }} />}
            </span>
            <span className="min-w-0 flex-1 py-0.5">
                <span className="flex items-center gap-1.5">
                    {confirmed ? <CheckCircle2 className="size-3.5 shrink-0" style={{ color: successColor }} aria-hidden="true" /> : confirmationIssues.some((issue) => !issue.includes("尚未确认")) ? <CircleAlert className="size-3.5 shrink-0" style={{ color: errorColor }} aria-hidden="true" /> : null}
                    <span className="shrink-0 text-[11px] font-medium" style={{ color: canvasTheme.node.muted }}>
                        第{page.index}页
                    </span>
                    <span className="truncate text-sm font-semibold">{page.title}</span>
                </span>
                <span className="mt-1.5 block text-xs" style={{ color: canvasTheme.node.muted }}>
                    {takes.length} 个方案分支 · {candidateCount} 个候选稿
                </span>
                <span className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                    <span style={{ color: confirmed ? successColor : canvasTheme.node.muted }}>{generating ? "生成中" : confirmed ? "已选最终版" : candidateCount ? "待确认" : "未生成"}</span>
                    <span className="flex items-center gap-1 font-medium">
                        进入精修 <ChevronRight className="size-3" aria-hidden="true" />
                    </span>
                </span>
            </span>
        </button>
    );
}
