import { buildNodeGenerationInputs, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { PPT_PAGE_PROMPT } from "@/lib/ppt/deck-builder";
import { derivePptLockedFacts, isPptLayoutIntentSupported, renderPptPageSpecText, requirePptPageRewriteSpec, validatePptPageSpec, type PptPageRewriteSpec } from "@/lib/ppt/content-plan";
import { hasPptRepeatBillingRisk } from "@/lib/ppt/generation-ledger";
import { assertPptPageCandidateCanBeConfirmed } from "@/lib/ppt/page-confirmation";
import { selectPptPageDescriptor, type PptPageDescriptor } from "@/lib/ppt/page-descriptor";
import { applyPptPageSpecUpdate, type CanvasProject, type CanvasProjectPpt, type CanvasProjectPptContentBlock, type CanvasProjectPptPage, type CanvasProjectPptTake } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata, type PptGenerationRequestTrace, type PptGenerationRunSummary } from "@/types/canvas";

/** 其余生成输入项：与 buildNodeGenerationInputs 同源，附带 pptRole 用于非视觉方向的上游输入展示。 */
export type PptPageUpstreamInput = NodeGenerationInput & { pptRole?: CanvasNodeMetadata["pptRole"] };

export type PptPageWorkspaceTake = {
    takeId: string;
    index: number;
    anchorNode?: CanvasNodeData;
    configNode?: CanvasNodeData;
    prompt: string;
    canEditPrompt: boolean;
    candidates: CanvasNodeData[];
    /** 当前 take 首次认领的全部图片输出（含批量 root、成功、失败与 loading）。 */
    ownedOutputNodeIds: string[];
    /** 全部历史失败图片；纯分组 batch root 不计数。 */
    failedOutputNodeIds: string[];
    generationRuns: PptGenerationRunSummary[];
    generationRequests: PptGenerationRequestTrace[];
    /** 最近一次请求可能已计费但无法取回时，新付费动作仍需再次确认。 */
    requiresRepeatBillingConfirmation: boolean;
    unresolvedGeneration: boolean;
    /** 传给共享删除命令的完整集合：owned outputs + 本 take 的 anchor/config。 */
    deleteNodeIds: string[];
    generating: boolean;
    issues: string[];
    /** 排版要求：专用 metadata.pptLayoutPrompt；旧工程按 PPT 模式回退。 */
    layoutPrompt: string;
    /** 配置合成器开关与后备模板；PPT 显式传 layoutPrompt 时以显式值作为合成模板。 */
    composerContent?: string;
    /** 除锚点提示词外，实际会被拼进生成 prompt 的其余上游输入（同源 buildNodeGenerationInputs，禁止另写遍历）。 */
    upstreamInputs: PptPageUpstreamInput[];
};

export type PptPageWorkspace = {
    page: CanvasProjectPptPage;
    descriptor: PptPageDescriptor;
    /** 由 canonical PageSpec / VerbatimSpec 派生，不从画布节点回退读取。 */
    canonicalPrompt: string;
    contentIssues: string[];
    takes: PptPageWorkspaceTake[];
    confirmedNode?: CanvasNodeData;
    /** 通过 Compiler 快照血缘门禁的最终候选稿 ID。 */
    resolvedConfirmedNodeId?: string;
    confirmationIssues: string[];
};

