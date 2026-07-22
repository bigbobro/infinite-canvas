import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
    createPptStyleDirectionInputKey,
    createPptStyleFallbackCandidates,
    isPptStyleDirectionCandidateStale,
    requestPptStyleDirections,
    type PptStyleDirectionCandidate,
    type PptStyleDirectionPlannerInput,
    type PptStyleTextRequester,
} from "@/lib/ppt/style-direction-planner";
import { applyPptStyleRepair, applyPptStyleReviewChoice, compilePptStyleContract, previewPptStyleRepair, reviewPptStyle, type PptStyleRepairPatch, type PptStyleReview, type PptStyleReviewInput } from "@/lib/ppt/style-contract";
import type { CanvasProjectPptPageSpec, CanvasProjectPptStyleContract, PptVisualDirectionPresetId } from "@/stores/canvas/use-canvas-store";
import type { AiConfig } from "@/stores/use-config-store";

type PptStylePlanningOptions = {
    initialContract?: CanvasProjectPptStyleContract | null;
    requester?: PptStyleTextRequester;
    brokenReferenceKeys?: string[];
};

type RecommendationState = {
    inputKey: string;
    status: "idle" | "loading" | "ready" | "error" | "fallback";
    error: string;
    receivedCharacters: number;
};

type PageSpecEntry = { inputKey: string; pageSpecs: CanvasProjectPptPageSpec[] };

export type PptStylePlanningController = ReturnType<typeof usePptStylePlanning>;

