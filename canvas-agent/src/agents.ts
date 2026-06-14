import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { AGENT_PROMPT, VERSION } from "./config.js";
import type { AgentAttachment, AgentEmit } from "./types.js";

type Json = Record<string, unknown>;
type AgentEvent = Json & { type: string; usage?: unknown };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };

let codexQueue: Promise<unknown> = Promise.resolve();
let codexApp: CodexAppClient | null = null;
let codexThreadId = "";
const canvasAgentMcp = canvasAgentMcpCommand();
const require = createRequire(import.meta.url);

export function withAgentPrompt(prompt: string) {
    return prompt.trim() ? `${AGENT_PROMPT}\n\n用户请求：${prompt}` : "";
}

export async function runCodexTurn(prompt: string, emit: AgentEmit, attachments: AgentAttachment[] = []) {
    if (!prompt.trim()) return;
    codexQueue = codexQueue.catch(() => undefined).then(() => runCodexTurnNow(prompt, emit, attachments));
    await codexQueue;
}

async function runCodexTurnNow(prompt: string, emit: AgentEmit, attachments: AgentAttachment[]) {
    let files: string[] = [];
    try {
        files = await writeAttachmentFiles(attachments);
        codexApp ||= await CodexAppClient.start(emit);
        codexThreadId ||= await codexApp.startThread();
        await codexApp.startTurn(codexThreadId, prompt, files);
    } catch (error) {
        emit("agent_error", { message: errorMessage(error) });
    } finally {
        await Promise.all(files.map((file) => fs.unlink(file).catch(() => undefined)));
    }
}