export function buildPptPageWorkspace(project: CanvasProject, page: CanvasProjectPptPage): PptPageWorkspace {
    const descriptor = safeSelectPptPageDescriptor(project.ppt, page.pageId);
    const canonicalPrompt = descriptor.status === "ok" ? getPptCanonicalPageText(project.ppt, page.pageId) : "";
    const contentIssues = getPptCanonicalPageIssues(project.ppt, page.pageId, descriptor);
    const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
    const downstreamById = new Map<string, string[]>();
    const addDownstream = (fromNodeId: string, toNodeId: string) => {
        const downstream = downstreamById.get(fromNodeId);
        if (downstream) {
            if (!downstream.includes(toNodeId)) downstream.push(toNodeId);
        } else downstreamById.set(fromNodeId, [toNodeId]);
    };
    project.connections.forEach((connection) => addDownstream(connection.fromNodeId, connection.toNodeId));
    project.nodes.forEach((node) => {
        node.metadata?.batchChildIds?.forEach((childId) => addDownstream(node.id, childId));
        if (node.metadata?.batchRootId) addDownstream(node.metadata.batchRootId, node.id);
    });

    const pageTakeList = Array.isArray(page.takes) ? page.takes.filter(isValidPptTake) : [];
    const projectPages = (Array.isArray(project.ppt?.pages) ? project.ppt.pages : [page]).filter((projectPage): projectPage is CanvasProjectPptPage => Boolean(projectPage && typeof projectPage === "object"));
    const takeBoundaryIds = new Set(projectPages.flatMap((projectPage) => (Array.isArray(projectPage.takes) ? projectPage.takes.filter(isValidPptTake) : []).flatMap((take) => [take.anchorNodeId, take.configNodeId])));
    const seenOutputNodeIds = new Set<string>();
    const takes = pageTakeList.map<PptPageWorkspaceTake>((take, takeIndex) => {
        const anchorNode = nodeById.get(take.anchorNodeId);
        const configNode = nodeById.get(take.configNodeId);
        const blockedIds = new Set(takeBoundaryIds);
        blockedIds.delete(take.configNodeId);
        const reachableIds = collectReachableIds(take.configNodeId, page.pageId, take.takeId, nodeById, downstreamById, blockedIds);
        const ownedOutputs = project.nodes.filter((node) => (reachableIds.has(node.id) || belongsToTakeLedger(node, page.pageId, take.takeId)) && node.type === CanvasNodeType.Image && !seenOutputNodeIds.has(node.id));
        ownedOutputs.forEach((node) => seenOutputNodeIds.add(node.id));
        const candidates = ownedOutputs.filter((node) => node.metadata?.status === "success" && !isBatchGroup(node));
        const ownedOutputNodeIds = ownedOutputs.map((node) => node.id);
        const failedOutputNodeIds = ownedOutputs.filter((node) => node.metadata?.status === "error" && !isBatchGroup(node)).map((node) => node.id);
        const generationRequests = ownedOutputs.map((node) => node.metadata?.pptGenerationRequest).filter((trace): trace is PptGenerationRequestTrace => Boolean(trace));
        const generationRuns = ownedOutputs.map((node) => node.metadata?.pptGenerationRun).filter((run): run is PptGenerationRunSummary => Boolean(run));
        const latestRun = generationRuns.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
        const latestRequests = latestRun ? generationRequests.filter((request) => request.runId === latestRun.runId) : [];
        const requiresRepeatBillingConfirmation = hasPptRepeatBillingRisk(latestRequests);
        const unresolvedGeneration =
            generationRequests.some((request) => !["completed", "failed", "abandoned"].includes(request.status)) || generationRuns.some((run) => run.status === "preparing" || run.status === "running" || run.status === "needs_attention");
        const deleteNodeIds = [...new Set([...ownedOutputNodeIds, take.anchorNodeId, take.configNodeId])];
        const generating =
            latestRequests.some((request) => ["draft", "persisted", "submitting", "submitted", "running", "succeeded", "materializing"].includes(request.status)) ||
            (!latestRun && (configNode?.metadata?.status === "loading" || ownedOutputs.some((node) => node.metadata?.status === "loading")));
        const prompt = canonicalPrompt;
        const composerContent = configNode?.metadata?.composerContent?.trim() ? configNode.metadata.composerContent : undefined;
        const upstreamInputs: PptPageUpstreamInput[] = configNode
            ? buildNodeGenerationInputs(configNode.id, project.nodes, project.connections)
                  .filter((input) => input.nodeId !== take.anchorNodeId)
                  .map((input) => ({ ...input, pptRole: nodeById.get(input.nodeId)?.metadata?.pptRole }))
            : [];

        // #7：技术分支归并为面向用户的两类，不出现「节点」字样，同一问题不重复表述。
        const issues: string[] = [...contentIssues];
        if (!anchorNode || anchorNode.type !== CanvasNodeType.Text) issues.push(`第 ${page.index} 页方案 ${takeIndex + 1} 的提示词丢失或异常，请重新创建方案`);
        else if (anchorNode.metadata?.content !== canonicalPrompt) issues.push("页面内容投影与 canonical 内容规格不一致，请重新同步后生成");
        if (!configNode || configNode.type !== CanvasNodeType.Config) issues.push(`第 ${page.index} 页方案 ${takeIndex + 1} 的生成配置丢失或异常，请重新创建方案`);
        if (anchorNode && configNode && !project.connections.some((connection) => connection.fromNodeId === anchorNode.id && connection.toNodeId === configNode.id)) issues.push(`第 ${page.index} 页方案 ${takeIndex + 1} 的提示词连接缺失，请重新创建方案`);
        const runLedgerIncomplete =
            latestRun &&
            (new Set(latestRun.requestIds).size !== latestRun.requestIds.length ||
                latestRequests.length !== latestRun.requestIds.length ||
                latestRun.requestIds.some((requestId) => latestRequests.filter((request) => request.requestId === requestId).length !== 1));
        if (runLedgerIncomplete) issues.push("最近一次生成台账不完整，请复制诊断后处理");
        const attentionRequests = generationRequests.filter((request) => request.status === "submission_unknown" || request.status === "recoverable_error");
        if (attentionRequests.some((request) => request.status === "submission_unknown" || !request.remoteTaskId)) issues.push("上一次请求的提交或保存结果未知，请先处理");
        else if (attentionRequests.length) issues.push(attentionRequests.at(-1)?.error || "上一次生成可重新获取");
        const latestFailedRequests = latestRequests.filter((request) => request.status === "failed");
        if (latestRun?.status === "partial") issues.push(`最近一次生成部分失败（${latestFailedRequests.length}/${latestRun.plannedCount}）`);
        else if (latestRun?.status === "failed") issues.push(latestFailedRequests.at(-1)?.error || "最近一次生成失败");
        else if (!latestRun && failedOutputNodeIds.length) issues.push(`存在失败产物（${failedOutputNodeIds.length}）`);
        if (!latestRun && configNode?.metadata?.status === "error") {
            const errorDetails = configNode.metadata.errorDetails || "方案生成失败";
            issues.push(candidates.length ? `最近一次生成失败：${errorDetails}` : errorDetails);
        }

        return {
            takeId: take.takeId,
            index: takeIndex,
            anchorNode,
            configNode,
            prompt,
            canEditPrompt: Boolean(descriptor.status === "ok" && anchorNode?.type === CanvasNodeType.Text && candidates.length === 0 && !generating && !unresolvedGeneration),
            candidates,
            ownedOutputNodeIds,
            failedOutputNodeIds,
            generationRuns,
            generationRequests,
            requiresRepeatBillingConfirmation,
            unresolvedGeneration,
            deleteNodeIds,
            generating,
            issues,
            // 排版要求只读专用字段；metadata.prompt 不是 PPT Compiler 的展示/编辑来源。
            layoutPrompt: (configNode?.metadata?.pptLayoutPrompt ?? "").trim() || (project.ppt?.compilePolicy === "structured" ? PPT_PAGE_PROMPT : ""),
            composerContent,
            upstreamInputs,
        };
    });

    const storedConfirmedNode = page.confirmedNodeId ? nodeById.get(page.confirmedNodeId) : undefined;
    const candidateIds = new Set(takes.flatMap((take) => take.candidates.map((node) => node.id)));
    // 把节点损坏和血缘损坏归并成稳定的用户语言，技术细节只在确认写入时报出。
    const confirmationIssues: string[] = [];
    if (!page.confirmedNodeId) confirmationIssues.push("尚未确认最终版");
    else if (!storedConfirmedNode || !candidateIds.has(storedConfirmedNode.id)) confirmationIssues.push("已确认的最终版已失效，请重新确认");
    else {
        try {
            assertPptPageCandidateCanBeConfirmed(project, page, storedConfirmedNode.id);
        } catch {
            confirmationIssues.push("已确认的最终版缺少可追溯的编译快照，请重新生成后确认");
        }
    }

    const confirmedNode = confirmationIssues.length ? undefined : storedConfirmedNode;
    const resolvedConfirmedNodeId = confirmedNode?.id;

    return { page, descriptor, canonicalPrompt, contentIssues, takes, confirmedNode, resolvedConfirmedNodeId, confirmationIssues };
}

