import localforage from "localforage";

import type { PptContentDraft } from "@/lib/ppt/content-plan";
import type { PptOutlinePage } from "@/lib/ppt/outline-prompt";
import type { CanvasProjectPptPageSpec, CanvasProjectPptStyleContract, PptContentBrief } from "@/stores/canvas/use-canvas-store";

export type PptWizardMode = "outline" | "extract";

/** Pre-finalize creation wizard snapshot. Only committed, serializable fields. */
export type PptCreationDraftSnapshot = {
    version: 1;
    mode: PptWizardMode;
    step: number;
    deckTitle: string;
    material: string;
    requirements: string;
    pages: PptOutlinePage[];
    extractedDirectionHint: string;
    extractGlobalDecision: "include" | "exclude" | null;
    contentDraft: PptContentDraft | null;
    finalizedContent: {
        brief: PptContentBrief;
        pageSpecs: CanvasProjectPptPageSpec[];
        contentRevision: string;
    } | null;
    styleContract: CanvasProjectPptStyleContract | null;
    stylePageSpecs: CanvasProjectPptPageSpec[] | null;
};

export type PptCreationDraftStorage = {
    getItem: (key: string) => Promise<unknown>;
    setItem: (key: string, value: unknown) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
};

export type PptListCreateAction = {
    kind: "resume" | "create";
    primaryLabel: string;
    supportingCue: string | null;
};

export type PptCreationClearFailureContext = "finalize" | "restart";

const STORE_NAME = "ppt_creation_draft";
const DRAFT_KEY = "latest";

const memoryStore = new Map<string, unknown>();

const memoryStorage: PptCreationDraftStorage = {
    getItem: async (key) => memoryStore.get(key) ?? null,
    setItem: async (key, value) => {
        memoryStore.set(key, value);
    },
    removeItem: async (key) => {
        memoryStore.delete(key);
    },
};

/** Serialize load/save/clear so delayed saves cannot race past a later clear. */
let mutationChain: Promise<void> = Promise.resolve();
/** Bumped on clear; in-flight saves capture epoch and no-op if cleared since request. */
let writeEpoch = 0;

function enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = mutationChain.then(fn, fn);
    mutationChain = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

function createLocalforageStorage(): PptCreationDraftStorage {
    // IndexedDB only — never let localforage fall through to localStorage for business drafts.
    const store = localforage.createInstance({
        name: "infinite-canvas",
        storeName: STORE_NAME,
        driver: localforage.INDEXEDDB,
    });
    return {
        getItem: (key) => store.getItem(key),
        setItem: async (key, value) => {
            await store.setItem(key, value);
        },
        removeItem: async (key) => {
            await store.removeItem(key);
        },
    };
}

function defaultStorage(): PptCreationDraftStorage {
    // Node tests / SSR have no IndexedDB. Browser production always uses localforage IndexedDB only.
    if (typeof indexedDB === "undefined") return memoryStorage;
    return createLocalforageStorage();
}

let storage: PptCreationDraftStorage = defaultStorage();

/** Test-only: inject memory or mock storage; pass null to restore default. */
export function setPptCreationDraftStorageForTests(next: PptCreationDraftStorage | null) {
    storage = next ?? defaultStorage();
}

/** Test-only: clear the module memory fallback map and mutation bookkeeping. */
export function resetPptCreationDraftMemoryForTests() {
    memoryStore.clear();
    writeEpoch = 0;
    mutationChain = Promise.resolve();
}

export function createEmptyPptCreationDraftSnapshot(): PptCreationDraftSnapshot {
    return {
        version: 1,
        mode: "outline",
        step: 0,
        deckTitle: "",
        material: "",
        requirements: "",
        pages: [],
        extractedDirectionHint: "",
        extractGlobalDecision: null,
        contentDraft: null,
        finalizedContent: null,
        styleContract: null,
        stylePageSpecs: null,
    };
}

export function hasPptCreationDraftProgress(snapshot: PptCreationDraftSnapshot | null | undefined): boolean {
    if (!snapshot) return false;
    return Boolean(
        snapshot.step > 0 ||
        snapshot.deckTitle.trim() ||
        snapshot.material.trim() ||
        snapshot.requirements.trim() ||
        snapshot.pages.length ||
        snapshot.extractedDirectionHint.trim() ||
        snapshot.extractGlobalDecision ||
        snapshot.contentDraft ||
        snapshot.finalizedContent ||
        snapshot.styleContract ||
        (snapshot.stylePageSpecs && snapshot.stylePageSpecs.length),
    );
}

