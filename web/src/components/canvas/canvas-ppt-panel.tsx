import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { App, Button, Modal, Radio, Tooltip, Typography, theme as antdTheme } from "antd";
import { CheckCircle2, ChevronRight, CircleAlert, ImageOff, Layers, LoaderCircle, Presentation, RotateCcw, Sparkles, X } from "lucide-react";

import { CanvasPptFinalReview } from "@/components/canvas/canvas-ppt-final-review";
import { planHasBlockingCompilationIssues, PptGenerationPlanSummary } from "@/components/canvas/canvas-ppt-generation-confirm";
import { CanvasPptPageWorkspace } from "@/components/canvas/canvas-ppt-page-workspace";
import { canvasThemes } from "@/lib/canvas-theme";
import { resolvePageImageNode } from "@/lib/ppt/deck-export";
import type { PptGenerationModule } from "@/lib/ppt/generation-execution";
import { createGenerationPlan, type GenerationPlan } from "@/lib/ppt/generation-plan";
import { buildPptPageWorkspace, type PptPageWorkspace } from "@/lib/ppt/page-workspace";
import { flushCanvasStore, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

// #11：面板实际宽度（w-[360px]）与外层安全间距同源，消除 :169 与 showStructure 计算的双源魔法数字。
const PANEL_WIDTH = 360;
const PANEL_GAP = 16; // 对应 tailwind `right-4`
const PANEL_SAFE_WIDTH = PANEL_WIDTH + PANEL_GAP * 2;

type BatchState = { kind: "start" } | { kind: "waitingFirst" } | { kind: "confirmRest"; count: number } | { kind: "hidden" };

function isPageUntouched(workspace: PptPageWorkspace) {
    return !workspace.takes.some((take) => take.candidates.length > 0 || take.generating || take.unresolvedGeneration);
}

export function CanvasPptPanel({ generationModule }: { generationModule: PptGenerationModule }) {
    const { message, modal } = App.useApp();
    const { token } = antdTheme.useToken();
    const params = useParams<{ id: string }>();
    const [searchParams] = useSearchParams();
    const projectId = params.id || "";
    const canvasTheme = canvasThemes[useThemeStore((state) => state.theme)];
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const updateProject = useCanvasStore((state) => state.updateProject);
    const canvasContext = useAgentStore((state) => state.canvasContext);
    const effectiveConfig = useEffectiveConfig();
    const setPptOverlayOpen = useCanvasUiStore((state) => state.setPptOverlayOpen);
    const [panelOpen, setPanelOpen] = useState(true);
    const [surface, setSurface] = useState<"workbench" | "structure">("workbench");
    const [focusPageId, setFocusPageId] = useState<string | null>(null);
    const [focusTakeId, setFocusTakeId] = useState<string | null>(null);
    const [finalReviewOpen, setFinalReviewOpen] = useState(false);
    const [startModalOpen, setStartModalOpen] = useState(false);
    const [restModalOpen, setRestModalOpen] = useState(false);
    const [anchorFirst, setAnchorFirst] = useState(false);
    const [pendingBatchPlan, setPendingBatchPlan] = useState<GenerationPlan>();
    const [pendingRepeatBillingRiskCount, setPendingRepeatBillingRiskCount] = useState(0);
    const [batchStarting, setBatchStarting] = useState(false);
    const notificationTokenRef = useRef<string | null>(null);

    useEffect(() => {
        setPanelOpen(true);
        setSurface("workbench");
        setFocusPageId(null);
        setFocusTakeId(null);
        setFinalReviewOpen(false);
        setStartModalOpen(false);
        setRestModalOpen(false);
        setAnchorFirst(false);
        setPendingBatchPlan(undefined);
        setPendingRepeatBillingRiskCount(0);
        setBatchStarting(false);
        notificationTokenRef.current = null;
    }, [projectId]);

    // #34：精修台/最终检视打开期间，画布节点悬浮工具条不得渲染（数据安全，避免误点删除底层节点）。
    // 用 useLayoutEffect 而非 useEffect：跨组件写 store 必须在浏览器绘制前完成，否则 surface 切到
    // workbench 的这一帧，project.tsx 读到的 pptOverlayOpen 仍是旧值，悬浮工具条会先画出来再被收回。
    useLayoutEffect(() => {
        const overlayOpen = Boolean(currentProject?.ppt) && (surface === "workbench" || finalReviewOpen);
        setPptOverlayOpen(overlayOpen);
        return () => setPptOverlayOpen(false);
    }, [currentProject?.ppt, surface, finalReviewOpen, setPptOverlayOpen]);

    const nodeById = useMemo(() => new Map((currentProject?.nodes || []).map((node) => [node.id, node])), [currentProject?.nodes]);
    const pageWorkspaces = useMemo(() => {
        if (!currentProject?.ppt) return [];
        return [...currentProject.ppt.pages].sort((left, right) => left.index - right.index).map((page) => buildPptPageWorkspace(currentProject, page));
    }, [currentProject]);
    const notifiedPageId = searchParams.get("pptPage");
    const notifiedTakeId = searchParams.get("pptTake");
    const notificationToken = [searchParams.get("pptRun"), searchParams.get("pptStatus")].filter(Boolean).join(":");
    useEffect(() => {
        if (!notifiedPageId || !notificationToken || notificationTokenRef.current === notificationToken) return;
        const workspace = pageWorkspaces.find((item) => item.page.pageId === notifiedPageId);
        if (!workspace) return;
        notificationTokenRef.current = notificationToken;
        setPanelOpen(true);
        setFocusPageId(notifiedPageId);
        setFocusTakeId(workspace.takes.some((take) => take.takeId === notifiedTakeId) ? notifiedTakeId : null);
        setSurface("workbench");
        setFinalReviewOpen(false);
    }, [notificationToken, notifiedPageId, notifiedTakeId, pageWorkspaces]);
    const restPlanPreview = useMemo(() => (currentProject ? createGenerationPlan({ kind: "generateRest" }, { project: currentProject, effectiveConfig }) : undefined), [currentProject, effectiveConfig]);
    const repeatBillingRiskCount = (plan?: GenerationPlan) =>
        plan?.runs.filter((run) => pageWorkspaces.find((workspace) => workspace.page.pageId === run.pageId)?.takes.find((take) => take.takeId === run.takeId)?.requiresRepeatBillingConfirmation).length || 0;

    const ppt = currentProject?.ppt;
    if (!ppt || !currentProject) return null;

    const pages = ppt.pages;
    const styleNodeIds = currentProject.nodes.filter((node) => node.metadata?.pptRole === "style").map((node) => node.id);
    const hasStyleNode = styleNodeIds.length > 0;
    // #18：skipAnchor 改为写回 ppt 数据的持久默认，不再靠面板内勾选框临时覆盖。
    const skipAnchor = ppt.skipAnchor ?? !hasStyleNode;
    const confirmedCount = pageWorkspaces.filter((item) => item.confirmationIssues.length === 0).length;
    const generatingCount = pageWorkspaces.filter((item) => item.takes.some((take) => take.generating)).length;
    const firstPageId = pageWorkspaces[0]?.page.pageId ?? pages[0]?.pageId ?? "";
    const activePageId = focusPageId && pageWorkspaces.some((item) => item.page.pageId === focusPageId) ? focusPageId : firstPageId;

    const executePlan = async (plan: GenerationPlan) => {
        if (!plan.pageCount) {
            message.warning("没有可生成的页面");
            return false;
        }
        if (planHasBlockingCompilationIssues(plan)) {
            message.warning("最终提示词仍有必须处理的问题，请展开检查后再生成");
            return false;
        }
        try {
            const result = await generationModule.start(plan);
            void result.settled.catch((error) => message.error(error instanceof Error ? error.message : "生成状态保存失败"));
            return true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "PPT 生成启动失败");
            return false;
        }
    };

    const firstPage = pageWorkspaces[0]?.page ?? pages[0];
    const firstWorkspace = pageWorkspaces.find((item) => item.page.pageId === firstPage?.pageId);
    const firstConfirmed = Boolean(firstWorkspace && firstWorkspace.confirmationIssues.length === 0);
    const nothingGenerated = pageWorkspaces.length > 0 && pageWorkspaces.every(isPageUntouched);
    // 首页单独排除只在「锚定流程」下有意义（首页已确认，天然不在未生成集合里）；skipAnchor=true 时不应
    // 无条件排除首页——否则用户若先手动生成过某一其他页，首页会被永久挡在批量「生成其余」之外。
    const restUntouchedWorkspaces = pageWorkspaces.filter((item) => (skipAnchor || item.page.pageId !== firstPage?.pageId) && isPageUntouched(item));
    // #3+#26：批量按钮四态状态机，替换旧的「anchorPending 二态」实现，杜绝首页候选未确认时仍可重复触发生成。
    let batchState: BatchState = { kind: "hidden" };
    if (pages.length > 1) {
        if (nothingGenerated) batchState = { kind: "start" };
        else if (!skipAnchor && !ppt.anchorConfirmed && !firstConfirmed) batchState = { kind: "waitingFirst" };
        else if (restUntouchedWorkspaces.length) batchState = { kind: "confirmRest", count: restPlanPreview?.pageCount ?? 0 };
    }

    const batchLabel = batchState.kind === "start" ? "开始生成" : batchState.kind === "waitingFirst" ? "等待确认首页" : batchState.kind === "confirmRest" ? `生成其余 ${batchState.count} 页` : "";
    const batchHidden = batchState.kind === "hidden";
    const batchDisabled = !canvasContext || batchState.kind === "waitingFirst";
    // #4：精修台头部按钮只在「锚定流程相关」的前两态出现；confirmRest 阶段收敛到结构面板，避免头部与
    // 结构面板双入口并存。结构面板自身仍按 batchHidden 展示全部三个非隐藏态。
    const workspaceBatchHidden = batchHidden || batchState.kind === "confirmRest";

    const openBatchModal = () => {
        if (batchState.kind === "start") {
            const nextAnchorFirst = hasStyleNode;
            const plan = createGenerationPlan({ kind: "startBatch", anchorFirst: nextAnchorFirst }, { project: currentProject, effectiveConfig });
            setAnchorFirst(nextAnchorFirst);
            setPendingBatchPlan(plan);
            setPendingRepeatBillingRiskCount(repeatBillingRiskCount(plan));
            setStartModalOpen(true);
        } else if (batchState.kind === "confirmRest") {
            const plan = createGenerationPlan({ kind: "generateRest" }, { project: currentProject, effectiveConfig });
            setPendingBatchPlan(plan);
            setPendingRepeatBillingRiskCount(repeatBillingRiskCount(plan));
            setRestModalOpen(true);
        }
    };

    const confirmStart = async () => {
        if (!pendingBatchPlan || batchStarting) return;
        setBatchStarting(true);
        try {
            if (!(await executePlan(pendingBatchPlan))) return;
            setStartModalOpen(false);
            setPendingBatchPlan(undefined);
        } finally {
            setBatchStarting(false);
        }
    };

    const confirmRest = async () => {
        if (!pendingBatchPlan || batchStarting) return;
        setBatchStarting(true);
        try {
            if (!(await executePlan(pendingBatchPlan))) return;
            setRestModalOpen(false);
            setPendingBatchPlan(undefined);
        } finally {
            setBatchStarting(false);
        }
    };

    const changeAnchorFirst = (value: boolean) => {
        if (batchStarting) return;
        const plan = createGenerationPlan({ kind: "startBatch", anchorFirst: value }, { project: currentProject, effectiveConfig });
        setAnchorFirst(value);
        setPendingBatchPlan(plan);
        setPendingRepeatBillingRiskCount(repeatBillingRiskCount(plan));
    };

    const closeBatchModal = (kind: "start" | "rest") => {
        if (batchStarting) return;
        if (kind === "start") setStartModalOpen(false);
        else setRestModalOpen(false);
        setPendingBatchPlan(undefined);
        setPendingRepeatBillingRiskCount(0);
    };

    const reanchor = () => {
        modal.confirm({
            title: "重新锚定？",
            content: "回到先确认首页再批量的流程，不会删除已生成的内容。",
            okText: "重新锚定",
            cancelText: "取消",
            onOk: async () => {
                updateProject(projectId, { ppt: { ...ppt, anchorConfirmed: false } });
                try {
                    await flushCanvasStore();
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "流程状态保存失败");
                }
            },
        });
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
        const width = Math.max((containerRect?.width || window.innerWidth) - PANEL_SAFE_WIDTH, 320);
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
        if (selectedPage) setFocusPageId(selectedPage.page.pageId);
        setSurface("workbench");
    };

    return (
        <>
            {surface === "structure" ? (
                panelOpen ? (
                    <aside
                        className="absolute right-4 top-20 z-40 flex max-h-[calc(100%-140px)] flex-col overflow-hidden rounded-xl border shadow-2xl backdrop-blur"
                        style={{ width: PANEL_WIDTH, background: canvasTheme.toolbar.panel, borderColor: canvasTheme.toolbar.border, color: canvasTheme.node.text }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label="PPT 结构画布导航"
                    >
                        <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5" style={{ borderColor: canvasTheme.toolbar.border }}>
                            <div className="flex min-w-0 items-center gap-2">
                                <Layers className="size-4 shrink-0" aria-hidden="true" />
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold">结构画布</div>
                                    <div className="truncate text-[11px]" style={{ color: canvasTheme.node.muted }}>
                                        节点与连线 ·{" "}
                                        <span className="font-mono tabular-nums">
                                            {confirmedCount}/{pages.length}
                                        </span>{" "}
                                        页已确认
                                        {generatingCount > 0 ? (
                                            <>
                                                {" · "}
                                                <span className="font-mono tabular-nums">{generatingCount}</span> 页生成中
                                            </>
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                <Button size="small" type="text" icon={<Presentation className="size-3.5" />} onClick={showWorkbench}>
                                    返回工作台
                                </Button>
                                <button
                                    type="button"
                                    className="grid size-7 place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
                                    style={{ color: canvasTheme.node.muted, outlineColor: canvasTheme.node.activeStroke }}
                                    onClick={() => setPanelOpen(false)}
                                    aria-label="收起 PPT 结构面板"
                                >
                                    <X className="size-4" aria-hidden="true" />
                                </button>
                            </div>
                        </header>

                        <div className="flex items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: canvasTheme.toolbar.border }}>
                            <div className="min-h-[20px]">
                                {ppt.anchorConfirmed ? (
                                    <button type="button" className="flex items-center gap-1 text-[11px] underline underline-offset-2" style={{ color: canvasTheme.node.muted }} onClick={reanchor}>
                                        <RotateCcw className="size-3" aria-hidden="true" />
                                        重新锚定
                                    </button>
                                ) : null}
                            </div>
                            {!batchHidden ? (
                                <Button size="small" type="primary" icon={<Sparkles className="size-3.5" />} disabled={batchDisabled} onClick={openBatchModal}>
                                    {batchLabel}
                                </Button>
                            ) : null}
                        </div>

                        <div className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                            {pageWorkspaces.map((workspace) => (
                                <PptPageRow
                                    key={workspace.page.pageId}
                                    workspace={workspace}
                                    project={currentProject}
                                    canvasTheme={canvasTheme}
                                    successColor={token.colorSuccess}
                                    errorColor={token.colorError}
                                    onOpen={() => {
                                        setFocusPageId(workspace.page.pageId);
                                        setSurface("workbench");
                                    }}
                                />
                            ))}
                        </div>

                        <footer className="border-t px-3 py-2.5" style={{ borderColor: canvasTheme.toolbar.border }}>
                            <Button block icon={<Presentation className="size-3.5" />} onClick={() => setFinalReviewOpen(true)}>
                                最终检视
                            </Button>
                        </footer>
                    </aside>
                ) : (
                    <Tooltip title="展开 PPT 结构面板" placement="left">
                        <button
                            type="button"
                            className="absolute right-4 top-20 z-40 grid size-10 place-items-center rounded-full border shadow-lg backdrop-blur transition hover:scale-105 motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{ background: canvasTheme.toolbar.panel, borderColor: canvasTheme.toolbar.border, color: canvasTheme.node.text, outlineColor: canvasTheme.node.activeStroke }}
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
                pageId={activePageId}
                targetTakeId={focusTakeId || undefined}
                generationModule={generationModule}
                onPageChange={setFocusPageId}
                onTargetTakeApplied={() => setFocusTakeId(null)}
                controls={{
                    batchLabel,
                    batchDisabled,
                    batchHidden: workspaceBatchHidden,
                    onBatchAction: openBatchModal,
                    onOpenFinalReview: () => setFinalReviewOpen(true),
                    onShowCanvas: showStructure,
                }}
            />
            <CanvasPptFinalReview
                open={finalReviewOpen}
                projectId={projectId}
                onClose={() => setFinalReviewOpen(false)}
                onEditPage={(pageId) => {
                    setFinalReviewOpen(false);
                    setFocusPageId(pageId);
                    setSurface("workbench");
                }}
            />

            <BatchConfirmModal
                open={startModalOpen}
                anchorFirst={anchorFirst}
                plan={pendingBatchPlan}
                repeatBillingRiskCount={pendingRepeatBillingRiskCount}
                starting={batchStarting}
                onAnchorFirstChange={changeAnchorFirst}
                onCancel={() => closeBatchModal("start")}
                onConfirm={confirmStart}
            />
            <Modal
                open={restModalOpen}
                onCancel={() => closeBatchModal("rest")}
                onOk={confirmRest}
                title={`生成其余 ${pendingBatchPlan?.pageCount ?? 0} 页？`}
                okText="生成"
                confirmLoading={batchStarting}
                closable={!batchStarting}
                maskClosable={!batchStarting}
                keyboard={!batchStarting}
                cancelButtonProps={{ disabled: batchStarting }}
                okButtonProps={{ disabled: batchStarting || !pendingBatchPlan?.pageCount || planHasBlockingCompilationIssues(pendingBatchPlan) }}
                cancelText="取消"
                destroyOnHidden
            >
                {pendingBatchPlan ? <PptGenerationPlanSummary plan={pendingBatchPlan} repeatBillingRiskCount={pendingRepeatBillingRiskCount} /> : null}
            </Modal>
        </>
    );
}

function BatchConfirmModal({
    open,
    anchorFirst,
    plan,
    repeatBillingRiskCount,
    starting,
    onAnchorFirstChange,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    anchorFirst: boolean;
    plan?: GenerationPlan;
    repeatBillingRiskCount: number;
    starting: boolean;
    onAnchorFirstChange: (value: boolean) => void;
    onCancel: () => void;
    onConfirm: () => void | Promise<void>;
}) {
    return (
        <Modal
            open={open}
            onCancel={onCancel}
            onOk={onConfirm}
            confirmLoading={starting}
            closable={!starting}
            maskClosable={!starting}
            keyboard={!starting}
            title={`开始生成 ${plan?.pageCount ?? 0} 页？`}
            okText={anchorFirst ? "生成第 1 页" : `生成全部 ${plan?.pageCount ?? 0} 页`}
            cancelButtonProps={{ disabled: starting }}
            okButtonProps={{ disabled: starting || !plan?.pageCount || planHasBlockingCompilationIssues(plan) }}
            cancelText="取消"
            destroyOnHidden
        >
            <Radio.Group className="flex flex-col gap-3" value={anchorFirst} disabled={starting} onChange={(event) => onAnchorFirstChange(event.target.value)}>
                <Radio value={true}>
                    <div className="text-sm font-medium">先生成第 1 页，确认风格后再批量</div>
                    <Typography.Text type="secondary" className="text-xs">
                        推荐，确认首页效果后再生成其余页面
                    </Typography.Text>
                </Radio>
                <Radio value={false}>
                    <div className="text-sm font-medium">直接生成全部可执行页面</div>
                    <Typography.Text type="secondary" className="text-xs">
                        各页按当前方案的模型、比例与张数执行
                    </Typography.Text>
                </Radio>
            </Radio.Group>
            {plan ? <PptGenerationPlanSummary plan={plan} repeatBillingRiskCount={repeatBillingRiskCount} /> : null}
        </Modal>
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
            className="flex w-full gap-3 rounded-lg border p-2 text-left transition hover:-translate-y-px motion-reduce:transition-none motion-reduce:hover:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ borderColor: confirmed ? successColor : canvasTheme.node.stroke, outlineColor: canvasTheme.node.activeStroke }}
            onClick={onOpen}
            aria-label={`精修第 ${page.index} 页，${confirmed ? "已确认" : "待确认"}`}
        >
            <span className="flex h-[68px] w-[120px] shrink-0 items-center justify-center overflow-hidden rounded-md" style={{ background: canvasTheme.node.fill }} aria-hidden="true">
                {imageNode?.metadata?.content ? (
                    <img src={imageNode.metadata.content} alt="" className="size-full object-contain" />
                ) : generating ? (
                    <LoaderCircle className="size-5 animate-spin" style={{ color: canvasTheme.node.muted }} />
                ) : (
                    <ImageOff className="size-5" style={{ color: canvasTheme.node.faint }} />
                )}
            </span>
            <span className="min-w-0 flex-1 py-0.5">
                <span className="flex items-center gap-1.5">
                    {generating ? (
                        <LoaderCircle className="size-3.5 shrink-0 animate-spin" style={{ color: canvasTheme.node.muted }} aria-hidden="true" />
                    ) : confirmed ? (
                        <CheckCircle2 className="size-3.5 shrink-0" style={{ color: successColor }} aria-hidden="true" />
                    ) : confirmationIssues.some((issue) => !issue.includes("尚未确认")) ? (
                        <CircleAlert className="size-3.5 shrink-0" style={{ color: errorColor }} aria-hidden="true" />
                    ) : (
                        <span className="size-3.5 shrink-0 rounded-full border" style={{ borderColor: canvasTheme.node.faint }} aria-hidden="true" />
                    )}
                    <span className="shrink-0 text-[11px] font-medium" style={{ color: canvasTheme.node.muted }}>
                        第<span className="font-mono tabular-nums">{page.index}</span>页
                    </span>
                    <span className="truncate text-sm font-semibold">{page.title}</span>
                </span>
                <span className="mt-1.5 block text-xs" style={{ color: canvasTheme.node.muted }}>
                    <span className="font-mono tabular-nums">{takes.length}</span> 个方案分支 · <span className="font-mono tabular-nums">{candidateCount}</span> 个候选稿
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
