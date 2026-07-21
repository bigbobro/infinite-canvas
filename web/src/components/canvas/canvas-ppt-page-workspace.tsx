import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Dropdown, Input, InputNumber, Modal, Popover, Select, Tooltip, theme as antdTheme } from "antd";
import { ArrowRight, CheckCircle2, ChevronDown, FileText, GitBranchPlus, ImageOff, Layers3, LoaderCircle, Music2, Network, Pencil, Plus, Presentation, RotateCcw, Save, ScanSearch, Sparkles, Trash2, Video, WandSparkles } from "lucide-react";
import { nanoid } from "nanoid";

import { CanvasImageLightbox } from "@/components/canvas/canvas-image-lightbox";
import { planHasBlockingCompilationIssues, PptGenerationPlanSummary } from "@/components/canvas/canvas-ppt-generation-confirm";
import { CanvasPptPromptEditor } from "@/components/canvas/canvas-ppt-prompt-editor";
import { imageAspectOptions, imageSizeLabel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { GENERATION_COUNT_MAX, GENERATION_COUNT_MIN, getGenerationCount, resolveGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { PPT_PAGE_PROMPT } from "@/lib/ppt/deck-builder";
import type { PptGenerationModule } from "@/lib/ppt/generation-execution";
import { createGenerationPlan, type GenerationPlan } from "@/lib/ppt/generation-plan";
import { setPptPageConfirmedNode } from "@/lib/ppt/page-confirmation";
import { buildPptPageWorkspace, type PptPageWorkspaceTake } from "@/lib/ppt/page-workspace";
import { buildPptPageSpec, derivePptStyleRules } from "@/lib/ppt/prompt-compiler";
import { cn } from "@/lib/utils";
import { useCopyText } from "@/hooks/use-copy-text";
import { flushCanvasStore, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAnnotateStore } from "@/stores/use-annotate-store";
import { modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeMetadata, type PptGenerationRequestStatus, type PptGenerationRequestTrace, type PptGenerationRunStatus, type PptGenerationRunSummary } from "@/types/canvas";

const ROW_GAP = 48;

type GenerationConfigDraft = { model: string; size: string; count: number };

type Props = {
    open: boolean;
    projectId: string;
    pageId: string;
    targetTakeId?: string;
    generationModule: PptGenerationModule;
    onPageChange: (pageId: string) => void;
    onTargetTakeApplied?: () => void;
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
function useElapsedSeconds(active: boolean, startedAt?: string) {
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
        if (!active) {
            setSeconds(0);
            return;
        }
        const start = startedAt ? Date.parse(startedAt) : Date.now();
        const safeStart = Number.isFinite(start) ? start : Date.now();
        setSeconds(Math.max(0, Math.floor((Date.now() - safeStart) / 1000)));
        const timer = window.setInterval(() => setSeconds(Math.max(0, Math.floor((Date.now() - safeStart) / 1000))), 1000);
        return () => window.clearInterval(timer);
    }, [active, startedAt]);
    return seconds;
}

const requestStatusLabel: Record<PptGenerationRequestStatus, string> = {
    draft: "待提交",
    persisted: "计划已保存",
    submitting: "提交中",
    submitted: "已提交 / 排队",
    running: "生成中",
    submission_unknown: "提交结果未知",
    succeeded: "结果已返回",
    materializing: "保存结果中",
    completed: "已回填",
    recoverable_error: "可恢复异常",
    failed: "已失败",
    abandoned: "已放弃",
};

const runStatusLabel: Record<PptGenerationRunStatus, string> = {
    preparing: "准备中",
    running: "生成中",
    needs_attention: "需要处理",
    completed: "已完成",
    partial: "部分完成",
    failed: "失败",
    abandoned: "已放弃",
};

function redactDiagnosticText(value: string | undefined, secrets: readonly string[] = []) {
    if (!value) return value;
    return secrets
        .filter((secret) => secret.length >= 4)
        .reduce((text, secret) => text.split(secret).join("[REDACTED]"), value)
        .slice(0, 500)
        .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=_-]+/gi, "[REDACTED_DATA]")
        .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(/((?:api[_-]?key|access[_-]?token|token|authorization)\s*[:=]\s*)[^\s&,;]+/gi, "$1[REDACTED]")
        .replace(/([?&](?:key|api_key|token|access_token)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function formatElapsed(seconds: number) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}

export function CanvasPptPageWorkspace({ open, projectId, pageId, targetTakeId, generationModule, onPageChange, onTargetTakeApplied, controls }: Props) {
    const { message, modal } = App.useApp();
    const copyText = useCopyText();
    const { token } = antdTheme.useToken();
    const canvasTheme = canvasThemes[useThemeStore((state) => state.theme)];
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const updateProject = useCanvasStore((state) => state.updateProject);
    const canvasContext = useAgentStore((state) => state.canvasContext);
    const openAnnotate = useAnnotateStore((state) => state.open);
    const effectiveConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const [activeTakeId, setActiveTakeId] = useState<string>();
    const [activeNodeId, setActiveNodeId] = useState<string>();
    const [promptDraft, setPromptDraft] = useState("");
    const [newTakeDraft, setNewTakeDraft] = useState<{ sourceTakeId?: string; prompt: string } | null>(null);
    const [promptEditorOpen, setPromptEditorOpen] = useState(false);
    const [compiledOverrideOpen, setCompiledOverrideOpen] = useState(false);
    const [compiledOverrideDraft, setCompiledOverrideDraft] = useState("");
    const [configPopoverOpen, setConfigPopoverOpen] = useState(false);
    const [configDraft, setConfigDraft] = useState<GenerationConfigDraft>();
    const [configBaseline, setConfigBaseline] = useState<GenerationConfigDraft>();
    const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
    const selectionPageIdRef = useRef<string | undefined>(undefined);

    const workspaces = useMemo(() => {
        if (!project?.ppt) return [];
        return [...project.ppt.pages].sort((left, right) => left.index - right.index).map((page) => buildPptPageWorkspace(project, page));
    }, [project]);
    const workspace = workspaces.find((item) => item.page.pageId === pageId);
    const activeTake = workspace?.takes.find((take) => take.takeId === activeTakeId) ?? workspace?.takes[0];
    const isExtractMode = project?.ppt?.mode === "extract";
    const fallbackPrompt = workspace ? (isExtractMode ? workspace.page.outline : [`标题：${workspace.page.title}`, workspace.page.outline, workspace.page.visualHint ? `视觉建议：${workspace.page.visualHint}` : ""].filter(Boolean).join("\n\n")) : "";
    const latestGenerationRun = activeTake ? [...activeTake.generationRuns].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1) : undefined;
    const latestGenerationRequests = latestGenerationRun ? activeTake?.generationRequests.filter((request) => request.runId === latestGenerationRun.runId).sort((left, right) => left.slotIndex - right.slotIndex) || [] : [];
    const generatingElapsed = useElapsedSeconds(Boolean(activeTake?.generating), latestGenerationRun?.createdAt);
    const activeGenerationConfig = useMemo(() => (activeTake?.configNode ? resolveGenerationConfig(effectiveConfig, activeTake.configNode, "image") : undefined), [activeTake?.configNode, effectiveConfig]);
    const singleGenerationPlan = useMemo(() => {
        if (!project || !activeTake) return undefined;
        return createGenerationPlan({ kind: "generateSingle", takeId: activeTake.takeId }, { project, effectiveConfig });
    }, [activeTake, effectiveConfig, project]);
    const overrideValidationPlan = useMemo(() => {
        if (!compiledOverrideOpen || !project || !activeTake?.configNode) return undefined;
        const value = compiledOverrideDraft.trim();
        const previewProject = {
            ...project,
            nodes: project.nodes.map((node) =>
                node.id === activeTake.configNode?.id
                    ? {
                          ...node,
                          metadata: {
                              ...node.metadata,
                              pptCompiledPromptOverride: value || undefined,
                              pptCompiledPromptReviewedOverride: value && node.metadata?.pptCompiledPromptReviewedOverride === value ? value : undefined,
                          },
                      }
                    : node,
            ),
        };
        return createGenerationPlan({ kind: "generateSingle", takeId: activeTake.takeId }, { project: previewProject, effectiveConfig });
    }, [activeTake?.configNode, activeTake?.takeId, compiledOverrideDraft, compiledOverrideOpen, effectiveConfig, project]);
    const textModelReady = Boolean(effectiveConfig.textModel.trim() && isAiConfigReady(effectiveConfig, effectiveConfig.textModel));

    useEffect(() => {
        if (!open) return;
        if (!workspace) return;
        const confirmedTake = workspace.takes.find((take) => take.candidates.some((node) => node.id === workspace.resolvedConfirmedNodeId));
        const fallbackTake = [...workspace.takes].reverse().find((take) => take.candidates.length) ?? workspace.takes.at(-1);
        const currentTake = workspace.takes.find((take) => take.takeId === activeTakeId);
        const targetTake = workspace.takes.find((take) => take.takeId === targetTakeId);
        const pageChanged = selectionPageIdRef.current !== pageId;
        const nextTake = targetTake ?? (pageChanged ? (confirmedTake ?? fallbackTake) : (currentTake ?? confirmedTake ?? fallbackTake));
        const nextNodeId = nextTake?.candidates.some((node) => node.id === activeNodeId) ? activeNodeId : (nextTake?.candidates.find((node) => node.id === workspace.resolvedConfirmedNodeId)?.id ?? nextTake?.candidates.at(-1)?.id);
        selectionPageIdRef.current = pageId;
        if (activeTakeId !== nextTake?.takeId) setActiveTakeId(nextTake?.takeId);
        if (activeNodeId !== nextNodeId) setActiveNodeId(nextNodeId);
        if (targetTake) onTargetTakeApplied?.();
    }, [activeNodeId, activeTakeId, onTargetTakeApplied, open, pageId, targetTakeId, workspace]);

    useEffect(() => {
        if (newTakeDraft) return;
        setPromptDraft(activeTake?.prompt ?? fallbackPrompt);
    }, [activeTake?.takeId, activeTake?.prompt, fallbackPrompt, newTakeDraft, pageId]);

    useEffect(() => {
        setPromptEditorOpen(false);
        setCompiledOverrideOpen(false);
        setConfigPopoverOpen(false);
        setConfigDraft(undefined);
        setConfigBaseline(undefined);
    }, [activeTake?.takeId, pageId]);

    useEffect(() => {
        if (open) return;
        setPromptEditorOpen(false);
        setCompiledOverrideOpen(false);
        setConfigPopoverOpen(false);
        setConfigDraft(undefined);
        setConfigBaseline(undefined);
    }, [open]);

    useEffect(() => {
        if (!activeTake?.generating) return;
        setConfigPopoverOpen(false);
        setConfigDraft(undefined);
        setConfigBaseline(undefined);
    }, [activeTake?.generating]);

    useEffect(() => {
        setLightboxSrc(null);
    }, [pageId]);

    if (!open || !project?.ppt || !workspace) return null;

    const ppt = project.ppt;
    const page = workspace.page;
    const pageSpec = ppt.pageSpecs.find((spec) => spec.pageId === page.pageId);
    const activeNode = activeTake?.candidates.find((node) => node.id === activeNodeId);
    const possiblySubmittedStatuses = ["submitting", "submitted", "running", "submission_unknown", "succeeded", "materializing", "recoverable_error"];
    const riskyRequests = activeTake?.generationRequests.filter((request) => !request.remoteTaskId && possiblySubmittedStatuses.includes(request.status)) || [];
    const riskyRequest = riskyRequests[0];
    const repeatBillingRisk = Boolean(activeTake?.requiresRepeatBillingConfirmation);
    const retrievableRequest = activeTake?.generationRequests.find((request) => request.remoteTaskId && possiblySubmittedStatuses.includes(request.status));
    const abandonableRequest = riskyRequest ?? (retrievableRequest?.status === "recoverable_error" ? retrievableRequest : undefined);
    const activeConfirmed = Boolean(activeNode && activeNode.id === workspace.resolvedConfirmedNodeId);
    // 预览井下缘信息条用：当前查看候选稿在其方案分支内的序号（第 N 稿）。
    const activeVersionIndex = activeTake?.candidates.findIndex((node) => node.id === activeNode?.id) ?? -1;
    const candidateCount = workspace.takes.reduce((total, take) => total + take.candidates.length, 0);
    const centerGenerateCtaShown = Boolean(!activeNode && !activeTake?.generating && activeTake?.configNode);
    const takeOverflow = workspace.takes.length >= 5;
    const visibleTakes = takeOverflow ? (activeTake ? [activeTake] : []) : workspace.takes;
    const overflowTakes = takeOverflow ? workspace.takes.filter((take) => take.takeId !== activeTake?.takeId) : [];
    const generationCount = singleGenerationPlan?.callCount || (activeGenerationConfig ? getGenerationCount(activeGenerationConfig.count) : 1);
    const configCount = activeGenerationConfig ? getGenerationCount(activeGenerationConfig.count) : 1;
    const defaultConfigDraft = activeGenerationConfig ? { model: activeGenerationConfig.model, size: activeGenerationConfig.size, count: configCount } : undefined;
    const configSummary = activeGenerationConfig ? `${modelOptionLabel(effectiveConfig, activeGenerationConfig.model)} · ${imageSizeLabel(activeGenerationConfig.size)} · ${configCount} 张` : "生成配置缺失";
    const configDraftDirty = Boolean(configDraft && configBaseline && (configDraft.model !== configBaseline.model || configDraft.size !== configBaseline.size || configDraft.count !== configBaseline.count));
    const generationLabel = (label: string) => (generationCount > 1 ? `${label}（${generationCount} 张）` : label);
    const returnedRequestCount = latestGenerationRequests.filter((request) => request.resultIdentity).length;
    const completedRequestCount = latestGenerationRequests.filter((request) => request.status === "completed").length;
    const generationRuns = project.nodes
        .map((node) => node.metadata?.pptGenerationRun)
        .filter((run): run is PptGenerationRunSummary => Boolean(run))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const generationRequests = project.nodes.map((node) => node.metadata?.pptGenerationRequest).filter((request): request is PptGenerationRequestTrace => Boolean(request));
    const runsByBatch = new Map<string, typeof generationRuns>();
    generationRuns.forEach((run) => runsByBatch.set(run.batchId, [...(runsByBatch.get(run.batchId) || []), run]));
    const generationBatches = [...runsByBatch.entries()];
    const persistProject = async (patch: Parameters<typeof updateProject>[1]) => {
        updateProject(projectId, patch);
        try {
            await flushCanvasStore();
            return true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "画布保存失败");
            return false;
        }
    };

    const pageSpecForPrompt = (value: string) => {
        const next = buildPptPageSpec({
            mode: ppt.mode || "outline",
            sourceMaterial: ppt.sourceMaterial,
            page: { pageId: page.pageId, title: page.title, outline: value, visualHint: page.visualHint },
            version: (pageSpec?.version || 0) + 1,
        });
        if (
            pageSpec &&
            JSON.stringify({ lockedCopy: next.lockedCopy, lockedFacts: next.lockedFacts.map(({ kind, value: factValue }) => ({ kind, value: factValue })), layoutIntent: next.layoutIntent, assetRefs: next.assetRefs, message: next.message }) ===
                JSON.stringify({
                    lockedCopy: pageSpec.lockedCopy,
                    lockedFacts: pageSpec.lockedFacts.map(({ kind, value: factValue }) => ({ kind, value: factValue })),
                    layoutIntent: pageSpec.layoutIntent,
                    assetRefs: pageSpec.assetRefs,
                    message: pageSpec.message,
                })
        ) {
            return pageSpec;
        }
        return next;
    };

    const executeGenerationPlan = async (plan: GenerationPlan) => {
        if (!plan.runs.length) {
            message.warning(plan.excludedPages[0]?.reason || "没有可生成的方案");
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

    const runGeneration = async () => {
        if (!activeTake?.configNode) {
            message.warning(activeTake ? `第 ${page.index} 页方案 ${activeTake.index + 1} 的配置缺失` : `第 ${page.index} 页尚未创建方案`);
            return;
        }
        if (!activeTake.anchorNode) {
            message.warning(`第 ${page.index} 页方案 ${activeTake.index + 1} 的提示词缺失`);
            return;
        }
        if (activeTake.canEditPrompt && !activeTake.prompt.trim()) {
            message.warning("请先填写方案提示词");
            return;
        }
        if (!singleGenerationPlan) return;
        if (planHasBlockingCompilationIssues(singleGenerationPlan)) {
            modal.warning({ title: "最终提示词需要处理", content: <PptGenerationPlanSummary plan={singleGenerationPlan} />, okText: "知道了", width: 680 });
            return;
        }
        if (retrievableRequest) {
            modal.confirm({
                title: "已有任务可重新获取",
                content: "请先继续获取原任务，避免新建请求导致重复计费。如果确定放弃原任务，请先在错误区标记放弃。",
                okText: "重新获取",
                cancelText: "暂不处理",
                onOk: () => retrieveExisting(),
            });
            return;
        }
        if (riskyRequest || repeatBillingRisk) {
            modal.confirm({
                title: "仍要重新生成？",
                content: (
                    <>
                        <p>上一次请求可能已经产生费用，且无法继续取回，本次可能重复计费。</p>
                        <PptGenerationPlanSummary plan={singleGenerationPlan} repeatBillingRiskCount={1} />
                    </>
                ),
                okText: "仍要生成",
                cancelText: "取消",
                onOk: async () => {
                    try {
                        for (const request of riskyRequests) {
                            const recovery = await generationModule.recover({ type: "abandonUnknown", requestId: request.requestId });
                            void recovery.settled.catch((error) => message.error(error instanceof Error ? error.message : "旧请求状态保存失败"));
                        }
                        await executeGenerationPlan(singleGenerationPlan);
                    } catch (error) {
                        message.error(error instanceof Error ? error.message : "无法开始新的生成");
                    }
                },
            });
            return;
        }
        if (activeTake.generationRuns.length || activeTake.candidates.length) {
            modal.confirm({
                title: "重新生成当前方案？",
                content: (
                    <>
                        <p>旧运行和候选稿会保留。</p>
                        <PptGenerationPlanSummary plan={singleGenerationPlan} />
                    </>
                ),
                okText: "确认生成",
                cancelText: "取消",
                onOk: () => executeGenerationPlan(singleGenerationPlan),
            });
            return;
        }
        modal.confirm({
            title: "生成当前方案？",
            content: <PptGenerationPlanSummary plan={singleGenerationPlan} />,
            okText: "确认生成",
            cancelText: "取消",
            width: 680,
            onOk: () => executeGenerationPlan(singleGenerationPlan),
        });
    };

    const retrieveExisting = async () => {
        if (!retrievableRequest) return;
        try {
            const result = await generationModule.recover({ type: "retrieveExisting", requestId: retrievableRequest.requestId });
            void result.settled.catch((error) => message.error(error instanceof Error ? error.message : "任务结果保存失败"));
            message.info("已开始重新获取原任务结果");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "重新获取失败");
        }
    };

    const abandonPendingRequest = () => {
        if (!abandonableRequest) return;
        modal.confirm({
            title: "放弃这次待处理请求？",
            content: "只会停止追踪这次请求，不会删除已生成的其他候选稿。之后再次生成会创建新请求，可能重复计费。",
            okText: "标记放弃",
            cancelText: "取消",
            onOk: async () => {
                const result = await generationModule.recover({ type: "abandonUnknown", requestId: abandonableRequest.requestId });
                void result.settled.catch((error) => message.error(error instanceof Error ? error.message : "请求状态保存失败"));
            },
        });
    };

    const copyGenerationDiagnostic = () => {
        if (!activeTake || (!activeTake.generationRequests.length && !activeTake.generationRuns.length)) return;
        const secrets = [
            effectiveConfig.apiKey,
            ...effectiveConfig.channels.map((channel) => channel.apiKey),
            activeTake.prompt,
            activeTake.layoutPrompt,
            activeTake.configNode?.metadata?.pptCompiledPromptOverride || "",
            ...activeTake.upstreamInputs.map((input) => input.text || ""),
        ];
        const requests = activeTake.generationRequests.map((request) => ({
            ...request,
            error: redactDiagnosticText(request.error, secrets),
            recentEvents: (request.recentEvents || []).map((event) => ({ ...event, error: redactDiagnosticText(event.error, secrets) })),
        }));
        copyText(JSON.stringify({ projectId, pageId: page.pageId, takeId: activeTake.takeId, runs: activeTake.generationRuns, requests }, null, 2), "生成诊断已复制");
    };

    const updateConfigPopover = (nextOpen: boolean) => {
        if (nextOpen && defaultConfigDraft) {
            setConfigDraft(defaultConfigDraft);
            setConfigBaseline(defaultConfigDraft);
        } else if (!nextOpen) {
            setConfigDraft(undefined);
            setConfigBaseline(undefined);
        }
        setConfigPopoverOpen(nextOpen);
    };

    const saveGenerationConfig = async () => {
        if (!canvasContext || !activeTake?.configNode || !configDraft || !configBaseline) return;
        const metadata: CanvasNodeMetadata = {};
        if (configDraft.model !== configBaseline.model) metadata.model = configDraft.model;
        if (configDraft.size !== configBaseline.size) metadata.size = configDraft.size;
        if (configDraft.count !== configBaseline.count) metadata.count = configDraft.count;
        setConfigPopoverOpen(false);
        setConfigDraft(undefined);
        setConfigBaseline(undefined);
        if (!Object.keys(metadata).length) return;
        const next = canvasContext.applyTrustedOps([{ type: "update_node", id: activeTake.configNode.id, metadata }]);
        if (!(await persistProject({ nodes: next.nodes, connections: next.connections }))) return;
        message.success("生成配置已更新");
    };

    const savePrompt = async (value: string) => {
        if (!canvasContext || !activeTake?.anchorNode || !activeTake.canEditPrompt) return;
        if (!value.trim()) {
            message.warning("方案提示词不能为空");
            return;
        }
        const nextPageSpec = pageSpecForPrompt(value);
        const next = canvasContext.applyTrustedOps([{ type: "update_node", id: activeTake.anchorNode.id, metadata: { content: value, status: "success" } }]);
        if (!(await persistProject({ nodes: next.nodes, connections: next.connections, ppt: nextPageSpec === pageSpec ? ppt : { ...ppt, pageSpecs: [...ppt.pageSpecs.filter((spec) => spec.pageId !== page.pageId), nextPageSpec] } }))) return;
        setPromptEditorOpen(false);
        message.success(`方案 ${activeTake.index + 1} 的提示词已保存`);
    };

    // #30：风格基调节点为全部页面共用，保存直接写回该节点，影响全部方案分支。
    const saveStyleNode = async (nodeId: string, content: string) => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        if (!content.trim()) {
            message.warning("风格基调不能为空");
            return;
        }
        const styleRules = derivePptStyleRules(ppt.requirements, content);
        const next = canvasContext.applyTrustedOps([{ type: "update_node", id: nodeId, metadata: { content, status: "success" } }]);
        if (
            !(await persistProject({
                nodes: next.nodes,
                connections: next.connections,
                ppt: {
                    ...ppt,
                    style: { ...ppt.style, description: content },
                    deckBrief: { ...ppt.deckBrief, ...styleRules, version: ppt.deckBrief.version + 1 },
                },
            }))
        )
            return;
        message.success("风格基调已更新，将影响全部页面");
    };

    // #31：排版要求只作用于当前方案分支，存在专用字段 pptLayoutPrompt。
    // metadata.prompt 不再作为 PPT Compiler 的指令来源。
    const saveLayoutPrompt = async (content: string) => {
        if (!canvasContext || !activeTake?.configNode) {
            message.warning("画布尚未就绪，请稍后再试");
            return false;
        }
        const value = content.trim();
        const persistLayout = async (reviewed: boolean) => {
            const next = canvasContext.applyTrustedOps([
                {
                    type: "update_node",
                    id: activeTake.configNode!.id,
                    metadata: {
                        pptLayoutPrompt: value,
                        pptLayoutPromptReviewed: value && reviewed ? value : undefined,
                    },
                },
            ]);
            if (!(await persistProject({ nodes: next.nodes, connections: next.connections }))) return false;
            message.success(`方案分支 ${activeTake.index + 1} 的排版要求已保存`);
            return true;
        };
        const alreadyReviewed = Boolean(value && activeTake.configNode.metadata?.pptLayoutPromptReviewed === value);
        if (value && value !== PPT_PAGE_PROMPT && !alreadyReviewed) {
            return new Promise<boolean>((resolve) => {
                modal.confirm({
                    title: "确认排版要求",
                    content: "自定义排版文本会进入最终提示词。请确认其中没有未经确认的文案或事实；后续再修改时会重新要求确认。",
                    okText: "确认准确并保存",
                    cancelText: "继续修改",
                    onOk: async () => resolve(await persistLayout(true)),
                    onCancel: () => resolve(false),
                });
            });
        }
        return persistLayout(alreadyReviewed);
    };

    const saveCompiledPromptOverride = async () => {
        if (!canvasContext || !activeTake?.configNode || activeTake.generating || activeTake.unresolvedGeneration) return;
        const value = compiledOverrideDraft.trim();
        const blockers = overrideValidationPlan?.compilation?.issues.filter((issue) => issue.severity === "blocking") || [];
        const needsExplicitReview = blockers.length > 0 && blockers.every((issue) => issue.code === "override_review_required");
        const alreadyReviewed = Boolean(value && activeTake.configNode.metadata?.pptCompiledPromptReviewedOverride === value);
        if (value && blockers.length && !needsExplicitReview) {
            message.warning("覆盖未保存：请先处理下方必须处理的检查项");
            return;
        }
        const persistOverride = async (reviewed: boolean) => {
            const next = canvasContext.applyTrustedOps([
                {
                    type: "update_node",
                    id: activeTake.configNode!.id,
                    metadata: {
                        pptCompiledPromptOverride: value || undefined,
                        pptCompiledPromptReviewedOverride: value && reviewed ? value : undefined,
                    },
                },
            ]);
            if (!(await persistProject({ nodes: next.nodes, connections: next.connections }))) return;
            setCompiledOverrideOpen(false);
            message.success(value ? "最终提示词覆盖已保存并通过当前检查" : "已恢复由页面规格自动编译");
        };
        if (needsExplicitReview) {
            modal.confirm({
                title: "确认新增或改写内容",
                content: "这些内容无法由 Compiler 自动溯源。请确认文案和事实准确；后续再修改时会重新要求确认。",
                okText: "确认准确并保存",
                cancelText: "继续修改",
                onOk: () => persistOverride(true),
            });
            return;
        }
        await persistOverride(alreadyReviewed);
    };

    const confirmPageSpecReview = async () => {
        if (!pageSpec?.requiresReview || pageSpec.reviewedAt) return;
        const reviewedAt = new Date().toISOString();
        if (!(await persistProject({ ppt: { ...ppt, pageSpecs: ppt.pageSpecs.map((spec) => (spec.pageId === page.pageId ? { ...spec, version: spec.version + 1, reviewedAt } : spec)) } }))) return;
        message.success("已确认本页正文与布局拆分");
    };

    const setConfirmed = async (confirmedNodeId?: string) => {
        await persistProject({ ppt: setPptPageConfirmedNode(ppt, page.pageId, confirmedNodeId) });
    };

    // #20：确认后自动前进到下一个未确认页；全部确认完则跳最终检视。
    const goToNextUnconfirmed = () => {
        const currentPos = workspaces.findIndex((item) => item.page.pageId === page.pageId);
        const rotated = [...workspaces.slice(currentPos + 1), ...workspaces.slice(0, currentPos + 1)];
        const next = rotated.find((item) => item.page.pageId !== page.pageId && item.confirmationIssues.length > 0);
        if (next) changePage(next.page.pageId);
        else discardPendingPrompt(controls.onOpenFinalReview);
    };

    const createTakeFromPrompt = async (prompt: string, sourceTake: PptPageWorkspaceTake | undefined, autoGenerate: boolean) => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        if (!prompt.trim()) {
            message.warning("方案提示词不能为空");
            return;
        }
        const nextPageSpec = pageSpecForPrompt(prompt);
        const projectWithSpec =
            nextPageSpec === pageSpec
                ? project
                : {
                      ...project,
                      ppt: { ...ppt, pageSpecs: [...ppt.pageSpecs.filter((spec) => spec.pageId !== page.pageId), nextPageSpec] },
                  };

        const takeId = nanoid();
        const outlineId = nanoid();
        const configId = nanoid();
        // 派生/复制继承源方案的 effective 配置；空白方案使用当前全局 effective 配置。
        const seedLayoutPrompt = sourceTake?.layoutPrompt?.trim() || (isExtractMode ? "" : PPT_PAGE_PROMPT);
        const inheritedConfig = resolveGenerationConfig(effectiveConfig, sourceTake?.configNode, "image");
        const configMetadata: CanvasNodeMetadata = {
            prompt: "",
            pptLayoutPrompt: seedLayoutPrompt,
            ...(seedLayoutPrompt && sourceTake?.configNode?.metadata?.pptLayoutPromptReviewed === seedLayoutPrompt ? { pptLayoutPromptReviewed: seedLayoutPrompt } : {}),
            model: inheritedConfig.model,
            size: inheritedConfig.size,
            count: getGenerationCount(inheritedConfig.count),
            pptPageId: page.pageId,
            pptTakeId: takeId,
            pptPageIndex: page.index,
            pptRole: "page",
        };
        if (isExtractMode) configMetadata.composerContent = "";

        const gridNodes = project.nodes.filter((node) => node.metadata?.pptPageId);
        const gridBottom = gridNodes.length ? Math.max(...gridNodes.map((node) => node.position.y + node.height)) : undefined;
        const newRowY = gridBottom == null ? undefined : gridBottom + ROW_GAP;
        const outlinePosition = sourceTake?.anchorNode && newRowY != null ? { x: sourceTake.anchorNode.position.x, y: newRowY } : undefined;
        const configPosition = sourceTake?.configNode && newRowY != null ? { x: sourceTake.configNode.position.x, y: newRowY } : undefined;
        const inheritedInputNodeIds = sourceTake?.configNode
            ? [...new Set(project.connections.filter((connection) => connection.toNodeId === sourceTake.configNode?.id && connection.fromNodeId !== sourceTake.anchorNode?.id).map((connection) => connection.fromNodeId))]
            : project.nodes.filter((node) => node.metadata?.pptRole === "style").map((node) => node.id);
        const nextTakeIndex = page.takes.length + 1;
        if (autoGenerate) {
            const plan = createGenerationPlan(
                {
                    kind: "deriveAndGenerate",
                    pageId: page.pageId,
                    reservedTakeId: takeId,
                    reservedAnchorNodeId: outlineId,
                    reservedConfigNodeId: configId,
                    configMetadata,
                    anchorContent: prompt,
                    inheritedInputNodeIds,
                    pageSpec: nextPageSpec === pageSpec ? undefined : nextPageSpec,
                    positions: { anchor: outlinePosition, config: configPosition },
                },
                { project: projectWithSpec, effectiveConfig },
            );
            modal.confirm({
                title: `保存并生成方案 ${nextTakeIndex}？`,
                content: (
                    <>
                        <p>{sourceTake?.requiresRepeatBillingConfirmation ? "原方案的上一次请求可能已产生费用且无法取回结果，继续生成可能重复计费。" : "原方案和候选稿会保留。"}</p>
                        <PptGenerationPlanSummary plan={plan} repeatBillingRiskCount={sourceTake?.requiresRepeatBillingConfirmation ? 1 : 0} />
                    </>
                ),
                okText: "确认生成",
                cancelText: "取消",
                width: 680,
                okButtonProps: { disabled: planHasBlockingCompilationIssues(plan) },
                onOk: async () => {
                    if (!(await executeGenerationPlan(plan))) return;
                    setActiveTakeId(takeId);
                    setActiveNodeId(undefined);
                    setNewTakeDraft(null);
                    setPromptEditorOpen(false);
                    message.success(`已基于新提示词创建方案 ${nextTakeIndex} 并开始生成`);
                },
            });
            return;
        }
        const ops: CanvasAgentOp[] = [
            {
                type: "add_node",
                id: outlineId,
                nodeType: CanvasNodeType.Text,
                title: `第${page.index}页大纲`,
                position: outlinePosition,
                metadata: { content: prompt, status: "success", pptPageId: page.pageId, pptTakeId: takeId, pptPageIndex: page.index, pptRole: "outline" },
            },
            { type: "add_node", id: configId, nodeType: CanvasNodeType.Config, title: `第${page.index}页生成配置`, position: configPosition, metadata: configMetadata },
            { type: "connect_nodes", fromNodeId: outlineId, toNodeId: configId },
            ...inheritedInputNodeIds.map((id): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId: id, toNodeId: configId })),
        ];
        const next = canvasContext.applyTrustedOps(ops);
        const nextTakes = [...page.takes, { takeId, anchorNodeId: outlineId, configNodeId: configId }];
        if (
            !(await persistProject({
                nodes: next.nodes,
                connections: next.connections,
                ppt: {
                    ...ppt,
                    pages: ppt.pages.map((item) => (item.pageId === page.pageId ? { ...item, takes: nextTakes } : item)),
                    pageSpecs: nextPageSpec === pageSpec ? ppt.pageSpecs : [...ppt.pageSpecs.filter((spec) => spec.pageId !== page.pageId), nextPageSpec],
                },
            }))
        )
            return;
        setActiveTakeId(takeId);
        setActiveNodeId(undefined);
        setNewTakeDraft(null);
        setPromptEditorOpen(false);
        message.success(`已创建方案 ${nextTakes.length}，确认提示词后再生成`);
    };

    const addPageTake = () => {
        if (!newTakeDraft?.prompt.trim()) {
            message.warning("方案提示词不能为空");
            return;
        }
        void createTakeFromPrompt(newTakeDraft.prompt, newTakeDraft.sourceTakeId ? workspace.takes.find((take) => take.takeId === newTakeDraft.sourceTakeId) : undefined, false);
    };

    // 删除集完全由 read model 派生；共享命令负责 abort、画布 UI 清态与图片存储清理。
    const deleteTake = async (take: PptPageWorkspaceTake) => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        if (take.generating || take.unresolvedGeneration) return;
        const willUnconfirm = Boolean(workspace.resolvedConfirmedNodeId && take.deleteNodeIds.includes(workspace.resolvedConfirmedNodeId));
        const latestProject = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        const latestPpt = latestProject?.ppt;
        const latestPage = latestPpt?.pages.find((item) => item.pageId === page.pageId);
        if (!latestProject || !latestPpt || !latestPage) {
            message.warning("PPT 工程已变化，请刷新后重试");
            return;
        }
        const pptAfterUnconfirm = willUnconfirm ? setPptPageConfirmedNode(latestPpt, page.pageId, undefined) : latestPpt;
        const nextTakes = latestPage.takes.filter((item) => item.takeId !== take.takeId);
        const remainingWorkspaceTakes = workspace.takes.filter((item) => item.takeId !== take.takeId);
        const deletingActive = activeTake?.takeId === take.takeId;
        const nextActiveTake = deletingActive ? (remainingWorkspaceTakes[take.index] ?? remainingWorkspaceTakes[take.index - 1]) : activeTake;
        const deleteIds = new Set(take.deleteNodeIds);
        if (
            !(await persistProject({
                nodes: latestProject.nodes.filter((node) => !deleteIds.has(node.id)),
                connections: latestProject.connections.filter((connection) => !deleteIds.has(connection.fromNodeId) && !deleteIds.has(connection.toNodeId)),
                ppt: { ...pptAfterUnconfirm, pages: pptAfterUnconfirm.pages.map((item) => (item.pageId === page.pageId ? { ...item, takes: nextTakes } : item)) },
            }))
        )
            return;
        canvasContext.deletePptCanvasNodesWithEffects(take.deleteNodeIds);
        if (deletingActive) {
            setActiveTakeId(nextActiveTake?.takeId);
            setActiveNodeId(nextActiveTake?.candidates.find((node) => node.id === workspace.resolvedConfirmedNodeId)?.id ?? nextActiveTake?.candidates.at(-1)?.id);
        }
        if (newTakeDraft?.sourceTakeId === take.takeId) setNewTakeDraft(null);
        if (deletingActive) setPromptEditorOpen(false);
        message.success(`方案分支 ${take.index + 1} 已删除`);
    };

    const confirmDeleteTake = (take: PptPageWorkspaceTake) => {
        if (take.generating || take.unresolvedGeneration) {
            message.warning(take.generating ? "方案仍在生成，暂不能删除" : "请先重新获取或标记放弃待处理请求，再删除方案");
            return;
        }
        const willUnconfirm = Boolean(workspace.resolvedConfirmedNodeId && take.deleteNodeIds.includes(workspace.resolvedConfirmedNodeId));
        let content = "该方案的提示词与配置将移除";
        if (take.candidates.length) content += `，其 ${take.candidates.length} 张候选稿将一并从画布删除`;
        if (take.failedOutputNodeIds.length) content += `，同时清理 ${take.failedOutputNodeIds.length} 个失败产物`;
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
        if (!newTakeDraft) {
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

    const beginPageTake = (sourceTake?: PptPageWorkspaceTake | null) => {
        discardPendingPrompt(() => setNewTakeDraft({ sourceTakeId: sourceTake?.takeId, prompt: sourceTake ? sourceTake.prompt : fallbackPrompt }));
    };

    const selectTake = (takeId: string) =>
        discardPendingPrompt(() => {
            const take = workspace.takes.find((item) => item.takeId === takeId);
            setActiveTakeId(takeId);
            setActiveNodeId(take?.candidates.find((node) => node.id === workspace.resolvedConfirmedNodeId)?.id ?? take?.candidates.at(-1)?.id);
        });

    const selectCandidate = (takeId: string, nodeId: string) =>
        discardPendingPrompt(() => {
            setActiveTakeId(takeId);
            setActiveNodeId(nodeId);
        });

    const changePage = (nextPageId: string) => discardPendingPrompt(() => onPageChange(nextPageId));

    // #21：键盘导航——↑/↓ 切页，←/→ 切候选；输入框/文本域/可编辑区聚焦时放行，不劫持按键。
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        event.stopPropagation();
        if (promptEditorOpen) return;
        const target = event.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            const currentPos = workspaces.findIndex((item) => item.page.pageId === pageId);
            const nextPage = workspaces[event.key === "ArrowUp" ? currentPos - 1 : currentPos + 1];
            if (nextPage) {
                event.preventDefault();
                changePage(nextPage.page.pageId);
            }
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            if (!activeTake?.candidates.length) return;
            const currentIdx = activeTake.candidates.findIndex((node) => node.id === activeNodeId);
            const nextNode = activeTake.candidates[event.key === "ArrowLeft" ? currentIdx - 1 : currentIdx + 1];
            if (nextNode) {
                event.preventDefault();
                selectCandidate(activeTake.takeId, nextNode.id);
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
                <header className="flex h-12 shrink-0 items-center justify-between gap-3 px-4 py-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                        <div className="grid size-7 shrink-0 place-items-center rounded-lg border" style={{ background: canvasTheme.node.fill, borderColor: canvasTheme.node.stroke }}>
                            <Layers3 className="size-3.5" aria-hidden="true" />
                        </div>
                        <h2 className="flex min-w-0 items-baseline gap-2 text-base font-medium">
                            <span className="truncate">
                                第 {page.index} 页 · {page.title}
                            </span>
                            <span className="shrink-0 font-mono text-[11px] font-normal tabular-nums" style={{ color: canvasTheme.node.muted }}>
                                {workspace.takes.length} 个方案 · {candidateCount} 个候选稿
                            </span>
                        </h2>
                    </div>
                    <div className="flex shrink-0 items-center justify-end gap-1">
                        {generationBatches.length ? (
                            <Popover
                                trigger="click"
                                placement="bottomRight"
                                content={
                                    <div className="thin-scrollbar max-h-[65vh] w-[440px] max-w-[78vw] space-y-3 overflow-y-auto pr-1 text-xs">
                                        {generationBatches.map(([batchId, runs]) => (
                                            <section key={batchId} className="space-y-1.5">
                                                <div className="flex items-center justify-between gap-3 font-medium">
                                                    <span title={batchId}>批次 {batchId.slice(0, 8)}</span>
                                                    <span style={{ color: canvasTheme.node.muted }}>
                                                        {runs.filter((run) => run.status === "completed").length}/{runs.length} 个 Run 完成
                                                    </span>
                                                </div>
                                                {runs.map((run) => {
                                                    const runPage = workspaces.find((item) => item.page.pageId === run.pageId);
                                                    const runTake = runPage?.takes.find((item) => item.takeId === run.takeId);
                                                    const requests = generationRequests.filter((request) => request.runId === run.runId).sort((left, right) => left.slotIndex - right.slotIndex);
                                                    return (
                                                        <div key={run.runId} className="rounded-md border px-2 py-1.5" style={{ borderColor: canvasTheme.node.stroke }}>
                                                            <button
                                                                type="button"
                                                                className="flex w-full items-center justify-between gap-3 text-left hover:opacity-75 focus-visible:outline-2 focus-visible:outline-offset-1"
                                                                style={{ outlineColor: canvasTheme.node.activeStroke }}
                                                                onClick={() =>
                                                                    discardPendingPrompt(() => {
                                                                        onPageChange(run.pageId);
                                                                        setActiveTakeId(run.takeId);
                                                                    })
                                                                }
                                                            >
                                                                <span>
                                                                    第 {runPage?.page.index ?? "?"} 页 · 方案 {(runTake?.index ?? 0) + 1}
                                                                </span>
                                                                <span>{runStatusLabel[run.status]}</span>
                                                            </button>
                                                            <div className="mt-1 space-y-1 border-t pt-1" style={{ borderColor: canvasTheme.node.stroke }}>
                                                                {requests.length ? (
                                                                    requests.map((request) => (
                                                                        <div key={request.requestId} className="flex items-start justify-between gap-3">
                                                                            <span>
                                                                                请求 {request.slotIndex + 1} · {requestStatusLabel[request.status]}
                                                                            </span>
                                                                            <span className="max-w-[220px] truncate font-mono text-[10px]" style={{ color: canvasTheme.node.muted }} title={request.remoteTaskId}>
                                                                                {request.remoteTaskId || "暂无 task ID"}
                                                                            </span>
                                                                        </div>
                                                                    ))
                                                                ) : (
                                                                    <span style={{ color: canvasTheme.node.muted }}>请求槽缺失</span>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </section>
                                        ))}
                                    </div>
                                }
                            >
                                <Button size="small" type="text" icon={<ScanSearch className="size-3.5" />}>
                                    生成记录 {generationRuns.length}
                                </Button>
                            </Popover>
                        ) : null}
                        {!controls.batchHidden ? (
                            <Button size="small" type="primary" icon={<Sparkles className="size-3.5" />} disabled={controls.batchDisabled || Boolean(newTakeDraft)} onClick={controls.onBatchAction}>
                                {controls.batchLabel}
                            </Button>
                        ) : null}
                        <Button size="small" type="text" icon={<Presentation className="size-3.5" />} onClick={() => discardPendingPrompt(controls.onOpenFinalReview)}>
                            最终检视
                        </Button>
                        <Button size="small" type="text" icon={<Network className="size-3.5" />} onClick={() => discardPendingPrompt(() => controls.onShowCanvas(activeNode?.id ?? activeTake?.configNode?.id ?? activeTake?.anchorNode?.id))}>
                            查看结构画布
                        </Button>
                    </div>
                </header>

                <main className="thin-scrollbar grid min-h-0 flex-1 gap-2 overflow-y-auto border-y p-2.5 xl:grid-cols-[96px_minmax(320px,0.8fr)_minmax(480px,1.2fr)] xl:overflow-hidden" style={{ borderColor: canvasTheme.node.stroke }}>
                    <nav className="flex min-h-0 flex-col gap-0.5 xl:overflow-y-auto" aria-label="PPT 页面导航">
                        {workspaces.map((item) => {
                            const selected = item.page.pageId === page.pageId;
                            const confirmed = item.confirmationIssues.length === 0;
                            const generating = item.takes.some((take) => take.generating);
                            // #33：状态用徽记表达（✓ 已确认 / spinner 生成中 / ○ 待确认），去掉「待确认/正在精修」文字行，行高收紧。
                            const statusLabel = generating ? "生成中" : confirmed ? "已确认" : "待确认";
                            return (
                                <button
                                    key={item.page.pageId}
                                    type="button"
                                    className={`flex items-center gap-2 rounded-md py-1 pl-2.5 pr-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${selected ? "bg-foreground/[0.06]" : "hover:bg-foreground/5"}`}
                                    style={{
                                        borderLeft: `3px solid ${selected ? canvasTheme.node.activeStroke : "transparent"}`,
                                        outlineColor: canvasTheme.node.activeStroke,
                                    }}
                                    aria-current={selected ? "page" : undefined}
                                    aria-label={`第 ${item.page.index} 页，${statusLabel}`}
                                    onClick={() => changePage(item.page.pageId)}
                                >
                                    {generating ? (
                                        <LoaderCircle className="size-3.5 shrink-0 animate-spin" style={{ color: canvasTheme.node.muted }} aria-hidden="true" />
                                    ) : confirmed ? (
                                        <CheckCircle2 className="size-3.5 shrink-0" style={{ color: token.colorSuccess }} aria-hidden="true" />
                                    ) : (
                                        <span className="size-3.5 shrink-0 rounded-full border" style={{ borderColor: canvasTheme.node.faint }} aria-hidden="true" />
                                    )}
                                    <span className={`truncate text-xs ${selected ? "font-semibold text-foreground" : "font-medium text-muted-foreground"}`}>
                                        第 <span className="font-mono tabular-nums">{item.page.index}</span> 页
                                    </span>
                                </button>
                            );
                        })}
                    </nav>

                    <section className="flex min-h-[380px] min-w-0 flex-col gap-2.5 xl:min-h-0" aria-label="当前页方案分支与候选稿">
                        <div className="thin-scrollbar flex min-w-0 shrink-0 items-center gap-1.5 overflow-x-auto" aria-label="方案分支切换器">
                            <span className="mr-1 shrink-0 text-xs font-medium" style={{ color: canvasTheme.node.muted }}>
                                方案分支
                            </span>
                            {visibleTakes.map((take) => {
                                const selected = take.takeId === activeTake?.takeId;
                                return (
                                    <div
                                        key={take.takeId}
                                        className="group flex min-w-0 items-center overflow-hidden rounded-md border"
                                        style={{ background: selected ? canvasTheme.toolbar.activeBg : "transparent", borderColor: selected ? canvasTheme.node.activeStroke : canvasTheme.node.stroke, borderLeftWidth: 3 }}
                                    >
                                        <button
                                            type="button"
                                            className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                                            style={{ outlineColor: canvasTheme.node.activeStroke }}
                                            aria-current={selected ? "true" : undefined}
                                            onClick={() => selectTake(take.takeId)}
                                        >
                                            <span>方案 {take.index + 1}</span>
                                            <span className="font-mono text-[10px] tabular-nums" style={{ color: canvasTheme.node.muted }}>
                                                {take.generating ? "生成中" : take.unresolvedGeneration ? "待处理" : `${take.candidates.length} 稿`}
                                            </span>
                                        </button>
                                        <Tooltip title={take.generating ? "生成中，暂不能删除" : take.unresolvedGeneration ? "请先处理待处理请求" : `删除方案 ${take.index + 1}`}>
                                            <span className="mr-1 shrink-0 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                                                <button
                                                    type="button"
                                                    className="grid size-6 place-items-center rounded hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-not-allowed dark:hover:bg-white/10"
                                                    style={{ color: take.generating || take.unresolvedGeneration ? canvasTheme.node.faint : token.colorError, outlineColor: canvasTheme.node.activeStroke }}
                                                    aria-label={`删除方案 ${take.index + 1}`}
                                                    disabled={take.generating || take.unresolvedGeneration}
                                                    onClick={() => confirmDeleteTake(take)}
                                                >
                                                    <Trash2 className="size-3.5" aria-hidden="true" />
                                                </button>
                                            </span>
                                        </Tooltip>
                                    </div>
                                );
                            })}
                            {overflowTakes.length ? (
                                <Dropdown
                                    trigger={["click"]}
                                    menu={{
                                        items: overflowTakes.map((take) => ({ key: take.takeId, label: `方案 ${take.index + 1} · ${take.generating ? "生成中" : take.unresolvedGeneration ? "待处理" : `${take.candidates.length} 稿`}` })),
                                        onClick: ({ key }) => selectTake(key),
                                    }}
                                >
                                    <button
                                        type="button"
                                        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 dark:hover:bg-white/10"
                                        style={{ color: canvasTheme.node.muted, outlineColor: canvasTheme.node.activeStroke }}
                                    >
                                        更多
                                        <ChevronDown className="size-3.5" aria-hidden="true" />
                                    </button>
                                </Dropdown>
                            ) : null}
                            <Dropdown
                                trigger={["click"]}
                                disabled={!canvasContext || Boolean(newTakeDraft)}
                                menu={{
                                    items: [
                                        { key: "blank", label: "空白方案" },
                                        { key: "copy", label: "复制当前方案", disabled: !activeTake },
                                    ],
                                    onClick: ({ key }) => beginPageTake(key === "copy" ? activeTake : null),
                                }}
                            >
                                <button
                                    type="button"
                                    className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10"
                                    style={{ color: canvasTheme.node.muted, outlineColor: canvasTheme.node.activeStroke }}
                                    disabled={!canvasContext || Boolean(newTakeDraft)}
                                >
                                    <Plus className="size-3.5" aria-hidden="true" />
                                    新方案
                                </button>
                            </Dropdown>
                        </div>

                        <section className="shrink-0 rounded-xl border bg-muted/50 p-2.5" style={{ borderColor: newTakeDraft ? canvasTheme.node.activeStroke : canvasTheme.node.stroke }}>
                            {newTakeDraft ? (
                                <>
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <h3 className="text-sm font-semibold">新方案页面规格</h3>
                                            <p className="mt-1 text-xs" style={{ color: canvasTheme.node.muted }}>
                                                先调整页面规格，创建方案后再决定是否生成，不会自动消耗 API。
                                            </p>
                                        </div>
                                        <GitBranchPlus className="size-4 shrink-0" aria-hidden="true" />
                                    </div>
                                    <Input.TextArea
                                        className="mt-3 !h-48 !resize-none overflow-y-auto"
                                        value={newTakeDraft.prompt}
                                        variant="filled"
                                        placeholder="填写这一方案的页面规格"
                                        onChange={(event) => setNewTakeDraft((current) => (current ? { ...current, prompt: event.target.value } : current))}
                                    />
                                    <div className="mt-3 flex justify-end gap-2">
                                        <Button size="small" onClick={() => setNewTakeDraft(null)}>
                                            取消
                                        </Button>
                                        <Button size="small" type="primary" icon={<Plus className="size-3.5" />} disabled={!newTakeDraft.prompt.trim()} onClick={addPageTake}>
                                            创建方案
                                        </Button>
                                    </div>
                                </>
                            ) : activeTake ? (
                                <>
                                    <div
                                        className="thin-scrollbar max-h-[46vh] cursor-text overflow-y-auto whitespace-pre-wrap rounded-lg px-3 py-2 text-sm"
                                        style={{ background: canvasTheme.node.fill }}
                                        aria-label={`方案 ${activeTake.index + 1} 页面规格，双击调整`}
                                        title="双击打开大编辑器"
                                        onDoubleClick={() => !activeTake.generating && setPromptEditorOpen(true)}
                                    >
                                        {promptDraft || <span style={{ color: canvasTheme.node.muted }}>暂无提示词</span>}
                                    </div>
                                    <div className="mt-3 flex items-center justify-between gap-3">
                                        <span className="text-[11px]" style={{ color: canvasTheme.node.muted }}>
                                            {activeTake.canEditPrompt ? "保存只更新当前方案；生成前可展开查看最终提示词" : `${activeTake.candidates.length} 个候选稿共用；调整后会另存为新方案`}
                                        </span>
                                        <div className="flex shrink-0 gap-1">
                                            <Button
                                                size="small"
                                                type="text"
                                                icon={<FileText className="size-3.5" />}
                                                disabled={activeTake.generating || activeTake.unresolvedGeneration}
                                                onClick={() => {
                                                    setCompiledOverrideDraft(activeTake.configNode?.metadata?.pptCompiledPromptOverride || singleGenerationPlan?.compilation?.prompts[0]?.finalPrompt || "");
                                                    setCompiledOverrideOpen(true);
                                                }}
                                            >
                                                {activeTake.configNode?.metadata?.pptCompiledPromptOverride ? "最终提示词（覆盖中）" : "最终提示词覆盖"}
                                            </Button>
                                            <Button size="small" icon={<Pencil className="size-3.5" />} disabled={activeTake.generating} onClick={() => setPromptEditorOpen(true)}>
                                                调整规格
                                            </Button>
                                        </div>
                                    </div>
                                    <UpstreamInputsPanel
                                        take={activeTake}
                                        canvasTheme={canvasTheme}
                                        muted={canvasTheme.node.muted}
                                        canEdit={Boolean(canvasContext) && !activeTake.unresolvedGeneration}
                                        onSaveStyle={saveStyleNode}
                                        onSaveLayout={saveLayoutPrompt}
                                    />
                                    {pageSpec?.requiresReview && !pageSpec.reviewedAt ? (
                                        <div className="mt-2.5 rounded-lg border p-3 text-xs" style={{ borderColor: token.colorWarningBorder, background: token.colorWarningBg }}>
                                            <div className="font-medium" style={{ color: token.colorWarningText }}>
                                                本页规格需要人工确认
                                            </div>
                                            <div className="mt-1" style={{ color: canvasTheme.node.muted }}>
                                                {pageSpec.reviewReason || "系统无法完全确定哪些内容是页面正文、哪些是布局要求。"}
                                            </div>
                                            <details className="mt-2" open>
                                                <summary className="cursor-pointer font-medium">查看解析结果</summary>
                                                <div className="mt-2 space-y-2">
                                                    <div>
                                                        <div className="font-medium">锁定正文</div>
                                                        <div className="mt-0.5 whitespace-pre-wrap">{pageSpec.lockedCopy.join("\n") || "未识别"}</div>
                                                    </div>
                                                    <div>
                                                        <div className="font-medium">布局意图</div>
                                                        <div className="mt-0.5 whitespace-pre-wrap">{pageSpec.layoutIntent.join("\n") || "未识别"}</div>
                                                    </div>
                                                    <Button size="small" onClick={() => void confirmPageSpecReview()}>
                                                        确认当前拆分
                                                    </Button>
                                                </div>
                                            </details>
                                        </div>
                                    ) : null}
                                </>
                            ) : (
                                <div className="py-4 text-center" style={{ color: canvasTheme.node.muted }}>
                                    <div className="text-sm font-semibold">本页还没有方案</div>
                                    <div className="mt-1 text-xs">使用上方「新方案」开始</div>
                                </div>
                            )}
                        </section>

                        <section className="thin-scrollbar min-h-0 flex-1 overflow-y-auto rounded-xl border p-2.5" style={{ borderColor: canvasTheme.node.stroke }} aria-label="当前方案候选稿">
                            {activeTake ? (
                                <div key={activeTake.takeId}>
                                    <div className="flex items-center justify-between gap-2">
                                        <h3 className="text-sm font-semibold">
                                            候选稿 · <span className="font-mono tabular-nums">{activeTake.candidates.length}</span>
                                        </h3>
                                        <div className="flex min-w-0 items-center gap-2">
                                            {activeTake.generating ? (
                                                <span className="flex shrink-0 items-center gap-1.5 text-[11px]" style={{ color: canvasTheme.node.muted }} role="status">
                                                    <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                                                    生成中
                                                </span>
                                            ) : null}
                                            <Popover
                                                key={activeTake.takeId}
                                                open={configPopoverOpen}
                                                onOpenChange={updateConfigPopover}
                                                trigger="click"
                                                placement="bottomRight"
                                                destroyOnHidden
                                                content={
                                                    activeGenerationConfig && defaultConfigDraft ? (
                                                        <GenerationConfigEditor
                                                            config={activeGenerationConfig}
                                                            draft={configDraft ?? defaultConfigDraft}
                                                            canvasTheme={canvasTheme}
                                                            dirty={configDraftDirty}
                                                            onChange={setConfigDraft}
                                                            onMissingConfig={() => {
                                                                setConfigPopoverOpen(false);
                                                                setConfigDraft(undefined);
                                                                setConfigBaseline(undefined);
                                                                openConfigDialog(true);
                                                            }}
                                                            onCancel={() => updateConfigPopover(false)}
                                                            onSave={saveGenerationConfig}
                                                        />
                                                    ) : null
                                                }
                                            >
                                                <button
                                                    type="button"
                                                    className="max-w-[280px] truncate rounded-md px-2 py-1 font-mono text-[11px] tabular-nums hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10"
                                                    style={{ color: canvasTheme.node.muted, outlineColor: canvasTheme.node.activeStroke }}
                                                    disabled={!activeTake.configNode || activeTake.generating || activeTake.unresolvedGeneration}
                                                    aria-label={`编辑生成配置：${configSummary}`}
                                                >
                                                    {configSummary}
                                                </button>
                                            </Popover>
                                        </div>
                                    </div>

                                    {latestGenerationRun ? (
                                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                            <Popover
                                                trigger="click"
                                                placement="bottomLeft"
                                                content={
                                                    <div className="w-[360px] max-w-[70vw] space-y-2 text-xs">
                                                        <div className="font-medium">
                                                            Run {latestGenerationRun.runId} · {runStatusLabel[latestGenerationRun.status]}
                                                        </div>
                                                        {latestGenerationRequests.length ? (
                                                            latestGenerationRequests.map((request) => (
                                                                <div key={request.requestId} className="border-t pt-2" style={{ borderColor: canvasTheme.node.stroke }}>
                                                                    <div className="flex items-center justify-between gap-3">
                                                                        <span>请求 {request.slotIndex + 1}</span>
                                                                        <span>{requestStatusLabel[request.status]}</span>
                                                                    </div>
                                                                    <div className="mt-1 break-all font-mono text-[10px]" style={{ color: canvasTheme.node.muted }} title={request.remoteTaskId}>
                                                                        task: {request.remoteTaskId || "暂无"}
                                                                    </div>
                                                                    {request.compilationSnapshotId ? (
                                                                        <div className="mt-0.5 break-all font-mono text-[10px]" style={{ color: canvasTheme.node.muted }}>
                                                                            prompt snapshot: {request.compilationSnapshotId}
                                                                        </div>
                                                                    ) : null}
                                                                    {request.resultIdentity ? (
                                                                        <div className="mt-0.5 break-all font-mono text-[10px]" style={{ color: canvasTheme.node.muted }}>
                                                                            result: {request.resultIdentity}
                                                                        </div>
                                                                    ) : null}
                                                                </div>
                                                            ))
                                                        ) : (
                                                            <div style={{ color: canvasTheme.node.muted }}>没有找到本轮请求槽，生成台账需要处理。</div>
                                                        )}
                                                    </div>
                                                }
                                            >
                                                <button
                                                    type="button"
                                                    className="rounded px-1.5 py-1 text-[11px] hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-1 dark:hover:bg-white/10"
                                                    style={{ color: canvasTheme.node.muted, outlineColor: canvasTheme.node.activeStroke }}
                                                >
                                                    本轮 {runStatusLabel[latestGenerationRun.status]} · 返回 {returnedRequestCount}/{latestGenerationRun.plannedCount} · 回填 {completedRequestCount}/{latestGenerationRun.plannedCount}
                                                    {activeTake.generating ? ` · ${formatElapsed(generatingElapsed)}` : ""}
                                                </button>
                                            </Popover>
                                            <Button type="text" size="small" className="!h-7 !px-1.5" onClick={copyGenerationDiagnostic}>
                                                复制诊断
                                            </Button>
                                        </div>
                                    ) : activeTake.generationRequests.length ? (
                                        <Button type="text" size="small" className="mt-2 !h-7 !px-1.5" onClick={copyGenerationDiagnostic}>
                                            复制生成诊断
                                        </Button>
                                    ) : null}

                                    {activeTake.issues.length ? (
                                        <div className="mt-3 rounded-lg border px-3 py-2 text-xs" style={{ background: token.colorErrorBg, borderColor: token.colorErrorBorder, color: token.colorErrorText }} role="alert">
                                            <div>{activeTake.issues.join("；")}</div>
                                            {retrievableRequest || abandonableRequest ? (
                                                <div className="mt-1.5 flex gap-1">
                                                    {retrievableRequest ? (
                                                        <Button type="text" size="small" className="!h-7 !px-1.5" onClick={() => void retrieveExisting()}>
                                                            重新获取
                                                        </Button>
                                                    ) : null}
                                                    {abandonableRequest ? (
                                                        <Button type="text" size="small" className="!h-7 !px-1.5" onClick={abandonPendingRequest}>
                                                            标记放弃
                                                        </Button>
                                                    ) : null}
                                                </div>
                                            ) : null}
                                        </div>
                                    ) : null}

                                    {activeTake.candidates.length ? (
                                        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                                            {activeTake.candidates.map((node, versionIndex) => {
                                                const viewing = node.id === activeNode?.id;
                                                const confirmed = node.id === workspace.resolvedConfirmedNodeId;
                                                return (
                                                    <button
                                                        key={node.id}
                                                        type="button"
                                                        className={cn(
                                                            "animate-in zoom-in-95 fade-in-0 duration-150 ease-out motion-reduce:animate-none overflow-hidden rounded-lg border p-1.5 text-left transition-[transform,box-shadow] duration-150 hover:scale-[1.03] hover:ring-2 hover:ring-foreground/20 motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2",
                                                            viewing && "ring-2 ring-foreground",
                                                        )}
                                                        style={{
                                                            background: viewing ? canvasTheme.node.panel : canvasTheme.canvas.background,
                                                            borderColor: confirmed ? token.colorSuccessBorder : canvasTheme.node.stroke,
                                                            outlineColor: canvasTheme.node.activeStroke,
                                                        }}
                                                        aria-pressed={viewing}
                                                        aria-label={`第 ${page.index} 页，方案 ${activeTake.index + 1}，第 ${versionIndex + 1} 稿${confirmed ? "，已选最终版" : ""}`}
                                                        onClick={() => selectCandidate(activeTake.takeId, node.id)}
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
                                                                第<span className="font-mono tabular-nums">{page.index}</span>页 · 方案<span className="font-mono tabular-nums">{activeTake.index + 1}</span> · 第
                                                                <span className="font-mono tabular-nums">{versionIndex + 1}</span>稿
                                                            </span>
                                                            {confirmed ? (
                                                                <span
                                                                    className="flex shrink-0 items-center gap-1 font-semibold animate-in zoom-in-50 duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:animate-none"
                                                                    style={{ color: token.colorSuccess }}
                                                                >
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
                                        <div className="mt-3 flex aspect-video w-full items-center justify-center rounded-lg border border-dashed text-sm" style={{ borderColor: canvasTheme.node.stroke, color: canvasTheme.node.muted }}>
                                            {activeTake.generating ? (
                                                <span className="flex items-center gap-2">
                                                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                                                    正在生成第一个候选稿
                                                </span>
                                            ) : (
                                                "此分支还没有候选稿"
                                            )}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="flex h-full min-h-32 items-center justify-center text-sm" style={{ color: canvasTheme.node.muted }}>
                                    创建方案后，候选稿会显示在这里
                                </div>
                            )}
                        </section>
                    </section>

                    <section className="flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-xl border xl:min-h-0" style={{ borderColor: canvasTheme.node.stroke }} aria-label="当前候选稿大图预览">
                        {/* 预览井：工作室的深色底衬，图片优先于留白——内边距取能保住投影呼吸感的最小值。 */}
                        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-[var(--surface-well)] p-2">
                            {activeNode?.metadata?.content ? (
                                <>
                                    <img
                                        src={activeNode.metadata.content}
                                        alt={`第 ${page.index} 页当前查看候选稿`}
                                        className="shadow-artwork max-h-full max-w-full cursor-zoom-in rounded-md object-contain"
                                        onClick={() => setLightboxSrc(activeNode.metadata!.content!)}
                                    />
                                    {/* 井内下缘信息条：深底浅字，独立于外层浅色主题。 */}
                                    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 rounded-b-lg bg-black/55 px-3 py-1.5 text-[11px] backdrop-blur-sm">
                                        <span className="text-white/85">
                                            第<span className="font-mono tabular-nums">{page.index}</span>页 · 方案<span className="font-mono tabular-nums">{(activeTake?.index ?? 0) + 1}</span> · 第
                                            <span className="font-mono tabular-nums">{activeVersionIndex + 1}</span>稿
                                        </span>
                                        {activeConfirmed ? (
                                            <span className="flex shrink-0 items-center gap-1 font-semibold animate-in zoom-in-50 duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:animate-none" style={{ color: token.colorSuccess }}>
                                                <CheckCircle2 className="size-3" aria-hidden="true" />
                                                最终版
                                            </span>
                                        ) : (
                                            <span className="text-white/70">查看中</span>
                                        )}
                                    </div>
                                </>
                            ) : activeTake?.generating ? (
                                <div className="flex flex-col items-center gap-3 text-center text-white/70">
                                    <LoaderCircle className="size-8 animate-spin" aria-hidden="true" />
                                    <div className="text-sm font-semibold text-white/90">正在生成第一个候选稿…</div>
                                </div>
                            ) : activeTake?.configNode ? (
                                <div className="flex flex-col items-center gap-3 text-center">
                                    <ScanSearch className="size-10 text-white/60" aria-hidden="true" />
                                    <div className="text-sm font-semibold text-white/90">这一方案还没有候选稿</div>
                                    <Button type="primary" icon={<Sparkles className="size-4" />} disabled={!canvasContext || Boolean(newTakeDraft) || (activeTake.canEditPrompt && !activeTake.prompt.trim())} onClick={runGeneration}>
                                        {generationLabel("生成首稿")}
                                    </Button>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center gap-3 text-center text-white/70">
                                    <ScanSearch className="size-10" aria-hidden="true" />
                                    <div>
                                        <div className="text-sm font-semibold text-white/90">本页还没有方案</div>
                                        <div className="mt-1 text-xs">先在中间栏创建一个方案</div>
                                    </div>
                                </div>
                            )}
                        </div>
                        <footer className="shrink-0 border-t p-2.5" style={{ background: canvasTheme.node.panel, borderColor: canvasTheme.node.stroke }}>
                            <div className="mb-2.5 flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-sm font-semibold">
                                        方案 <span className="font-mono tabular-nums">{activeTake?.index != null ? activeTake.index + 1 : "-"}</span>
                                    </div>
                                    <div className="mt-0.5 truncate text-xs" style={{ color: canvasTheme.node.muted }}>
                                        {activeNode ? (activeConfirmed ? "此候选稿已选为本页最终版" : "正在查看，尚未确认为最终版") : activeTake?.generating ? "生成中，请稍候" : "暂无选中候选稿"}
                                    </div>
                                </div>
                                {activeConfirmed ? (
                                    <span className="flex shrink-0 items-center gap-1 text-xs font-semibold animate-in zoom-in-50 duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:animate-none" style={{ color: token.colorSuccess }}>
                                        <CheckCircle2 className="size-4" aria-hidden="true" />
                                        已选最终版
                                    </span>
                                ) : null}
                            </div>
                            {centerGenerateCtaShown ? null : (
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                        icon={activeTake?.generating ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                                        disabled={!activeTake?.configNode || activeTake.generating || !canvasContext || Boolean(newTakeDraft)}
                                        onClick={runGeneration}
                                    >
                                        {activeTake?.generating ? (
                                            <span className="inline-flex items-center gap-1.5">
                                                生成中
                                                <span className="font-mono text-[11px]">{formatElapsed(generatingElapsed)}</span>
                                            </span>
                                        ) : activeTake?.candidates.length ? (
                                            generationLabel("继续生成")
                                        ) : (
                                            generationLabel("生成首稿")
                                        )}
                                    </Button>
                                    <Button icon={<WandSparkles className="size-4" />} disabled={!activeNode?.metadata?.content} onClick={() => activeNode && openAnnotate(activeNode.id)}>
                                        标注改图
                                    </Button>
                                    {activeConfirmed ? (
                                        <>
                                            <Button type="primary" icon={<ArrowRight className="size-4" />} onClick={goToNextUnconfirmed}>
                                                {workspaces.some((item) => item.page.pageId !== page.pageId && item.confirmationIssues.length > 0) ? "下一未确认页" : "最终检视"}
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
            {promptEditorOpen && activeTake ? (
                <CanvasPptPromptEditor
                    key={activeTake.takeId}
                    open
                    initialValue={activeTake.prompt}
                    lockedTake={!activeTake.canEditPrompt}
                    textModelReady={textModelReady}
                    onSave={(value) => {
                        if (activeTake.canEditPrompt) savePrompt(value);
                        else createTakeFromPrompt(value, activeTake, false);
                    }}
                    onSaveAndGenerate={(value) => createTakeFromPrompt(value, activeTake, true)}
                    onCancel={() => setPromptEditorOpen(false)}
                />
            ) : null}
            <Modal
                title="显式覆盖最终提示词"
                open={compiledOverrideOpen}
                onCancel={() => setCompiledOverrideOpen(false)}
                onOk={() => void saveCompiledPromptOverride()}
                okText="保存并重新检查"
                cancelText="取消"
                width="min(88vw, 1080px)"
                centered
                destroyOnHidden
            >
                <Alert className="mb-3" type="warning" showIcon message="这里编辑的内容会原样发送给图片模型" description="保存后仍会检查锁定正文、数字、术语、点数和必要约束；新增或改写内容需要再次明确确认。清空内容可恢复自动编译。" />
                <Input.TextArea
                    className="thin-scrollbar !h-[min(56vh,640px)] !resize-none overflow-y-auto font-mono text-sm leading-6"
                    value={compiledOverrideDraft}
                    aria-label="最终提示词显式覆盖"
                    onChange={(event) => setCompiledOverrideDraft(event.target.value)}
                />
                {overrideValidationPlan ? <PptGenerationPlanSummary plan={overrideValidationPlan} /> : null}
                <div className="mt-3 flex justify-start">
                    <Button
                        type="text"
                        onClick={() => {
                            setCompiledOverrideDraft("");
                        }}
                    >
                        清除覆盖，恢复自动编译
                    </Button>
                </div>
            </Modal>
            <CanvasImageLightbox src={lightboxSrc} alt={`第 ${page.index} 页候选稿`} onClose={() => setLightboxSrc(null)} />
        </Modal>
    );
}

function GenerationConfigEditor({
    config,
    draft,
    canvasTheme,
    dirty,
    onChange,
    onMissingConfig,
    onCancel,
    onSave,
}: {
    config: AiConfig;
    draft: GenerationConfigDraft;
    canvasTheme: (typeof canvasThemes)[keyof typeof canvasThemes];
    dirty: boolean;
    onChange: (draft: GenerationConfigDraft) => void;
    onMissingConfig: () => void;
    onCancel: () => void;
    onSave: () => void;
}) {
    const sizeOptions = imageAspectOptions.some((option) => option.value === draft.size) ? imageAspectOptions : [{ value: draft.size, label: imageSizeLabel(draft.size) }, ...imageAspectOptions];
    const pickerConfig = { ...config, model: draft.model, size: draft.size, count: String(draft.count) };

    return (
        <div className="w-[340px] space-y-4 p-1" style={{ color: canvasTheme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
            <div>
                <div className="mb-1.5 text-xs font-medium" style={{ color: canvasTheme.node.muted }}>
                    生图模型
                </div>
                <ModelPicker config={pickerConfig} value={draft.model} capability="image" fullWidth onChange={(model) => onChange({ ...draft, model })} onMissingConfig={onMissingConfig} className="!h-9 !rounded-lg" />
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
                <label className="min-w-0 text-xs font-medium" style={{ color: canvasTheme.node.muted }}>
                    <span className="mb-1.5 block">尺寸</span>
                    <Select className="w-full" value={draft.size} options={sizeOptions} onChange={(size) => onChange({ ...draft, size })} />
                </label>
                <label className="text-xs font-medium" style={{ color: canvasTheme.node.muted }}>
                    <span className="mb-1.5 block">张数</span>
                    <InputNumber className="w-full" min={GENERATION_COUNT_MIN} max={GENERATION_COUNT_MAX} value={draft.count} onChange={(count) => onChange({ ...draft, count: getGenerationCount(count ?? GENERATION_COUNT_MIN) })} />
                </label>
            </div>
            <div className="flex justify-end gap-2 border-t pt-3" style={{ borderColor: canvasTheme.node.stroke }}>
                <Button size="small" onClick={onCancel}>
                    取消
                </Button>
                <Button size="small" type="primary" disabled={!dirty} onClick={onSave}>
                    保存配置
                </Button>
            </div>
        </div>
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
    onSaveLayout: (content: string) => Promise<boolean>;
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
    }, [take.takeId, take.layoutPrompt]);

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
            <button
                type="button"
                className="mt-2.5 flex w-full items-center justify-between rounded-lg border border-dashed px-3 py-1.5 text-xs opacity-80 transition hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ borderColor: canvasTheme.node.faint, color: muted, outlineColor: canvasTheme.node.activeStroke }}
                onClick={() => setCollapsed(false)}
            >
                <span>其他生成输入：风格基调 + 排版要求</span>
                <span className="shrink-0 underline underline-offset-2">展开</span>
            </button>
        );
    }

    return (
        <div className="mt-2.5 space-y-2 rounded-lg border border-dashed p-2.5" style={{ borderColor: canvasTheme.node.faint }}>
            <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: muted }}>
                    其他生成输入
                </span>
                <button type="button" className="text-[11px] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2" style={{ color: muted, outlineColor: canvasTheme.node.activeStroke }} onClick={() => setCollapsed(true)}>
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
                            仅作用于本方案
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
                                onClick={async () => {
                                    if (await onSaveLayout(layoutDraft)) setEditingLayout(false);
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