export type PptCreationDraftAutosaveDecision = { kind: "noop"; hadMeaningfulProgress: boolean } | { kind: "schedule"; snapshot: PptCreationDraftSnapshot; hadMeaningfulProgress: true } | { kind: "clear"; hadMeaningfulProgress: false };

/**
 * Decide autosave/clear for the page owner.
 * - Initial empty (never had progress): no-op — must not wipe a draft that hydrate-before-mount owns elsewhere.
 * - Meaningful progress: schedule save; mark session as having progress.
 * - Progress → empty: clear durable draft (save intentionally ignores empty snapshots).
 */
export function resolvePptCreationDraftAutosaveDecision(input: { snapshot: PptCreationDraftSnapshot; hadMeaningfulProgress: boolean }): PptCreationDraftAutosaveDecision {
    if (hasPptCreationDraftProgress(input.snapshot)) {
        return { kind: "schedule", snapshot: input.snapshot, hadMeaningfulProgress: true };
    }
    if (input.hadMeaningfulProgress) {
        return { kind: "clear", hadMeaningfulProgress: false };
    }
    return { kind: "noop", hadMeaningfulProgress: false };
}

/**
 * List-page CTA when at most one unfinished draft exists.
 * Resume is explicit — never hide a draft behind a silent「新建 PPT」.
 */
export function getPptListCreateAction(snapshot: PptCreationDraftSnapshot | null | undefined): PptListCreateAction {
    if (hasPptCreationDraftProgress(snapshot)) {
        return {
            kind: "resume",
            primaryLabel: "继续创建",
            supportingCue: "有未完成的创建草稿",
        };
    }
    return {
        kind: "create",
        primaryLabel: "新建 PPT",
        supportingCue: null,
    };
}

/** User-facing copy when draft clear fails after importProject or on explicit restart. */
export function describePptCreationClearFailure(context: PptCreationClearFailureContext): string {
    if (context === "finalize") {
        return "画布已创建，但未完成草稿清理失败；列表可能仍显示「继续创建」";
    }
    return "清除草稿失败，请重试";
}

/**
 * Route leave / unmount must flush the latest committed snapshot even if the 400ms
 * debounce has not fired. Explicit restart and successful finalize set suppress so
 * the just-cleared draft is not recreated by the unmount flush.
 */
export function resolvePptCreationDraftUnmountFlush(input: { suppressUnmountFlush: boolean; pendingSnapshot: PptCreationDraftSnapshot | null | undefined }): PptCreationDraftSnapshot | null {
    if (input.suppressUnmountFlush) return null;
    if (!hasPptCreationDraftProgress(input.pendingSnapshot)) return null;
    return input.pendingSnapshot ?? null;
}

/** Test/page: current write epoch (bumped on clear). */
export function getPptCreationDraftWriteEpoch(): number {
    return writeEpoch;
}

export type PptCreationDraftAutosaveScheduler = {
    schedule: (snapshot: PptCreationDraftSnapshot, delayMs?: number) => void;
    /** Synchronously cancel a pending debounce timer (restart/finalize must call this before clear). */
    cancel: () => void;
    /** Whether a timer is currently armed (tests). */
    hasPendingTimer: () => boolean;
};

/**
 * Debounced autosave with schedule-time epoch capture.
 * A timer scheduled before clear must not write after clear bumps epoch — even if the
 * callback still runs — and callers must cancel() before clear for the primary path.
 */
export function createPptCreationDraftAutosaveScheduler(deps: {
    save: (snapshot: PptCreationDraftSnapshot) => Promise<void>;
    nowEpoch?: () => number;
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}): PptCreationDraftAutosaveScheduler {
    const nowEpoch = deps.nowEpoch ?? (() => writeEpoch);
    const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id));
    let timer: ReturnType<typeof setTimeout> | null = null;

    return {
        schedule(snapshot, delayMs = 400) {
            if (timer != null) clearTimer(timer);
            const epochAtSchedule = nowEpoch();
            timer = setTimer(() => {
                timer = null;
                if (epochAtSchedule !== nowEpoch()) return;
                void deps.save(snapshot).catch(() => undefined);
            }, delayMs);
        },
        cancel() {
            if (timer == null) return;
            clearTimer(timer);
            timer = null;
        },
        hasPendingTimer: () => timer != null,
    };
}

