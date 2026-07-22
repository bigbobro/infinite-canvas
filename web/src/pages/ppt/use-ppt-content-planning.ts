import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
    acceptPptPageSuggestions,
    applyPptContentAction,
    applyPptContentRepair,
    assertPptPageAuditIssuesResolved,
    createPptContentRepairPreview,
    finalizePptContentDraft,
    isPptAuthoringInstruction,
    normalizePptContentDraft,
    previewPptContentAction,
    replacePptContentDraftPage,
    resolvePptInformationGap,
    validatePptContentDraft,
    type PptContentAction,
    type PptContentDraft,
    type PptContentRepairPreview,
    type PptInformationGapResolution,
} from "@/lib/ppt/content-plan";
import { previewPptContentPlanStream, requestPptContentPageRegeneration, requestPptContentPlan, type PptContentPlanRequest, type PptContentStreamProgress } from "@/services/api/ppt-content";
import type { AiConfig } from "@/stores/use-config-store";

type DraftEntry = { inputKey: string; draft: PptContentDraft | null };
type RequestState = { inputKey: string; loading: boolean; error: string; receivedCharacters: number; streamProgress: PptContentStreamProgress };
type PageRequestState = { inputKey: string; pageId: string | null; loading: boolean; error: string; receivedCharacters: number };

const EMPTY_STREAM_PROGRESS: PptContentStreamProgress = { completedPages: [] };

export type PptContentPlanningController = ReturnType<typeof usePptContentPlanning>;
export type FinalizedPptContent = ReturnType<typeof finalizePptContentDraft>;

