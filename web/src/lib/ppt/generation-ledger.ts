import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata, PptGenerationRequestTrace } from "@/types/canvas";

const TERMINAL_REQUEST_STATUSES = new Set(["completed", "failed", "abandoned"]);
const UNRESOLVED_RUN_STATUSES = new Set(["preparing", "running", "needs_attention"]);

export function hasUnresolvedPptGeneration(nodes: readonly CanvasNodeData[]) {
    return nodes.some((node) => {
        const request = node.metadata?.pptGenerationRequest;
        const run = node.metadata?.pptGenerationRun;
        return Boolean((request && !TERMINAL_REQUEST_STATUSES.has(request.status)) || (run && UNRESOLVED_RUN_STATUSES.has(run.status)));
    });
}

export function hasPptRepeatBillingRisk(requests: readonly PptGenerationRequestTrace[]) {
    return requests.some((request) => request.billingRisk || (request.status === "abandoned" && request.recentEvents.some((event) => event.status === "submission_unknown" || event.status === "recoverable_error")));
}

export function hasPptGenerationLedger(nodes: readonly CanvasNodeData[]) {
    return nodes.some((node) => node.metadata?.pptGenerationRun || node.metadata?.pptGenerationRequest);
}

export function nodeIdsTouchUnresolvedPptGeneration(nodes: readonly CanvasNodeData[], nodeIds: ReadonlySet<string>) {
    const activeScopes = unresolvedScopeKeys(nodes);
    return nodes.some((node) => nodeIds.has(node.id) && Boolean(activeScopes.has(nodeScopeKey(node.metadata)) || isUnresolvedRequestNode(node)));
}

export function connectionTouchesUnresolvedPptGeneration(nodes: readonly CanvasNodeData[], connection: CanvasConnection | undefined) {
    return Boolean(connection && nodeIdsTouchUnresolvedPptGeneration(nodes, new Set([connection.fromNodeId, connection.toNodeId])));
}

export function nodeIdsTouchPptGenerationLedger(nodes: readonly CanvasNodeData[], nodeIds: ReadonlySet<string>) {
    const scopes = ledgerScopeKeys(nodes);
    return nodes.some((node) => nodeIds.has(node.id) && Boolean(scopes.has(nodeScopeKey(node.metadata)) || node.metadata?.pptGenerationRun || node.metadata?.pptGenerationRequest));
}

export function connectionTouchesPptGenerationLedger(nodes: readonly CanvasNodeData[], connection: CanvasConnection | undefined) {
    return Boolean(connection && nodeIdsTouchPptGenerationLedger(nodes, new Set([connection.fromNodeId, connection.toNodeId])));
}

export function agentOpsTouchPptGenerationLedger(ops: readonly CanvasAgentOp[], nodes: readonly CanvasNodeData[], connections: readonly CanvasConnection[]) {
    for (const op of ops) {
        if (op.type === "add_node" && (op.metadata?.pptGenerationRun || op.metadata?.pptGenerationRequest || unresolvedScopeKeys(nodes).has(nodeScopeKey(op.metadata)))) return true;
        if (op.type === "update_node") {
            const target = nodes.find((node) => node.id === op.id);
            if (target?.metadata?.pptGenerationRun || target?.metadata?.pptGenerationRequest || op.metadata?.pptGenerationRun || op.metadata?.pptGenerationRequest) return true;
            if (nodeIdsTouchUnresolvedPptGeneration(nodes, new Set([op.id]))) return true;
        }
        if (op.type === "delete_node") {
            const ids = new Set(op.ids || (op.id ? [op.id] : op.nodeType ? nodes.filter((node) => node.type === op.nodeType).map((node) => node.id) : []));
            if (nodeIdsTouchPptGenerationLedger(nodes, ids)) return true;
        }
        if (op.type === "delete_connections") {
            if (op.all) return hasPptGenerationLedger(nodes);
            const ids = new Set(op.ids || (op.id ? [op.id] : []));
            if (connections.some((connection) => ids.has(connection.id) && connectionTouchesPptGenerationLedger(nodes, connection))) return true;
        }
        if (op.type === "connect_nodes") {
            const fromNode = nodes.find((node) => node.id === op.fromNodeId);
            const toNode = nodes.find((node) => node.id === op.toNodeId);
            if (
                fromNode?.metadata?.pptGenerationRun ||
                fromNode?.metadata?.pptGenerationRequest ||
                (fromNode?.metadata?.pptPageId && fromNode.metadata.pptTakeId) ||
                toNode?.metadata?.pptGenerationRun ||
                toNode?.metadata?.pptGenerationRequest ||
                nodeIdsTouchUnresolvedPptGeneration(nodes, new Set([op.fromNodeId, op.toNodeId]))
            )
                return true;
        }
        if (op.type === "run_generation") {
            const target = nodes.find((node) => node.id === op.nodeId);
            if (target?.metadata?.pptGenerationRun || target?.metadata?.pptGenerationRequest || (target?.metadata?.pptPageId && target.metadata.pptTakeId)) return true;
        }
    }
    return false;
}

