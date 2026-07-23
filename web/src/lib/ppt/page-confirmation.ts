import type { CanvasProject, CanvasProjectPpt, CanvasProjectPptCompilationSnapshot, CanvasProjectPptPage } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData, type PptGenerationRequestTrace, type PptGenerationRunSummary } from "@/types/canvas";
import { isPptCandidateEditSnapshot } from "@/lib/ppt/candidate-edit";
import { compilePptPromptSnapshot } from "@/lib/ppt/prompt-compiler";
import { hashPptContentSource, hashPptSourceText } from "@/lib/ppt/source-lineage";
import { compilePptStyleContract } from "@/lib/ppt/style-contract";

type PptCandidateIdentity = {
    pageId: string;
    takeId: string;
    request: PptGenerationRequestTrace;
};

/**
 * 沿修改稿的 baseNodeId 回溯到最初生成稿，并返回它唯一绑定的 Compiler 快照。
 * 修改稿自身声称的 compilationSnapshotId 不参与裁决，避免用伪造指针截断真实血缘。
 */
export function resolvePptCandidateCompilationSnapshot(project: CanvasProject, candidateId: string): CanvasProjectPptCompilationSnapshot {
    if (!project.ppt) throw new Error("当前工程不是 PPT 工程");
    const target = uniqueNode(project, candidateId);
    const targetIdentity = candidateIdentity(project, target);
    const visited = new Set<string>();
    let current = target;

    while (true) {
        if (visited.has(current.id)) throw new Error("候选稿的生成血缘存在循环");
        visited.add(current.id);
        const identity = candidateIdentity(project, current);
        if (identity.pageId !== targetIdentity.pageId || identity.takeId !== targetIdentity.takeId) throw new Error("候选稿的生成血缘跨越了其他页面或方案");

        const candidateEdit = identity.request.candidateEdit;
        if (candidateEdit) {
            if (!isPptCandidateEditSnapshot(candidateEdit, candidateEdit.baseNodeId) || identity.request.requestType !== "imageToImage" || current.metadata?.prompt !== candidateEdit.finalPrompt) throw new Error("修改稿的生成快照无效");
            const baseNodeId = candidateEdit.baseNodeId;
            if (project.connections.filter((connection) => connection.fromNodeId === baseNodeId && connection.toNodeId === current.id).length !== 1) throw new Error("修改稿的基图连接已断开或重复");
            current = uniqueNode(project, baseNodeId);
            continue;
        }

        const snapshotId = identity.request.compilationSnapshotId;
        if (typeof snapshotId !== "string" || !snapshotId.trim()) throw new Error("候选稿缺少 Compiler 快照绑定");
        const snapshots = project.ppt.compilationSnapshots.filter((snapshot) => snapshot.snapshotId === snapshotId);
        if (snapshots.length !== 1) throw new Error(snapshots.length ? "候选稿绑定了重复的 Compiler 快照" : "候选稿绑定的 Compiler 快照已丢失");
        const snapshot = assertCompilationSnapshotIntegrity(snapshots[0]);
        if (snapshot.compilePolicy !== project.ppt.compilePolicy) throw new Error("候选稿的 Compiler 快照与当前工程编译策略不一致");
        assertCandidateSnapshotCurrent(project.ppt, snapshot, targetIdentity.pageId);
        const prompts = snapshot.prompts.filter((prompt) => prompt.pageId === targetIdentity.pageId && prompt.takeId === targetIdentity.takeId && typeof prompt.finalPrompt === "string" && Boolean(prompt.finalPrompt.trim()));
        if (prompts.length !== 1) throw new Error("Compiler 快照不包含该页面方案的唯一编译结果");
        if (current.metadata?.prompt !== prompts[0].finalPrompt) throw new Error("候选稿的实际提示词与 Compiler 快照不一致");
        return snapshot;
    }
}