function isValidPptTake(take: CanvasProjectPptTake | null | undefined): take is CanvasProjectPptTake {
    return Boolean(take && typeof take.takeId === "string" && take.takeId.trim() && typeof take.anchorNodeId === "string" && take.anchorNodeId.trim() && typeof take.configNodeId === "string" && take.configNodeId.trim());
}

export function getPptCanonicalPageText(ppt: CanvasProjectPpt | undefined, pageId: string) {
    const descriptor = safeSelectPptPageDescriptor(ppt, pageId);
    if (!ppt || descriptor.status === "invalid") return "";
    if (ppt.compilePolicy === "verbatim") return ppt.verbatimSpecs.find((spec) => spec.pageId === pageId)?.exactText ?? "";
    const pageSpec = ppt.pageSpecs.find((spec) => spec.pageId === pageId);
    return pageSpec ? renderPptPageSpecText(pageSpec) : "";
}

/**
 * 把工作台的全页文本编辑写回 canonical content source。
 * structured 编辑会重建可见 ContentBlock 的 user_answer 溯源，并回到 reviewable；
 * verbatim 编辑只改 exactText，不从文本反推标题。
 */
export function applyPptCanonicalPageTextEdit(ppt: CanvasProjectPpt, pageId: string, expectedVersion: number, value: string, approvedAt?: string): CanvasProjectPpt {
    if (!value.trim()) throw new Error("页面内容不能为空");
    if (approvedAt !== undefined && !approvedAt.trim()) throw new Error("内容批准时间不能为空");
    if (ppt.compilePolicy === "verbatim") {
        const current = ppt.verbatimSpecs.find((spec) => spec.pageId === pageId);
        if (!current) throw new Error(`页面 ${pageId} 缺少 VerbatimSpec`);
        if (current.version !== expectedVersion) throw new Error(`页面 ${pageId} 的规格已变更，请刷新后重试`);
        if (current.exactText === value) return ppt;
        const firstPageId = [...ppt.pages].sort((left, right) => left.index - right.index)[0]?.pageId;
        return {
            ...ppt,
            ...(pageId === firstPageId ? { anchorConfirmed: false } : {}),
            verbatimSpecs: ppt.verbatimSpecs.map((spec) => (spec.pageId === pageId ? { ...spec, version: spec.version + 1, exactText: value, origin: { kind: "user_edited" } } : spec)),
            pages: ppt.pages.map((page) => (page.pageId === pageId && page.confirmedNodeId ? { ...page, confirmedNodeId: undefined } : page)),
        };
    }

    const current = ppt.pageSpecs.find((spec) => spec.pageId === pageId);
    if (!current) throw new Error(`页面 ${pageId} 缺少 PageSpec`);
    if (renderPptPageSpecText(current) === value) return approvedAt ? approvePptCanonicalPageContent(ppt, pageId, expectedVersion, approvedAt) : ppt;
    const lines = value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length < 2) throw new Error("结构化页面至少需要标题和核心信息两行");
    return applyPptPageSpecUpdate(ppt, pageId, expectedVersion, (pageSpec) => {
        const previousBlocks = pageSpec.contentBlocks.filter((block) => block.kind !== "placeholder");
        const exactBlockByLine = new Map<number, CanvasProjectPptContentBlock>();
        const exactBlockIds = new Set<string>();
        for (const [index, text] of lines.entries()) {
            const requiredKind = index === 0 ? "title" : index === 1 ? "primary_claim" : undefined;
            const candidates = previousBlocks.filter(
                (block) => !exactBlockIds.has(block.id) && (requiredKind ? block.kind === requiredKind : block.kind !== "title" && block.kind !== "primary_claim") && normalizePptEditableText(block.text) === normalizePptEditableText(text),
            );
            const match = candidates.find((block) => block.id === previousBlocks[index]?.id) || candidates[0];
            if (!match) continue;
            exactBlockByLine.set(index, match);
            exactBlockIds.add(match.id);
        }
        const preservedBlockIds = new Set<string>();
        const sourceRefs = lines.map((text, index) => ({ id: `${pageId}:source:user-answer:${pageSpec.version + 1}:${index + 1}`, source: "user_answer" as const, relation: "verbatim" as const, excerpt: text }));
        const contentBlocks = lines.map<CanvasProjectPptContentBlock>((text, index) => {
            const requiredKind = index === 0 ? "title" : index === 1 ? "primary_claim" : undefined;
            const positional = previousBlocks[index];
            const previous = exactBlockByLine.get(index);
            const positionalKind = requiredKind || previous?.kind || (positional && !exactBlockIds.has(positional.id) && positional.kind !== "title" && positional.kind !== "primary_claim" ? positional.kind : "body");
            if (previous) preservedBlockIds.add(previous.id);
            return {
                id: previous?.id || `${pageId}:block:user-answer:${pageSpec.version + 1}:${index + 1}`,
                kind: positionalKind,
                text,
                sourceRefIds: [sourceRefs[index].id],
            };
        });
        const contentOrder = new Map(contentBlocks.map((block, index) => [block.id, index]));
        const visualEncoding = pageSpec.visualEncoding.flatMap((encoding) => {
            const contentBlockIds = encoding.contentBlockIds.filter((id) => preservedBlockIds.has(id)).sort((left, right) => contentOrder.get(left)! - contentOrder.get(right)!);
            return contentBlockIds.length ? [{ ...encoding, contentBlockIds, lockedMapping: undefined }] : [];
        });
        const next = {
            ...pageSpec,
            sourceRefs,
            contentBlocks,
            contentState: approvedAt ? ({ status: "approved", approvedAt } as const) : ({ status: "reviewable" } as const),
            visualEncoding,
        };
        next.lockedFacts = derivePptLockedFacts(next);
        if (approvedAt) {
            const issues = validatePptPageSpec(next, { sourceMaterial: ppt.sourceMaterial, requirements: ppt.requirements });
            if (issues.length) throw new Error(`页面内容规格无法批准：${issues.map((issue) => issue.message).join("；")}`);
        }
        return next;
    });
}

