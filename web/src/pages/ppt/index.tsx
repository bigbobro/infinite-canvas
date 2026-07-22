import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, App, Button, Empty, Input, Modal, Popconfirm, Progress, Segmented, Skeleton, Steps } from "antd";
import { ArrowLeft, ArrowRight, FolderOpen, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";

import { PptVisualDirectionEditor } from "@/components/ppt-visual-direction-editor";
import { useEffectiveConfig, useConfigStore } from "@/stores/use-config-store";
import { useCanvasStore, type CanvasProject, type CanvasProjectPptDeckBrief, type CanvasProjectPptStyleContract } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { hasUnresolvedPptGeneration } from "@/lib/ppt/generation-ledger";
import { getImageBlob, resolveImageUrl } from "@/services/image-storage";
import {
    buildPptCreationDraftSnapshot,
    clearPptCreationDraft,
    createPptCreationDraftAutosaveScheduler,
    describePptCreationClearFailure,
    getPptListCreateAction,
    hasPptCreationDraftProgress,
    loadPptCreationDraft,
    resolvePptCreationDraftAutosaveDecision,
    resolvePptCreationDraftUnmountFlush,
    runPptCreationDraftLeaveSequence,
    savePptCreationDraft,
    nextSuppressMountInterruptedStyle,
    shouldAutoGeneratePptStyleDirections,
    shouldSuppressMountAutoStyleFromSnapshot,
    type PptCreationDraftSnapshot,
    type PptListCreateAction,
    type PptWizardMode,
} from "@/services/ppt-creation-draft";
import { extractPptPages, previewExtractPages, type PptOutlinePage } from "@/lib/ppt/outline-prompt";
import { buildPptDeckProject, createPptVerbatimSpecs } from "@/lib/ppt/deck-builder";
import { buildPptPageWorkspace } from "@/lib/ppt/page-workspace";
import { derivePptVisualDirectionRules, normalizePptStyleContract } from "@/lib/ppt/style-contract";
import { selectPptPageDescriptor } from "@/lib/ppt/page-descriptor";
import { PptContentPlanStep } from "@/pages/ppt/components/ppt-content-plan-step";
import { PptStyleReviewPanel } from "@/pages/ppt/components/ppt-style-review-panel";
import { usePptContentPlanning, type FinalizedPptContent } from "@/pages/ppt/use-ppt-content-planning";
import { usePptStylePlanning } from "@/pages/ppt/use-ppt-style-planning";
import type { CanvasNodeData } from "@/types/canvas";

type PptDeck = CanvasProject & { ppt: NonNullable<CanvasProject["ppt"]> };
type WizardSession = { key: number; snapshot: PptCreationDraftSnapshot | null; resumed: boolean };

const { TextArea } = Input;

/** 封面 URL:先同步用节点 content(本会话生成的图直接可用);img 报错(跨会话 blob 已死)时
 *  经 storageKey 异步重试一次,再失败才回排版化封面——绝不把本来能显示的图降级。 */
function useDeckCover(node: CanvasNodeData | null) {
    const [cover, setCover] = useState<string | null>(() => node?.metadata?.content || null);
    const retriedRef = useRef(false);
    useEffect(() => {
        retriedRef.current = false;
        setCover(node?.metadata?.content || null);
    }, [node]);
    const onCoverError = () => {
        if (!retriedRef.current && node?.metadata?.storageKey) {
            retriedRef.current = true;
            void resolveImageUrl(node.metadata.storageKey, "").then((url) => setCover(url || null));
        } else {
            setCover(null);
        }
    };
    return { cover, onCoverError };
}

/** 每次新增页卡的浮现 stagger 延迟；封顶避免页数很多时尾部等太久。 */
function revealDelay(index: number) {
    return `${Math.min(index, 8) * 60}ms`;
}

export default function PptPage() {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const effectiveConfig = useEffectiveConfig();
    const projects = useCanvasStore((state) => state.projects);
    const importProject = useCanvasStore((state) => state.importProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);

    const decks = useMemo(() => projects.filter((project): project is PptDeck => Boolean(project.ppt)), [projects]);

    const [wizardSession, setWizardSession] = useState<WizardSession | null>(null);
    const [wizardOpening, setWizardOpening] = useState(false);
    const [listCreateAction, setListCreateAction] = useState<PptListCreateAction>(() => getPptListCreateAction(null));
    const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
    const deletingDeckIdRef = useRef<string | null>(null);

    const refreshListCreateAction = async () => {
        try {
            const snapshot = await loadPptCreationDraft();
            setListCreateAction(getPptListCreateAction(snapshot));
        } catch {
            setListCreateAction(getPptListCreateAction(null));
        }
    };

    useEffect(() => {
        void refreshListCreateAction();
    }, []);

    const openWizard = async () => {
        if (wizardOpening) return;
        setWizardOpening(true);
        try {
            // Load snapshot before mounting PptWizard so empty defaults cannot race autosave.
            const snapshot = await loadPptCreationDraft();
            setWizardSession({
                key: Date.now(),
                snapshot,
                resumed: hasPptCreationDraftProgress(snapshot),
            });
        } catch {
            message.warning("草稿恢复失败，已打开空白向导");
            setWizardSession({ key: Date.now(), snapshot: null, resumed: false });
        } finally {
            setWizardOpening(false);
        }
    };

    const closeWizard = () => {
        setWizardSession(null);
        void refreshListCreateAction();
    };

    const restartWizard = async () => {
        try {
            await clearPptCreationDraft();
            setWizardSession({ key: Date.now(), snapshot: null, resumed: false });
            setListCreateAction(getPptListCreateAction(null));
        } catch (error) {
            // Explicit restart clear failure must not falsely reset UI.
            message.error(describePptCreationClearFailure("restart"));
            throw error instanceof Error ? error : new Error(describePptCreationClearFailure("restart"));
        }
    };

    const confirmDeleteDeck = (deck: CanvasProject) => {
        if (hasUnresolvedPptGeneration(deck.nodes)) {
            message.warning("该 PPT 仍有生成请求待处理，暂不能删除");
            return;
        }
        // 防重入:连点删除会让 modal.confirm 排队弹出第二个同款确认框(实测)。
        if (deletingDeckIdRef.current === deck.id) return;
        deletingDeckIdRef.current = deck.id;
        modal.confirm({
            title: "删除画布？",
            content: `将删除「${deck.title}」，里面的节点和连线也会一起移除，同时会从「我的画布」移除。`,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            afterClose: () => {
                deletingDeckIdRef.current = null;
            },
            onOk: () => {
                const latest = useCanvasStore.getState().projects.find((project) => project.id === deck.id);
                if (latest && hasUnresolvedPptGeneration(latest.nodes)) {
                    message.warning("该 PPT 仍有生成请求待处理，暂不能删除");
                    return;
                }
                deleteProjects([deck.id]);
                cleanupImages();
                message.success("已删除");
            },
        });
    };

    const saveRename = () => {
        if (renameTarget) renameProject(renameTarget.id, renameTarget.title);
        setRenameTarget(null);
    };

    if (wizardSession) {
        return (
            <PptWizard
                key={wizardSession.key}
                effectiveConfig={effectiveConfig}
                initialSnapshot={wizardSession.snapshot}
                resumed={wizardSession.resumed}
                onCancel={closeWizard}
                onRestart={restartWizard}
                onCreated={(id) => {
                    closeWizard();
                    navigate(`/canvas/${id}`);
                }}
                importProject={importProject}
                message={message}
            />
        );
    }

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">PPT 工作台</p>
                        <h1 className="mt-3 text-3xl font-semibold">我的 PPT</h1>
                        <p className="mt-2 text-sm text-stone-500">材料生成分页大纲，确定视觉方向后批量出图，交付页面图片或图片版 PPT。</p>
                        {listCreateAction.supportingCue ? <p className="mt-1 text-xs text-stone-500">{listCreateAction.supportingCue}</p> : null}
                    </div>
                    <Button type="primary" icon={<Plus className="size-4" />} loading={wizardOpening} onClick={() => void openWizard()}>
                        {listCreateAction.primaryLabel}
                    </Button>
                </header>

                {decks.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {decks.map((deck) => (
                            <DeckCard key={deck.id} deck={deck} onOpen={() => navigate(`/canvas/${deck.id}`)} onRename={() => setRenameTarget({ id: deck.id, title: deck.title })} onDelete={() => confirmDeleteDeck(deck)} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center gap-4 border-y border-stone-200 text-center dark:border-stone-800">
                        <p className="text-sm text-stone-500">{listCreateAction.kind === "resume" ? listCreateAction.supportingCue : "从一份材料开始你的第一份 deck"}</p>
                        <Button type="primary" icon={<Plus className="size-4" />} loading={wizardOpening} onClick={() => void openWizard()}>
                            {listCreateAction.primaryLabel}
                        </Button>
                    </section>
                )}
            </div>

            <Modal title="重命名" open={renameTarget !== null} onCancel={() => setRenameTarget(null)} onOk={saveRename} okText="保存">
                <Input value={renameTarget?.title ?? ""} onChange={(event) => setRenameTarget((prev) => (prev ? { ...prev, title: event.target.value } : prev))} onPressEnter={saveRename} autoFocus />
            </Modal>
        </main>
    );
}

function DeckCard({ deck, onOpen, onRename, onDelete }: { deck: PptDeck; onOpen: () => void; onRename: () => void; onDelete: () => void }) {
    const total = deck.ppt.pages.length;
    const workspaces = useMemo(() => [...deck.ppt.pages].sort((left, right) => left.index - right.index).map((page) => buildPptPageWorkspace(deck, page)), [deck]);
    const confirmedWorkspaces = workspaces.filter((workspace) => workspace.confirmationIssues.length === 0);
    const confirmed = confirmedWorkspaces.length;
    const { cover, onCoverError } = useDeckCover(confirmedWorkspaces[0]?.confirmedNode ?? null);
    const firstPage = [...deck.ppt.pages].sort((a, b) => a.index - b.index)[0];
    const firstPageDescriptor = firstPage ? selectPptPageDescriptor(deck.ppt, firstPage.pageId) : null;
    const headline = firstPageDescriptor?.title || deck.title;
    const iconButtonClass =
        "flex size-7 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm transition-colors duration-150 hover:bg-black/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/70 motion-reduce:transition-none";

    return (
        <article
            className="group flex cursor-pointer flex-col overflow-hidden rounded-lg border border-stone-200 bg-card text-left shadow-sm transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:border-stone-800 dark:hover:border-stone-600"
            onClick={onOpen}
        >
            <div className="relative aspect-video w-full overflow-hidden bg-stone-100 dark:bg-stone-900">
                {cover ? (
                    <img src={cover} alt="" onError={onCoverError} className="size-full object-cover transition-transform duration-150 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100" />
                ) : (
                    <div className="flex size-full flex-col items-center justify-center gap-2 px-6 text-center">
                        <span className="text-[10px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">未定稿</span>
                        <span className="line-clamp-3 text-lg font-semibold leading-snug text-stone-600 dark:text-stone-300">{headline}</span>
                    </div>
                )}
                <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none" onClick={(event) => event.stopPropagation()}>
                    <button type="button" className={iconButtonClass} aria-label="打开" onClick={onOpen}>
                        <FolderOpen className="size-3.5" />
                    </button>
                    <button type="button" className={iconButtonClass} aria-label="重命名" onClick={onRename}>
                        <Pencil className="size-3.5" />
                    </button>
                    <button type="button" className={iconButtonClass} aria-label="删除" onClick={onDelete}>
                        <Trash2 className="size-3.5" />
                    </button>
                </div>
            </div>
            <div className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{deck.title}</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-stone-500 dark:text-stone-400">
                        {confirmed}/{total}
                    </span>
                </div>
                <Progress percent={total ? Math.round((confirmed / total) * 100) : 0} size={[-1, 2]} showInfo={false} />
            </div>
        </article>
    );
}

type MessageApi = ReturnType<typeof App.useApp>["message"];

function PptWizard({
    effectiveConfig,
    initialSnapshot,
    resumed,
    onCancel,
    onRestart,
    onCreated,
    importProject,
    message,
}: {
    effectiveConfig: ReturnType<typeof useEffectiveConfig>;
    initialSnapshot: PptCreationDraftSnapshot | null;
    resumed: boolean;
    onCancel: () => void;
    onRestart: () => void | Promise<void>;
    onCreated: (id: string) => void;
    importProject: (project: Partial<CanvasProject>) => string;
    message: MessageApi;
}) {
    const seed = initialSnapshot;
    // One-shot: block only the initial restored interrupted step2 auto-effect; clear when leaving step 2.
    const suppressMountInterruptedStyleRef = useRef(shouldSuppressMountAutoStyleFromSnapshot(seed));
    const [step, setStep] = useState(seed?.step ?? 0);
    const [mode, setMode] = useState<PptWizardMode>(seed?.mode ?? "outline");
    const [deckTitle, setDeckTitle] = useState(seed?.deckTitle ?? "");
    const [material, setMaterial] = useState(seed?.material ?? "");
    const [requirements, setRequirements] = useState(seed?.requirements ?? "");
    const [extractLoading, setExtractLoading] = useState(false);
    const [extractError, setExtractError] = useState("");
    const [extractReceivedCharacters, setExtractReceivedCharacters] = useState(0);
    const [pages, setPages] = useState<PptOutlinePage[]>(() => seed?.pages ?? []);
    const [extractedDirectionHint, setExtractedDirectionHint] = useState(seed?.extractedDirectionHint ?? "");
    const [extractGlobalDecision, setExtractGlobalDecision] = useState<"include" | "exclude" | null>(seed?.extractGlobalDecision ?? null);
    const [finalizedContent, setFinalizedContent] = useState<FinalizedPptContent | null>(() => seed?.finalizedContent ?? null);
    const [brokenReferenceKeys, setBrokenReferenceKeys] = useState<string[]>([]);
    const [building, setBuilding] = useState(false);
    const extractControllerRef = useRef<AbortController | null>(null);
    const extractTokenRef = useRef(0);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const contentPlanning = usePptContentPlanning(
        effectiveConfig,
        {
            title: deckTitle,
            sourceMaterial: material,
            requirements,
        },
        { initialDraft: seed?.contentDraft ?? null },
    );
    const styleInput = useMemo(
        () =>
            finalizedContent
                ? { brief: finalizedContent.brief, pageSpecs: finalizedContent.pageSpecs, contentRevision: finalizedContent.contentRevision }
                : {
                      brief: { title: deckTitle, audience: "", goal: "", narrative: "", visualSignals: [] },
                      pageSpecs: [],
                      contentRevision: "",
                  },
        [deckTitle, finalizedContent],
    );
    const stylePlanning = usePptStylePlanning(effectiveConfig, styleInput, {
        brokenReferenceKeys,
        initialContract: seed?.styleContract ?? null,
        initialPageSpecs: seed?.stylePageSpecs ?? null,
    });

    const cancelExtract = () => {
        extractControllerRef.current?.abort();
        extractControllerRef.current = null;
        extractTokenRef.current += 1;
        setExtractLoading(false);
    };

    useEffect(
        () => () => {
            extractControllerRef.current?.abort();
            extractTokenRef.current += 1;
        },
        [],
    );

    // Latest committed snapshot for debounced save + immediate unmount flush (route leave).
    const pendingDraftRef = useRef<PptCreationDraftSnapshot | null>(null);
    // Restart / successful finalize must not let unmount recreate a just-cleared draft.
    const suppressUnmountFlushRef = useRef(false);
    // Distinguish initial empty mount (no-op) from progress→empty (must clear durable draft).
    const hadMeaningfulProgressRef = useRef(hasPptCreationDraftProgress(seed));
    // Hold debounce timer outside the effect local so restart/finalize can cancel before clear.
    const autosaveSchedulerRef = useRef(
        createPptCreationDraftAutosaveScheduler({
            save: savePptCreationDraft,
        }),
    );

    // Persist committed progress only (skip mid-request / building). 400ms debounce; leave/unmount flushes pending.
    useEffect(() => {
        if (extractLoading || contentPlanning.loading || stylePlanning.loading || building) {
            autosaveSchedulerRef.current.cancel();
            return;
        }
        const snapshot = buildPptCreationDraftSnapshot({
            mode,
            step,
            deckTitle,
            material,
            requirements,
            pages,
            extractedDirectionHint,
            extractGlobalDecision,
            contentDraft: contentPlanning.draft,
            finalizedContent,
            styleContract: stylePlanning.contract,
            stylePageSpecs: stylePlanning.contract ? stylePlanning.pageSpecs : null,
        });
        const decision = resolvePptCreationDraftAutosaveDecision({
            snapshot,
            hadMeaningfulProgress: hadMeaningfulProgressRef.current,
        });
        hadMeaningfulProgressRef.current = decision.hadMeaningfulProgress;

        if (decision.kind === "noop") {
            pendingDraftRef.current = null;
            autosaveSchedulerRef.current.cancel();
            return;
        }
        if (decision.kind === "clear") {
            // Progress → empty: cancel armed save then clear durable storage (save ignores empty).
            pendingDraftRef.current = null;
            autosaveSchedulerRef.current.cancel();
            void clearPptCreationDraft().catch(() => undefined);
            return;
        }
        pendingDraftRef.current = decision.snapshot;
        autosaveSchedulerRef.current.schedule(decision.snapshot, 400);
        return () => autosaveSchedulerRef.current.cancel();
    }, [
        building,
        contentPlanning.draft,
        contentPlanning.loading,
        deckTitle,
        extractGlobalDecision,
        extractLoading,
        extractedDirectionHint,
        finalizedContent,
        material,
        mode,
        pages,
        requirements,
        step,
        stylePlanning.contract,
        stylePlanning.loading,
        stylePlanning.pageSpecs,
    ]);

    useEffect(
        () => () => {
            autosaveSchedulerRef.current.cancel();
            const toFlush = resolvePptCreationDraftUnmountFlush({
                suppressUnmountFlush: suppressUnmountFlushRef.current,
                pendingSnapshot: pendingDraftRef.current,
            });
            if (toFlush) void savePptCreationDraft(toFlush).catch(() => undefined);
        },
        [],
    );

    /** Explicit leave: flush before parent close/list refresh so CTA is not stale. */
    const handleCancel = async () => {
        autosaveSchedulerRef.current.cancel();
        const leave = await runPptCreationDraftLeaveSequence({
            suppressUnmountFlush: suppressUnmountFlushRef.current,
            pendingSnapshot: pendingDraftRef.current,
            save: savePptCreationDraft,
        });
        suppressUnmountFlushRef.current = leave.suppressUnmountFlush;
        if (leave.flushed) pendingDraftRef.current = null;
        onCancel();
    };

    const handleRestart = () => {
        // Cancel armed debounce BEFORE clear — a post-clear timer fire captures the new epoch and can resurrect.
        autosaveSchedulerRef.current.cancel();
        // Suppress unmount flush only while restart clear + remount proceeds.
        // If clear fails, re-enable so later route leave can still persist.
        suppressUnmountFlushRef.current = true;
        const snapshotBeforeRestart = pendingDraftRef.current;
        pendingDraftRef.current = null;
        void Promise.resolve(onRestart()).catch(() => {
            suppressUnmountFlushRef.current = false;
            pendingDraftRef.current = snapshotBeforeRestart;
        });
    };

    // Clear one-shot suppress when user leaves the initial restored interrupted step2 (e.g. back to content).
    useEffect(() => {
        suppressMountInterruptedStyleRef.current = nextSuppressMountInterruptedStyle({
            suppress: suppressMountInterruptedStyleRef.current,
            step,
        });
    }, [step]);

    // Auto style generation only when there is no restored/current Contract yet.
    // Initial interrupted resume (step2 + content, no Contract) one-shot blocked; UI retry still works.
    useEffect(() => {
        if (
            !shouldAutoGeneratePptStyleDirections({
                mode,
                step,
                hasFinalizedContent: Boolean(finalizedContent),
                hasStyleContract: Boolean(stylePlanning.contract),
                recommendationStatus: stylePlanning.recommendation.status,
                candidateCount: stylePlanning.candidates.length,
                suppressMountInterruptedStyle: suppressMountInterruptedStyleRef.current,
            })
        ) {
            return;
        }
        void stylePlanning.generate();
    }, [finalizedContent, mode, step, stylePlanning.candidates.length, stylePlanning.contract, stylePlanning.generate, stylePlanning.recommendation.status]);

    const textModelReady = () => {
        const model = effectiveConfig.textModel || effectiveConfig.model;
        if (isAiConfigReady(effectiveConfig, model)) return true;
        message.warning("请先配置可用的文本模型");
        openConfigDialog(true, "channels");
        return false;
    };

    const runExtract = async () => {
        if (!material.trim()) {
            message.error("请先粘贴材料内容");
            return;
        }
        if (!textModelReady()) return;
        const previousPages = pages;
        cancelExtract();
        const controller = new AbortController();
        const token = extractTokenRef.current + 1;
        extractTokenRef.current = token;
        extractControllerRef.current = controller;
        setExtractLoading(true);
        setExtractError("");
        setExtractReceivedCharacters(0);
        try {
            const result = await extractPptPages(
                effectiveConfig,
                material,
                (text) => {
                    if (controller.signal.aborted || extractTokenRef.current !== token) return;
                    setExtractReceivedCharacters(text.length);
                    setPages(previewExtractPages(text, material));
                },
                { signal: controller.signal },
            );
            if (controller.signal.aborted || extractTokenRef.current !== token) return;
            setPages(result.pages);
            setExtractedDirectionHint(result.globalStyle.trim());
            setExtractGlobalDecision(null);
            if (result.droppedCount > 0) {
                const shown = result.droppedTitles.slice(0, 3).join("、");
                const suffix = result.droppedTitles.length > 3 ? ` 等 ${result.droppedTitles.length} 页` : "";
                message.warning(`以下内容因边界识别失败被丢弃：${shown}${suffix}，请检查材料`);
            }
            message.success(`已展开 ${result.pages.length} 页`);
        } catch (error) {
            if (controller.signal.aborted || extractTokenRef.current !== token) return;
            setPages(previousPages);
            setExtractError(error instanceof Error ? error.message : "展开分页失败，请重试");
        } finally {
            if (extractTokenRef.current === token) {
                extractControllerRef.current = null;
                setExtractLoading(false);
            }
        }
    };

    const updateExtractPage = (index: number, patch: Pick<PptOutlinePage, "title"> | Pick<PptOutlinePage, "outline">) =>
        setPages((prev) => prev.map((page, pageIndex) => (pageIndex === index ? { ...page, ...patch, ...(Object.hasOwn(patch, "outline") ? { sourceRange: undefined } : {}) } : page)));
    const removePage = (index: number) => setPages((prev) => prev.filter((_, i) => i !== index));
    const addPage = () => setPages((prev) => [...prev, { title: `第${prev.length + 1}页`, outline: "", visualHint: "" }]);

    const startPlanning = () => {
        if (!material.trim()) {
            message.error("请先粘贴材料内容");
            return;
        }
        if (!textModelReady()) return;
        setStep(1);
        if (mode === "extract") void runExtract();
        else void contentPlanning.generate();
    };

    const continueExtract = () => {
        if (!pages.length) {
            setExtractError("分页内容为空，请先展开或手动添加分页");
            return;
        }
        if (pages.some((page) => !page.title.trim() || !page.outline.trim())) {
            setExtractError("每页都需要标题和完整规格");
            return;
        }
        setExtractError("");
        setStep(2);
    };

    const confirmBuild = async () => {
        setBuilding(true);
        try {
            const title = deckTitle.trim() || `PPT-${new Date().toLocaleDateString()}`;
            const content = mode === "outline" ? finalizedContent || contentPlanning.finalize() : null;
            if (content && (!stylePlanning.contract || stylePlanning.review.blocking || stylePlanning.contractStale)) throw new Error("请先完成视觉 Contract 检查");
            if (content && stylePlanning.contract) {
                const referenceResults = await Promise.all(
                    stylePlanning.contract.references.map(async ({ storageKey }) => {
                        try {
                            return (await getImageBlob(storageKey)) ? null : storageKey;
                        } catch {
                            return storageKey;
                        }
                    }),
                );
                const broken = referenceResults.filter((key): key is string => Boolean(key));
                setBrokenReferenceKeys(broken);
                if (broken.length) throw new Error("有参考图无法读取，请移除或重新上传后再继续");
            }
            const deck = content
                ? buildPptDeckProject({
                      title,
                      sourceMaterial: material,
                      requirements,
                      compilePolicy: "structured",
                      deckBrief: createDeckBrief(content, stylePlanning.contract!, requirements),
                      pageSpecs: stylePlanning.pageSpecs,
                  })
                : buildPptDeckProject({
                      title,
                      sourceMaterial: material,
                      requirements: "",
                      compilePolicy: "verbatim",
                      verbatimSpecs: createPptVerbatimSpecs(pages, material),
                      ...(extractGlobalDecision === "include" && extractedDirectionHint ? { confirmedGlobalSpec: extractedDirectionHint } : {}),
                  });
            const id = importProject(deck);
            // Cancel debounce timer before clear — do not rely on setBuilding effect scheduling.
            autosaveSchedulerRef.current.cancel();
            // Suppress unmount flush so clear is not undone when the wizard unmounts after navigate.
            suppressUnmountFlushRef.current = true;
            pendingDraftRef.current = null;
            // Project creation already succeeded; clear failure must not report「建图失败」or invite a duplicate import.
            try {
                await clearPptCreationDraft();
                message.success("画布已创建");
            } catch {
                message.warning(describePptCreationClearFailure("finalize"));
            }
            onCreated(id);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "建图失败，请重试");
        } finally {
            setBuilding(false);
        }
    };

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
                <header className="flex items-center gap-3 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <Button type="text" icon={<ArrowLeft className="size-4" />} onClick={() => void handleCancel()}>
                        返回列表
                    </Button>
                    <h1 className="text-xl font-semibold">新建 PPT</h1>
                    <div className="ml-auto">
                        <Popconfirm title="重新开始？" description="将清除未完成的创建草稿并回到初始步骤。" okText="重新开始" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={handleRestart}>
                            <Button type="text">重新开始</Button>
                        </Popconfirm>
                    </div>
                </header>

                {resumed ? <Alert type="info" showIcon message="已恢复上次未完成内容" className="border-stone-200 dark:border-stone-800" /> : null}

                <Steps
                    current={step}
                    size="small"
                    className="[&_.ant-steps-item-icon-number]:font-mono [&_.ant-steps-item-icon-number]:tabular-nums"
                    items={[{ title: "材料与目标" }, { title: mode === "outline" ? "内容方案" : "分页规格" }, { title: mode === "outline" ? "视觉方向" : "整套说明" }]}
                />

                {step === 0 ? (
                    <div className="flex flex-col gap-4">
                        <label className="grid gap-1.5">
                            <span className="text-sm font-medium">生成方式</span>
                            <Segmented
                                block
                                value={mode}
                                onChange={(value) => {
                                    contentPlanning.cancel();
                                    stylePlanning.cancel();
                                    cancelExtract();
                                    setMode(value as PptWizardMode);
                                    setPages([]);
                                    setFinalizedContent(null);
                                    setBrokenReferenceKeys([]);
                                    setExtractedDirectionHint("");
                                    setExtractGlobalDecision(null);
                                    setExtractError("");
                                }}
                                options={[
                                    {
                                        value: "outline",
                                        label: (
                                            <span className="flex min-h-12 flex-col justify-center px-1 py-1 text-left leading-5">
                                                <span className="font-medium">从材料拆大纲</span>
                                                <span className="text-xs opacity-55">工具帮你规划分页与要点，适合还没想清楚具体每页内容</span>
                                            </span>
                                        ),
                                    },
                                    {
                                        value: "extract",
                                        label: (
                                            <span className="flex min-h-12 flex-col justify-center px-1 py-1 text-left leading-5">
                                                <span className="font-medium">已有规格，直接生图</span>
                                                <span className="text-xs opacity-55">你的稿子已写好每页提示词，按原样逐字展开、不改写</span>
                                            </span>
                                        ),
                                    },
                                ]}
                            />
                        </label>
                        <label className="grid gap-1.5">
                            <span className="text-sm font-medium">PPT 标题</span>
                            <Input value={deckTitle} onChange={(event) => setDeckTitle(event.target.value)} placeholder="例如：2026 年度产品发布提案" />
                        </label>
                        <label className="grid gap-1.5">
                            <span className="text-sm font-medium">材料内容</span>
                            <TextArea
                                value={material}
                                onChange={(event) => setMaterial(event.target.value)}
                                placeholder={mode === "extract" ? "粘贴已经写好的完整提示词稿，每页内容按原样展开" : "粘贴 Markdown 或整份文字材料"}
                                autoSize={{ minRows: 8, maxRows: 16 }}
                            />
                        </label>
                        {mode === "outline" ? (
                            <label className="grid gap-1.5">
                                <span className="text-sm font-medium">PPT 要求（可选）</span>
                                <TextArea value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="例如：9 页以内，保留全部数据，禁止二维码" autoSize={{ minRows: 2, maxRows: 6 }} />
                            </label>
                        ) : null}
                        <div className="flex justify-end">
                            <Button type="primary" icon={<Sparkles className="size-4" />} onClick={startPlanning}>
                                {mode === "outline" ? "生成内容方案" : "展开分页规格"}
                            </Button>
                        </div>
                    </div>
                ) : null}

                {step === 1 && mode === "outline" ? (
                    <PptContentPlanStep
                        planning={contentPlanning}
                        onBack={() => setStep(0)}
                        onConfirmed={(content) => {
                            setBrokenReferenceKeys([]);
                            setFinalizedContent(content);
                            setStep(2);
                        }}
                    />
                ) : null}

                {step === 1 && mode === "extract" ? (
                    <ExtractSpecStep
                        pages={pages}
                        loading={extractLoading}
                        error={extractError}
                        receivedCharacters={extractReceivedCharacters}
                        onBack={() => {
                            cancelExtract();
                            setStep(0);
                        }}
                        onRetry={() => void runExtract()}
                        onCancel={cancelExtract}
                        onUpdate={updateExtractPage}
                        onRemove={removePage}
                        onAdd={addPage}
                        onContinue={continueExtract}
                    />
                ) : null}

                {step === 2 ? (
                    <div className="flex flex-col gap-4">
                        {mode === "outline" ? (
                            <>
                                <div>
                                    <h2 className="text-base font-semibold">选择整套 PPT 的视觉方向</h2>
                                    <p className="mt-1 text-sm text-stone-500">内容已经定稿，这一步只决定整套的视觉规则。</p>
                                </div>
                                <PptVisualDirectionEditor
                                    value={stylePlanning.contract || stylePlanning.fallbackCandidates[0].contract}
                                    onChange={(contract) => {
                                        setBrokenReferenceKeys([]);
                                        stylePlanning.editContract(contract);
                                    }}
                                    candidates={stylePlanning.candidates}
                                    selectedCandidateId={stylePlanning.selectedCandidateId || ""}
                                    onSelectCandidate={stylePlanning.chooseCandidate}
                                    pageCount={finalizedContent?.pageSpecs.length || 0}
                                    loading={stylePlanning.loading}
                                    error={stylePlanning.error}
                                    onRetry={() => void stylePlanning.generate({ force: true })}
                                    onUseFallback={() => stylePlanning.useFallback()}
                                    onAddReferences={stylePlanning.addReferences}
                                    extractedDirectionHint={finalizedContent?.brief.visualSignals.join("\n") || undefined}
                                />
                                {!stylePlanning.loading && (stylePlanning.contract || stylePlanning.recommendation.status !== "idle") ? (
                                    <PptStyleReviewPanel
                                        planning={stylePlanning}
                                        onReturnToContent={(pageId, regenerate) => {
                                            stylePlanning.cancel();
                                            setFinalizedContent(null);
                                            setStep(1);
                                            if (pageId && regenerate) void contentPlanning.regeneratePage(pageId);
                                        }}
                                        onOpenContract={(issue) => {
                                            const advanced = document.getElementById("ppt-style-contract-advanced") as HTMLDetailsElement | null;
                                            if (advanced) {
                                                advanced.open = true;
                                                advanced.scrollIntoView({ behavior: "smooth", block: "start" });
                                            }
                                            message.info(issue?.code === "reference_unreadable" ? "请在高级设置中删除或重新上传参考图" : "请在高级设置中调整整套 Contract");
                                        }}
                                    />
                                ) : null}
                            </>
                        ) : (
                            <ExtractGlobalSpecDecision value={extractedDirectionHint} decision={extractGlobalDecision} onChange={setExtractGlobalDecision} />
                        )}

                        <div className="flex justify-between">
                            <Button
                                icon={<ArrowLeft className="size-4" />}
                                onClick={() => {
                                    stylePlanning.cancel();
                                    setStep(1);
                                }}
                            >
                                上一步
                            </Button>
                            <Button
                                type="primary"
                                icon={<Sparkles className="size-4" />}
                                loading={building}
                                disabled={(mode === "outline" && !stylePlanning.canContinue) || (mode === "extract" && Boolean(extractedDirectionHint) && extractGlobalDecision === null)}
                                onClick={() => void confirmBuild()}
                            >
                                生成画布
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>
        </main>
    );
}

function createDeckBrief(content: FinalizedPptContent, styleContract: CanvasProjectPptStyleContract, requirements: string): CanvasProjectPptDeckBrief {
    const normalizedContract = normalizePptStyleContract(styleContract);
    const styleRules = derivePptVisualDirectionRules(requirements);
    return {
        version: 1,
        sourceHash: content.brief.sourceHash,
        contentRevision: content.contentRevision,
        audience: content.brief.audience,
        goal: content.brief.goal,
        narrative: content.brief.narrative,
        styleContract: normalizedContract,
        globalRules: [],
        forbiddenRules: styleRules.forbiddenRules,
        lockedDeckFacts: [],
    };
}

function ExtractSpecStep({
    pages,
    loading,
    error,
    receivedCharacters,
    onBack,
    onRetry,
    onCancel,
    onUpdate,
    onRemove,
    onAdd,
    onContinue,
}: {
    pages: PptOutlinePage[];
    loading: boolean;
    error: string;
    receivedCharacters: number;
    onBack: () => void;
    onRetry: () => void;
    onCancel: () => void;
    onUpdate: (index: number, patch: Pick<PptOutlinePage, "title"> | Pick<PptOutlinePage, "outline">) => void;
    onRemove: (index: number) => void;
    onAdd: () => void;
    onContinue: () => void;
}) {
    return (
        <section className="flex flex-col gap-4" aria-busy={loading}>
            <div className="flex items-start justify-between gap-3">
                <div>
                    <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-stone-400">逐字模式</p>
                    <h2 className="mt-2 text-lg font-semibold">分页规格</h2>
                    <p className="mt-1 text-sm text-stone-500">只定位每页原文，不改写、不补充内容。</p>
                </div>
                {pages.length && !loading ? (
                    <Button size="small" icon={<Sparkles className="size-3.5" />} onClick={onRetry}>
                        重新展开
                    </Button>
                ) : null}
            </div>

            {error ? <Alert type="error" showIcon message={error} description={pages.length ? "当前分页仍已保留。" : "原始材料已保留，可以直接重试。"} /> : null}

            {loading && !pages.length ? (
                <div className="border-y border-stone-200 py-6 dark:border-stone-800">
                    <Skeleton active title={{ width: "35%" }} paragraph={{ rows: 5 }} />
                    <p className="mt-3 text-center text-xs text-stone-500">{receivedCharacters ? "正在按原文定位分页…" : "正在读取分页结构…"}</p>
                </div>
            ) : null}

            {loading && pages.length ? (
                <div className="flex items-center justify-between border-l-2 border-stone-300 py-1 pl-3 text-sm text-stone-500 dark:border-stone-700">
                    <span>正在展开新分页，已识别 {pages.length} 页</span>
                    <Button type="text" danger size="small" onClick={onCancel}>
                        取消
                    </Button>
                </div>
            ) : null}

            {pages.length ? (
                <div className="flex flex-col gap-3">
                    {pages.map((page, index) => (
                        <article
                            key={`${page.sourceRange?.startLine ?? "edited"}:${index}`}
                            style={{ animationDelay: revealDelay(index) }}
                            className="group animate-in fade-in-0 slide-in-from-bottom-2 border border-stone-200 p-3 duration-200 ease-out motion-reduce:animate-none dark:border-stone-800"
                        >
                            <div className="mb-2 flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                    <span className="font-mono text-xs font-medium tabular-nums text-stone-500">{String(index + 1).padStart(2, "0")}</span>
                                    <span className="text-[11px] text-stone-400">{page.sourceRange ? `原稿 L${page.sourceRange.startLine}–${page.sourceRange.endLine}` : "用户编辑"}</span>
                                </div>
                                <Popconfirm title="删除该页？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => onRemove(index)}>
                                    <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} aria-label="删除该页" />
                                </Popconfirm>
                            </div>
                            <div className="grid gap-2">
                                <Input value={page.title} onChange={(event) => onUpdate(index, { title: event.target.value })} placeholder="页标题" />
                                <TextArea value={page.outline} onChange={(event) => onUpdate(index, { outline: event.target.value })} placeholder="该页完整提示词" autoSize={{ minRows: 5, maxRows: 14 }} />
                            </div>
                        </article>
                    ))}
                    <Button type="text" icon={<Plus className="size-3.5" />} onClick={onAdd}>
                        手动增加一页
                    </Button>
                </div>
            ) : !loading ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未展开分页">
                    <div className="flex flex-col items-center gap-2">
                        <Button type="primary" icon={<Sparkles className="size-3.5" />} onClick={onRetry}>
                            重试展开
                        </Button>
                        <Button type="text" icon={<Plus className="size-3.5" />} onClick={onAdd}>
                            手动添加一页
                        </Button>
                    </div>
                </Empty>
            ) : null}

            <div className="flex justify-between border-t border-stone-200 pt-4 dark:border-stone-800">
                <Button icon={<ArrowLeft className="size-4" />} onClick={onBack}>
                    上一步
                </Button>
                <Button type="primary" icon={<ArrowRight className="size-4" />} iconPosition="end" disabled={loading || !pages.length} onClick={onContinue}>
                    确认分页
                </Button>
            </div>
        </section>
    );
}

