import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { getGenerationCount, resolveGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { PPT_PAGE_PROMPT } from "@/lib/ppt/deck-builder";
import { buildPptPageWorkspace, type PptPageWorkspace, type PptPageWorkspaceTake } from "@/lib/ppt/page-workspace";
import { pageTakes, type CanvasProject, type CanvasProjectPpt } from "@/stores/canvas/use-canvas-store";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type Position } from "@/types/canvas";

export type GenerationIntent =
    | { kind: "startBatch"; anchorFirst: boolean }
    | { kind: "generateRest" }
    | { kind: "generateSingle"; takeKey: string; promptDraft?: string }
    | {
          kind: "deriveAndGenerate";
          pageIndex: number;
          reservedConfigNodeId: string;
          reservedAnchorNodeId: string;
          configMetadata: CanvasNodeMetadata;
          anchorContent: string;
          inheritedInputNodeIds: string[];
          positions?: { anchor?: Position; config?: Position };
      };

export type GenerationPlanItem = {
    pageIndex: number;
    configNodeId: string;
    prompt: string;
    count: number;
    mode: "textToImage" | "imageToImage";
    runOp: CanvasAgentOp;
};

export type GenerationPlan = {
    readonly items: readonly GenerationPlanItem[];
    readonly ops: CanvasAgentOp[];
    readonly pptPatch: (latest: CanvasProjectPpt) => CanvasProjectPpt;
    readonly pageCount: number;
    readonly callCount: number;
    readonly callBreakdown: { textToImage: number; imageToImage: number };
    readonly excludedPages: readonly { pageIndex: number; reason: string }[];
};

type ExistingTarget = { kind: "existing"; pageIndex: number; take?: PptPageWorkspaceTake };
type PendingTarget = {
    kind: "pending";
    pageIndex: number;
    configNode: CanvasNodeData;
    anchorNode: CanvasNodeData;
    connections: CanvasConnection[];
};