function assertCandidateSnapshotCurrent(ppt: CanvasProjectPpt, snapshot: CanvasProjectPptCompilationSnapshot, pageId: string) {
    if (snapshot.compilePolicy === "structured" && ppt.compilePolicy === "structured") {
        if (snapshot.deckBrief.sourceHash !== hashPptContentSource(ppt.sourceMaterial, ppt.requirements)) throw new Error("候选稿的整套内容来源已变化");
        if (!sameCandidateContentBrief(snapshot.deckBrief, ppt.deckBrief)) throw new Error("候选稿的全局内容规格已变化");
        const snapshotSpec = snapshot.pageSpecs.find((spec) => spec.pageId === pageId);
        const currentSpecs = ppt.pageSpecs.filter((spec) => spec.pageId === pageId);
        if (!snapshotSpec || currentSpecs.length !== 1 || JSON.stringify(snapshotSpec) !== JSON.stringify(currentSpecs[0])) throw new Error("候选稿的页面内容规格已变化");
        return;
    }
    if (snapshot.compilePolicy === "verbatim" && ppt.compilePolicy === "verbatim") {
        const snapshotSpec = snapshot.verbatimSpecs.find((spec) => spec.pageId === pageId);
        const currentSpecs = ppt.verbatimSpecs.filter((spec) => spec.pageId === pageId);
        if (snapshot.confirmedGlobalSpec !== ppt.confirmedGlobalSpec || !snapshotSpec || currentSpecs.length !== 1 || JSON.stringify(snapshotSpec) !== JSON.stringify(currentSpecs[0])) throw new Error("候选稿的逐字内容规格已变化");
        if (snapshotSpec.origin.kind === "source_slice" && snapshotSpec.origin.sourceHash !== hashPptSourceText(ppt.sourceMaterial)) throw new Error("候选稿的原文版本已变化");
    }
}

function sameCandidateContentBrief(left: Extract<CanvasProjectPptCompilationSnapshot, { compilePolicy: "structured" }>["deckBrief"], right: Extract<CanvasProjectPpt, { compilePolicy: "structured" }>["deckBrief"]) {
    const contentFields = (brief: typeof left) => ({
        sourceHash: brief.sourceHash,
        contentRevision: brief.contentRevision,
        audience: brief.audience,
        goal: brief.goal,
        narrative: brief.narrative,
        styleContract: brief.styleContract,
        globalRules: brief.globalRules,
        lockedDeckFacts: brief.lockedDeckFacts,
    });
    return JSON.stringify(contentFields(left)) === JSON.stringify(contentFields(right));
}

/**
 * 设定/取消某页的最终版确认节点。精修台与终审必须共用这一实现（design §17），
 * 不允许两处各写一套 pages.map 逻辑。
 */
export function setPptPageConfirmedNode(project: CanvasProject, pageId: string, confirmedNodeId: string | undefined): CanvasProjectPpt {
    const ppt = project.ppt;
    if (!ppt) throw new Error("当前工程不是 PPT 工程");
    const page = ppt.pages.find((item) => item.pageId === pageId);
    if (!page) throw new Error("要确认的 PPT 页面已不存在");
    if (confirmedNodeId) assertPptPageCandidateCanBeConfirmed(project, page, confirmedNodeId);
    const next: CanvasProjectPpt = {
        ...ppt,
        pages: ppt.pages.map((page) => (page.pageId === pageId ? { ...page, confirmedNodeId } : page)),
    };
    const isProofPage = ppt.styleProofPageId === pageId || ppt.styleProof?.pageId === pageId;
    if (!isProofPage) return next;
    if (!confirmedNodeId) return { ...next, anchorConfirmed: false, styleProof: undefined };
    if (ppt.compilePolicy !== "structured") return next;

    const compiled = compilePptStyleContract(ppt.deckBrief.styleContract);
    if (!compiled.ok) throw new Error("视觉 Contract 无效，不能确认风格校样");
    const snapshot = resolvePptCandidateCompilationSnapshot(project, confirmedNodeId);
    if (snapshot.compilePolicy !== "structured" || snapshot.styleFingerprint !== compiled.value.fingerprint) throw new Error("候选稿不是由当前视觉 Contract 生成，请重新生成校样");
    const styleProof = {
        pageId,
        candidateNodeId: confirmedNodeId,
        styleFingerprint: compiled.value.fingerprint,
        contentRevision: ppt.deckBrief.contentRevision,
    };
    const proofChanged = JSON.stringify(styleProof) !== JSON.stringify(ppt.styleProof);
    const styleProofCandidateIds = Array.from(new Set([...(ppt.styleProofCandidateIds || []), confirmedNodeId]));
    return { ...next, ...(proofChanged ? { anchorConfirmed: false } : {}), styleProof, styleProofCandidateIds };
}

/** 确认写入与精修台 read model 共用的完整门禁。 */
export function assertPptPageCandidateCanBeConfirmed(project: CanvasProject, page: CanvasProjectPptPage, candidateId: string): CanvasNodeData {
    const candidate = uniqueNode(project, candidateId);
    if (candidate.type !== CanvasNodeType.Image || candidate.metadata?.status !== "success" || !candidate.metadata.storageKey || candidate.metadata.isBatchRoot || candidate.metadata.batchChildIds?.length) {
        throw new Error("只能确认已成功且本地图片完整的单张候选稿");
    }
    const identity = candidateIdentity(project, candidate);
    if (identity.pageId !== page.pageId || !page.takes.some((take) => take.takeId === identity.takeId)) throw new Error("候选稿不属于当前页面方案");
    resolvePptCandidateCompilationSnapshot(project, candidateId);
    return candidate;
}