export function usePptContentPlanning(config: AiConfig, input: PptContentPlanRequest) {
    const inputSnapshot = useMemo(() => ({ title: input.title, sourceMaterial: input.sourceMaterial, requirements: input.requirements }), [input.requirements, input.sourceMaterial, input.title]);
    const inputKey = useMemo(() => createPptContentInputKey(inputSnapshot), [inputSnapshot]);
    const requestConfigKey = `${config.textModel || config.model}\u0000${config.baseUrl}\u0000${config.apiFormat}`;
    const cacheRef = useRef(new Map<string, PptContentDraft>());
    const controllerRef = useRef<AbortController | null>(null);
    const requestTokenRef = useRef(0);
    const inputRef = useRef(inputSnapshot);
    const inputKeyRef = useRef(inputKey);
    const configRef = useRef(config);
    const draftRef = useRef<PptContentDraft | null>(null);
    const draftKeyRef = useRef(inputKey);
    const [draftEntry, setDraftEntry] = useState<DraftEntry>({ inputKey, draft: null });
    const [requestState, setRequestState] = useState<RequestState>({ inputKey, loading: false, error: "", receivedCharacters: 0, streamProgress: EMPTY_STREAM_PROGRESS });
    const [pageRequestState, setPageRequestState] = useState<PageRequestState>({ inputKey, pageId: null, loading: false, error: "", receivedCharacters: 0 });
    const [repairPreview, setRepairPreview] = useState<PptContentRepairPreview | null>(null);

    inputRef.current = inputSnapshot;
    inputKeyRef.current = inputKey;
    configRef.current = config;

    const cancel = useCallback(() => {
        controllerRef.current?.abort();
        controllerRef.current = null;
        requestTokenRef.current += 1;
        setRequestState((current) => (current.loading ? { ...current, loading: false, streamProgress: EMPTY_STREAM_PROGRESS } : current));
        setPageRequestState((current) => (current.loading ? { ...current, loading: false } : current));
    }, []);

    useEffect(() => {
        cancel();
        const cached = cacheRef.current.get(inputKey) ?? null;
        draftRef.current = cached;
        draftKeyRef.current = inputKey;
        setDraftEntry({ inputKey, draft: cached });
        setRepairPreview(null);
        setRequestState({ inputKey, loading: false, error: "", receivedCharacters: 0, streamProgress: EMPTY_STREAM_PROGRESS });
        setPageRequestState({ inputKey, pageId: null, loading: false, error: "", receivedCharacters: 0 });
    }, [cancel, inputKey, requestConfigKey]);

    useEffect(
        () => () => {
            controllerRef.current?.abort();
            requestTokenRef.current += 1;
        },
        [],
    );

    const visibleDraft = draftEntry.inputKey === inputKey ? draftEntry.draft : (cacheRef.current.get(inputKey) ?? null);
    const validation = useMemo(() => (visibleDraft ? validatePptContentDraft(visibleDraft) : null), [visibleDraft]);
    const visibleRequest = requestState.inputKey === inputKey ? requestState : { inputKey, loading: false, error: "", receivedCharacters: 0, streamProgress: EMPTY_STREAM_PROGRESS };
    const visiblePageRequest = pageRequestState.inputKey === inputKey ? pageRequestState : { inputKey, pageId: null, loading: false, error: "", receivedCharacters: 0 };

    const commitDraft = useCallback((targetInputKey: string, draft: PptContentDraft) => {
        cacheRef.current.set(targetInputKey, draft);
        if (inputKeyRef.current !== targetInputKey) return;
        draftRef.current = draft;
        draftKeyRef.current = targetInputKey;
        setDraftEntry({ inputKey: targetInputKey, draft });
    }, []);

    const currentDraft = useCallback(() => {
        const key = inputKeyRef.current;
        return draftKeyRef.current === key ? draftRef.current : (cacheRef.current.get(key) ?? null);
    }, []);

    const setError = useCallback((message: string) => {
        const key = inputKeyRef.current;
        setRequestState((current) => ({
            inputKey: key,
            loading: current.inputKey === key ? current.loading : false,
            error: message,
            receivedCharacters: current.inputKey === key ? current.receivedCharacters : 0,
            streamProgress: current.inputKey === key ? current.streamProgress : EMPTY_STREAM_PROGRESS,
        }));
    }, []);

    const generate = useCallback(
        async ({ force = false }: { force?: boolean } = {}) => {
            const requestedInput = inputRef.current;
            const requestedInputKey = inputKeyRef.current;
            const previousDraft = currentDraft();
            const requestedRevision = previousDraft?.revision ?? null;
            if (!requestedInput.sourceMaterial.trim()) {
                setError("请先粘贴材料内容");
                return null;
            }
            if (!force) {
                const cached = cacheRef.current.get(requestedInputKey);
                if (cached) {
                    commitDraft(requestedInputKey, cached);
                    setError("");
                    return cached;
                }
            }

            cancel();
            const controller = new AbortController();
            const token = requestTokenRef.current + 1;
            requestTokenRef.current = token;
            controllerRef.current = controller;
            setRepairPreview(null);
            setPageRequestState({ inputKey: requestedInputKey, pageId: null, loading: false, error: "", receivedCharacters: 0 });
            setRequestState({ inputKey: requestedInputKey, loading: true, error: "", receivedCharacters: 0, streamProgress: EMPTY_STREAM_PROGRESS });

            try {
                const raw = await requestPptContentPlan(
                    configRef.current,
                    requestedInput,
                    (text) => {
                        if (controller.signal.aborted || requestTokenRef.current !== token || inputKeyRef.current !== requestedInputKey) return;
                        setRequestState({ inputKey: requestedInputKey, loading: true, error: "", receivedCharacters: text.length, streamProgress: previewPptContentPlanStream(text) });
                    },
                    { signal: controller.signal },
                );
                if (controller.signal.aborted || requestTokenRef.current !== token || inputKeyRef.current !== requestedInputKey) return null;
                if ((currentDraft()?.revision ?? null) !== requestedRevision) {
                    setError("内容方案已在生成期间变更，本次返回结果已丢弃");
                    return null;
                }
                const next = normalizePptContentDraft(raw, {
                    ...requestedInput,
                    ...(previousDraft ? { previousPageSpecs: previousDraft.pageSpecs } : {}),
                });
                commitDraft(requestedInputKey, next);
                return next;
            } catch (error) {
                if (controller.signal.aborted || requestTokenRef.current !== token || inputKeyRef.current !== requestedInputKey) return null;
                setError(error instanceof Error ? error.message : "内容方案生成失败，请重试");
                return null;
            } finally {
                if (requestTokenRef.current === token) {
                    controllerRef.current = null;
                    setRequestState((current) => (current.inputKey === requestedInputKey ? { ...current, loading: false, streamProgress: EMPTY_STREAM_PROGRESS } : current));
                }
            }
        },
        [cancel, commitDraft, currentDraft, setError],
    );

    const resolveGap = useCallback(
        (gapId: string, resolution: PptInformationGapResolution) => {
            const draft = currentDraft();
            if (!draft) return null;
            try {
                const next = resolvePptInformationGap(draft, gapId, resolution);
                commitDraft(inputKeyRef.current, next);
                setRepairPreview(null);
                setError("");
                return next;
            } catch (error) {
                setError(error instanceof Error ? error.message : "信息缺口处理失败");
                return null;
            }
        },
        [commitDraft, currentDraft, setError],
    );

    const previewRepair = useCallback(
        (issueIds: string[]) => {
            const draft = currentDraft();
            if (!draft) return null;
            try {
                const preview = createPptContentRepairPreview(draft, issueIds);
                if (!preview.operations.length) {
                    setError("所选问题没有可安全自动处理的修复");
                    return null;
                }
                setRepairPreview(preview);
                setError("");
                return preview;
            } catch (error) {
                setError(error instanceof Error ? error.message : "修复预览生成失败");
                return null;
            }
        },
        [currentDraft, setError],
    );

    const applyRepair = useCallback(() => {
        const draft = currentDraft();
        if (!draft || !repairPreview) return null;
        try {
            const next = applyPptContentRepair(draft, repairPreview);
            commitDraft(inputKeyRef.current, next);
            setRepairPreview(null);
            setError("");
            return next;
        } catch (error) {
            setRepairPreview(null);
            setError(error instanceof Error ? error.message : "内容修复失败");
            return null;
        }
    }, [commitDraft, currentDraft, repairPreview, setError]);

    const applyAction = useCallback(
        (action: PptContentAction) => {
            const draft = currentDraft();
            if (!draft) return null;
            try {
                const next = applyPptContentAction(draft, previewPptContentAction(draft, action));
                commitDraft(inputKeyRef.current, next);
                setRepairPreview(null);
                setError("");
                return next;
            } catch (error) {
                setError(error instanceof Error ? error.message : "内容操作失败");
                return null;
            }
        },
        [commitDraft, currentDraft, setError],
    );

    const acceptPageSuggestions = useCallback(
        (pageId: string) => {
            const draft = currentDraft();
            if (!draft) return null;
            const suggestions = draft.audit.gaps.filter((gap) => gap.pageId === pageId && !gap.resolution && gap.proposedAnswer?.trim());
            if (!suggestions.length) {
                setError("本页暂无可采纳的 AI 建议");
                return null;
            }
            try {
                const next = acceptPptPageSuggestions(draft, pageId, new Date().toISOString());
                commitDraft(inputKeyRef.current, next);
                setRepairPreview(null);
                setError("");
                return next;
            } catch (error) {
                setError(error instanceof Error ? error.message : "采纳本页建议失败");
                return null;
            }
        },
        [commitDraft, currentDraft, setError],
    );

    const regeneratePage = useCallback(
        async (pageId: string) => {
            const requestedInput = inputRef.current;
            const requestedInputKey = inputKeyRef.current;
            const draft = currentDraft();
            const targetIndex = draft?.pageSpecs.findIndex((page) => page.pageId === pageId) ?? -1;
            if (!draft || targetIndex < 0) {
                setError("单页生成目标不存在");
                return null;
            }
            const target = draft.pageSpecs[targetIndex];
            const titleOf = (page: typeof target) => page.contentBlocks.find((block) => block.kind === "title")?.text || "未命名页";
            const claim = target.contentBlocks.find((block) => block.kind === "primary_claim")?.text || "";
            const authoringInstructions = target.contentBlocks.map((block) => block.text).filter(isPptAuthoringInstruction);
            const auditIssues = draft.audit.issues
                .filter((issue) => issue.code !== "unresolved_gap" && issue.pageIds.includes(pageId))
                .map((issue) => ({ code: issue.code, message: issue.message, ...(issue.field ? { field: issue.field } : {}), ...(issue.value ? { value: issue.value } : {}) }));
            const sourceById = new Map(target.sourceRefs.map((source) => [source.id, source]));
            const requestedRevision = draft.revision;

            cancel();
            const controller = new AbortController();
            const token = requestTokenRef.current + 1;
            requestTokenRef.current = token;
            controllerRef.current = controller;
            setRepairPreview(null);
            setPageRequestState({ inputKey: requestedInputKey, pageId, loading: true, error: "", receivedCharacters: 0 });

            try {
                const raw = await requestPptContentPageRegeneration(
                    configRef.current,
                    {
                        ...requestedInput,
                        draftRevision: requestedRevision,
                        targetPageNumber: targetIndex + 1,
                        targetPage: {
                            title: titleOf(target),
                            purpose: target.purpose,
                            primaryClaim: isPptAuthoringInstruction(claim) ? "" : claim,
                            contentBlocks: target.contentBlocks.filter((block) => block.kind !== "title" && block.kind !== "primary_claim" && !isPptAuthoringInstruction(block.text)).map((block) => ({ kind: block.kind, text: block.text })),
                        },
                        authoringInstructions,
                        auditIssues,
                        confirmedInputs: target.contentBlocks.flatMap((block) => {
                            if (isPptAuthoringInstruction(block.text)) return [];
                            const source = block.sourceRefIds.map((sourceRefId) => sourceById.get(sourceRefId)).find((candidate) => candidate?.source === "user_answer" || candidate?.source === "confirmed_assumption");
                            return source ? [{ source: source.source as "user_answer" | "confirmed_assumption", kind: block.kind, text: block.text }] : [];
                        }),
                        unresolvedGaps: draft.audit.gaps.filter((gap) => gap.pageId === pageId && !gap.resolution).map((gap) => ({ question: gap.question, reason: gap.reason, ...(gap.proposedAnswer ? { proposedAnswer: gap.proposedAnswer } : {}) })),
                        otherPageTitles: draft.pageSpecs.filter((page) => page.pageId !== pageId).map(titleOf),
                    },
                    (text) => {
                        if (controller.signal.aborted || requestTokenRef.current !== token || inputKeyRef.current !== requestedInputKey) return;
                        setPageRequestState({ inputKey: requestedInputKey, pageId, loading: true, error: "", receivedCharacters: text.length });
                    },
                    { signal: controller.signal },
                );
                if (controller.signal.aborted || requestTokenRef.current !== token || inputKeyRef.current !== requestedInputKey) return null;
                const normalized = normalizePptContentDraft(raw, { ...requestedInput, previousPageSpecs: [target] });
                if (normalized.pageSpecs.length !== 1) throw new Error("单页生成返回了多个页面");
                const latest = currentDraft();
                if (!latest) return null;
                const next = replacePptContentDraftPage(
                    latest,
                    requestedRevision,
                    pageId,
                    normalized.pageSpecs[0],
                    normalized.audit.gaps.filter((gap) => gap.pageId === pageId),
                );
                assertPptPageAuditIssuesResolved(next, pageId, auditIssues);
                commitDraft(requestedInputKey, next);
                return next;
            } catch (error) {
                if (controller.signal.aborted || requestTokenRef.current !== token || inputKeyRef.current !== requestedInputKey) return null;
                const errorMessage = error instanceof Error ? error.message : "单页生成失败";
                setPageRequestState({ inputKey: requestedInputKey, pageId, loading: false, error: errorMessage, receivedCharacters: 0 });
                return null;
            } finally {
                if (requestTokenRef.current === token) {
                    controllerRef.current = null;
                    setPageRequestState((current) => (current.inputKey === requestedInputKey && current.pageId === pageId ? { ...current, loading: false } : current));
                }
            }
        },
        [cancel, commitDraft, currentDraft, setError],
    );

    const finalize = useCallback(
        (approvedAt = new Date().toISOString()) => {
            const draft = currentDraft();
            if (!draft) throw new Error("请先生成内容方案");
            return finalizePptContentDraft(draft, approvedAt);
        },
        [currentDraft],
    );

    return {
        input: inputSnapshot,
        inputKey,
        draft: visibleDraft,
        validation,
        repairPreview,
        loading: visibleRequest.loading || visiblePageRequest.loading,
        error: visibleRequest.error,
        receivedCharacters: visibleRequest.receivedCharacters,
        streamProgress: visibleRequest.streamProgress,
        pageRequest: visiblePageRequest,
        generate,
        regeneratePage,
        cancel,
        resolveGap,
        acceptPageSuggestions,
        editBlock: (pageId: string, blockId: string, text: string) => applyAction({ kind: "edit_block", pageId, blockId, text, editedAt: new Date().toISOString() }),
        editPurpose: (pageId: string, purpose: string) => applyAction({ kind: "edit_purpose", pageId, purpose }),
        removePage: (pageId: string) => applyAction({ kind: "remove_page", pageId }),
        mergePages: (pageIds: [string, string]) => applyAction({ kind: "merge_pages", pageIds }),
        reorderPages: (pageIds: string[]) => applyAction({ kind: "reorder_pages", pageIds }),
        previewRepair,
        applyRepair,
        dismissRepair: () => setRepairPreview(null),
        clearError: () => setError(""),
        finalize,
    };
}

export function createPptContentInputKey(input: PptContentPlanRequest) {
    return [input.title, input.sourceMaterial, input.requirements].map((value) => `${value.length}:${value}`).join("|");
}