export function applyPptCanonicalPageRewrite(ppt: CanvasProjectPpt, pageId: string, expectedVersion: number, rewrite: PptPageRewriteSpec, approvedAt?: string): CanvasProjectPpt {
    const checkedRewrite = requirePptPageRewriteSpec(rewrite);
    if (rewrite.canonicalText !== checkedRewrite.canonicalText) throw new Error("AI 改写结果与结构化内容不一致");
    if (ppt.compilePolicy !== "structured") return applyPptCanonicalPageTextEdit(ppt, pageId, expectedVersion, checkedRewrite.canonicalText, approvedAt);
    if (approvedAt !== undefined && !approvedAt.trim()) throw new Error("内容批准时间不能为空");

    return applyPptPageSpecUpdate(ppt, pageId, expectedVersion, (pageSpec) => {
        const visibleBlocks = [{ key: "__title", kind: "title" as const, text: checkedRewrite.title }, { key: "__primary_claim", kind: "primary_claim" as const, text: checkedRewrite.primaryClaim }, ...checkedRewrite.blocks];
        const previousSourceById = new Map(pageSpec.sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]));
        const usedPreviousBlockIds = new Set<string>();
        const sourceRefById = new Map<string, (typeof pageSpec.sourceRefs)[number]>();
        const contentBlocks = visibleBlocks.map<CanvasProjectPptContentBlock>((block, index) => {
            const previous = pageSpec.contentBlocks.find((candidate) => !usedPreviousBlockIds.has(candidate.id) && candidate.kind === block.kind && normalizePptEditableText(candidate.text) === normalizePptEditableText(block.text));
            if (previous) {
                usedPreviousBlockIds.add(previous.id);
                for (const sourceRefId of previous.sourceRefIds) {
                    const sourceRef = previousSourceById.get(sourceRefId);
                    if (sourceRef) sourceRefById.set(sourceRef.id, sourceRef);
                }
                return previous;
            }
            const sourceRef = { id: `${pageId}:source:ai-rewrite:${pageSpec.version + 1}:${index + 1}`, source: "confirmed_assumption" as const, relation: "verbatim" as const, excerpt: block.text };
            sourceRefById.set(sourceRef.id, sourceRef);
            return {
                id: `${pageId}:block:ai-rewrite:${pageSpec.version + 1}:${index + 1}`,
                kind: block.kind,
                text: block.text,
                sourceRefIds: [sourceRef.id],
            };
        });
        const sourceRefs = [...sourceRefById.values()];
        const blockIdByKey = new Map(checkedRewrite.blocks.map((block, index) => [block.key, contentBlocks[index + 2].id]));
        const visualEncoding = checkedRewrite.visualEncoding.map((encoding, index) => ({
            id: `${pageId}:encoding:ai-rewrite:${pageSpec.version + 1}:${index + 1}`,
            contentBlockIds: encoding.contentKeys.map((key) => {
                const blockId = blockIdByKey.get(key);
                if (!blockId) throw new Error(`AI 改写的信息表达引用了不存在的内容块：${key}`);
                return blockId;
            }),
            intent: encoding.intent,
            channel: encoding.channel,
        }));
        const next = {
            ...pageSpec,
            contentForm: checkedRewrite.contentForm,
            contentFormNote: undefined,
            sourceRefs,
            contentBlocks,
            visualEncoding,
            contentState: approvedAt ? ({ status: "approved", approvedAt } as const) : ({ status: "reviewable" } as const),
        };
        next.layoutIntent = next.layoutIntent.filter((intent) => isPptLayoutIntentSupported(next, intent));
        next.lockedFacts = derivePptLockedFacts(next);
        const previousFacts = new Set(pageSpec.lockedFacts.map((fact) => `${fact.kind}\u0000${normalizePptEditableText(fact.value)}`));
        const newFacts = next.lockedFacts.filter((fact) => !previousFacts.has(`${fact.kind}\u0000${normalizePptEditableText(fact.value)}`));
        if (newFacts.length) throw new Error(`AI 改写新增了未批准的事实：${newFacts.map((fact) => fact.value).join("、")}`);
        const issues = validatePptPageSpec(approvedAt ? next : { ...next, contentState: { status: "approved", approvedAt: "validation" } }, { sourceMaterial: ppt.sourceMaterial, requirements: ppt.requirements });
        if (issues.length) throw new Error(`AI 改写结果无法写入页面规格：${issues.map((issue) => issue.message).join("；")}`);
        return next;
    });
}

