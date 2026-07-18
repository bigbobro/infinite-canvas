import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Dropdown, Input, Modal, theme as antdTheme } from "antd";
import { ArrowRight, Check, CheckCircle2, FileText, GitBranchPlus, ImageOff, Layers3, LoaderCircle, Music2, Network, Pencil, Plus, Presentation, RotateCcw, Save, ScanSearch, Sparkles, Trash2, Video, WandSparkles } from "lucide-react";
import { nanoid } from "nanoid";

import { CanvasImageLightbox } from "@/components/canvas/canvas-image-lightbox";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { PPT_PAGE_PROMPT } from "@/lib/ppt/deck-builder";
import { setPptPageConfirmedNode } from "@/lib/ppt/page-confirmation";
import { buildPptPageWorkspace, type PptPageWorkspaceTake } from "@/lib/ppt/page-workspace";
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
        batchLabel: string;
        batchDisabled: boolean;
        batchHidden: boolean;
        onBatchAction: () => void;
        onOpenFinalReview: () => void;
        onShowCanvas: (nodeId?: string) => void;
    };
};

/** 生成中已用时长（#28），组件内计时，不持久化。 */
function useElapsedSeconds(active: boolean) {
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
        if (!active) {
            setSeconds(0);
            return;
        }
        const start = Date.now();
        setSeconds(0);
        const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
        return () => window.clearInterval(timer);
    }, [active]);
    return seconds;
}

