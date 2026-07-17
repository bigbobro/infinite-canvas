import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Checkbox, Input, Modal, theme as antdTheme } from "antd";
import { Check, CheckCircle2, GitBranchPlus, ImageOff, Layers3, LoaderCircle, Network, Plus, Presentation, RotateCcw, Save, ScanSearch, Sparkles, WandSparkles } from "lucide-react";
import { nanoid } from "nanoid";

import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { PPT_PAGE_PROMPT } from "@/lib/ppt/deck-builder";
import { buildPptPageWorkspace } from "@/lib/ppt/page-workspace";
import { pageTakes, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAnnotateStore } from "@/stores/use-annotate-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeMetadata } from "@/types/canvas";

const ROW_GAP = 48;

type Props = {
    open: boolean;
    projectId: string;
    pageIndex: number;
    onPageChange: (pageIndex: number) => void;
    controls: {
        anchorEnabled: boolean;
        anchorDisabled: boolean;
        batchLabel: string;
        batchDisabled: boolean;
        onAnchorEnabledChange: (enabled: boolean) => void;
        onBatchAction: () => void;
        onOpenFinalReview: () => void;
        onShowCanvas: (nodeId?: string) => void;
    };
};

export function CanvasPptPageWorkspace({ open, projectId, pageIndex, onPageChange, controls }: Props) {
    const { message, modal } = App.useApp();
    const { token } = antdTheme.useToken();
    const canvasTheme = canvasThemes[useThemeStore((state) => state.theme)];
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const updateProject = useCanvasStore((state) => state.updateProject);
    const canvasContext = useAgentStore((state) => state.canvasContext);
    const openAnnotate = useAnnotateStore((state) => state.open);
    const [activeTakeIndex, setActiveTakeIndex] = useState(0);
    const [activeNodeId, setActiveNodeId] = useState<string>();
    const [promptDraft, setPromptDraft] = useState("");
    const [newTakeDraft, setNewTakeDraft] = useState<{ sourceTakeKey?: string; prompt: string } | null>(null);
    const selectionPageIndexRef = useRef<number | undefined>(undefined);

    const workspaces = useMemo(() => {
        if (!project?.ppt) return [];
        return [...project.ppt.pages]
            .sort((left, right) => left.index - right.index)
            .map((page) => buildPptPageWorkspace(project, page));
    }, [project]);
    const workspace = workspaces.find((item) => item.page.index === pageIndex);
    const activeTake = workspace?.takes.find((take) => take.index === activeTakeIndex) ?? workspace?.takes[0];
    const isExtractMode = project?.ppt?.mode === "extract";
    const fallbackPrompt = workspace
        ? isExtractMode
            ? workspace.page.outline
            : [`标题：${workspace.page.title}`, workspace.page.outline, workspace.page.visualHint ? `视觉建议：${workspace.page.visualHint}` : ""].filter(Boolean).join("\n\n")
        : "";

    useEffect(() => {
        if (!open) return;
        if (!workspace) return;
        const confirmedTake = workspace.takes.find((take) => take.candidates.some((node) => node.id === workspace.page.confirmedNodeId));
        const fallbackTake = [...workspace.takes].reverse().find((take) => take.candidates.length) ?? workspace.takes.at(-1);
        const currentTake = workspace.takes.find((take) => take.index === activeTakeIndex);
        const pageChanged = selectionPageIndexRef.current !== pageIndex;
        const nextTake = pageChanged ? confirmedTake ?? fallbackTake : currentTake ?? confirmedTake ?? fallbackTake;
        const nextNodeId = nextTake?.candidates.some((node) => node.id === activeNodeId)
            ? activeNodeId
            : nextTake?.candidates.find((node) => node.id === workspace.page.confirmedNodeId)?.id ?? nextTake?.candidates.at(-1)?.id;
        selectionPageIndexRef.current = pageIndex;
        if (activeTakeIndex !== (nextTake?.index ?? 0)) setActiveTakeIndex(nextTake?.index ?? 0);
        if (activeNodeId !== nextNodeId) setActiveNodeId(nextNodeId);
    }, [activeNodeId, activeTakeIndex, open, pageIndex, workspace]);

    useEffect(() => {
        if (newTakeDraft) return;
        setPromptDraft(activeTake?.prompt ?? fallbackPrompt);
    }, [activeTake?.key, activeTake?.prompt, fallbackPrompt, newTakeDraft, pageIndex]);

    if (!open || !project?.ppt || !workspace) return null;

    const ppt = project.ppt;
    const page = workspace.page;
    const activeNode = activeTake?.candidates.find((node) => node.id === activeNodeId);
    const activeConfirmed = Boolean(activeNode && activeNode.id === page.confirmedNodeId);
    const candidateCount = workspace.takes.reduce((total, take) => total + take.candidates.length, 0);
    const promptDirty = Boolean(activeTake?.canEditPrompt && promptDraft !== activeTake.prompt);

    const buildRunGenerationOp = (configNodeId: string): CanvasAgentOp =>
        isExtractMode
            ? { type: "run_generation", nodeId: configNodeId, mode: "image" }
            : { type: "run_generation", nodeId: configNodeId, mode: "image", prompt: PPT_PAGE_PROMPT };

    const runGeneration = () => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        if (!activeTake?.configNode) {
            message.warning(`第 ${page.index} 页方案分支 ${activeTakeIndex + 1} 的配置节点缺失`);
            return;
        }
        if (!activeTake.anchorNode) {
            message.warning(`第 ${page.index} 页方案分支 ${activeTakeIndex + 1} 的提示词节点缺失`);
            return;
        }
        if (activeTake.canEditPrompt && !promptDraft.trim()) {
            message.warning("请先填写方案提示词");
            return;
        }
        const ops: CanvasAgentOp[] = [];
        if (promptDirty) ops.push({ type: "update_node", id: activeTake.anchorNode.id, metadata: { content: promptDraft, status: "success" } });
        ops.push(buildRunGenerationOp(activeTake.configNode.id));
        const next = canvasContext.applyOps(ops);
        if (promptDirty) updateProject(projectId, { nodes: next.nodes, connections: next.connections });
    };

    const savePrompt = () => {
        if (!canvasContext || !activeTake?.anchorNode || !activeTake.canEditPrompt) return;
        if (!promptDraft.trim()) {
            message.warning("方案提示词不能为空");
            return;
        }
        const next = canvasContext.applyOps([{ type: "update_node", id: activeTake.anchorNode.id, metadata: { content: promptDraft, status: "success" } }]);
        updateProject(projectId, { nodes: next.nodes, connections: next.connections });
        message.success(`方案分支 ${activeTake.index + 1} 的提示词已保存`);
    };

    const setConfirmed = (confirmedNodeId?: string) => {
        updateProject(projectId, {
            ppt: {
                ...ppt,
                pages: ppt.pages.map((item) => (item.index === page.index ? { ...item, confirmedNodeId } : item)),
            },
        });
    };

    const addPageTake = () => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        if (!newTakeDraft?.prompt.trim()) {
            message.warning("方案提示词不能为空");
            return;
        }

        const outlineId = nanoid();
        const configId = nanoid();
        const sourceTake = workspace.takes.find((take) => take.key === newTakeDraft.sourceTakeKey) ?? activeTake;
        const configMetadata: CanvasNodeMetadata = { prompt: isExtractMode ? "" : PPT_PAGE_PROMPT, size: "16:9", count: 1, pptPageIndex: page.index, pptRole: "page" };
        if (isExtractMode) configMetadata.composerContent = "";

        const gridNodes = project.nodes.filter((node) => node.metadata?.pptPageIndex != null);
        const gridBottom = gridNodes.length ? Math.max(...gridNodes.map((node) => node.position.y + node.height)) : undefined;
        const newRowY = gridBottom == null ? undefined : gridBottom + ROW_GAP;
        const outlinePosition = sourceTake?.anchorNode && newRowY != null ? { x: sourceTake.anchorNode.position.x, y: newRowY } : undefined;
        const configPosition = sourceTake?.configNode && newRowY != null ? { x: sourceTake.configNode.position.x, y: newRowY } : undefined;
        const inheritedInputNodeIds = sourceTake?.configNode
            ? [...new Set(project.connections.filter((connection) => connection.toNodeId === sourceTake.configNode?.id && connection.fromNodeId !== sourceTake.anchorNode?.id).map((connection) => connection.fromNodeId))]
            : project.nodes.filter((node) => node.metadata?.pptRole === "style").map((node) => node.id);
        const ops: CanvasAgentOp[] = [
            { type: "add_node", id: outlineId, nodeType: CanvasNodeType.Text, title: `第${page.index}页大纲`, position: outlinePosition, metadata: { content: newTakeDraft.prompt, status: "success", pptPageIndex: page.index, pptRole: "outline" } },
            { type: "add_node", id: configId, nodeType: CanvasNodeType.Config, title: `第${page.index}页生成配置`, position: configPosition, metadata: configMetadata },
            { type: "connect_nodes", fromNodeId: outlineId, toNodeId: configId },
            ...inheritedInputNodeIds.map((id): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId: id, toNodeId: configId })),
        ];
        const next = canvasContext.applyOps(ops);
        updateProject(projectId, {
            nodes: next.nodes,
            connections: next.connections,
            ppt: {
                ...ppt,
                pages: ppt.pages.map((item) =>
                    item.index === page.index
                        ? {
                              ...item,
                              takes: [...pageTakes(item), { anchorNodeId: outlineId, configNodeId: configId }],
                              anchorNodeId: undefined,
                              configNodeId: undefined,
                          }
                        : item,
                ),
            },
        });
        setActiveTakeIndex(workspace.takes.length);
        setActiveNodeId(undefined);
        setNewTakeDraft(null);
        message.success(`已创建方案分支 ${workspace.takes.length + 1}，确认提示词后再生成`);
    };

    const discardPendingPrompt = (next: () => void) => {
        if (!newTakeDraft && !promptDirty) {
            next();
            return;
        }
        modal.confirm({
            title: "放弃未保存的提示词？",
            content: "当前编辑还没有保存，切换后将丢失这些修改。",
            okText: "放弃并切换",
            cancelText: "继续编辑",
            onOk: () => {
                setNewTakeDraft(null);
                setPromptDraft(activeTake?.prompt ?? fallbackPrompt);
                next();
            },
        });
    };

    const beginPageTake = (sourceTake = activeTake) => {
        discardPendingPrompt(() => setNewTakeDraft({ sourceTakeKey: sourceTake?.key, prompt: sourceTake ? sourceTake.prompt : fallbackPrompt }));
    };

    const selectTake = (takeIndex: number) => discardPendingPrompt(() => {
        const take = workspace.takes.find((item) => item.index === takeIndex);
        setActiveTakeIndex(takeIndex);
        setActiveNodeId(take?.candidates.find((node) => node.id === page.confirmedNodeId)?.id ?? take?.candidates.at(-1)?.id);
    });

    const selectCandidate = (takeIndex: number, nodeId: string) => discardPendingPrompt(() => {
        setActiveTakeIndex(takeIndex);
        setActiveNodeId(nodeId);
    });

    const changePage = (nextPageIndex: number) => discardPendingPrompt(() => onPageChange(nextPageIndex));

    return (
        <Modal
            title={`第 ${page.index} 页 PPT 工作台`}
            classNames={{ header: "sr-only" }}
            open={open}
            footer={null}
            closable={false}
            keyboard={false}
            mask={false}
            getContainer={false}
            width="100%"
            zIndex={60}
            style={{ top: 0, height: "100%", maxWidth: "none", margin: 0, paddingBottom: 0 }}
            styles={{
                root: { position: "absolute", inset: "64px 0 0" },
                wrapper: { position: "absolute", inset: 0, overflow: "hidden" },
                container: { width: "100%", height: "100%", maxWidth: "none", margin: 0, padding: 0, borderRadius: 0, boxShadow: "none" },
                body: { height: "100%", padding: 0 },
            }}
        >
            <div
                className="flex h-full min-h-0 flex-col overflow-hidden"
                style={{ background: canvasTheme.node.panel, color: canvasTheme.node.text }}
                data-canvas-no-zoom
                onKeyDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
            >
                <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 px-5 py-4">
                    <div className="flex min-w-0 items-start gap-3">
                        <div className="grid size-10 shrink-0 place-items-center rounded-lg border" style={{ background: canvasTheme.node.fill, borderColor: canvasTheme.node.stroke }}>
                            <Layers3 className="size-5" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="truncate text-lg font-semibold">第 {page.index} 页 · {page.title}</h2>
                            <p className="mt-1 text-sm" style={{ color: canvasTheme.node.muted }}>
                                {workspace.takes.length} 个方案分支 · {candidateCount} 个候选稿
                            </p>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <Checkbox checked={controls.anchorEnabled} disabled={controls.anchorDisabled} onChange={(event) => controls.onAnchorEnabledChange(event.target.checked)}>
                            <span className="text-xs" style={{ color: canvasTheme.node.muted }}>首页锚定</span>
                        </Checkbox>
                        <Button size="small" type="primary" icon={<Sparkles className="size-3.5" />} disabled={controls.batchDisabled || Boolean(newTakeDraft) || promptDirty} onClick={controls.onBatchAction}>
                            {controls.batchLabel}
                        </Button>
                        <Button size="small" icon={<Presentation className="size-3.5" />} onClick={() => discardPendingPrompt(controls.onOpenFinalReview)}>最终检视</Button>
                        <Button
                            size="small"
                            icon={<Network className="size-3.5" />}
                            onClick={() => discardPendingPrompt(() => controls.onShowCanvas(activeNode?.id ?? activeTake?.configNode?.id ?? activeTake?.anchorNode?.id))}
                        >
                            查看结构画布
                        </Button>
                        <Button size="small" icon={<GitBranchPlus className="size-3.5" />} disabled={!canvasContext || Boolean(newTakeDraft)} onClick={() => beginPageTake()}>
                            新建方案分支
                        </Button>
                    </div>
                </header>

                <main className="thin-scrollbar grid min-h-0 flex-1 gap-4 overflow-y-auto border-y p-4 xl:grid-cols-[156px_minmax(380px,0.95fr)_minmax(440px,1.05fr)] xl:overflow-hidden" style={{ borderColor: canvasTheme.node.stroke }}>
                    <nav className="flex min-h-0 flex-col gap-1.5 xl:overflow-y-auto" aria-label="PPT 页面导航">
                        {workspaces.map((item) => {
                            const selected = item.page.index === page.index;
                            const confirmed = item.confirmationIssues.length === 0;
                            return (
                                <button
                                    key={item.page.index}
                                    type="button"
                                    className="rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2"
                                    style={{
                                        background: selected ? canvasTheme.toolbar.activeBg : "transparent",
                                        borderColor: selected ? canvasTheme.node.activeStroke : canvasTheme.node.stroke,
                                        outlineColor: canvasTheme.node.activeStroke,
                                    }}
                                    aria-current={selected ? "page" : undefined}
                                    onClick={() => changePage(item.page.index)}
                                >
                                    <span className="flex items-center gap-2 text-xs font-semibold">
                                        {confirmed ? <CheckCircle2 className="size-3.5 shrink-0" style={{ color: token.colorSuccess }} aria-hidden="true" /> : <span className="size-3.5 shrink-0 rounded-full border" style={{ borderColor: canvasTheme.node.faint }} aria-hidden="true" />}
                                        第 {item.page.index} 页
                                    </span>
                                    <span className="mt-1 block truncate text-[11px]" style={{ color: canvasTheme.node.muted }}>
                                        {selected ? "正在精修" : confirmed ? "已确认" : "待确认"}
                                    </span>
                                </button>
                            );
                        })}
                    </nav>

                    <section className="flex min-h-[380px] min-w-0 flex-col gap-3 xl:min-h-0" aria-label="当前页方案分支与候选稿">
                        <section className="shrink-0 rounded-xl border p-3" style={{ background: canvasTheme.node.fill, borderColor: newTakeDraft ? canvasTheme.node.activeStroke : canvasTheme.node.stroke }}>
                            {newTakeDraft ? (
                                <>
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <h3 className="text-sm font-semibold">新方案分支提示词</h3>
                                            <p className="mt-1 text-xs" style={{ color: canvasTheme.node.muted }}>先调整提示词，创建分支后再决定是否生成，不会自动消耗 API。</p>
                                        </div>
                                        <GitBranchPlus className="size-4 shrink-0" aria-hidden="true" />
                                    </div>
                                    <Input.TextArea
                                        className="mt-3"
                                        value={newTakeDraft.prompt}
                                        autoSize={{ minRows: 5, maxRows: 9 }}
                                        variant="filled"
                                        placeholder="填写这一方案分支的完整提示词"
                                        onChange={(event) => setNewTakeDraft((current) => (current ? { ...current, prompt: event.target.value } : current))}
                                    />
                                    <div className="mt-3 flex justify-end gap-2">
                                        <Button size="small" onClick={() => setNewTakeDraft(null)}>取消</Button>
                                        <Button size="small" type="primary" icon={<Plus className="size-3.5" />} disabled={!newTakeDraft.prompt.trim()} onClick={addPageTake}>创建方案分支</Button>
                                    </div>
                                </>
                            ) : activeTake ? (
                                <>
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <h3 className="text-sm font-semibold">方案分支 {activeTake.index + 1} 提示词</h3>
                                            <p className="mt-1 text-xs" style={{ color: canvasTheme.node.muted }}>
                                                {activeTake.generating ? "生成中，提示词暂时锁定" : activeTake.canEditPrompt ? "首个候选生成前可以继续调整" : "已有候选稿；调整提示词会派生新分支"}
                                            </p>
                                        </div>
                                        <span className="shrink-0 text-[11px] font-medium" style={{ color: activeTake.canEditPrompt ? token.colorWarningText : canvasTheme.node.muted }}>
                                            {activeTake.canEditPrompt ? "可编辑" : "只读"}
                                        </span>
                                    </div>
                                    <Input.TextArea
                                        className="mt-3"
                                        value={promptDraft}
                                        autoSize={{ minRows: 4, maxRows: 8 }}
                                        variant="filled"
                                        readOnly={!activeTake.canEditPrompt}
                                        placeholder="填写这一方案分支的完整提示词"
                                        onChange={(event) => setPromptDraft(event.target.value)}
                                    />
                                    <div className="mt-3 flex items-center justify-between gap-3">
                                        <span className="text-[11px]" style={{ color: canvasTheme.node.muted }}>
                                            {promptDirty ? "有未保存修改；直接生成时也会先使用这份提示词" : activeTake.candidates.length ? `${activeTake.candidates.length} 个候选稿共用这份提示词` : "创建和生成是两个独立步骤"}
                                        </span>
                                        {activeTake.canEditPrompt ? (
                                            <Button size="small" icon={<Save className="size-3.5" />} disabled={!promptDirty || !promptDraft.trim() || !canvasContext} onClick={savePrompt}>保存提示词</Button>
                                        ) : (
                                            <Button size="small" icon={<GitBranchPlus className="size-3.5" />} disabled={activeTake.generating || !canvasContext} onClick={() => beginPageTake(activeTake)}>基于此方案调整</Button>
                                        )}
                                    </div>
                                </>
                            ) : (
                                <div className="py-4 text-center">
                                    <div className="text-sm font-semibold">本页还没有方案分支</div>
                                    <Button className="mt-3" size="small" icon={<GitBranchPlus className="size-3.5" />} disabled={!canvasContext} onClick={() => beginPageTake(undefined)}>新建方案分支</Button>
                                </div>
                            )}
                        </section>

                        <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                            {workspace.takes.length ? (
                                workspace.takes.map((take) => {
                                    const selectedTake = take.index === activeTake?.index;
                                    return (
                                        <section
                                            key={take.key}
                                            className="rounded-xl border p-3"
                                            style={{ background: selectedTake ? canvasTheme.toolbar.activeBg : canvasTheme.node.fill, borderColor: selectedTake ? canvasTheme.node.activeStroke : canvasTheme.node.stroke }}
                                            aria-labelledby={`ppt-take-${page.index}-${take.index}`}
                                        >
                                            <button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={() => selectTake(take.index)}>
                                                <span>
                                                    <span id={`ppt-take-${page.index}-${take.index}`} className="block text-sm font-semibold">方案分支 {take.index + 1}</span>
                                                    <span className="mt-0.5 block text-[11px]" style={{ color: canvasTheme.node.muted }}>
                                                        {take.generating ? "生成中" : take.candidates.length ? `${take.candidates.length} 个候选稿` : "尚未生成"}
                                                    </span>
                                                </span>
                                                {selectedTake ? <span className="flex items-center gap-1 text-xs font-medium"><Check className="size-3.5" aria-hidden="true" />当前分支</span> : null}
                                            </button>

                                            {take.issues.length ? (
                                                <div className="mt-3 rounded-lg border px-3 py-2 text-xs" style={{ background: token.colorErrorBg, borderColor: token.colorErrorBorder, color: token.colorErrorText }} role="alert">
                                                    {take.issues.join("；")}
                                                </div>
                                            ) : null}

                                            {take.candidates.length ? (
                                                <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                                                    {take.candidates.map((node, versionIndex) => {
                                                        const viewing = node.id === activeNode?.id;
                                                        const confirmed = node.id === page.confirmedNodeId;
                                                        return (
                                                            <button
                                                                key={node.id}
                                                                type="button"
                                                                className="overflow-hidden rounded-lg border p-1.5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2"
                                                                style={{
                                                                    background: viewing ? canvasTheme.node.panel : canvasTheme.canvas.background,
                                                                    borderColor: viewing ? canvasTheme.node.activeStroke : confirmed ? token.colorSuccessBorder : canvasTheme.node.stroke,
                                                                    boxShadow: viewing ? `0 0 0 1px ${canvasTheme.node.activeStroke}` : undefined,
                                                                    outlineColor: canvasTheme.node.activeStroke,
                                                                }}
                                                                aria-pressed={viewing}
                                                                aria-label={`第 ${page.index} 页，方案分支 ${take.index + 1}，候选稿 ${versionIndex + 1}${confirmed ? "，已选最终版" : ""}`}
                                                                onClick={() => selectCandidate(take.index, node.id)}
                                                            >
                                                                <span className="flex aspect-video items-center justify-center overflow-hidden rounded-md" style={{ background: canvasTheme.node.fill }}>
                                                                    {node.metadata?.content ? <img src={node.metadata.content} alt="" className="size-full object-contain" /> : <ImageOff className="size-5" style={{ color: canvasTheme.node.faint }} aria-hidden="true" />}
                                                                </span>
                                                                <span className="mt-1.5 flex items-center justify-between gap-2 px-0.5 text-[11px]">
                                                                    <span className="font-medium">P{page.index} · B{take.index + 1} · V{versionIndex + 1}</span>
                                                                    {confirmed ? <span className="flex shrink-0 items-center gap-1 font-semibold" style={{ color: token.colorSuccess }}><CheckCircle2 className="size-3" aria-hidden="true" />最终版</span> : viewing ? <span className="shrink-0" style={{ color: canvasTheme.node.muted }}>查看中</span> : null}
                                                                </span>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            ) : (
                                                <button type="button" className="mt-3 flex aspect-video w-full items-center justify-center rounded-lg border border-dashed text-sm" style={{ borderColor: canvasTheme.node.stroke, color: canvasTheme.node.muted }} onClick={() => selectTake(take.index)}>
                                                    {take.generating ? <span className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />正在生成第一个候选稿</span> : "此分支还没有候选稿"}
                                                </button>
                                            )}
                                        </section>
                                    );
                                })
                            ) : null}
                        </div>
                    </section>

                    <section className="flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-xl border xl:min-h-0" style={{ background: canvasTheme.canvas.background, borderColor: canvasTheme.node.stroke }} aria-label="当前候选稿大图预览">
                        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
                            {activeNode?.metadata?.content ? (
                                <img src={activeNode.metadata.content} alt={`第 ${page.index} 页当前查看候选稿`} className="max-h-full max-w-full rounded-lg object-contain" />
                            ) : (
                                <div className="flex flex-col items-center gap-3 text-center" style={{ color: canvasTheme.node.muted }}>
                                    <ScanSearch className="size-10" aria-hidden="true" />
                                    <div>
                                        <div className="text-sm font-semibold" style={{ color: canvasTheme.node.text }}>选择一个候选稿查看大图</div>
                                        <div className="mt-1 text-xs">也可以先确认提示词，再生成首个候选稿</div>
                                    </div>
                                </div>
                            )}
                        </div>
                        <footer className="shrink-0 border-t p-3" style={{ background: canvasTheme.node.panel, borderColor: canvasTheme.node.stroke }}>
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-sm font-semibold">方案分支 {activeTake?.index != null ? activeTake.index + 1 : "-"}</div>
                                    <div className="mt-0.5 truncate text-xs" style={{ color: canvasTheme.node.muted }}>
                                        {activeNode ? activeConfirmed ? "此候选稿已选为本页最终版" : "正在查看，尚未确认为最终版" : activeTake?.generating ? "生成中，请稍候" : "暂无选中候选稿"}
                                    </div>
                                </div>
                                {activeConfirmed ? <span className="flex shrink-0 items-center gap-1 text-xs font-semibold" style={{ color: token.colorSuccess }}><CheckCircle2 className="size-4" aria-hidden="true" />已选最终版</span> : null}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <Button icon={activeTake?.generating ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} disabled={!activeTake?.configNode || activeTake.generating || !canvasContext || Boolean(newTakeDraft)} onClick={runGeneration}>
                                    {activeTake?.generating ? "生成中" : activeTake?.candidates.length ? "继续生成" : promptDirty ? "保存并生成首稿" : "生成首稿"}
                                </Button>
                                <Button icon={<WandSparkles className="size-4" />} disabled={!activeNode?.metadata?.content} onClick={() => activeNode && openAnnotate(activeNode.id)}>
                                    标注改图
                                </Button>
                                <Button type="primary" icon={<CheckCircle2 className="size-4" />} disabled={!activeNode?.metadata?.storageKey} onClick={() => setConfirmed(activeConfirmed ? undefined : activeNode?.id)}>
                                    {activeConfirmed ? "取消确认" : "确认此候选稿"}
                                </Button>
                            </div>
                        </footer>
                    </section>
                </main>
            </div>
        </Modal>
    );
}