export type PptCreationDraftLeaveResult = {
    flushed: boolean;
    /** After a successful flush, unmount must not write again; on failure keep unsuppress so unmount can best-effort retry. */
    suppressUnmountFlush: boolean;
};

/**
 * Explicit leave path: flush pending committed snapshot before parent closes/refreshes list CTA.
 * Call this from the wizard before onCancel so load sees the latest draft, not a pre-unmount null.
 */
export async function runPptCreationDraftLeaveSequence(input: {
    suppressUnmountFlush: boolean;
    pendingSnapshot: PptCreationDraftSnapshot | null | undefined;
    save: (snapshot: PptCreationDraftSnapshot) => Promise<void>;
}): Promise<PptCreationDraftLeaveResult> {
    const toFlush = resolvePptCreationDraftUnmountFlush({
        suppressUnmountFlush: input.suppressUnmountFlush,
        pendingSnapshot: input.pendingSnapshot,
    });
    if (!toFlush) {
        return { flushed: false, suppressUnmountFlush: input.suppressUnmountFlush };
    }
    try {
        await input.save(toFlush);
        return { flushed: true, suppressUnmountFlush: true };
    } catch {
        // Best-effort: leave unsuppress so passive unmount flush may retry.
        return { flushed: false, suppressUnmountFlush: false };
    }
}

/**
 * Initial snapshot that was committed mid style-step without a Contract
 * (e.g. user left while auto-style was loading). Resume must not re-fire auto generate.
 */
export function shouldSuppressMountAutoStyleFromSnapshot(snapshot: PptCreationDraftSnapshot | null | undefined): boolean {
    if (!snapshot) return false;
    return snapshot.mode === "outline" && snapshot.step === 2 && Boolean(snapshot.finalizedContent) && !snapshot.styleContract;
}

/**
 * One-shot lifecycle for mount interrupted-style suppress.
 * Starts true only for interrupted step2 resume; clears permanently once the user leaves step 2
 * (e.g. return to content) so a later re-entry to step 2 can auto-generate again.
 */
export function nextSuppressMountInterruptedStyle(input: { suppress: boolean; step: number }): boolean {
    if (!input.suppress) return false;
    if (input.step !== 2) return false;
    return true;
}

/**
 * Whether the outline wizard should auto-call style direction generation.
 * Restored Contract suppresses; interrupted resume at step 2 without Contract one-shot suppresses
 * the initial restored step2 auto generate (explicit retry remains available). After the user
 * leaves that step2, suppress clears and later step2 entry may auto-generate.
 */
export function shouldAutoGeneratePptStyleDirections(input: {
    mode: PptWizardMode;
    step: number;
    hasFinalizedContent: boolean;
    hasStyleContract: boolean;
    recommendationStatus: "idle" | "loading" | "ready" | "error" | "fallback";
    candidateCount: number;
    /** One-shot: true only while still on the initial restored interrupted step2. */
    suppressMountInterruptedStyle?: boolean;
}): boolean {
    if (input.suppressMountInterruptedStyle) return false;
    if (input.mode !== "outline" || input.step !== 2 || !input.hasFinalizedContent || input.hasStyleContract) return false;
    if (input.recommendationStatus !== "idle" || input.candidateCount > 0) return false;
    return true;
}

/**
 * Normalize unknown input into a committed snapshot.
 * Drops loading/error/runtime keys; invalid shapes become null.
 */