function normalizePptEditableText(value: string) {
    return value.trim().replace(/\s+/g, " ");
}

export function approvePptCanonicalPageContent(ppt: CanvasProjectPpt, pageId: string, expectedVersion: number, approvedAt: string): CanvasProjectPpt {
    if (ppt.compilePolicy !== "structured") return ppt;
    if (!approvedAt.trim()) throw new Error("内容批准时间不能为空");
    const current = ppt.pageSpecs.find((spec) => spec.pageId === pageId);
    if (!current) throw new Error(`页面 ${pageId} 缺少 PageSpec`);
    if (current.version !== expectedVersion) throw new Error(`页面 ${pageId} 的规格已变更，请刷新后重试`);
    if (current.contentState.status === "approved") return ppt;
    if (current.contentState.status === "blocked") throw new Error("页面仍有未解决的信息缺口");
    const candidate = { ...structuredClone(current), contentState: { status: "approved" as const, approvedAt } };
    candidate.lockedFacts = derivePptLockedFacts(candidate);
    const issues = validatePptPageSpec(candidate, { sourceMaterial: ppt.sourceMaterial, requirements: ppt.requirements });
    if (issues.length) throw new Error(`页面内容规格无法批准：${issues.map((issue) => issue.message).join("；")}`);
    return applyPptPageSpecUpdate(ppt, pageId, expectedVersion, () => candidate);
}