function uniqueNode(project: CanvasProject, nodeId: string) {
    const nodes = project.nodes.filter((node) => node.id === nodeId);
    if (nodes.length !== 1) throw new Error(nodes.length ? "候选稿的节点 ID 不唯一" : "候选稿的生成血缘已断开");
    return nodes[0];
}

function candidateIdentity(project: CanvasProject, node: CanvasNodeData): PptCandidateIdentity {
    if (node.type !== CanvasNodeType.Image) throw new Error("候选稿的生成血缘包含非图片节点");
    const request = node.metadata?.pptGenerationRequest;
    if (!request || [request.requestId, request.runId, request.batchId, request.pageId, request.takeId].some((value) => typeof value !== "string" || !value.trim())) throw new Error("候选稿缺少生成请求血缘");
    if (request.status !== "completed") throw new Error("候选稿的生成请求尚未完整结束");
    if (project.nodes.filter((candidate) => candidate.metadata?.pptGenerationRequest?.requestId === request.requestId).length !== 1) throw new Error("候选稿的生成请求 ID 不唯一");
    if (node.metadata?.pptPageId !== request.pageId || node.metadata.pptTakeId !== request.takeId) throw new Error("候选稿的页面或方案标识被篡改");
    const runNodes = project.nodes.filter((candidate) => candidate.metadata?.pptGenerationRun?.runId === request.runId);
    if (runNodes.length !== 1) throw new Error("候选稿缺少唯一的生成运行台账");
    const run = runNodes[0].metadata!.pptGenerationRun!;
    assertCompleteRunLedger(project, node, request, runNodes[0], run);
    return { pageId: request.pageId, takeId: request.takeId, request };
}

function assertCompleteRunLedger(project: CanvasProject, node: CanvasNodeData, request: PptGenerationRequestTrace, runNode: CanvasNodeData, run: PptGenerationRunSummary) {
    if (
        [run.runId, run.batchId, run.pageId, run.takeId].some((value) => typeof value !== "string" || !value.trim()) ||
        !Number.isInteger(run.plannedCount) ||
        run.plannedCount < 1 ||
        !Array.isArray(run.requestIds) ||
        run.requestIds.length !== run.plannedCount ||
        run.requestIds.some((requestId) => typeof requestId !== "string" || !requestId.trim()) ||
        new Set(run.requestIds).size !== run.requestIds.length ||
        run.runId !== request.runId ||
        run.batchId !== request.batchId ||
        run.pageId !== request.pageId ||
        run.takeId !== request.takeId ||
        run.requestIds.filter((requestId) => requestId === request.requestId).length !== 1
    )
        throw new Error("候选稿的请求与生成运行台账不一致");

    const requestEntries = project.nodes.flatMap((candidate) => (candidate.metadata?.pptGenerationRequest ? [{ node: candidate, trace: candidate.metadata.pptGenerationRequest }] : []));
    const runEntries = requestEntries.filter(({ trace }) => trace.runId === run.runId);
    if (runEntries.length !== run.plannedCount) throw new Error("候选稿的生成运行台账缺少请求槽");
    const slots = new Set<number>();
    const requestNodes: CanvasNodeData[] = [];
    for (let slot = 0; slot < run.requestIds.length; slot += 1) {
        const requestId = run.requestIds[slot];
        const entries = requestEntries.filter(({ trace }) => trace.requestId === requestId);
        if (entries.length !== 1) throw new Error("候选稿的生成运行台账缺少唯一请求槽");
        const entry = entries[0];
        const trace = entry.trace;
        if (
            [trace.requestId, trace.runId, trace.batchId, trace.pageId, trace.takeId].some((value) => typeof value !== "string" || !value.trim()) ||
            trace.runId !== run.runId ||
            trace.batchId !== run.batchId ||
            trace.pageId !== run.pageId ||
            trace.takeId !== run.takeId ||
            !Number.isInteger(trace.slotIndex) ||
            trace.slotIndex !== slot ||
            trace.slotIndex < 0 ||
            trace.slotIndex >= run.plannedCount ||
            slots.has(trace.slotIndex)
        )
            throw new Error("候选稿的生成请求槽与运行台账不一致");
        slots.add(trace.slotIndex);
        requestNodes.push(entry.node);
    }
    if (!requestNodes.includes(node)) throw new Error("候选稿不是当前运行台账的请求产物");

    const statuses = requestEntries.filter(({ trace }) => trace.runId === run.runId).map(({ trace }) => trace.status);
    const derivedStatus = statuses.every((status) => status === "completed")
        ? "completed"
        : statuses.every((status) => status === "completed" || status === "failed" || status === "abandoned") && statuses.some((status) => status === "completed")
          ? "partial"
          : undefined;
    if (!derivedStatus || run.status !== derivedStatus) throw new Error("候选稿的请求状态与生成运行台账不一致");

    if (run.plannedCount === 1) {
        if (runNode.id !== node.id || requestNodes[0].id !== runNode.id || runNode.metadata?.isBatchRoot || runNode.metadata?.batchChildIds?.length) throw new Error("单张候选稿的生成运行台账异常");
        return;
    }
    const childIds = runNode.metadata?.batchChildIds;
    if (
        runNode.type !== CanvasNodeType.Image ||
        requestNodes.includes(runNode) ||
        requestNodes.some((requestNode) => requestNode.type !== CanvasNodeType.Image || requestNode.metadata?.isBatchRoot) ||
        !runNode.metadata?.isBatchRoot ||
        !Array.isArray(childIds) ||
        childIds.length !== run.plannedCount ||
        new Set(childIds).size !== childIds.length ||
        childIds.some((childId, slot) => childId !== requestNodes[slot].id) ||
        requestNodes.some((requestNode) => requestNode.metadata?.batchRootId !== runNode.id || project.connections.filter((connection) => connection.fromNodeId === runNode.id && connection.toNodeId === requestNode.id).length !== 1)
    )
        throw new Error("批量候选稿与生成运行台账不一致");
}