export function createGenerationPlan(intent: GenerationIntent, { project, effectiveConfig }: { project: CanvasProject; effectiveConfig: AiConfig }): GenerationPlan {
    if (!project.ppt) return emptyPlan();

    const workspaces = [...project.ppt.pages].sort((left, right) => left.index - right.index).map((page) => buildPptPageWorkspace(project, page));
    const anchorUpdates: CanvasAgentOp[] = [];
    const anchorConnections: CanvasAgentOp[] = [];
    const pendingOps: CanvasAgentOp[] = [];
    const excludedPages: Array<{ pageIndex: number; reason: string }> = [];
    const targets: Array<ExistingTarget | PendingTarget> = [];
    let pptPatch = (latest: CanvasProjectPpt) => latest;

    if (intent.kind === "startBatch") {
        const selected = intent.anchorFirst ? workspaces.slice(0, 1) : workspaces.filter(isPageUntouched);
        targets.push(...selected.map((workspace): ExistingTarget => ({ kind: "existing", pageIndex: workspace.page.index, take: workspace.takes.at(-1) })));
        pptPatch = (latest) => ({ ...latest, skipAnchor: !intent.anchorFirst, ...(intent.anchorFirst ? { anchorConfirmed: false } : {}) });
    }

    if (intent.kind === "generateRest") {
        const firstWorkspace = workspaces[0];
        const hasStyleNode = project.nodes.some((node) => node.metadata?.pptRole === "style");
        const skipAnchor = project.ppt.skipAnchor ?? !hasStyleNode;
        const selected = workspaces.filter((workspace) => (skipAnchor || workspace.page.index !== firstWorkspace?.page.index) && isPageUntouched(workspace));
        targets.push(...selected.map((workspace): ExistingTarget => ({ kind: "existing", pageIndex: workspace.page.index, take: workspace.takes.at(-1) })));
        // anchorConfirmed 只是流程摘要；每个后来修复/新建的目标仍需幂等确保首页参考图连线。
        const anchorNodeId = !skipAnchor ? firstWorkspace?.resolvedConfirmedNodeId : undefined;
        if (anchorNodeId) {
            for (const target of targets) {
                if (target.kind === "existing" && target.take?.configNode?.type === CanvasNodeType.Config) anchorConnections.push({ type: "connect_nodes", fromNodeId: anchorNodeId, toNodeId: target.take.configNode.id });
            }
            if (anchorConnections.length) pptPatch = (latest) => ({ ...latest, anchorConfirmed: true });
        }
    }

    if (intent.kind === "generateSingle") {
        const workspace = workspaces.find((item) => item.takes.some((take) => take.key === intent.takeKey));
        const take = workspace?.takes.find((item) => item.key === intent.takeKey);
        if (workspace) targets.push({ kind: "existing", pageIndex: workspace.page.index, take });
        else excludedPages.push({ pageIndex: 0, reason: "方案不存在" });
        if (take?.anchorNode && intent.promptDraft !== undefined && intent.promptDraft !== take.prompt) {
            anchorUpdates.push({ type: "update_node", id: take.anchorNode.id, metadata: { content: intent.promptDraft, status: "success" } });
        }
    }

    if (intent.kind === "deriveAndGenerate") {
        const anchorNode = pendingNode(intent.reservedAnchorNodeId, CanvasNodeType.Text, `第${intent.pageIndex}页大纲`, intent.positions?.anchor, {
            content: intent.anchorContent,
            status: "success",
            pptPageIndex: intent.pageIndex,
            pptRole: "outline",
        });
        const configNode = pendingNode(intent.reservedConfigNodeId, CanvasNodeType.Config, `第${intent.pageIndex}页生成配置`, intent.positions?.config, intent.configMetadata);
        const connections = [pendingConnection(intent.reservedAnchorNodeId, intent.reservedConfigNodeId, "anchor"), ...intent.inheritedInputNodeIds.map((nodeId, index) => pendingConnection(nodeId, intent.reservedConfigNodeId, `input-${index}`))];
        pendingOps.push(
            { type: "add_node", id: anchorNode.id, nodeType: anchorNode.type, title: anchorNode.title, position: intent.positions?.anchor, metadata: anchorNode.metadata },
            { type: "add_node", id: configNode.id, nodeType: configNode.type, title: configNode.title, position: intent.positions?.config, metadata: configNode.metadata },
            ...connections.map((connection): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId: connection.fromNodeId, toNodeId: connection.toNodeId })),
        );
        targets.push({ kind: "pending", pageIndex: intent.pageIndex, anchorNode, configNode, connections });
        pptPatch = (latest) => ({
            ...latest,
            pages: latest.pages.map((page) => {
                if (page.index !== intent.pageIndex) return page;
                const takes = pageTakes(page);
                const nextTakes = takes.some((take) => take.configNodeId === intent.reservedConfigNodeId) ? takes : [...takes, { anchorNodeId: intent.reservedAnchorNodeId, configNodeId: intent.reservedConfigNodeId }];
                return { ...page, takes: nextTakes, anchorNodeId: undefined, configNodeId: undefined };
            }),
        });
    }

    const validTargets: Array<{ pageIndex: number; configNode: CanvasNodeData; extraNodes?: CanvasNodeData[]; extraConnections?: CanvasConnection[] }> = [];
    for (const target of targets) {
        if (target.kind === "existing") {
            if (!target.take?.configNode || target.take.configNode.type !== CanvasNodeType.Config) {
                excludedPages.push({ pageIndex: target.pageIndex, reason: "缺少生成配置" });
                continue;
            }
            validTargets.push({ pageIndex: target.pageIndex, configNode: target.take.configNode });
        } else {
            validTargets.push({ pageIndex: target.pageIndex, configNode: target.configNode, extraNodes: [target.anchorNode, target.configNode], extraConnections: target.connections });
        }
    }

    const plannedConnections = anchorConnections.map((op, index): CanvasConnection => ({ id: `generation-plan-anchor-${index}`, fromNodeId: op.type === "connect_nodes" ? op.fromNodeId : "", toNodeId: op.type === "connect_nodes" ? op.toNodeId : "" }));
    const items = validTargets.map<GenerationPlanItem>((target) => {
        const prompt = generationPrompt(project, target.configNode);
        const config = resolveGenerationConfig(effectiveConfig, target.configNode, "image");
        const nodes = target.extraNodes ? [...project.nodes.filter((node) => !target.extraNodes!.some((extra) => extra.id === node.id)), ...target.extraNodes] : project.nodes;
        const connections = [...project.connections, ...plannedConnections, ...(target.extraConnections || [])];
        const requestPrompt = prompt || target.configNode.metadata?.composerContent || target.configNode.metadata?.prompt || "";
        const mode = buildNodeGenerationContext(target.configNode.id, nodes, connections, requestPrompt).referenceImages.length ? "imageToImage" : "textToImage";
        const runOp: CanvasAgentOp = prompt ? { type: "run_generation", nodeId: target.configNode.id, mode: "image", prompt } : { type: "run_generation", nodeId: target.configNode.id, mode: "image" };
        return { pageIndex: target.pageIndex, configNodeId: target.configNode.id, prompt, count: getGenerationCount(config.count), mode, runOp };
    });
    const runOps = items.map((item) => item.runOp);
    const callBreakdown = items.reduce((total, item) => ({ ...total, [item.mode]: total[item.mode] + item.count }), { textToImage: 0, imageToImage: 0 });

    return {
        items,
        ops: [...anchorUpdates, ...anchorConnections, ...pendingOps, ...runOps],
        pptPatch,
        pageCount: items.length,
        callCount: callBreakdown.textToImage + callBreakdown.imageToImage,
        callBreakdown,
        excludedPages,
    };
}

function isPageUntouched(workspace: PptPageWorkspace) {
    return !workspace.takes.some((take) => take.candidates.length || take.generating);
}

function generationPrompt(project: CanvasProject, configNode: CanvasNodeData) {
    return (configNode.metadata?.pptLayoutPrompt ?? "").trim() || (project.ppt?.mode === "extract" ? "" : PPT_PAGE_PROMPT);
}

function pendingNode(id: string, type: CanvasNodeData["type"], title: string, position: Position | undefined, metadata: CanvasNodeMetadata): CanvasNodeData {
    return { id, type, title, position: position || { x: 0, y: 0 }, width: 0, height: 0, metadata };
}

function pendingConnection(fromNodeId: string, toNodeId: string, suffix: string): CanvasConnection {
    return { id: `generation-plan-${suffix}`, fromNodeId, toNodeId };
}

function emptyPlan(): GenerationPlan {
    return { items: [], ops: [], pptPatch: (latest) => latest, pageCount: 0, callCount: 0, callBreakdown: { textToImage: 0, imageToImage: 0 }, excludedPages: [] };
}