function getPptCanonicalPageIssues(ppt: CanvasProjectPpt | undefined, pageId: string, descriptor: PptPageDescriptor) {
    if (descriptor.status === "invalid") return [`页面内容规格需要修复：${descriptor.reason}`];
    if (!ppt || ppt.compilePolicy !== "structured") return [];
    const pageSpec = ppt.pageSpecs.find((spec) => spec.pageId === pageId);
    if (!pageSpec) return ["页面内容规格需要修复：缺少 PageSpec"];
    try {
        return validatePptPageSpec(pageSpec, { sourceMaterial: ppt.sourceMaterial, requirements: ppt.requirements }).map((issue) => issue.message);
    } catch {
        return ["页面内容规格需要修复：PageSpec 结构损坏"];
    }
}

function safeSelectPptPageDescriptor(ppt: CanvasProjectPpt | undefined, pageId: string): PptPageDescriptor {
    try {
        return selectPptPageDescriptor(ppt, pageId);
    } catch {
        const ledger = Array.isArray(ppt?.pages) ? ppt.pages.find((page) => page?.pageId === pageId) : undefined;
        return { status: "invalid", pageId, ...(Number.isInteger(ledger?.index) ? { index: ledger!.index } : {}), title: "内容规格待修复", keyMessage: "", reason: "页面内容规格结构损坏" };
    }
}