function assertCompilationSnapshotIntegrity(snapshot: CanvasProjectPptCompilationSnapshot) {
    if (
        !snapshot ||
        typeof snapshot.snapshotId !== "string" ||
        !snapshot.snapshotId.trim() ||
        typeof snapshot.compilerVersion !== "string" ||
        !snapshot.compilerVersion.trim() ||
        typeof snapshot.createdAt !== "string" ||
        !snapshot.createdAt.trim() ||
        typeof snapshot.inputHash !== "string" ||
        !snapshot.inputHash.trim() ||
        (snapshot.compilePolicy !== "structured" && snapshot.compilePolicy !== "verbatim") ||
        !Array.isArray(snapshot.targets) ||
        !Array.isArray(snapshot.prompts) ||
        !Array.isArray(snapshot.issues)
    )
        throw new Error("Compiler 快照结构不完整");
    const targetKeys = snapshot.targets.map((target) => `${target.pageId}:${target.takeId}`);
    const promptKeys = snapshot.prompts.map((prompt) => `${prompt.pageId}:${prompt.takeId}`);
    if (snapshot.targets.length !== snapshot.prompts.length || new Set(targetKeys).size !== targetKeys.length || new Set(promptKeys).size !== promptKeys.length || targetKeys.some((key) => !promptKeys.includes(key))) {
        throw new Error("Compiler 快照的编译目标与结果不一致");
    }
    let rebuilt: CanvasProjectPptCompilationSnapshot;
    try {
        if (snapshot.compilePolicy === "structured") {
            if (!Number.isInteger(snapshot.deckBriefVersion) || !Number.isInteger(snapshot.pageSpecsVersion) || !snapshot.deckBrief || !Array.isArray(snapshot.pageSpecs) || !snapshot.deckShell) throw new Error("invalid structured snapshot");
            rebuilt = compilePptPromptSnapshot({
                compilePolicy: "structured",
                snapshotId: snapshot.snapshotId,
                compiledAt: snapshot.createdAt,
                deckBrief: snapshot.deckBrief,
                pageSpecs: snapshot.pageSpecs,
                deckShell: snapshot.deckShell,
                targets: snapshot.targets,
            });
        } else {
            if (!Array.isArray(snapshot.verbatimSpecs) || (snapshot.confirmedGlobalSpec !== undefined && typeof snapshot.confirmedGlobalSpec !== "string")) throw new Error("invalid verbatim snapshot");
            rebuilt = compilePptPromptSnapshot({
                compilePolicy: "verbatim",
                snapshotId: snapshot.snapshotId,
                compiledAt: snapshot.createdAt,
                verbatimSpecs: snapshot.verbatimSpecs,
                ...(snapshot.confirmedGlobalSpec === undefined ? {} : { confirmedGlobalSpec: snapshot.confirmedGlobalSpec }),
                targets: snapshot.targets,
            });
        }
    } catch {
        throw new Error("Compiler 快照结构不完整");
    }
    if (JSON.stringify(rebuilt) !== JSON.stringify(snapshot)) throw new Error("Compiler 快照未通过确定性完整性校验");
    if (rebuilt.issues.some((issue) => issue.severity === "blocking")) throw new Error("Compiler 快照包含未解决的阻断问题");
    return snapshot;
}