export function usePptStylePlanning(config: AiConfig, input: PptStyleDirectionPlannerInput, options: PptStylePlanningOptions = {}) {
    const plannerInput = useMemo<PptStyleDirectionPlannerInput>(
        () => ({
            brief: input.brief,
            pageSpecs: input.pageSpecs,
            contentRevision: input.contentRevision,
            ...(input.visualSignals ? { visualSignals: input.visualSignals } : {}),
            ...(input.referenceKeys ? { referenceKeys: input.referenceKeys } : {}),
        }),
        [input.brief, input.contentRevision, input.pageSpecs, input.referenceKeys, input.visualSignals],
    );
    const inputKey = useMemo(() => createPptStyleDirectionInputKey(plannerInput), [plannerInput]);
    const requestConfigKey = `${config.textModel || config.model}\u0000${config.baseUrl}\u0000${config.apiFormat}`;
    const initialContract = useMemo(() => canonicalContract(options.initialContract), []);

    const cacheRef = useRef(new Map<string, PptStyleDirectionCandidate[]>());
    const controllerRef = useRef<AbortController | null>(null);
    const requestTokenRef = useRef(0);
    const inputRef = useRef(plannerInput);
    const inputKeyRef = useRef(inputKey);
    const configRef = useRef(config);
    const requestConfigKeyRef = useRef(requestConfigKey);
    const requesterRef = useRef(options.requester);
    const brokenReferenceKeysRef = useRef(options.brokenReferenceKeys || []);
    const interactedRef = useRef(false);
    const contractRef = useRef<CanvasProjectPptStyleContract | null>(initialContract);
    const selectedCandidateIdRef = useRef<string | null>(null);
    const draftRevisionRef = useRef(initialContract ? 1 : 0);
    const reviewedContentRevisionRef = useRef(initialContract ? input.contentRevision : "");
    const pageSpecsRef = useRef(structuredClone(input.pageSpecs));

    const [candidates, setCandidates] = useState<PptStyleDirectionCandidate[]>([]);
    const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
    const [contract, setContract] = useState<CanvasProjectPptStyleContract | null>(initialContract);
    const [draftRevision, setDraftRevision] = useState(initialContract ? 1 : 0);
    const [reviewedContentRevision, setReviewedContentRevision] = useState(initialContract ? input.contentRevision : "");
    const [pageSpecEntry, setPageSpecEntry] = useState<PageSpecEntry>({ inputKey, pageSpecs: structuredClone(input.pageSpecs) });
    const [repairPreview, setRepairPreview] = useState<PptStyleRepairPatch | null>(null);
    const [interacted, setInteracted] = useState(false);
    const [recommendation, setRecommendation] = useState<RecommendationState>({ inputKey, status: "idle", error: "", receivedCharacters: 0 });

    inputRef.current = plannerInput;
    inputKeyRef.current = inputKey;
    configRef.current = config;
    requesterRef.current = options.requester;
    brokenReferenceKeysRef.current = options.brokenReferenceKeys || [];
    const pageSpecs = pageSpecEntry.inputKey === inputKey ? pageSpecEntry.pageSpecs : input.pageSpecs;
    pageSpecsRef.current = pageSpecs;

    const cancel = useCallback(() => {
        controllerRef.current?.abort();
        controllerRef.current = null;
        requestTokenRef.current += 1;
        const currentInputKey = inputKeyRef.current;
        setRecommendation((current) => (current.status === "loading" ? { inputKey: currentInputKey, status: "idle", error: "", receivedCharacters: 0 } : current));
    }, []);

    useEffect(() => {
        cancel();
        const nextPageSpecs = structuredClone(plannerInput.pageSpecs);
        pageSpecsRef.current = nextPageSpecs;
        setPageSpecEntry({ inputKey, pageSpecs: nextPageSpecs });
        setRepairPreview(null);
        const cached = cacheRef.current.get(inputKey);
        setCandidates(cached || []);
        setRecommendation({ inputKey, status: cached ? "ready" : "idle", error: "", receivedCharacters: 0 });
    }, [cancel, inputKey]);

    useEffect(() => {
        if (requestConfigKeyRef.current === requestConfigKey) return;
        requestConfigKeyRef.current = requestConfigKey;
        cancel();
    }, [cancel, requestConfigKey]);

    useEffect(
        () => () => {
            controllerRef.current?.abort();
            requestTokenRef.current += 1;
        },
        [],
    );

    const visibleRecommendation: RecommendationState = recommendation.inputKey === inputKey ? recommendation : { inputKey, status: "idle", error: "", receivedCharacters: 0 };

    const setError = useCallback((message: string) => {
        const currentInputKey = inputKeyRef.current;
        setRecommendation((current) => ({
            inputKey: currentInputKey,
            status: current.status === "loading" ? "loading" : "error",
            error: message,
            receivedCharacters: current.inputKey === currentInputKey ? current.receivedCharacters : 0,
        }));
    }, []);

    const commitContract = useCallback((next: CanvasProjectPptStyleContract, candidateId: string | null, reviewedRevision: string, markInteracted: boolean) => {
        const nextRevision = draftRevisionRef.current + 1;
        contractRef.current = structuredClone(next);
        draftRevisionRef.current = nextRevision;
        reviewedContentRevisionRef.current = reviewedRevision;
        selectedCandidateIdRef.current = candidateId;
        setContract(structuredClone(next));
        setDraftRevision(nextRevision);
        setReviewedContentRevision(reviewedRevision);
        setSelectedCandidateId(candidateId);
        setRepairPreview(null);
        if (markInteracted) {
            interactedRef.current = true;
            setInteracted(true);
            setRecommendation({ inputKey: inputKeyRef.current, status: "ready", error: "", receivedCharacters: 0 });
        }
    }, []);

    const acceptCandidates = useCallback(
        (next: PptStyleDirectionCandidate[], requestedRevision: string) => {
            setCandidates(next);
            if (interactedRef.current) return;
            const recommended = next.find((candidate) => candidate.recommended) || next[0];
            if (recommended) commitContract(recommended.contract, recommended.id, requestedRevision, false);
        },
        [commitContract],
    );

    const generate = useCallback(
        async ({ force = false }: { force?: boolean } = {}) => {
            const requestedInput = inputRef.current;
            const requestedInputKey = inputKeyRef.current;
            if (!requestedInput.contentRevision.trim()) {
                setError("内容版本缺失，不能生成视觉方向");
                return null;
            }
            if (!force) {
                const cached = cacheRef.current.get(requestedInputKey);
                if (cached) {
                    acceptCandidates(cached, requestedInput.contentRevision);
                    setRecommendation({ inputKey: requestedInputKey, status: "ready", error: "", receivedCharacters: 0 });
                    return cached;
                }
            }

            cancel();
            const controller = new AbortController();
            const token = requestTokenRef.current + 1;
            requestTokenRef.current = token;
            controllerRef.current = controller;
            setRepairPreview(null);
            setRecommendation({ inputKey: requestedInputKey, status: "loading", error: "", receivedCharacters: 0 });

            try {
                const next = await requestPptStyleDirections(
                    configRef.current,
                    requestedInput,
                    (text) => {
                        if (controller.signal.aborted || requestTokenRef.current !== token || inputKeyRef.current !== requestedInputKey) return;
                        setRecommendation({ inputKey: requestedInputKey, status: "loading", error: "", receivedCharacters: text.length });
                    },
                    { signal: controller.signal, ...(requesterRef.current ? { requester: requesterRef.current } : {}) },
                );
                if (controller.signal.aborted || requestTokenRef.current !== token || inputKeyRef.current !== requestedInputKey) return null;
                cacheRef.current.set(requestedInputKey, next);
                acceptCandidates(next, requestedInput.contentRevision);
                setRecommendation({ inputKey: requestedInputKey, status: "ready", error: "", receivedCharacters: 0 });
                return next;
            } catch (error) {
                if (controller.signal.aborted || requestTokenRef.current !== token || inputKeyRef.current !== requestedInputKey) return null;
                setRecommendation({
                    inputKey: requestedInputKey,
                    status: "error",
                    error: error instanceof Error ? error.message : "视觉方向生成失败，请重试或使用通用方向",
                    receivedCharacters: 0,
                });
                return null;
            } finally {
                if (requestTokenRef.current === token) controllerRef.current = null;
            }
        },
        [acceptCandidates, cancel, setError],
    );

    const chooseCandidate = useCallback(
        (candidateId: string) => {
            const candidate = candidates.find((item) => item.id === candidateId);
            if (!candidate) {
                setError("视觉方向候选不存在");
                return null;
            }
            cancel();
            const compiled = compilePptStyleContract({
                ...candidate.contract,
                references: contractRef.current?.references || candidate.contract.references,
            });
            if (!compiled.ok) {
                setError(compiled.issues.map((issue) => issue.message).join("；"));
                return null;
            }
            commitContract(compiled.value.canonical, candidate.id, inputRef.current.contentRevision, true);
            return compiled.value.canonical;
        },
        [cancel, candidates, commitContract, setError],
    );

    const editContract = useCallback(
        (next: CanvasProjectPptStyleContract) => {
            cancel();
            const compiled = compilePptStyleContract(next);
            if (!compiled.ok) {
                setError(compiled.issues.map((issue) => issue.message).join("；"));
                return null;
            }
            commitContract(compiled.value.canonical, selectedCandidateId, inputRef.current.contentRevision, true);
            return compiled.value.canonical;
        },
        [cancel, commitContract, selectedCandidateId, setError],
    );

    const useFallback = useCallback(
        (presetId: PptVisualDirectionPresetId = "clean-report") => {
            cancel();
            const fallback = createPptStyleFallbackCandidates(inputRef.current);
            const selected = fallback.find((candidate) => candidate.contract.source.kind === "preset" && candidate.contract.source.presetId === presetId) || fallback[0];
            const selectedContract = { ...selected.contract, references: contractRef.current?.references || selected.contract.references };
            setCandidates(fallback);
            commitContract(selectedContract, selected.id, inputRef.current.contentRevision, true);
            setRecommendation({ inputKey: inputKeyRef.current, status: "fallback", error: "", receivedCharacters: 0 });
            return fallback;
        },
        [cancel, commitContract],
    );

    const addReferences = useCallback(
        (references: Array<{ storageKey: string }>) => {
            const current = contractRef.current || createPptStyleFallbackCandidates(inputRef.current)[0].contract;
            const seen = new Set(current.references.map((reference) => reference.storageKey));
            const nextReferences = [...current.references, ...references.filter((reference) => reference.storageKey.trim() && !seen.has(reference.storageKey.trim())).map((reference) => ({ storageKey: reference.storageKey.trim() }))];
            const compiled = compilePptStyleContract({ ...current, references: nextReferences });
            if (!compiled.ok) {
                setError(compiled.issues.map((issue) => issue.message).join("；"));
                return null;
            }
            cancel();
            commitContract(compiled.value.canonical, selectedCandidateIdRef.current, inputRef.current.contentRevision, true);
            return compiled.value.canonical;
        },
        [cancel, commitContract, setError],
    );

    const makeReviewInput = useCallback(
        (reviewedRevision = reviewedContentRevisionRef.current): PptStyleReviewInput => ({
            contract: contractRef.current,
            contentRevision: inputRef.current.contentRevision,
            reviewedContentRevision: reviewedRevision,
            draftRevision: draftRevisionRef.current,
            pageSpecs: pageSpecsRef.current,
            brokenReferenceKeys: brokenReferenceKeysRef.current,
        }),
        [],
    );

    const review = useMemo<PptStyleReview>(
        () =>
            reviewPptStyle({
                contract,
                contentRevision: plannerInput.contentRevision,
                reviewedContentRevision,
                draftRevision,
                pageSpecs,
                brokenReferenceKeys: options.brokenReferenceKeys || [],
            }),
        [contract, draftRevision, options.brokenReferenceKeys, pageSpecs, plannerInput.contentRevision, reviewedContentRevision],
    );

    const recheck = useCallback(() => {
        const revision = inputRef.current.contentRevision;
        reviewedContentRevisionRef.current = revision;
        setReviewedContentRevision(revision);
        setRepairPreview(null);
        const next = reviewPptStyle(makeReviewInput(revision));
        setRecommendation((current) => ({ ...current, error: "" }));
        return next;
    }, [makeReviewInput]);

    const previewRepair = useCallback(
        (actionIds?: string[]) => {
            try {
                const preview = previewPptStyleRepair(makeReviewInput(), actionIds);
                if (!preview.operations.length) {
                    setError("当前问题没有可一键应用的确定性修复");
                    return null;
                }
                setRepairPreview(preview);
                setRecommendation((current) => ({ ...current, error: "" }));
                return preview;
            } catch (error) {
                setError(error instanceof Error ? error.message : "视觉修复预览失败");
                return null;
            }
        },
        [makeReviewInput, setError],
    );

    const applyRepair = useCallback(() => {
        if (!repairPreview) return null;
        try {
            const repaired = applyPptStyleRepair(makeReviewInput(), repairPreview);
            contractRef.current = repaired.contract;
            pageSpecsRef.current = repaired.pageSpecs;
            draftRevisionRef.current = repaired.draftRevision;
            reviewedContentRevisionRef.current = inputRef.current.contentRevision;
            interactedRef.current = true;
            setContract(repaired.contract);
            setPageSpecEntry({ inputKey: inputKeyRef.current, pageSpecs: repaired.pageSpecs });
            setDraftRevision(repaired.draftRevision);
            setReviewedContentRevision(inputRef.current.contentRevision);
            setInteracted(true);
            setRepairPreview(null);
            setRecommendation((current) => ({ ...current, error: "" }));
            return repaired;
        } catch (error) {
            setRepairPreview(null);
            setError(error instanceof Error ? error.message : "视觉修复失败");
            return null;
        }
    }, [makeReviewInput, repairPreview, setError]);

    const applyReviewChoice = useCallback(
        (issueId: string, kind: "keep_semantic_encoding" | "use_non_color_encoding", expectedReviewFingerprint: string) => {
            try {
                const repaired = applyPptStyleReviewChoice(makeReviewInput(), issueId, kind, expectedReviewFingerprint);
                contractRef.current = repaired.contract;
                pageSpecsRef.current = repaired.pageSpecs;
                draftRevisionRef.current = repaired.draftRevision;
                reviewedContentRevisionRef.current = inputRef.current.contentRevision;
                interactedRef.current = true;
                setContract(repaired.contract);
                setPageSpecEntry({ inputKey: inputKeyRef.current, pageSpecs: repaired.pageSpecs });
                setDraftRevision(repaired.draftRevision);
                setReviewedContentRevision(inputRef.current.contentRevision);
                setInteracted(true);
                setRepairPreview(null);
                setRecommendation((current) => ({ ...current, error: "" }));
                return repaired;
            } catch (error) {
                setError(error instanceof Error ? error.message : "视觉冲突处理失败");
                return null;
            }
        },
        [makeReviewInput, setError],
    );

    const fallbackCandidates = useMemo(() => createPptStyleFallbackCandidates(plannerInput), [plannerInput]);
    const candidateStale = candidates.some((candidate) => isPptStyleDirectionCandidateStale(candidate, plannerInput.contentRevision));
    const contractStale = Boolean(contract) && reviewedContentRevision !== plannerInput.contentRevision;

    return {
        input: plannerInput,
        inputKey,
        candidates,
        fallbackCandidates,
        selectedCandidateId,
        contract,
        pageSpecs,
        draftRevision,
        reviewedContentRevision,
        review,
        repairPreview,
        recommendation: visibleRecommendation,
        loading: visibleRecommendation.status === "loading",
        error: visibleRecommendation.error,
        receivedCharacters: visibleRecommendation.receivedCharacters,
        interacted,
        candidateStale,
        contractStale,
        canContinue: Boolean(contract) && !review.blocking && !contractStale,
        generate,
        cancel,
        chooseCandidate,
        editContract,
        useFallback,
        addReferences,
        recheck,
        previewRepair,
        applyRepair,
        applyReviewChoice,
        dismissRepair: () => setRepairPreview(null),
        clearError: () => setRecommendation((current) => ({ ...current, error: "", status: current.status === "error" ? "idle" : current.status })),
    };
}

function canonicalContract(value: CanvasProjectPptStyleContract | null | undefined) {
    if (!value) return null;
    const compiled = compilePptStyleContract(value);
    return compiled.ok ? compiled.value.canonical : null;
}
