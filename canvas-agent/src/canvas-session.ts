import crypto from "node:crypto";
import type { ServerResponse } from "node:http";

import { type ToolName } from "./schemas.js";
import { compactCanvasState, compactNode, isToolName, nextCanvasX, parseToolInput } from "./tools.js";
import type { CanvasSnapshot } from "./types.js";

type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class CanvasSession {
    private clients = new Map<string, ServerResponse>();
    private pending = new Map<string, PendingRequest>();
    private canvasState: CanvasSnapshot | null = null;

    health() {
        return { ok: true, hasCanvas: Boolean(this.canvasState), clients: this.clients.size };
    }

    openEvents(url: URL, res: ServerResponse) {
        const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        this.clients.set(clientId, res);
        sendEvent(res, "hello", { ok: true, clientId });
        const timer = setInterval(() => sendEvent(res, "ping", { time: Date.now() }), 15000);
        res.on("close", () => {
            clearInterval(timer);
            this.clients.delete(clientId);
            if (this.canvasState?.clientId === clientId) this.canvasState = null;
        });
    }

    updateState(body: unknown, clientId?: string) {
        this.canvasState = { ...((body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>), clientId } as CanvasSnapshot;
    }

    resolveResult(body: { requestId?: string; error?: string; result?: unknown }) {
        const item = body.requestId ? this.pending.get(body.requestId) : null;
        if (!item || !body.requestId) return;
        this.pending.delete(body.requestId);
        body.error ? item.reject(new Error(body.error)) : item.resolve(body.result);
    }

    emitAll(type: string, payload: unknown) {
        this.clients.forEach((client) => sendEvent(client, type, payload));
    }

    async callTool(name: unknown, rawInput: unknown) {
        if (!isToolName(name)) throw new Error(`未知工具：${String(name)}`);
        let tool: ToolName = name;
        let input = parseToolInput(tool, rawInput) as Record<string, unknown>;
        const readTool = ["canvas_get_state", "canvas_get_selection", "canvas_export_snapshot"].includes(tool);
        if (readTool && (!this.clients.size || !this.canvasState)) throw new Error("当前没有已连接画布");
        if (tool === "canvas_get_state" || tool === "canvas_export_snapshot") return compactCanvasState(this.canvasState);
        if (tool === "canvas_get_selection") {
            const ids = new Set(this.canvasState?.selectedNodeIds || []);
            return { nodes: (this.canvasState?.nodes || []).filter((node) => ids.has(node.id)).map(compactNode) };
        }
        if (tool === "canvas_create_text_node") {
            const text = input as { text?: string; x?: number; y?: number; title?: string };
            input = { ops: [{ type: "add_node", nodeType: "text", title: text.title, position: { x: text.x ?? 0, y: text.y ?? 0 }, metadata: { content: text.text || "" } }] };
            tool = "canvas_apply_ops";
        }
        if (tool === "canvas_create_image_prompt_flow") {
            const flow = input as { prompt: string; x?: number; y?: number };
            const x = Number(flow.x ?? nextCanvasX(this.canvasState));
            const y = Number(flow.y ?? 0);
            const textId = `text-${crypto.randomUUID()}`;
            const configId = `config-${crypto.randomUUID()}`;
            input = { ops: [{ type: "add_node", id: textId, nodeType: "text", title: "提示词", position: { x, y }, metadata: { content: flow.prompt } }, { type: "add_node", id: configId, nodeType: "config", title: "图片生成", position: { x: x + 420, y }, metadata: { generationMode: "image", composerContent: flow.prompt } }, { type: "connect_nodes", fromNodeId: textId, toNodeId: configId }, { type: "select_nodes", ids: [configId] }] };
            tool = "canvas_apply_ops";
        }
        if (tool !== "canvas_apply_ops") throw new Error(`未知工具：${tool}`);
        if (!this.clients.size) throw new Error("当前没有已连接画布");
        return await this.requestCanvasTool(tool, input);
    }

    private async requestCanvasTool(name: ToolName, input: Record<string, unknown>) {
        const requestId = crypto.randomUUID();
        const client = this.clients.get(this.canvasState?.clientId || "") || this.clients.values().next().value;
        if (!client) throw new Error("当前没有已连接画布");
        sendEvent(client, "tool_call", { requestId, name, input });
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error("画布操作超时"));
            }, 30000);
            this.pending.set(requestId, { resolve: (value) => (clearTimeout(timer), resolve(value)), reject: (error) => (clearTimeout(timer), reject(error)) });
        });
    }
}

function sendEvent(res: ServerResponse, type: string, payload: unknown) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