function formatElapsed(seconds: number) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}

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
    const [editingLockedPrompt, setEditingLockedPrompt] = useState(false);
    const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
    const selectionPageIndexRef = useRef<number | undefined>(undefined);

    const workspaces = useMemo(() => {
        if (!project?.ppt) return [];
        return [...project.ppt.pages].sort((left, right) => left.index - right.index).map((page) => buildPptPageWorkspace(project, page));
    }, [project]);
    const workspace = workspaces.find((item) => item.page.index === pageIndex);
    const activeTake = workspace?.takes.find((take) => take.index === activeTakeIndex) ?? workspace?.takes[0];
    const isExtractMode = project?.ppt?.mode === "extract";
    const fallbackPrompt = workspace ? (isExtractMode ? workspace.page.outline : [`标题：${workspace.page.title}`, workspace.page.outline, workspace.page.visualHint ? `视觉建议：${workspace.page.visualHint}` : ""].filter(Boolean).join("\n\n")) : "";
    const generatingElapsed = useElapsedSeconds(Boolean(activeTake?.generating));

    useEffect(() => {
        if (!open) return;
        if (!workspace) return;
        const confirmedTake = workspace.takes.find((take) => take.candidates.some((node) => node.id === workspace.page.confirmedNodeId));
        const fallbackTake = [...workspace.takes].reverse().find((take) => take.candidates.length) ?? workspace.takes.at(-1);
        const currentTake = workspace.takes.find((take) => take.index === activeTakeIndex);
        const pageChanged = selectionPageIndexRef.current !== pageIndex;
        const nextTake = pageChanged ? (confirmedTake ?? fallbackTake) : (currentTake ?? confirmedTake ?? fallbackTake);
        const nextNodeId = nextTake?.candidates.some((node) => node.id === activeNodeId) ? activeNodeId : (nextTake?.candidates.find((node) => node.id === workspace.page.confirmedNodeId)?.id ?? nextTake?.candidates.at(-1)?.id);
        selectionPageIndexRef.current = pageIndex;
        if (activeTakeIndex !== (nextTake?.index ?? 0)) setActiveTakeIndex(nextTake?.index ?? 0);
        if (activeNodeId !== nextNodeId) setActiveNodeId(nextNodeId);
    }, [activeNodeId, activeTakeIndex, open, pageIndex, workspace]);

    useEffect(() => {
        if (newTakeDraft) return;
        setPromptDraft(activeTake?.prompt ?? fallbackPrompt);
    }, [activeTake?.key, activeTake?.prompt, fallbackPrompt, newTakeDraft, pageIndex]);

    useEffect(() => {
        setEditingLockedPrompt(false);
    }, [activeTake?.key]);

    useEffect(() => {
        setLightboxSrc(null);
    }, [pageIndex]);

    if (!open || !project?.ppt || !workspace) return null;

    const ppt = project.ppt;
    const page = workspace.page;
    const activeNode = activeTake?.candidates.find((node) => node.id === activeNodeId);
    const activeConfirmed = Boolean(activeNode && activeNode.id === page.confirmedNodeId);
    const candidateCount = workspace.takes.reduce((total, take) => total + take.candidates.length, 0);
    const promptDirty = Boolean(activeTake?.canEditPrompt && promptDraft !== activeTake.prompt);
    const forkDirty = Boolean(activeTake && !activeTake.canEditPrompt && editingLockedPrompt && promptDraft.trim() !== activeTake.prompt.trim());
    const hasPendingPromptEdit = promptDirty || forkDirty;
    const centerGenerateCtaShown = Boolean(!activeNode && !activeTake?.generating && activeTake?.configNode && !editingLockedPrompt);

    // 生成指令读专用字段 pptLayoutPrompt(metadata.prompt 会被回写污染,禁止读);
    // 旧工程无此字段或清空时回退默认:outline 恒传常量(防 bridge 落到污染的节点 prompt),extract 不传(保 composerContent 挡板)。
    const buildRunGenerationOp = (configNodeId: string): CanvasAgentOp => {
        const meta = project.nodes.find((node) => node.id === configNodeId)?.metadata;
        const layoutPrompt = (meta?.pptLayoutPrompt ?? "").trim() || (isExtractMode ? "" : PPT_PAGE_PROMPT);
        return layoutPrompt ? { type: "run_generation", nodeId: configNodeId, mode: "image", prompt: layoutPrompt } : { type: "run_generation", nodeId: configNodeId, mode: "image" };
    };

    const runGeneration = () => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        if (!activeTake?.configNode) {
            message.warning(`第 ${page.index} 页方案分支 ${activeTakeIndex + 1} 的配置缺失`);
            return;
        }
        if (!activeTake.anchorNode) {
            message.warning(`第 ${page.index} 页方案分支 ${activeTakeIndex + 1} 的提示词缺失`);
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

    // #30：风格基调节点为全部页面共用，保存直接写回该节点，影响全部方案分支。
    const saveStyleNode = (nodeId: string, content: string) => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        if (!content.trim()) {
            message.warning("风格基调不能为空");
            return;
        }
        const next = canvasContext.applyOps([{ type: "update_node", id: nodeId, metadata: { content, status: "success" } }]);
        updateProject(projectId, { nodes: next.nodes, connections: next.connections });
        message.success("风格基调已更新，将影响全部页面");
    };

    // #31：排版要求只作用于当前方案分支。存专用字段 pptLayoutPrompt——
    // metadata.prompt 每轮生成会被拼装全文回写(污染),不可作可编辑指令的存储位。
    const saveLayoutPrompt = (content: string) => {
        if (!canvasContext || !activeTake?.configNode) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        const next = canvasContext.applyOps([{ type: "update_node", id: activeTake.configNode.id, metadata: { pptLayoutPrompt: content } }]);
        updateProject(projectId, { nodes: next.nodes, connections: next.connections });
        message.success(`方案分支 ${activeTake.index + 1} 的排版要求已保存`);
    };

    const setConfirmed = (confirmedNodeId?: string) => {
        updateProject(projectId, { ppt: setPptPageConfirmedNode(ppt, page.index, confirmedNodeId) });
    };

    // #20：确认后自动前进到下一个未确认页；全部确认完则跳最终检视。
    const goToNextUnconfirmed = () => {
        const currentPos = workspaces.findIndex((item) => item.page.index === page.index);
        const rotated = [...workspaces.slice(currentPos + 1), ...workspaces.slice(0, currentPos + 1)];
        const next = rotated.find((item) => item.page.index !== page.index && item.confirmationIssues.length > 0);
        if (next) changePage(next.page.index);
        else discardPendingPrompt(controls.onOpenFinalReview);
    };

    const createTakeFromPrompt = (prompt: string, sourceTake: PptPageWorkspaceTake | undefined, autoGenerate: boolean) => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        if (!prompt.trim()) {
            message.warning("方案提示词不能为空");
            return;
        }

        const outlineId = nanoid();
        const configId = nanoid();
        // 派生分支继承源分支的排版要求(effective 值);空白分支用默认种子。
        const seedLayoutPrompt = sourceTake?.layoutPrompt?.trim() || (isExtractMode ? "" : PPT_PAGE_PROMPT);
        const configMetadata: CanvasNodeMetadata = { prompt: isExtractMode ? "" : PPT_PAGE_PROMPT, pptLayoutPrompt: seedLayoutPrompt, size: "16:9", count: 1, pptPageIndex: page.index, pptRole: "page" };
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
            { type: "add_node", id: outlineId, nodeType: CanvasNodeType.Text, title: `第${page.index}页大纲`, position: outlinePosition, metadata: { content: prompt, status: "success", pptPageIndex: page.index, pptRole: "outline" } },
            { type: "add_node", id: configId, nodeType: CanvasNodeType.Config, title: `第${page.index}页生成配置`, position: configPosition, metadata: configMetadata },
            { type: "connect_nodes", fromNodeId: outlineId, toNodeId: configId },
            ...inheritedInputNodeIds.map((id): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId: id, toNodeId: configId })),
        ];
        // 新节点尚未入 project.nodes,不能走 buildRunGenerationOp 查表,直接用种子值构造。
        if (autoGenerate) ops.push(seedLayoutPrompt ? { type: "run_generation", nodeId: configId, mode: "image", prompt: seedLayoutPrompt } : { type: "run_generation", nodeId: configId, mode: "image" });
        const next = canvasContext.applyOps(ops);
        const nextTakes = [...pageTakes(page), { anchorNodeId: outlineId, configNodeId: configId }];
        updateProject(projectId, {
            nodes: next.nodes,
            connections: next.connections,
            ppt: {
                ...ppt,
                pages: ppt.pages.map((item) => (item.index === page.index ? { ...item, takes: nextTakes, anchorNodeId: undefined, configNodeId: undefined } : item)),
            },
        });
        setActiveTakeIndex(nextTakes.length - 1);
        setActiveNodeId(undefined);
        setNewTakeDraft(null);
        setEditingLockedPrompt(false);
        message.success(autoGenerate ? `已基于新提示词创建方案分支 ${nextTakes.length} 并开始生成` : `已创建方案分支 ${nextTakes.length}，确认提示词后再生成`);
    };

    const addPageTake = () => {
        if (!newTakeDraft?.prompt.trim()) {
            message.warning("方案提示词不能为空");
            return;
        }
        createTakeFromPrompt(newTakeDraft.prompt, workspace.takes.find((take) => take.key === newTakeDraft.sourceTakeKey) ?? activeTake, false);
    };

    // #32：删除方案分支——只删「仅属于该 take」的候选（take.candidates 已按 buildPptPageWorkspace 的
    // 可达性+去重规则同源计算，不另写一套遍历）；若含已确认最终版，先经共享实现取消确认再删节点。
    const deleteTake = (take: PptPageWorkspaceTake) => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        const idsToDelete = [take.anchorNode?.id, take.configNode?.id, ...take.candidates.map((node) => node.id)].filter((id): id is string => Boolean(id));
        const willUnconfirm = take.candidates.some((node) => node.id === page.confirmedNodeId);
        const pptAfterUnconfirm = willUnconfirm ? setPptPageConfirmedNode(ppt, page.index, undefined) : ppt;
        const nextTakes = pageTakes(page).filter((item) => item.configNodeId !== take.key);
        const next = canvasContext.applyOps([{ type: "delete_node", ids: idsToDelete }]);
        updateProject(projectId, {
            nodes: next.nodes,
            connections: next.connections,
            ppt: { ...pptAfterUnconfirm, pages: pptAfterUnconfirm.pages.map((item) => (item.index === page.index ? { ...item, takes: nextTakes, anchorNodeId: undefined, configNodeId: undefined } : item)) },
        });
        if (activeTakeIndex === take.index) {
            setActiveTakeIndex(0);
            setActiveNodeId(undefined);
        }
        if (newTakeDraft?.sourceTakeKey === take.key) setNewTakeDraft(null);
        if (editingLockedPrompt && activeTakeIndex === take.index) setEditingLockedPrompt(false);
        message.success(`方案分支 ${take.index + 1} 已删除`);
    };

    const confirmDeleteTake = (take: PptPageWorkspaceTake) => {
        const willUnconfirm = take.candidates.some((node) => node.id === page.confirmedNodeId);
        let content = "该方案的提示词与配置将移除";
        if (take.candidates.length) content += `，其 ${take.candidates.length} 张候选稿将一并从画布删除`;
        content += willUnconfirm ? "；本页已确认的最终版属于该方案，删除后将回到未确认状态。" : "。";
        modal.confirm({
            title: `删除方案分支 ${take.index + 1}？`,
            content,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => deleteTake(take),
        });
    };

    const discardPendingPrompt = (next: () => void) => {
        if (!newTakeDraft && !hasPendingPromptEdit) {
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
                setEditingLockedPrompt(false);
                setPromptDraft(activeTake?.prompt ?? fallbackPrompt);
                next();
            },
        });
    };

    const beginPageTake = (sourceTake = activeTake) => {
        discardPendingPrompt(() => setNewTakeDraft({ sourceTakeKey: sourceTake?.key, prompt: sourceTake ? sourceTake.prompt : fallbackPrompt }));
    };

    const selectTake = (takeIndex: number) =>
        discardPendingPrompt(() => {
            const take = workspace.takes.find((item) => item.index === takeIndex);
            setActiveTakeIndex(takeIndex);
            setActiveNodeId(take?.candidates.find((node) => node.id === page.confirmedNodeId)?.id ?? take?.candidates.at(-1)?.id);
        });

    const selectCandidate = (takeIndex: number, nodeId: string) =>
        discardPendingPrompt(() => {
            setActiveTakeIndex(takeIndex);
            setActiveNodeId(nodeId);
        });

    const changePage = (nextPageIndex: number) => discardPendingPrompt(() => onPageChange(nextPageIndex));

    // #21：键盘导航——↑/↓ 切页，←/→ 切候选；输入框/文本域/可编辑区聚焦时放行，不劫持按键。
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        event.stopPropagation();
        const target = event.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            const currentPos = workspaces.findIndex((item) => item.page.index === pageIndex);
            const nextPage = workspaces[event.key === "ArrowUp" ? currentPos - 1 : currentPos + 1];
            if (nextPage) {
                event.preventDefault();
                changePage(nextPage.page.index);
            }
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            if (!activeTake?.candidates.length) return;
            const currentIdx = activeTake.candidates.findIndex((node) => node.id === activeNodeId);
            const nextNode = activeTake.candidates[event.key === "ArrowLeft" ? currentIdx - 1 : currentIdx + 1];
            if (nextNode) {
                event.preventDefault();
                selectCandidate(activeTake.index, nextNode.id);
            }
        }
    };

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
                onKeyDown={handleKeyDown}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
            >
                <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 px-5 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                        <div className="grid size-8 shrink-0 place-items-center rounded-lg border" style={{ background: canvasTheme.node.fill, borderColor: canvasTheme.node.stroke }}>
                            <Layers3 className="size-4" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="truncate text-base font-semibold">
                                第 {page.index} 页 · {page.title}
                            </h2>
                            <p className="mt-0.5 text-xs" style={{ color: canvasTheme.node.muted }}>
                                {workspace.takes.length} 个方案分支 · {candidateCount} 个候选稿
                            </p>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        {!controls.batchHidden ? (
                            <Button size="small" type="primary" icon={<Sparkles className="size-3.5" />} disabled={controls.batchDisabled || Boolean(newTakeDraft) || hasPendingPromptEdit} onClick={controls.onBatchAction}>
                                {controls.batchLabel}
                            </Button>
                        ) : null}
                        <Button size="small" icon={<Presentation className="size-3.5" />} onClick={() => discardPendingPrompt(controls.onOpenFinalReview)}>
                            最终检视
                        </Button>
                        <Button size="small" icon={<Network className="size-3.5" />} onClick={() => discardPendingPrompt(() => controls.onShowCanvas(activeNode?.id ?? activeTake?.configNode?.id ?? activeTake?.anchorNode?.id))}>
                            查看结构画布
                        </Button>
                    </div>
                </header>

                <main className="thin-scrollbar grid min-h-0 flex-1 gap-4 overflow-y-auto border-y p-4 xl:grid-cols-[156px_minmax(380px,0.95fr)_minmax(440px,1.05fr)] xl:overflow-hidden" style={{ borderColor: canvasTheme.node.stroke }}>
                    <nav className="flex min-h-0 flex-col gap-1 xl:overflow-y-auto" aria-label="PPT 页面导航">
                        {workspaces.map((item) => {
                            const selected = item.page.index === page.index;
                            const confirmed = item.confirmationIssues.length === 0;
                            const generating = item.takes.some((take) => take.generating);
                            // #33：状态用徽记表达（✓ 已确认 / spinner 生成中 / ○ 待确认），去掉「待确认/正在精修」文字行，行高收紧。
                            const statusLabel = generating ? "生成中" : confirmed ? "已确认" : "待确认";
                            return (
                                <button
                                    key={item.page.index}
                                    type="button"
                                    className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2"
                                    style={{
                                        background: selected ? canvasTheme.toolbar.activeBg : "transparent",
                                        borderColor: selected ? canvasTheme.node.activeStroke : canvasTheme.node.stroke,
                                        outlineColor: canvasTheme.node.activeStroke,
                                    }}
                                    aria-current={selected ? "page" : undefined}
                                    aria-label={`第 ${item.page.index} 页，${statusLabel}`}
                                    onClick={() => changePage(item.page.index)}
                                >
                                    {generating ? (
                                        <LoaderCircle className="size-3.5 shrink-0 animate-spin" style={{ color: canvasTheme.node.muted }} aria-hidden="true" />
                                    ) : confirmed ? (
                                        <CheckCircle2 className="size-3.5 shrink-0" style={{ color: token.colorSuccess }} aria-hidden="true" />
                                    ) : (
                                        <span className="size-3.5 shrink-0 rounded-full border" style={{ borderColor: canvasTheme.node.faint }} aria-hidden="true" />
                                    )}
                                    <span className="truncate text-xs font-semibold">第 {item.page.index} 页</span>
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
                                            <p className="mt-1 text-xs" style={{ color: canvasTheme.node.muted }}>
                                                先调整提示词，创建分支后再决定是否生成，不会自动消耗 API。
                                            </p>
                                        </div>
                                        <GitBranchPlus className="size-4 shrink-0" aria-hidden="true" />
                                    </div>
                                    <Input.TextArea
                                        className="mt-3"
                                        value={newTakeDraft.prompt}
                                        autoSize={{ minRows: 8, maxRows: 24 }}
                                        variant="filled"
                                        placeholder="填写这一方案分支的完整提示词"
                                        onChange={(event) => setNewTakeDraft((current) => (current ? { ...current, prompt: event.target.value } : current))}
                                    />
                                    <div className="mt-3 flex justify-end gap-2">
                                        <Button size="small" onClick={() => setNewTakeDraft(null)}>
                                            取消
                                        </Button>
                                        <Button size="small" type="primary" icon={<Plus className="size-3.5" />} disabled={!newTakeDraft.prompt.trim()} onClick={addPageTake}>
                                            创建方案分支
                                        </Button>
                                    </div>
                                </>
                            ) : activeTake ? (
                                <>
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <h3 className="text-sm font-semibold">方案分支 {activeTake.index + 1} 提示词</h3>
                                            <p className="mt-1 text-xs" style={{ color: canvasTheme.node.muted }}>
                                                {activeTake.generating
                                                    ? "生成中，提示词暂时锁定"
                                                    : activeTake.canEditPrompt
                                                      ? "首个候选生成前可以继续调整"
                                                      : editingLockedPrompt
                                                        ? "调整后可另存为新方案分支，原方案不受影响"
                                                        : "已有候选稿；只读展示，点击「调整」可派生新方案"}
                                            </p>
                                        </div>
                                        <span className="shrink-0 text-[11px] font-medium" style={{ color: activeTake.canEditPrompt || editingLockedPrompt ? token.colorWarningText : canvasTheme.node.muted }}>
                                            {activeTake.canEditPrompt || editingLockedPrompt ? "可编辑" : "只读"}
                                        </span>
                                    </div>
                                    {/* #29：方案提示词是本卡视觉主体——只读态自适应内容高度（超长内滚），编辑态给足展开空间。 */}
                                    {activeTake.canEditPrompt || editingLockedPrompt ? (
                                        <Input.TextArea className="mt-3" value={promptDraft} autoSize={{ minRows: 8, maxRows: 24 }} variant="filled" placeholder="填写这一方案分支的完整提示词" onChange={(event) => setPromptDraft(event.target.value)} />
                                    ) : (
                                        <div className="thin-scrollbar mt-3 max-h-[46vh] overflow-y-auto whitespace-pre-wrap rounded-lg px-3 py-2 text-sm" style={{ background: canvasTheme.node.fill }}>
                                            {promptDraft || <span style={{ color: canvasTheme.node.muted }}>暂无提示词</span>}
                                        </div>
                                    )}
                                    <div className="mt-3 flex items-center justify-between gap-3">
                                        <span className="text-[11px]" style={{ color: canvasTheme.node.muted }}>
                                            {activeTake.canEditPrompt
                                                ? promptDirty
                                                    ? "有未保存修改；直接生成时也会先使用这份提示词"
                                                    : "创建和生成是两个独立步骤"
                                                : editingLockedPrompt
                                                  ? forkDirty
                                                      ? "内容已修改，可生成或另存为新方案"
                                                      : "内容未变化，修改后才能另存为新方案"
                                                  : `${activeTake.candidates.length} 个候选稿共用这份提示词`}
                                        </span>
                                        {activeTake.canEditPrompt ? (
                                            <Button size="small" icon={<Save className="size-3.5" />} disabled={!promptDirty || !promptDraft.trim() || !canvasContext} onClick={savePrompt}>
                                                保存提示词
                                            </Button>
                                        ) : editingLockedPrompt ? (
                                            <div className="flex items-center gap-2">
                                                <Button
                                                    size="small"
                                                    onClick={() => {
                                                        setEditingLockedPrompt(false);
                                                        setPromptDraft(activeTake.prompt);
                                                    }}
                                                >
                                                    取消调整
                                                </Button>
                                                <Button size="small" disabled={!forkDirty || !canvasContext} onClick={() => createTakeFromPrompt(promptDraft, activeTake, false)}>
                                                    仅保存为新方案
                                                </Button>
                                                <Button size="small" type="primary" icon={<Sparkles className="size-3.5" />} disabled={!forkDirty || !canvasContext} onClick={() => createTakeFromPrompt(promptDraft, activeTake, true)}>
                                                    以新提示词生成（新方案）
                                                </Button>
                                            </div>
                                        ) : (
                                            <Button size="small" icon={<Pencil className="size-3.5" />} disabled={activeTake.generating} onClick={() => setEditingLockedPrompt(true)}>
                                                调整
                                            </Button>
                                        )}
                                    </div>
                                    <UpstreamInputsPanel take={activeTake} canvasTheme={canvasTheme} muted={canvasTheme.node.muted} canEdit={Boolean(canvasContext)} onSaveStyle={saveStyleNode} onSaveLayout={saveLayoutPrompt} />
                                </>
                            ) : (
                                <div className="py-4 text-center">
                                    <div className="text-sm font-semibold">本页还没有方案分支</div>
                                    <Button className="mt-3" size="small" icon={<GitBranchPlus className="size-3.5" />} disabled={!canvasContext} onClick={() => beginPageTake(undefined)}>
                                        新建方案分支
                                    </Button>
                                </div>
                            )}
                        </section>

                        <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                            {workspace.takes.length
                                ? workspace.takes.map((take) => {
                                      const selectedTake = take.index === activeTake?.index;
                                      return (
                                          <section
                                              key={take.key}
                                              className="group rounded-xl border p-3"
                                              style={{ background: selectedTake ? canvasTheme.toolbar.activeBg : canvasTheme.node.fill, borderColor: selectedTake ? canvasTheme.node.activeStroke : canvasTheme.node.stroke }}
                                              aria-labelledby={`ppt-take-${page.index}-${take.index}`}
                                          >
                                              <div className="flex items-center gap-2">
                                                  <button type="button" className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left" onClick={() => selectTake(take.index)}>
                                                      <span>
                                                          <span id={`ppt-take-${page.index}-${take.index}`} className="block text-sm font-semibold">
                                                              方案分支 {take.index + 1}
                                                          </span>
                                                          <span className="mt-0.5 block text-[11px]" style={{ color: canvasTheme.node.muted }}>
                                                              {take.generating ? "生成中" : take.candidates.length ? `${take.candidates.length} 个候选稿` : "尚未生成"}
                                                          </span>
                                                      </span>
                                                      {selectedTake ? (
                                                          <span className="flex items-center gap-1 text-xs font-medium">
                                                              <Check className="size-3.5" aria-hidden="true" />
                                                              当前分支
                                                          </span>
                                                      ) : null}
                                                  </button>
                                                  {/* #32：分支删除入口，hover 才显现，避免误触 */}
                                                  <button
                                                      type="button"
                                                      className="shrink-0 rounded-md p-1 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                                                      style={{ color: token.colorError }}
                                                      aria-label={`删除方案分支 ${take.index + 1}`}
                                                      title="删除该方案分支"
                                                      onClick={(event) => {
                                                          event.stopPropagation();
                                                          confirmDeleteTake(take);
                                                      }}
                                                  >
                                                      <Trash2 className="size-3.5" aria-hidden="true" />
                                                  </button>
                                              </div>

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
                                                                  aria-label={`第 ${page.index} 页，方案 ${take.index + 1}，第 ${versionIndex + 1} 稿${confirmed ? "，已选最终版" : ""}`}
                                                                  onClick={() => selectCandidate(take.index, node.id)}
                                                              >
                                                                  <span className="flex aspect-video items-center justify-center overflow-hidden rounded-md" style={{ background: canvasTheme.node.fill }}>
                                                                      {node.metadata?.content ? (
                                                                          <img src={node.metadata.content} alt="" className="size-full object-contain" />
                                                                      ) : (
                                                                          <ImageOff className="size-5" style={{ color: canvasTheme.node.faint }} aria-hidden="true" />
                                                                      )}
                                                                  </span>
                                                                  <span className="mt-1.5 flex items-center justify-between gap-2 px-0.5 text-[11px]">
                                                                      <span className="font-medium">
                                                                          第{page.index}页 · 方案{take.index + 1} · 第{versionIndex + 1}稿
                                                                      </span>
                                                                      {confirmed ? (
                                                                          <span className="flex shrink-0 items-center gap-1 font-semibold" style={{ color: token.colorSuccess }}>
                                                                              <CheckCircle2 className="size-3" aria-hidden="true" />
                                                                              最终版
                                                                          </span>
                                                                      ) : viewing ? (
                                                                          <span className="shrink-0" style={{ color: canvasTheme.node.muted }}>
                                                                              查看中
                                                                          </span>
                                                                      ) : null}
                                                                  </span>
                                                              </button>
                                                          );
                                                      })}
                                                  </div>
                                              ) : (
                                                  <button
                                                      type="button"
                                                      className="mt-3 flex aspect-video w-full items-center justify-center rounded-lg border border-dashed text-sm"
                                                      style={{ borderColor: canvasTheme.node.stroke, color: canvasTheme.node.muted }}
                                                      onClick={() => selectTake(take.index)}
                                                  >
                                                      {take.generating ? (
                                                          <span className="flex items-center gap-2">
                                                              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                                                              正在生成第一个候选稿
                                                          </span>
                                                      ) : (
                                                          "此分支还没有候选稿"
                                                      )}
                                                  </button>
                                              )}
                                          </section>
                                      );
                                  })
                                : null}

                            {workspace.takes.length ? (
                                <Dropdown
                                    trigger={["click"]}
                                    disabled={!canvasContext || Boolean(newTakeDraft)}
                                    menu={{
                                        items: [
                                            { key: "blank", label: "空白方案" },
                                            { key: "copy", label: "复制当前方案", disabled: !activeTake },
                                        ],
                                        onClick: ({ key }) => beginPageTake(key === "copy" ? activeTake : undefined),
                                    }}
                                >
                                    <button
                                        type="button"
                                        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50"
                                        style={{ borderColor: canvasTheme.node.stroke, color: canvasTheme.node.muted }}
                                        disabled={!canvasContext || Boolean(newTakeDraft)}
                                    >
                                        <Plus className="size-4" aria-hidden="true" />
                                        新方案
                                    </button>
                                </Dropdown>
                            ) : null}
                        </div>
                    </section>

                    <section className="flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-xl border xl:min-h-0" style={{ background: canvasTheme.canvas.background, borderColor: canvasTheme.node.stroke }} aria-label="当前候选稿大图预览">
                        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
                            {activeNode?.metadata?.content ? (
                                <img src={activeNode.metadata.content} alt={`第 ${page.index} 页当前查看候选稿`} className="max-h-full max-w-full cursor-zoom-in rounded-lg object-contain" onClick={() => setLightboxSrc(activeNode.metadata!.content!)} />
                            ) : activeTake?.generating ? (
                                <div className="flex flex-col items-center gap-3 text-center" style={{ color: canvasTheme.node.muted }}>
                                    <LoaderCircle className="size-8 animate-spin" aria-hidden="true" />
                                    <div className="text-sm font-semibold" style={{ color: canvasTheme.node.text }}>
                                        正在生成第一个候选稿…
                                    </div>
                                </div>
                            ) : activeTake?.configNode ? (
                                <div className="flex flex-col items-center gap-3 text-center">
                                    <ScanSearch className="size-10" style={{ color: canvasTheme.node.muted }} aria-hidden="true" />
                                    <div className="text-sm font-semibold" style={{ color: canvasTheme.node.text }}>
                                        这一方案还没有候选稿
                                    </div>
                                    <Button type="primary" icon={<Sparkles className="size-4" />} disabled={!canvasContext || Boolean(newTakeDraft) || (activeTake.canEditPrompt && !promptDraft.trim())} onClick={runGeneration}>
                                        {promptDirty ? "保存并生成首稿" : "生成首稿"}
                                    </Button>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center gap-3 text-center" style={{ color: canvasTheme.node.muted }}>
                                    <ScanSearch className="size-10" aria-hidden="true" />
                                    <div>
                                        <div className="text-sm font-semibold" style={{ color: canvasTheme.node.text }}>
                                            本页还没有方案分支
                                        </div>
                                        <div className="mt-1 text-xs">先在中间栏创建一个方案分支</div>
                                    </div>
                                </div>
                            )}
                        </div>
                        <footer className="shrink-0 border-t p-3" style={{ background: canvasTheme.node.panel, borderColor: canvasTheme.node.stroke }}>
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-sm font-semibold">方案分支 {activeTake?.index != null ? activeTake.index + 1 : "-"}</div>
                                    <div className="mt-0.5 truncate text-xs" style={{ color: canvasTheme.node.muted }}>
                                        {activeNode ? (activeConfirmed ? "此候选稿已选为本页最终版" : "正在查看，尚未确认为最终版") : activeTake?.generating ? "生成中，请稍候" : "暂无选中候选稿"}
                                    </div>
                                </div>
                                {activeConfirmed ? (
                                    <span className="flex shrink-0 items-center gap-1 text-xs font-semibold" style={{ color: token.colorSuccess }}>
                                        <CheckCircle2 className="size-4" aria-hidden="true" />
                                        已选最终版
                                    </span>
                                ) : null}
                            </div>
                            {centerGenerateCtaShown ? null : (
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                        icon={activeTake?.generating ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                                        disabled={!activeTake?.configNode || activeTake.generating || !canvasContext || Boolean(newTakeDraft) || editingLockedPrompt}
                                        onClick={runGeneration}
                                    >
                                        {activeTake?.generating ? (
                                            <span className="inline-flex items-center gap-1.5">
                                                生成中
                                                <span className="font-mono text-[11px]">{formatElapsed(generatingElapsed)}</span>
                                            </span>
                                        ) : activeTake?.candidates.length ? (
                                            "继续生成"
                                        ) : promptDirty ? (
                                            "保存并生成首稿"
                                        ) : (
                                            "生成首稿"
                                        )}
                                    </Button>
                                    <Button icon={<WandSparkles className="size-4" />} disabled={!activeNode?.metadata?.content} onClick={() => activeNode && openAnnotate(activeNode.id)}>
                                        标注改图
                                    </Button>
                                    {activeConfirmed ? (
                                        <>
                                            <Button type="primary" icon={<ArrowRight className="size-4" />} onClick={goToNextUnconfirmed}>
                                                {workspaces.some((item) => item.page.index !== page.index && item.confirmationIssues.length > 0) ? "下一未确认页" : "最终检视"}
                                            </Button>
                                            <Button icon={<CheckCircle2 className="size-4" />} onClick={() => setConfirmed(undefined)}>
                                                取消确认
                                            </Button>
                                        </>
                                    ) : (
                                        <Button type="primary" icon={<CheckCircle2 className="size-4" />} disabled={!activeNode?.metadata?.storageKey} onClick={() => setConfirmed(activeNode?.id)}>
                                            确认此候选稿
                                        </Button>
                                    )}
                                </div>
                            )}
                        </footer>
                    </section>
                </main>
            </div>
            <CanvasImageLightbox src={lightboxSrc} alt={`第 ${page.index} 页候选稿`} onClose={() => setLightboxSrc(null)} />
        </Modal>
    );
}