function isBatchGroup(node: CanvasNodeData) {
    return Boolean(node.metadata?.batchChildIds?.length);
}

function belongsToTakeLedger(node: CanvasNodeData, pageId: string | undefined, takeId: string | undefined) {
    if (!pageId || !takeId) return false;
    const request = node.metadata?.pptGenerationRequest;
    const run = node.metadata?.pptGenerationRun;
    return (request?.pageId === pageId && request?.takeId === takeId) || (run?.pageId === pageId && run?.takeId === takeId);
}

function collectReachableIds(pageConfigNodeId: string, pageId: string, takeId: string, nodeById: Map<string, CanvasNodeData>, downstreamById: Map<string, string[]>, blockedIds: Set<string>) {
    const reachableIds = new Set<string>();
    const queue = [pageConfigNodeId];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        for (const targetId of downstreamById.get(queue[cursor]) || []) {
            if (reachableIds.has(targetId) || blockedIds.has(targetId)) continue;
            const target = nodeById.get(targetId);
            if (target?.metadata?.pptPageId && target.metadata.pptPageId !== pageId) continue;
            if (target?.metadata?.pptTakeId && target.metadata.pptTakeId !== takeId) continue;
            reachableIds.add(targetId);
            queue.push(targetId);
        }
    }
    return reachableIds;
}