export function runClaudeTurn(prompt: string, emit: AgentEmit) {
    if (!prompt.trim()) return;
    const child = spawnAgent("claude", ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--allowedTools", "mcp__infinite-canvas__*", prompt], ["ignore", "pipe", "pipe"], emit);
    if (!child) return;
    pipeJsonLines(child, emit, "claude");
}

class CodexAppClient {
    private nextId = 1;
    private buffer = "";
    private textByItem = new Map<string, string>();
    private deltaCount = 0;
    private lastUsage: unknown = null;
    private pending = new Map<number, PendingRequest>();
    private activeTurns = new Map<string, PendingRequest>();
    private completedTurns = new Map<string, Error | null>();

    private constructor(private child: ChildProcess, private emit: AgentEmit) {}

    static async start(emit: AgentEmit) {
        const child = spawn(process.execPath, [codexBin(), "app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const client = new CodexAppClient(child, emit);
        child.stdout?.on("data", (chunk) => client.read(chunk.toString()));
        child.stderr?.on("data", (chunk) => emit("agent_log", { text: chunk.toString() }));
        child.on("error", (error) => emit("agent_error", { message: error.message }));
        child.on("exit", (code) => {
            client.failAll(`Codex app-server exited: ${code ?? 0}`);
            codexApp = null;
            codexThreadId = "";
            emit("agent_log", { text: `Codex app-server exited: ${code ?? 0}` });
        });
        await client.request("initialize", { clientInfo: { name: "canvas-agent", title: "Infinite Canvas Agent", version: VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
        client.notify("initialized");
        return client;
    }

    async startThread() {
        const result = await this.request("thread/start", { approvalPolicy: "never", sandbox: "workspace-write", config: codexConfig(), threadSource: "user" });
        const id = String(field(field(result, "thread"), "id") || "");
        if (!id) throw new Error("Codex app-server 没有返回 thread id");
        return id;
    }

    async startTurn(threadId: string, prompt: string, images: string[]) {
        const result = await this.request("turn/start", { threadId, input: codexInput(prompt, images), approvalPolicy: "never" });
        const turnId = String(field(field(result, "turn"), "id") || "");
        if (!turnId) throw new Error("Codex app-server 没有返回 turn id");
        const completed = this.completedTurns.get(turnId);
        if (this.completedTurns.has(turnId)) {
            this.completedTurns.delete(turnId);
            if (completed) throw completed;
            return;
        }
        await new Promise((resolve, reject) => this.activeTurns.set(turnId, { resolve, reject }));
    }

    private request(method: string, params: unknown) {
        const id = this.nextId++;
        this.write({ id, method, params });
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    private notify(method: string, params?: unknown) {
        this.write(params === undefined ? { method } : { method, params });
    }

    private write(value: unknown) {
        this.child.stdin?.write(`${JSON.stringify(value)}\n`);
    }

    private read(chunk: string) {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() || "";
        lines.filter(Boolean).forEach((line) => {
            try {
                this.handle(JSON.parse(line) as Json);
            } catch {
                this.emit("agent_log", { text: line });
            }
        });
    }

    private handle(message: Json) {
        const id = Number(message.id);
        if (message.error && this.pending.has(id)) return this.reject(id, String(field(message.error, "message") || "Codex request failed"));
        if (this.pending.has(id)) return this.resolve(id, message.result);
        if (typeof message.method === "string" && "id" in message) return this.answerServerRequest(message);
        if (typeof message.method === "string") this.handleNotification(message.method, (message.params || {}) as Json);
    }

    private handleNotification(method: string, params: Json) {
        if (method === "item/agentMessage/delta") return this.emitDelta(params);
        if (method === "thread/tokenUsage/updated") this.lastUsage = normalizeUsage(params);
        const event = normalizeCodexNotification(method, params);
        if (!event) return;
        if (event.type === "turn.completed") event.usage = this.lastUsage;
        this.emit("agent_event", { agent: "codex", ...event });
        if (event.type === "turn.completed") {
            const turnId = String(field(params, "turnId") || field(field(params, "turn"), "id") || "");
            const pending = this.activeTurns.get(turnId);
            const error = field(field(params, "turn"), "error");
            if (pending) {
                this.activeTurns.delete(turnId);
                error ? pending.reject(new Error(String(field(error, "message") || "Codex turn failed"))) : pending.resolve(event);
            } else if (turnId) {
                this.completedTurns.set(turnId, error ? new Error(String(field(error, "message") || "Codex turn failed")) : null);
            }
            this.emit("agent_event", { agent: "codex", type: "stream.summary", delta_count: this.deltaCount });
            this.deltaCount = 0;
            this.emit("agent_done", { agent: "codex", usage: event.usage });
        }
    }

    private emitDelta(params: Json) {
        const id = String(field(params, "itemId") || "");
        const text = `${this.textByItem.get(id) || ""}${String(field(params, "delta") || "")}`;
        this.deltaCount += 1;
        this.textByItem.set(id, text);
        this.emit("agent_event", { agent: "codex", type: "item.updated", item: { id, type: "agent_message", text } });
    }

    private answerServerRequest(message: Json) {
        const method = String(message.method);
        const result = method === "mcpServer/elicitation/request" ? { action: "accept", content: {}, _meta: null } : { decision: "decline" };
        this.write({ id: message.id, result });
        this.emit("agent_event", { agent: "codex", type: "server.request", method, params: message.params, result });
    }

    private resolve(id: number, result: unknown) {
        const pending = this.pending.get(id);
        if (pending) (this.pending.delete(id), pending.resolve(result));
    }

    private reject(id: number, message: string) {
        const pending = this.pending.get(id);
        if (pending) (this.pending.delete(id), pending.reject(new Error(message)));
    }

    failAll(message: string) {
        [...this.pending.values(), ...this.activeTurns.values()].forEach((item) => item.reject(new Error(message)));
        this.pending.clear();
        this.activeTurns.clear();
    }
}

function canvasAgentMcpCommand() {
    const current = process.argv.find((arg) => /index\.(t|j)s$/.test(arg)) || "";
    const entry = path.resolve(current || fileURLToPath(new URL("./index.js", import.meta.url)));
    const tsx = path.join(path.dirname(entry), "..", "node_modules", "tsx", "dist", "cli.mjs");
    return entry.endsWith(".ts") ? { command: process.execPath, args: [tsx, entry, "mcp"] } : { command: process.execPath, args: [entry, "mcp"] };
}

function codexConfig() {
    return { mcp_servers: { "infinite-canvas": { command: canvasAgentMcp.command, args: canvasAgentMcp.args, default_tools_approval_mode: "approve", startup_timeout_sec: 20, tool_timeout_sec: 90 } } };
}

function codexInput(prompt: string, images: string[]) {
    return [{ type: "text", text: prompt, text_elements: [] }, ...images.map((file) => ({ type: "localImage", path: file }))];
}

function normalizeCodexNotification(method: string, params: Json): AgentEvent | null {
    if (method === "thread/started") return { type: "thread.started", thread_id: field(field(params, "thread"), "id") };
    if (method === "turn/started") return { type: "turn.started" };
    if (method === "turn/completed") return { type: "turn.completed", usage: null };
    if (method === "item/started") return { type: "item.started", item: normalizeItem(field(params, "item")) };
    if (method === "item/completed") return { type: "item.completed", item: normalizeItem(field(params, "item")) };
    if (method === "error") return { type: "error", message: field(params, "message") };
    return null;
}

function normalizeItem(item: unknown) {
    const value = item && typeof item === "object" ? { ...(item as Json) } : {};
    if (value.type === "agentMessage") value.type = "agent_message";
    if (value.type === "mcpToolCall") value.type = "mcp_tool_call";
    if (value.type === "agent_message" && typeof value.id === "string") value.text = String(value.text || "");
    if ("arguments" in value) value.arguments = parseMaybeJson(value.arguments);
    return value;
}

function normalizeUsage(params: Json) {
    const total = field(field(params, "tokenUsage"), "total") as Json | undefined;
    return {
        input_tokens: field(total, "inputTokens"),
        cached_input_tokens: field(total, "cachedInputTokens"),
        output_tokens: field(total, "outputTokens"),
        reasoning_output_tokens: field(total, "reasoningOutputTokens"),
    };
}

function parseMaybeJson(value: unknown) {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function field(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Json)[key] : undefined;
}

async function writeAttachmentFiles(attachments: AgentAttachment[]) {
    return await Promise.all(attachments.filter((item) => item.dataUrl?.startsWith("data:image/")).map(writeAttachmentFile));
}

async function writeAttachmentFile(item: AgentAttachment) {
    const [, meta = "", data = ""] = item.dataUrl?.match(/^data:([^;]+);base64,(.+)$/) || [];
    if (!data) throw new Error(`图片附件无效：${item.name || "未命名图片"}`);
    const file = path.join(os.tmpdir(), `infinite-canvas-${Date.now()}-${Math.random().toString(16).slice(2)}.${imageExt(meta || item.type)}`);
    await fs.writeFile(file, Buffer.from(data, "base64"));
    return file;
}

function imageExt(type = "") {
    if (type.includes("png")) return "png";
    if (type.includes("webp")) return "webp";
    return "jpg";
}

function codexBin() {
    return path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
}

function pipeJsonLines(child: ReturnType<typeof spawn>, emit: AgentEmit, agent: string) {
    let out = "";
    child.stdout?.on("data", (chunk) => {
        out += chunk.toString();
        const lines = out.split(/\r?\n/);
        out = lines.pop() || "";
        lines.filter(Boolean).forEach((line) => {
            try {
                emit("agent_event", { agent, ...JSON.parse(line) });
            } catch {
                emit("agent_event", { agent, type: "raw", text: line });
            }
        });
    });
    child.stderr?.on("data", (chunk) => emit("agent_log", { text: chunk.toString() }));
    child.on("error", (error) => emit("agent_error", { message: error.message }));
    child.on("close", (code) => emit("agent_done", { agent, code }));
}

function spawnAgent(name: string, args: string[], stdio: StdioOptions, emit: AgentEmit) {
    try {
        return spawn(name, args, { stdio, shell: process.platform === "win32", windowsHide: true });
    } catch (error) {
        emit("agent_error", { message: errorMessage(error) });
        return null;
    }
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