function ExtractGlobalSpecDecision({ value, decision, onChange }: { value: string; decision: "include" | "exclude" | null; onChange: (value: "include" | "exclude") => void }) {
    if (!value) {
        return <Alert type="info" showIcon message="没有待确认的整套说明" description="后续将仅使用每页的逐字规格，不额外添加默认视觉 Contract。" />;
    }
    return (
        <section className="space-y-4">
            <div>
                <h2 className="text-base font-semibold">确认原稿中未归入单页的说明</h2>
                <p className="mt-1 text-sm text-stone-500">这段内容不会自动添加。请明确决定是否逐字附加到每页。</p>
            </div>
            <pre className="thin-scrollbar max-h-64 overflow-auto whitespace-pre-wrap border-y border-stone-200 py-4 font-sans text-sm leading-6 text-stone-600 dark:border-stone-800 dark:text-stone-300">{value}</pre>
            <Segmented
                block
                value={decision || undefined}
                onChange={(next) => onChange(next as "include" | "exclude")}
                options={[
                    { label: "附加到每页", value: "include" },
                    { label: "不附加", value: "exclude" },
                ]}
            />
            {decision === null ? <p className="text-sm text-amber-600 dark:text-amber-300">请选择后再生成画布。</p> : null}
        </section>
    );
}