export function sanitizeCopiedCanvasMetadata(metadata: CanvasNodeMetadata | undefined) {
    if (!metadata) return undefined;
    const next = { ...metadata };
    const hadRuntimeState = Boolean(next.pptGenerationRun || next.pptGenerationRequest || next.imageTask || next.isBatchRoot || next.batchRootId);
    const hadPptOwnership = Boolean(next.pptGenerationRun || next.pptGenerationRequest || next.pptPageId || next.pptTakeId);
    delete next.pptGenerationRun;
    delete next.pptGenerationRequest;
    delete next.imageTask;
    delete next.isBatchRoot;
    delete next.batchRootId;
    delete next.batchChildIds;
    delete next.batchUsesReferenceImages;
    delete next.primaryImageId;
    delete next.imageBatchExpanded;
    delete next.pptPageId;
    delete next.pptTakeId;
    delete next.pptPageIndex;
    if (hadPptOwnership) delete next.pptRole;
    if (hadRuntimeState) {
        next.status = next.content || next.storageKey ? "success" : "idle";
        next.errorDetails = undefined;
    }
    return next;
}

export function historyEntryTouchesPptGenerationLedger(currentNodes: readonly CanvasNodeData[], nextNodes: readonly CanvasNodeData[], currentConnections: readonly CanvasConnection[], nextConnections: readonly CanvasConnection[]) {
    const currentLedgerNodes = currentNodes.filter(hasLedgerMetadata);
    const nextLedgerNodes = nextNodes.filter(hasLedgerMetadata);
    const currentById = new Map(currentLedgerNodes.map((node) => [node.id, node]));
    const nextById = new Map(nextLedgerNodes.map((node) => [node.id, node]));
    const ledgerNodeIds = new Set([...currentById.keys(), ...nextById.keys()]);
    if ([...ledgerNodeIds].some((nodeId) => JSON.stringify(ledgerProjection(currentById.get(nodeId))) !== JSON.stringify(ledgerProjection(nextById.get(nodeId))))) return true;
    const currentLedgerConnections = currentConnections
        .filter((connection) => ledgerNodeIds.has(connection.fromNodeId) || ledgerNodeIds.has(connection.toNodeId))
        .map(connectionIdentity)
        .sort();
    const nextLedgerConnections = nextConnections
        .filter((connection) => ledgerNodeIds.has(connection.fromNodeId) || ledgerNodeIds.has(connection.toNodeId))
        .map(connectionIdentity)
        .sort();
    return JSON.stringify(currentLedgerConnections) !== JSON.stringify(nextLedgerConnections);
}

function isUnresolvedRequestNode(node: CanvasNodeData) {
    const request = node.metadata?.pptGenerationRequest;
    return Boolean(request && !TERMINAL_REQUEST_STATUSES.has(request.status));
}

function unresolvedScopeKeys(nodes: readonly CanvasNodeData[]) {
    return new Set(
        nodes.flatMap((node) => {
            const request = node.metadata?.pptGenerationRequest;
            const run = node.metadata?.pptGenerationRun;
            if (request && !TERMINAL_REQUEST_STATUSES.has(request.status)) return [scopeKey(request.pageId, request.takeId)];
            if (run && UNRESOLVED_RUN_STATUSES.has(run.status)) return [scopeKey(run.pageId, run.takeId)];
            return [];
        }),
    );
}

function ledgerScopeKeys(nodes: readonly CanvasNodeData[]) {
    return new Set(
        nodes
            .map((node) => node.metadata?.pptGenerationRequest || node.metadata?.pptGenerationRun)
            .filter(Boolean)
            .map((owner) => scopeKey(owner!.pageId, owner!.takeId)),
    );
}

function nodeScopeKey(metadata: CanvasNodeMetadata | undefined) {
    const pageId = metadata?.pptGenerationRequest?.pageId || metadata?.pptGenerationRun?.pageId || metadata?.pptPageId;
    const takeId = metadata?.pptGenerationRequest?.takeId || metadata?.pptGenerationRun?.takeId || metadata?.pptTakeId;
    return pageId && takeId ? scopeKey(pageId, takeId) : "";
}

function scopeKey(pageId: string, takeId: string) {
    return `${pageId}:${takeId}`;
}

function hasLedgerMetadata(node: CanvasNodeData) {
    return Boolean(node.metadata?.pptGenerationRun || node.metadata?.pptGenerationRequest);
}

function ledgerProjection(node: CanvasNodeData | undefined) {
    if (!node) return null;
    const metadata = node.metadata;
    return {
        run: metadata?.pptGenerationRun,
        request: metadata?.pptGenerationRequest,
        imageTask: metadata?.imageTask,
        status: metadata?.status,
        errorDetails: metadata?.errorDetails,
        content: metadata?.content,
        storageKey: metadata?.storageKey,
        naturalWidth: metadata?.naturalWidth,
        naturalHeight: metadata?.naturalHeight,
        bytes: metadata?.bytes,
        mimeType: metadata?.mimeType,
        batchChildIds: metadata?.batchChildIds,
        primaryImageId: metadata?.primaryImageId,
    };
}

function connectionIdentity(connection: CanvasConnection) {
    return `${connection.id}:${connection.fromNodeId}:${connection.toNodeId}`;
}
