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

export function isPptControlledNode(node: CanvasNodeData | undefined) {
    return Boolean(node && ((node.metadata?.pptPageId && node.metadata.pptTakeId) || node.metadata?.pptRole === "style" || node.metadata?.pptRole === "source"));
}

export function hasPptControlledNodes(nodes: readonly CanvasNodeData[]) {
    return nodes.some(isPptControlledNode);
}

export function nodeIdsTouchPptControlledNodes(nodes: readonly CanvasNodeData[], nodeIds: ReadonlySet<string>) {
    return nodes.some((node) => nodeIds.has(node.id) && isPptControlledNode(node));
}

export function connectionTouchesPptControlledNodes(nodes: readonly CanvasNodeData[], connection: CanvasConnection | undefined) {
    return Boolean(connection && nodeIdsTouchPptControlledNodes(nodes, new Set([connection.fromNodeId, connection.toNodeId])));
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
        if (
            op.type === "add_node" &&
            (op.metadata?.pptGenerationRun ||
                op.metadata?.pptGenerationRequest ||
                op.metadata?.pptPageId ||
                op.metadata?.pptTakeId ||
                op.metadata?.pptRole === "style" ||
                op.metadata?.pptRole === "source" ||
                unresolvedScopeKeys(nodes).has(nodeScopeKey(op.metadata)))
        )
            return true;
        if (op.type === "update_node") {
            const target = nodes.find((node) => node.id === op.id);
            if (target?.metadata?.pptGenerationRun || target?.metadata?.pptGenerationRequest || op.metadata?.pptGenerationRun || op.metadata?.pptGenerationRequest) return true;
            if (isPptControlledNode(target) || op.metadata?.pptPageId || op.metadata?.pptTakeId || op.metadata?.pptRole === "style" || op.metadata?.pptRole === "source") return true;
            if (nodeIdsTouchUnresolvedPptGeneration(nodes, new Set([op.id]))) return true;
        }
        if (op.type === "delete_node") {
            const ids = new Set(op.ids || (op.id ? [op.id] : op.nodeType ? nodes.filter((node) => node.type === op.nodeType).map((node) => node.id) : []));
            if (nodeIdsTouchPptGenerationLedger(nodes, ids) || nodeIdsTouchPptControlledNodes(nodes, ids)) return true;
        }
        if (op.type === "delete_connections") {
            if (op.all) return hasPptGenerationLedger(nodes) || hasPptControlledNodes(nodes);
            const ids = new Set(op.ids || (op.id ? [op.id] : []));
            if (connections.some((connection) => ids.has(connection.id) && (connectionTouchesPptGenerationLedger(nodes, connection) || connectionTouchesPptControlledNodes(nodes, connection)))) return true;
        }
        if (op.type === "connect_nodes") {
            const fromNode = nodes.find((node) => node.id === op.fromNodeId);
            const toNode = nodes.find((node) => node.id === op.toNodeId);
            if (
                fromNode?.metadata?.pptGenerationRun ||
                fromNode?.metadata?.pptGenerationRequest ||
                (fromNode?.metadata?.pptPageId && fromNode.metadata.pptTakeId) ||
                isPptControlledNode(fromNode) ||
                toNode?.metadata?.pptGenerationRun ||
                toNode?.metadata?.pptGenerationRequest ||
                isPptControlledNode(toNode) ||
                nodeIdsTouchUnresolvedPptGeneration(nodes, new Set([op.fromNodeId, op.toNodeId]))
            )
                return true;
        }
        if (op.type === "run_generation") {
            const target = nodes.find((node) => node.id === op.nodeId);
            if (target?.metadata?.pptGenerationRun || target?.metadata?.pptGenerationRequest || isPptControlledNode(target)) return true;
        }
    }
    return false;
}

export function sanitizeCopiedCanvasMetadata(metadata: CanvasNodeMetadata | undefined) {
    if (!metadata) return undefined;
    const next = { ...metadata };
    const hadRuntimeState = Boolean(next.pptGenerationRun || next.pptGenerationRequest || next.imageTask || next.isBatchRoot || next.batchRootId);
    const hadPptOwnership = Boolean(next.pptGenerationRun || next.pptGenerationRequest || next.pptPageId || next.pptTakeId || next.pptRole === "style" || next.pptRole === "source");
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
    const currentProtectedNodes = currentNodes.filter((node) => hasLedgerMetadata(node) || isPptControlledNode(node));
    const nextProtectedNodes = nextNodes.filter((node) => hasLedgerMetadata(node) || isPptControlledNode(node));
    const currentById = new Map(currentProtectedNodes.map((node) => [node.id, node]));
    const nextById = new Map(nextProtectedNodes.map((node) => [node.id, node]));
    const protectedNodeIds = new Set([...currentById.keys(), ...nextById.keys()]);
    if ([...protectedNodeIds].some((nodeId) => JSON.stringify(protectedProjection(currentById.get(nodeId))) !== JSON.stringify(protectedProjection(nextById.get(nodeId))))) return true;
    const currentProtectedConnections = currentConnections
        .filter((connection) => protectedNodeIds.has(connection.fromNodeId) || protectedNodeIds.has(connection.toNodeId))
        .map(connectionIdentity)
        .sort();
    const nextProtectedConnections = nextConnections
        .filter((connection) => protectedNodeIds.has(connection.fromNodeId) || protectedNodeIds.has(connection.toNodeId))
        .map(connectionIdentity)
        .sort();
    return JSON.stringify(currentProtectedConnections) !== JSON.stringify(nextProtectedConnections);
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

function protectedProjection(node: CanvasNodeData | undefined) {
    if (!node) return null;
    const { fontSize: _fontSize, freeResize: _freeResize, groupId: _groupId, interactive: _interactive, ...metadata } = node.metadata || {};
    return {
        type: node.type,
        metadata,
    };
}

function connectionIdentity(connection: CanvasConnection) {
    return `${connection.id}:${connection.fromNodeId}:${connection.toNodeId}`;
}
