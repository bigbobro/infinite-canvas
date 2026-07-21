import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { useAgentStore } from "@/stores/use-agent-store";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { agentOpsTouchPptGenerationLedger, historyEntryTouchesPptGenerationLedger, nodeIdsTouchPptControlledNodes, nodeIdsTouchPptGenerationLedger } from "@/lib/ppt/generation-ledger";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasConnection, CanvasNodeData, ContextMenuState, ViewportTransform } from "@/types/canvas";

type GenerateNodeRef = MutableRefObject<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>;

type AgentBridgeParams = {
    projectId: string;
    title: string | undefined;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    viewport: ViewportTransform;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    viewportRef: MutableRefObject<ViewportTransform>;
    generateNodeRef: GenerateNodeRef;
    deleteCanvasNodesWithEffects: (ids: string[]) => void;
    onBlockedPptMutation: () => void;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setViewport: Dispatch<SetStateAction<ViewportTransform>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
};

/**
 * 画布与本地 Agent 的桥接：把当前画布快照与 apply/undo 能力发布到 agent store，
 * 供本地 Codex 面板与 PPT 工作台读取。除 applyAgentOps（配置节点插件宿主会用到）外均为内部实现。
 */
export function useAgentBridge(params: AgentBridgeParams) {
    const {
        projectId,
        title,
        nodes,
        connections,
        selectedNodeIds,
        viewport,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        deleteCanvasNodesWithEffects,
        onBlockedPptMutation,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setViewport,
        setContextMenu,
    } = params;
    const setAgentCanvasContext = useAgentStore((state) => state.setCanvasContext);
    const [agentUndoSnapshot, setAgentUndoSnapshot] = useState<CanvasAgentSnapshot | null>(null);
    const projectTitle = title || "未命名画布";
    const deleteCanvasNodesWithEffectsRef = useRef(deleteCanvasNodesWithEffects);
    const onBlockedPptMutationRef = useRef(onBlockedPptMutation);
    deleteCanvasNodesWithEffectsRef.current = deleteCanvasNodesWithEffects;
    onBlockedPptMutationRef.current = onBlockedPptMutation;
    const deleteCanvasNodes = useCallback(
        (ids: string[]) => {
            if (nodeIdsTouchPptControlledNodes(nodesRef.current, new Set(ids)) || nodeIdsTouchPptGenerationLedger(nodesRef.current, new Set(ids))) {
                onBlockedPptMutationRef.current();
                return;
            }
            deleteCanvasNodesWithEffectsRef.current(ids);
        },
        [nodesRef],
    );

    const agentSnapshot = useMemo<CanvasAgentSnapshot>(() => ({ projectId, title: projectTitle, nodes, connections, selectedNodeIds: Array.from(selectedNodeIds), viewport }), [connections, projectTitle, nodes, projectId, selectedNodeIds, viewport]);
    const applyCanvasOps = useCallback(
        (ops: CanvasAgentOp[] | undefined, protectPptInputs: boolean) => {
            const safeOps = Array.isArray(ops) ? ops.filter((op) => op?.type) : [];
            const before = { projectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: Array.from(selectedNodeIdsRef.current), viewport: viewportRef.current };
            if (protectPptInputs && agentOpsTouchPptGenerationLedger(safeOps, before.nodes, before.connections)) {
                onBlockedPptMutationRef.current();
                return before;
            }
            const generationOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation" && Boolean(op.nodeId));
            const next = applyCanvasAgentOps(
                before,
                safeOps.filter((op) => op.type !== "run_generation"),
            );
            nodesRef.current = next.nodes;
            connectionsRef.current = next.connections;
            selectedNodeIdsRef.current = new Set(next.selectedNodeIds);
            viewportRef.current = next.viewport;
            if (protectPptInputs) setAgentUndoSnapshot(before);
            setNodes(next.nodes);
            setConnections(next.connections);
            setSelectedNodeIds(new Set(next.selectedNodeIds));
            setSelectedConnectionId(null);
            setViewport(next.viewport);
            setContextMenu(null);
            if (generationOps.length) {
                queueMicrotask(() =>
                    generationOps.forEach((op) => {
                        const target = nodesRef.current.find((node) => node.id === op.nodeId);
                        const prompt = op.prompt?.trim() ? op.prompt : (target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                        void generateNodeRef.current?.(op.nodeId, op.mode || target?.metadata?.generationMode || "image", prompt);
                    }),
                );
            }
            return { ...next, projectId, title: projectTitle };
        },
        [projectTitle, projectId],
    );
    const applyAgentOps = useCallback((ops?: CanvasAgentOp[]) => applyCanvasOps(ops, true), [applyCanvasOps]);
    const applyTrustedOps = useCallback((ops?: CanvasAgentOp[]) => applyCanvasOps(ops, false), [applyCanvasOps]);
    const undoAgentOps = useCallback(() => {
        if (!agentUndoSnapshot) return null;
        if (historyEntryTouchesPptGenerationLedger(nodesRef.current, agentUndoSnapshot.nodes, connectionsRef.current, agentUndoSnapshot.connections)) {
            onBlockedPptMutationRef.current();
            return null;
        }
        nodesRef.current = agentUndoSnapshot.nodes;
        connectionsRef.current = agentUndoSnapshot.connections;
        selectedNodeIdsRef.current = new Set(agentUndoSnapshot.selectedNodeIds);
        viewportRef.current = agentUndoSnapshot.viewport;
        setNodes(agentUndoSnapshot.nodes);
        setConnections(agentUndoSnapshot.connections);
        setSelectedNodeIds(new Set(agentUndoSnapshot.selectedNodeIds));
        setSelectedConnectionId(null);
        setViewport(agentUndoSnapshot.viewport);
        setContextMenu(null);
        setAgentUndoSnapshot(null);
        return { ...agentUndoSnapshot, projectId, title: projectTitle };
    }, [agentUndoSnapshot, connectionsRef, nodesRef, projectTitle, projectId]);

    useEffect(() => {
        setAgentCanvasContext({
            snapshot: agentSnapshot,
            applyOps: applyAgentOps,
            applyTrustedOps,
            deleteCanvasNodesWithEffects: deleteCanvasNodes,
            deletePptCanvasNodesWithEffects: deleteCanvasNodesWithEffects,
            undoOps: undoAgentOps,
            canUndo: Boolean(agentUndoSnapshot),
        });
        return () => setAgentCanvasContext(null);
    }, [agentSnapshot, applyAgentOps, applyTrustedOps, agentUndoSnapshot, deleteCanvasNodes, setAgentCanvasContext, undoAgentOps]);

    return { applyAgentOps };
}