/**
 * #16：所见即所生成——除锚点提示词外，实际会拼进生成 prompt 的其余输入，展示逻辑与生成路径同源。
 * #29：整体默认收起为一行摘要，把视觉重心让给上方的方案提示词。
 * #30/#31：风格基调（写回风格节点，全局共用）与排版要求（写回本分支配置节点）均支持行内编辑。
 */
function UpstreamInputsPanel({
    take,
    canvasTheme,
    muted,
    canEdit,
    onSaveStyle,
    onSaveLayout,
}: {
    take: PptPageWorkspaceTake;
    canvasTheme: (typeof canvasThemes)[keyof typeof canvasThemes];
    muted: string;
    canEdit: boolean;
    onSaveStyle: (nodeId: string, content: string) => void;
    onSaveLayout: (content: string) => void;
}) {
    const [collapsed, setCollapsed] = useState(true);
    const [editingStyleNodeId, setEditingStyleNodeId] = useState<string | null>(null);
    const [styleDraft, setStyleDraft] = useState("");
    const [editingLayout, setEditingLayout] = useState(false);
    const [layoutDraft, setLayoutDraft] = useState(take.layoutPrompt);

    useEffect(() => {
        setEditingStyleNodeId(null);
        setEditingLayout(false);
        setLayoutDraft(take.layoutPrompt);
    }, [take.key, take.layoutPrompt]);

    if (take.composerContent) {
        return (
            <div className="mt-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: canvasTheme.node.stroke, background: canvasTheme.node.fill }}>
                <div className="font-medium" style={{ color: canvasTheme.node.text }}>
                    本分支已启用组装提示词，生成以组装内容为准
                </div>
                <div className="mt-1 line-clamp-3 whitespace-pre-wrap" style={{ color: muted }}>
                    {take.composerContent}
                </div>
            </div>
        );
    }

    if (collapsed) {
        return (
            <button type="button" className="mt-3 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-xs transition" style={{ borderColor: canvasTheme.node.stroke, color: muted }} onClick={() => setCollapsed(false)}>
                <span>其他生成输入：风格基调 + 排版要求</span>
                <span className="shrink-0 underline underline-offset-2">展开</span>
            </button>
        );
    }

    return (
        <div className="mt-3 space-y-2 rounded-lg border p-2.5" style={{ borderColor: canvasTheme.node.stroke }}>
            <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: muted }}>
                    其他生成输入
                </span>
                <button type="button" className="text-[11px] underline underline-offset-2" style={{ color: muted }} onClick={() => setCollapsed(true)}>
                    收起
                </button>
            </div>

            {take.upstreamInputs.length ? (
                <ul className="space-y-1.5">
                    {take.upstreamInputs.map((input) => {
                        const isStyle = input.pptRole === "style" && input.type === "text";
                        const isEditingThis = editingStyleNodeId === input.nodeId;
                        return (
                            <li key={input.nodeId} className="flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs" style={{ borderColor: canvasTheme.node.stroke }}>
                                {input.type === "image" ? (
                                    input.image?.dataUrl ? (
                                        <img src={input.image.dataUrl} alt="" className="size-8 shrink-0 rounded object-cover" />
                                    ) : (
                                        <ImageOff className="size-4 shrink-0" style={{ color: muted }} aria-hidden="true" />
                                    )
                                ) : input.type === "video" ? (
                                    <Video className="size-4 shrink-0" style={{ color: muted }} aria-hidden="true" />
                                ) : input.type === "audio" ? (
                                    <Music2 className="size-4 shrink-0" style={{ color: muted }} aria-hidden="true" />
                                ) : (
                                    <FileText className="size-4 shrink-0" style={{ color: muted }} aria-hidden="true" />
                                )}
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="font-medium" style={{ color: canvasTheme.node.text }}>
                                            {input.pptRole === "style" ? "风格基调" : input.title}
                                        </span>
                                        {isStyle && canEdit && !take.generating && !isEditingThis ? (
                                            <button
                                                type="button"
                                                className="shrink-0 text-[11px] underline underline-offset-2"
                                                style={{ color: muted }}
                                                onClick={() => {
                                                    setEditingStyleNodeId(input.nodeId);
                                                    setStyleDraft(input.text ?? "");
                                                }}
                                            >
                                                编辑
                                            </button>
                                        ) : null}
                                    </div>
                                    {isEditingThis && !take.generating ? (
                                        <>
                                            <Input.TextArea className="mt-1.5" value={styleDraft} autoSize={{ minRows: 3, maxRows: 12 }} variant="filled" onChange={(event) => setStyleDraft(event.target.value)} />
                                            <div className="mt-1 text-[11px]" style={{ color: muted }}>
                                                全部页面共用，修改将影响所有页面
                                            </div>
                                            <div className="mt-1.5 flex justify-end gap-2">
                                                <Button size="small" onClick={() => setEditingStyleNodeId(null)}>
                                                    取消
                                                </Button>
                                                <Button
                                                    size="small"
                                                    type="primary"
                                                    icon={<Save className="size-3" />}
                                                    disabled={!styleDraft.trim()}
                                                    onClick={() => {
                                                        onSaveStyle(input.nodeId, styleDraft);
                                                        setEditingStyleNodeId(null);
                                                    }}
                                                >
                                                    保存
                                                </Button>
                                            </div>
                                        </>
                                    ) : input.text ? (
                                        <div className="mt-0.5 whitespace-pre-wrap" style={{ color: muted }}>
                                            {input.text}
                                        </div>
                                    ) : null}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <div className="text-xs" style={{ color: muted }}>
                    无其他上游输入
                </div>
            )}

            <div className="rounded-lg border px-2.5 py-1.5 text-xs" style={{ borderColor: canvasTheme.node.stroke }}>
                <div className="flex items-center justify-between gap-2">
                    <span className="font-medium" style={{ color: canvasTheme.node.text }}>
                        排版要求
                    </span>
                    {canEdit && !take.generating && !editingLayout ? (
                        <button
                            type="button"
                            className="shrink-0 text-[11px] underline underline-offset-2"
                            style={{ color: muted }}
                            onClick={() => {
                                setEditingLayout(true);
                                setLayoutDraft(take.layoutPrompt);
                            }}
                        >
                            编辑
                        </button>
                    ) : null}
                </div>
                {editingLayout && !take.generating ? (
                    <>
                        <Input.TextArea className="mt-1.5" value={layoutDraft} autoSize={{ minRows: 3, maxRows: 12 }} variant="filled" onChange={(event) => setLayoutDraft(event.target.value)} />
                        <div className="mt-1 text-[11px]" style={{ color: muted }}>
                            仅作用于本方案分支
                        </div>
                        <div className="mt-1.5 flex justify-end gap-2">
                            <Button
                                size="small"
                                onClick={() => {
                                    setEditingLayout(false);
                                    setLayoutDraft(take.layoutPrompt);
                                }}
                            >
                                取消
                            </Button>
                            <Button
                                size="small"
                                type="primary"
                                icon={<Save className="size-3" />}
                                onClick={() => {
                                    onSaveLayout(layoutDraft);
                                    setEditingLayout(false);
                                }}
                            >
                                保存
                            </Button>
                        </div>
                    </>
                ) : take.layoutPrompt ? (
                    <div className="mt-0.5 whitespace-pre-wrap" style={{ color: muted }}>
                        {take.layoutPrompt}
                    </div>
                ) : (
                    <div className="mt-0.5" style={{ color: muted }}>
                        未设置
                    </div>
                )}
            </div>
        </div>
    );
}