export function normalizePptCreationDraftSnapshot(raw: unknown): PptCreationDraftSnapshot | null {
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    const mode = record.mode === "extract" ? "extract" : record.mode === "outline" ? "outline" : null;
    if (!mode) return null;
    const step = typeof record.step === "number" && Number.isFinite(record.step) ? Math.max(0, Math.min(2, Math.floor(record.step))) : 0;
    const pages = normalizePages(record.pages);
    const extractGlobalDecision = record.extractGlobalDecision === "include" || record.extractGlobalDecision === "exclude" ? record.extractGlobalDecision : null;
    const contentDraft = isPlainObject(record.contentDraft) ? (structuredClone(record.contentDraft) as PptContentDraft) : null;
    const finalizedContent = normalizeFinalizedContent(record.finalizedContent);
    const styleContract = isPlainObject(record.styleContract) ? (structuredClone(record.styleContract) as CanvasProjectPptStyleContract) : null;
    const stylePageSpecs = Array.isArray(record.stylePageSpecs) ? (structuredClone(record.stylePageSpecs) as CanvasProjectPptPageSpec[]) : null;

    const snapshot: PptCreationDraftSnapshot = {
        version: 1,
        mode,
        step,
        deckTitle: asString(record.deckTitle),
        material: asString(record.material),
        requirements: asString(record.requirements),
        pages,
        extractedDirectionHint: asString(record.extractedDirectionHint),
        extractGlobalDecision,
        contentDraft,
        finalizedContent,
        styleContract,
        stylePageSpecs,
    };

    // Explicitly never persist request/runtime fields even if callers pass extra keys.
    return snapshot;
}

export function buildPptCreationDraftSnapshot(input: {
    mode: PptWizardMode;
    step: number;
    deckTitle: string;
    material: string;
    requirements: string;
    pages: PptOutlinePage[];
    extractedDirectionHint: string;
    extractGlobalDecision: "include" | "exclude" | null;
    contentDraft: PptContentDraft | null;
    finalizedContent: PptCreationDraftSnapshot["finalizedContent"];
    styleContract: CanvasProjectPptStyleContract | null;
    stylePageSpecs: CanvasProjectPptPageSpec[] | null;
}): PptCreationDraftSnapshot {
    return normalizePptCreationDraftSnapshot({
        version: 1,
        ...input,
    })!;
}

/**
 * Load latest draft. Storage read failures propagate so the page can warn
 * 「草稿恢复失败」instead of treating errors as "no draft".
 * Invalid stored shape still returns null (not a storage failure).
 */
export async function loadPptCreationDraft(): Promise<PptCreationDraftSnapshot | null> {
    // Observe pending mutations so load never races mid save/clear.
    await mutationChain;
    const raw = await storage.getItem(DRAFT_KEY);
    return normalizePptCreationDraftSnapshot(raw);
}

export async function savePptCreationDraft(snapshot: PptCreationDraftSnapshot): Promise<void> {
    const epochAtRequest = writeEpoch;
    const normalized = normalizePptCreationDraftSnapshot(snapshot);
    if (!normalized || !hasPptCreationDraftProgress(normalized)) return;
    await enqueueMutation(async () => {
        if (epochAtRequest !== writeEpoch) return;
        await storage.setItem(DRAFT_KEY, normalized);
        // Clear may bump epoch while setItem is in flight; undo a stale write.
        if (epochAtRequest !== writeEpoch) {
            await storage.removeItem(DRAFT_KEY);
        }
    });
}

export async function clearPptCreationDraft(): Promise<void> {
    // Bump immediately so any save that captured the prior epoch is dropped even if
    // its mutation runs after this clear was requested (stale debounce / unmount race).
    writeEpoch += 1;
    await enqueueMutation(async () => {
        await storage.removeItem(DRAFT_KEY);
    });
}

function asString(value: unknown) {
    return typeof value === "string" ? value : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePages(raw: unknown): PptOutlinePage[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => {
        const page = isPlainObject(item) ? item : {};
        const sourceRange = isPlainObject(page.sourceRange) && typeof page.sourceRange.startLine === "number" && typeof page.sourceRange.endLine === "number" ? { startLine: page.sourceRange.startLine, endLine: page.sourceRange.endLine } : undefined;
        return {
            title: asString(page.title),
            outline: asString(page.outline),
            visualHint: asString(page.visualHint),
            ...(sourceRange ? { sourceRange } : {}),
        };
    });
}

function normalizeFinalizedContent(raw: unknown): PptCreationDraftSnapshot["finalizedContent"] {
    if (!isPlainObject(raw)) return null;
    if (!isPlainObject(raw.brief) || !Array.isArray(raw.pageSpecs) || typeof raw.contentRevision !== "string") return null;
    return {
        brief: structuredClone(raw.brief) as PptContentBrief,
        pageSpecs: structuredClone(raw.pageSpecs) as CanvasProjectPptPageSpec[],
        contentRevision: raw.contentRevision,
    };
}
