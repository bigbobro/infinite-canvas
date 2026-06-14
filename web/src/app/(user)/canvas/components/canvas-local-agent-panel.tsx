"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { App, Button, Input, Modal, Segmented, Switch, Tooltip } from "antd";
import copyToClipboard from "copy-to-clipboard";
import { ArrowUp, Bot, Copy, ImagePlus, LoaderCircle, PlugZap, RotateCcw, Terminal, Trash2, UserRound, Wrench, X } from "lucide-react";
import { motion } from "motion/react";

import { canvasThemes } from "@/lib/canvas-theme";
import type { AuthUser } from "@/services/api/auth";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { useCanvasAgentStore, type AgentAttachment, type AgentChatItem, type AgentEventLog, type AgentPendingToolCall } from "../stores/use-canvas-agent-store";
import { summarizeCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "../utils/canvas-agent-ops";

const PANEL_MOTION_SECONDS = 0.5;
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_PAYLOAD_BYTES = 28 * 1024 * 1024;

type AgentEventPayload = {
    agent?: string;
    type?: string;
    thread_id?: string;
    item?: AgentEventItem;
    error?: { message?: string };
    message?: string;
    usage?: Record<string, unknown>;
};
type AgentEventItem = { id?: string; type?: string; text?: unknown; message?: unknown; server?: string; tool?: string; status?: string; arguments?: unknown; result?: unknown; error?: { message?: string } };

type AgentLogContext = { endpoint: string; connected: boolean; enabled: boolean; activity: string; waiting: boolean; sending: boolean; messages: number; pendingTool?: string };

export function CanvasLocalAgentPanel({ snapshot, canUndoOps, collapsed, onApplyOps, onUndoOps, onCollapseStart }: { snapshot: CanvasAgentSnapshot; canUndoOps: boolean; collapsed: boolean; onApplyOps: (ops: CanvasAgentOp[]) => unknown; onUndoOps: () => CanvasAgentSnapshot | null; onCollapseStart: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const user = useUserStore((state) => state.user);
    const { message } = App.useApp();
    const { width, url, token, connected, enabled, prompt, attachments, sending, waiting, messages, eventLogs, confirmTools, logOpen, activity, pendingTool, setAgentState, addMessage: pushMessage, addEventLog: pushEventLog, clearEventLogs } = useCanvasAgentStore();
    const [resizing, setResizing] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const snapshotRef = useRef(snapshot);
    const confirmToolsRef = useRef(confirmTools);
    const pendingToolRef = useRef<AgentPendingToolCall | null>(null);
    const onApplyOpsRef = useRef(onApplyOps);
    const connectedRef = useRef(false);
    const errorLoggedRef = useRef(false);
    const attachmentUrlsRef = useRef(new Set<string>());
    const clientIdRef = useRef(typeof crypto === "undefined" ? `${Date.now()}` : crypto.randomUUID());
    const endpoint = useMemo(() => url.replace(/\/$/, ""), [url]);

    useEffect(() => {
        snapshotRef.current = snapshot;
    }, [snapshot]);
    useEffect(() => {
        confirmToolsRef.current = confirmTools;
    }, [confirmTools]);
    useEffect(() => {
        pendingToolRef.current = pendingTool;
    }, [pendingTool]);
    useEffect(() => {
        onApplyOpsRef.current = onApplyOps;
    }, [onApplyOps]);
    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }, [messages, pendingTool, waiting]);
    useEffect(() => () => attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)), []);

    useEffect(() => {
        if (!enabled || !token.trim()) return;
        localStorage.setItem("canvas-agent-url", endpoint);
        localStorage.setItem("canvas-agent-token", token);
        const clientId = clientIdRef.current;
        const source = new EventSource(`${endpoint}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
        source.addEventListener("hello", () => {
            errorLoggedRef.current = false;
            connectedRef.current = true;
            setAgentState({ connected: true, activity: "已连接" });
            void postState(endpoint, token, clientId, snapshotRef.current);
        });
        source.addEventListener("tool_call", (event) => {
            const data = parseEventData<AgentPendingToolCall>(event);
            if (data) void handleToolCall(endpoint, token, data);
        });
        source.addEventListener("agent_event", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (data) handleAgentEvent(data);
        });
        source.addEventListener("agent_log", (event) => {
            const text = parseEventData<{ text?: unknown }>(event)?.text;
            addEventLog("日志", text, text);
        });
        source.addEventListener("agent_error", (event) => {
            const message = parseEventData<{ message?: unknown }>(event)?.message;
            setAgentState({ activity: "出错", waiting: false });
            addMessage({ role: "error", title: "错误", text: normalizeText(message) });
            addEventLog("错误", message, message);
        });
        source.addEventListener("agent_done", () => {
            setAgentState({ activity: "完成", waiting: false, sending: false });
        });
        source.onerror = () => {
            const wasConnected = connectedRef.current;
            if (!errorLoggedRef.current || wasConnected) addMessage({ role: "error", text: wasConnected ? "本地 Agent 连接失败或已断开" : "无法连接本地 Agent，请检查地址和 token" });
            errorLoggedRef.current = true;
            connectedRef.current = false;
            setAgentState({ waiting: false, activity: "离线", connected: false });
            if (!wasConnected) {
                source.close();
                setAgentState({ enabled: false });
            }
        };
        return () => {
            source.close();
            connectedRef.current = false;
            setAgentState({ connected: false });
        };
    }, [enabled, endpoint, setAgentState, token]);

    useEffect(() => {
        if (!connected) return;
        const timer = setTimeout(() => void postState(endpoint, token, clientIdRef.current, snapshot), 300);
        return () => clearTimeout(timer);
    }, [connected, endpoint, snapshot, token]);

    const sendPrompt = async () => {
        const text = prompt.trim();
        const files = attachments;
        const requestPrompt = promptWithAttachments(text, files);
        if (!connected || !requestPrompt || sending || waiting) return;
        if (attachmentPayloadBytes(files) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
            addMessage({ role: "error", title: "图片过大", text: "图片附件超过 30MB，请删减后再发送。" });
            return;
        }
        setAgentState({ activity: "发送中", sending: true, waiting: true });
        addMessage({ role: "user", text: text || "发送了图片", attachments: files });
        addEventLog("用户发送", { text, attachments: files.map(({ name, type, size }) => ({ name, type, size })) });
        try {
            const res = await fetch(`${endpoint}/agent/codex/turn?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: requestPrompt, attachments: files.map(({ name, type, dataUrl }) => ({ name, type, dataUrl })) }) });
            if (!res.ok) throw new Error("本地 Agent 拒绝了请求");
            addEventLog("本地 Agent 已接收", { status: res.status });
            files.forEach((item) => {
                URL.revokeObjectURL(item.url);
                attachmentUrlsRef.current.delete(item.url);
            });
            setAgentState({ prompt: "", attachments: [] });
        } catch (error) {
            setAgentState({ activity: "发送失败", waiting: false });
            addMessage({ role: "error", title: "发送失败", text: error instanceof Error ? error.message : "发送失败" });
            addEventLog("发送失败", error);
        } finally {
            setAgentState({ sending: false });
        }
    };

    const addAttachments = async (files: FileList | File[] | null) => {
        if (!files) return;
        const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
        const prev = useCanvasAgentStore.getState().attachments;
        try {
            const next = await Promise.all(images.slice(0, Math.max(0, MAX_ATTACHMENTS - prev.length)).map(async (file) => {
                const dataUrl = await readDataUrl(file);
                const url = URL.createObjectURL(file);
                attachmentUrlsRef.current.add(url);
                return { id: createId(), name: file.name, type: file.type, size: file.size, url, dataUrl };
            }));
            const merged = [...prev, ...next];
            if (attachmentPayloadBytes(merged) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
                next.forEach((item) => {
                    URL.revokeObjectURL(item.url);
                    attachmentUrlsRef.current.delete(item.url);
                });
                addMessage({ role: "error", title: "图片过大", text: "图片附件最多约 30MB。" });
                return;
            }
            if (next.length) setAgentState({ attachments: merged });
        } catch (error) {
            addMessage({ role: "error", title: "图片读取失败", text: error instanceof Error ? error.message : "图片读取失败" });
        }
    };

    const removeAttachment = (id: string) => {
        const removed = attachments.find((item) => item.id === id);
        if (removed) {
            URL.revokeObjectURL(removed.url);
            attachmentUrlsRef.current.delete(removed.url);
        }
        setAgentState({ attachments: attachments.filter((item) => item.id !== id) });
    };

    const handleToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (confirmToolsRef.current && payload.name === "canvas_apply_ops") {
            if (pendingToolRef.current) {
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: "仍有待确认的画布工具调用" });
                return;
            }
            pendingToolRef.current = payload;
            setAgentState({ pendingTool: payload, activity: "等待确认", waiting: false });
            addEventLog("等待确认", payload, payload);
            return;
        }
        await runToolCall(endpoint, token, payload);
    };

    const runToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        try {
            const input: { ops?: CanvasAgentOp[] } = payload.input || {};
            setAgentState({ activity: payload.name === "canvas_apply_ops" ? "执行画布操作" : "读取画布" });
            addEventLog(toolName(payload.name), payload, payload);
            const result = payload.name === "canvas_apply_ops" ? onApplyOpsRef.current(input.ops || []) : snapshotRef.current;
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
            if (payload.name === "canvas_apply_ops") void postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            setAgentState({ activity: "工具完成", waiting: true });
            addEventLog(`${toolName(payload.name)}完成`, result, result);
            addMessage({ role: "tool", title: `${toolName(payload.name)}完成`, text: payload.name === "canvas_apply_ops" ? summarizeCanvasAgentOps(input.ops || []) || "画布操作" : "已完成", detail: { requestId: payload.requestId, name: payload.name, input, result } });
        } catch (error) {
            const message = error instanceof Error ? error.message : "画布操作失败";
            setAgentState({ activity: "工具失败", waiting: false });
            addMessage({ role: "error", title: "工具失败", text: message, detail: payload });
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
        }
    };

    const rejectPendingTool = async () => {
        if (!pendingTool) return;
        await postToolResult(endpoint, token, clientIdRef.current, { requestId: pendingTool.requestId, error: "用户取消了画布工具调用" });
        setAgentState({ activity: "已取消", waiting: false });
        addMessage({ role: "tool", title: "已取消", text: toolName(pendingTool.name), detail: { requestId: pendingTool.requestId, name: pendingTool.name, input: pendingTool.input } });
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
    };

    const approvePendingTool = async () => {
        if (!pendingTool) return;
        const tool = pendingTool;
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
        await runToolCall(endpoint, token, tool);
    };

    const undoLastTool = () => {
        const restored = onUndoOps();
        if (!restored) return;
        setAgentState({ activity: "已撤销" });
        addMessage({ role: "tool", title: "已撤销", text: "上一次工具操作", detail: restored });
        if (connected) void postState(endpoint, token, clientIdRef.current, restored);
    };

    const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            nextWidth = clamp(startWidth + startX - moveEvent.clientX, 360, 760);
            setAgentState({ width: nextWidth });
        };
        const onUp = () => {
            localStorage.setItem("canvas-agent-panel-width", String(nextWidth));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    const addMessage = (item: Omit<AgentChatItem, "id">) => {
        const text = normalizeText(item.text);
        if (!text && !item.attachments?.length) return;
        const next = { ...item, id: `${Date.now()}-${Math.random()}`, text };
        const currentMessages = useCanvasAgentStore.getState().messages;
        if (next.streamId) {
            const index = currentMessages.findIndex((message) => message.streamId === next.streamId);
            if (index >= 0) {
                setAgentState({ messages: currentMessages.map((message, i) => i === index ? { ...message, ...next, id: message.id, text: next.text || message.text } : message) });
                return;
            }
        }
        const last = currentMessages.at(-1);
        if (last?.role === "assistant" && next.role === "assistant" && last.title === next.title) {
            const merged = mergeAgentText(last.text, next.text);
            if (merged === last.text) return;
            setAgentState({ messages: [...useCanvasAgentStore.getState().messages.slice(0, -1), { ...last, text: merged, meta: next.meta || last.meta }] });
            return;
        }
        pushMessage(next);
    };

    const addEventLog = (title: string, text: unknown, raw?: unknown) => {
        pushEventLog({ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleTimeString(), title, text: normalizeText(text) || title, raw });
    };

    const handleAgentEvent = (event: AgentEventPayload) => {
        if (shouldLogAgentEvent(event)) addEventLog(eventTitle(event), event, event);
        const nextActivity = activityText(event);
        if (nextActivity) setAgentState({ activity: nextActivity });
        if (event.type === "turn.completed" || event.type === "turn.failed") setAgentState({ waiting: false, sending: false });
        const item = formatAgentEvent(event);
        if (item) {
            if (item.role !== "tool" && event.type !== "item.updated") setAgentState({ waiting: false });
            addMessage(item);
        }
    };

    return (
        <motion.div
            className="relative z-[70] flex h-full shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: collapsed ? 0 : width + 1, opacity: collapsed ? 0 : 1 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: collapsed ? "none" : undefined }}
        >
        <motion.aside
            className="relative flex h-full shrink-0 flex-col border-l"
            initial={{ x: 48 }}
            animate={{ x: collapsed ? 28 : 0 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
        >
            <div className="absolute left-0 top-0 h-full w-1 cursor-col-resize transition hover:bg-current/20" onPointerDown={startResize} />
            <header className="flex h-14 items-center justify-between border-b px-4" style={{ borderColor: theme.node.stroke }}>
                <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-8 place-items-center rounded-lg" style={{ background: theme.node.fill }}>
                        <Bot className="size-4" />
                    </span>
                    <div className="min-w-0">
                        <div className="text-base font-semibold leading-5">Agent</div>
                        <div className="truncate text-xs" style={{ color: theme.node.muted }}>
                            Codex · {connected ? activity : "离线"}
                        </div>
                    </div>
                    <span className="ml-1 rounded-full px-2 py-0.5 text-xs" style={{ background: connected ? "rgba(34,197,94,.14)" : theme.node.fill, color: connected ? "#16a34a" : theme.node.muted }}>
                        {connected ? "在线" : "离线"}
                    </span>
                </div>
                <Button type="text" icon={<X className="size-4" />} onClick={onCollapseStart} />
            </header>

            <div className="grid gap-2 border-b p-3" style={{ borderColor: theme.node.stroke }}>
                <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
                    <Input value={url} onChange={(event) => setAgentState({ url: event.target.value })} placeholder="本地 Agent 地址" />
                    <Button type={enabled ? "default" : "primary"} icon={<PlugZap className="size-4" />} onClick={() => setAgentState({ enabled: !enabled })}>
                        {enabled ? "断开" : "连接"}
                    </Button>
                </div>
                <Input.Password value={token} onChange={(event) => setAgentState({ token: event.target.value })} placeholder="Agent token" />
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-sm" style={{ color: theme.node.muted }}>
                        <Switch size="small" checked={confirmTools} onChange={(confirmTools) => setAgentState({ confirmTools })} />
                        工具确认
                    </label>
                    <div className="flex items-center gap-1.5">
                        <Button size="small" type="text" icon={<Terminal className="size-3.5" />} onClick={() => setAgentState({ logOpen: true })}>
                            运行日志{eventLogs.length ? ` ${eventLogs.length}` : ""}
                        </Button>
                        <Button size="small" type="text" disabled={!canUndoOps} icon={<RotateCcw className="size-3.5" />} onClick={undoLastTool}>
                            撤销
                        </Button>
                    </div>
                </div>
            </div>

            <EventLogModal
                logs={eventLogs}
                open={logOpen}
                theme={theme}
                context={{ endpoint, connected, enabled, activity, waiting, sending, messages: messages.length, pendingTool: pendingTool?.name }}
                onClose={() => setAgentState({ logOpen: false })}
                onClear={clearEventLogs}
                onCopied={(text) => message.success(text)}
                onCopyBlocked={(text) => message.warning(text)}
            />

            <div ref={listRef} className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                {messages.map((item) => (
                    <ChatMessage key={item.id} item={item} theme={theme} user={user} />
                ))}
                {pendingTool ? <PendingToolCard tool={pendingTool} theme={theme} onReject={rejectPendingTool} onApprove={approvePendingTool} /> : null}
                {waiting ? <WorkingMessage theme={theme} logs={eventLogs.length} onOpenLog={() => setAgentState({ logOpen: true })} /> : null}
            </div>

            <AgentComposer prompt={prompt} attachments={attachments} connected={connected} sending={sending || waiting} theme={theme} onPromptChange={(prompt) => setAgentState({ prompt })} onSubmit={sendPrompt} onAddFiles={addAttachments} onRemoveAttachment={removeAttachment} />
        </motion.aside>
        </motion.div>
    );
}

function AgentComposer({ prompt, attachments, connected, sending, theme, onPromptChange, onSubmit, onAddFiles, onRemoveAttachment }: { prompt: string; attachments: AgentAttachment[]; connected: boolean; sending: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onPromptChange: (value: string) => void; onSubmit: () => void; onAddFiles: (files: FileList | File[] | null) => Promise<void>; onRemoveAttachment: (id: string) => void }) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const canSubmit = connected && !sending && Boolean(prompt.trim() || attachments.length);
    const sizeText = attachments.length ? `${formatBytes(attachmentPayloadBytes(attachments))} / 30MB` : "";
    return (
        <div className="border-t px-2 pb-2 pt-2" style={{ borderColor: theme.node.stroke }} onWheelCapture={(event) => event.stopPropagation()}>
            <div className="rounded-[24px] border px-3 pb-3 pt-3 shadow-lg" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}>
                {attachments.length ? (
                    <div className="thin-scrollbar mb-2 flex gap-2 overflow-x-auto pb-1">
                        {attachments.map((item) => (
                            <div key={item.id} className="group relative size-14 shrink-0 overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke, background: theme.node.fill }} title={item.name}>
                                <img src={item.url} alt={item.name} className="size-full object-cover" />
                                <button type="button" className="absolute right-1 top-1 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition group-hover:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => onRemoveAttachment(item.id)} aria-label="移除图片">
                                    <X className="size-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                ) : null}
                <textarea
                    value={prompt}
                    onChange={(event) => onPromptChange(event.target.value)}
                    onPaste={(event) => {
                        const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                        if (!images.length) return;
                        event.preventDefault();
                        void onAddFiles(images);
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
                        event.preventDefault();
                        void onSubmit();
                    }}
                    className="thin-scrollbar max-h-32 min-h-20 w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-5 outline-none placeholder:opacity-45"
                    style={{ color: theme.node.text }}
                    placeholder="询问 Codex，或让它操作画布"
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                        <input ref={fileInputRef} hidden type="file" accept="image/*" multiple onChange={(event) => {
                            void onAddFiles(event.target.files);
                            event.target.value = "";
                        }} />
                        <Tooltip title="上传图片">
                            <Button type="text" shape="circle" className="!h-9 !w-9 !min-w-9" disabled={sending} style={{ color: theme.node.muted }} icon={<ImagePlus className="size-4" />} onClick={() => fileInputRef.current?.click()} />
                        </Tooltip>
                        {sizeText ? <span className="text-[11px]" style={{ color: theme.node.muted }}>{sizeText}</span> : null}
                    </div>
                    <Button type="primary" shape="circle" className="!h-10 !w-10 !min-w-10" disabled={!canSubmit} icon={sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />} onClick={() => void onSubmit()} aria-label="发送" />
                </div>
            </div>
        </div>
    );
}

function EventLogModal({ logs, open, theme, context, onClose, onClear, onCopied, onCopyBlocked }: { logs: AgentEventLog[]; open: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; context: AgentLogContext; onClose: () => void; onClear: () => void; onCopied: (text: string) => void; onCopyBlocked: (text: string) => void }) {
    const [mode, setMode] = useState<"text" | "json">("text");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const content = mode === "text" ? formatLogText(logs, context) : formatLogJson(logs, context);
    const lastError = [...logs].reverse().find((item) => /错误|失败|error/i.test(`${item.title}\n${item.text}`));
    const copy = async (value = content, tip = "日志已复制") => {
        if (await copyToClipboard(value)) {
            onCopied(tip);
            return;
        }
        textareaRef.current?.focus();
        textareaRef.current?.select();
        onCopyBlocked("已选中日志，请手动复制");
    };
    return (
        <Modal title="运行日志" open={open} onCancel={onClose} footer={null} width="min(920px, calc(100vw - 32px))" centered destroyOnHidden>
            <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <Segmented size="small" value={mode} onChange={(value) => setMode(value as "text" | "json")} options={[{ label: "排查日志", value: "text" }, { label: "原始 JSON", value: "json" }]} />
                    <div className="flex items-center gap-2">
                        <span className="text-xs" style={{ color: theme.node.muted }}>{logs.length} 条</span>
                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void copy()}>复制排查日志</Button>
                        <Button size="small" disabled={!lastError} onClick={() => lastError && void copy(formatLogText([lastError], context), "最近错误已复制")}>复制最近错误</Button>
                        <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} disabled={!logs.length} onClick={onClear}>清空</Button>
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                    {[
                        ["连接", context.connected ? "在线" : context.enabled ? "连接中" : "未启用"],
                        ["状态", context.activity],
                        ["等待", context.waiting ? "是" : "否"],
                        ["工具", context.pendingTool ? toolName(context.pendingTool) : "无"],
                    ].map(([label, value]) => (
                        <div key={label} className="rounded-lg border px-3 py-2" style={{ borderColor: theme.node.stroke }}>
                            <div style={{ color: theme.node.muted }}>{label}</div>
                            <div className="mt-0.5 truncate" style={{ color: theme.node.text }}>{value}</div>
                        </div>
                    ))}
                </div>
                <textarea
                    ref={textareaRef}
                    readOnly
                    value={content}
                    className="thin-scrollbar h-[62vh] max-h-[620px] min-h-[360px] w-full resize-none rounded-lg border p-3 font-mono text-xs leading-5 outline-none"
                    style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}
                    onFocus={(event) => event.currentTarget.select()}
                />
            </div>
        </Modal>
    );
}

function ChatMessage({ item, theme, user }: { item: AgentChatItem; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; user: AuthUser | null }) {
    const isUser = item.role === "user";
    const isSystem = item.role === "system";
    const color = item.role === "error" ? "#dc2626" : item.role === "tool" ? "#2563eb" : theme.node.text;
    if (isSystem) {
        return (
            <div className="flex justify-center text-xs">
                <div className="max-w-[88%] px-3 py-1.5 text-center" style={{ color: theme.node.muted }}>
                    <div>
                        {item.text}
                        {item.meta ? <span className="ml-2 opacity-60">{item.meta}</span> : null}
                    </div>
                </div>
            </div>
        );
    }
    if (item.role === "tool") {
        return (
            <div className="flex items-start gap-3">
                <OpenAiAvatar theme={theme} />
                <ToolCard title={item.title || "工具调用"} text={item.text} detail={item.detail} theme={theme} />
            </div>
        );
    }
    return (
        <div className={`flex items-start gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
            {!isUser ? <OpenAiAvatar theme={theme} /> : null}
            <div className={`min-w-0 max-w-[82%] text-sm leading-6 ${isUser ? "text-right" : "text-left"}`} style={{ color }}>
                <div className="whitespace-pre-wrap break-words">{item.text}</div>
                {item.attachments?.length ? <MessageAttachments attachments={item.attachments} /> : null}
                {item.meta ? <div className="mt-1 text-[11px] opacity-45">{item.meta}</div> : null}
            </div>
            {isUser ? <UserAvatar user={user} theme={theme} /> : null}
        </div>
    );
}

function PendingToolCard({ tool, theme, onReject, onApprove }: { tool: AgentPendingToolCall; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onReject: () => void; onApprove: () => void }) {
    return (
        <div className="flex items-start gap-3">
            <OpenAiAvatar theme={theme} />
            <div className="min-w-0 max-w-[82%] rounded-2xl border p-3" style={{ borderColor: theme.node.stroke, background: "transparent", color: theme.node.text }}>
                <details>
                    <summary className="cursor-pointer list-none">
                        <div className="flex items-start gap-2">
                            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                                <Wrench className="size-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-3 text-sm font-medium leading-5">
                                    <span>确认工具调用</span>
                                    <span className="text-[11px] font-normal" style={{ color: theme.node.muted }}>详情</span>
                                </div>
                                <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                    {summarizeCanvasAgentOps(tool.input?.ops || []) || toolName(tool.name)}
                                </div>
                            </div>
                        </div>
                    </summary>
                    <DetailBlock detail={{ requestId: tool.requestId, name: tool.name, input: tool.input }} theme={theme} />
                </details>
                <div className="mt-3 flex justify-end gap-2">
                    <Button size="small" onClick={() => void onReject()}>
                        取消
                    </Button>
                    <Button size="small" type="primary" onClick={() => void onApprove()}>
                        执行
                    </Button>
                </div>
            </div>
        </div>
    );
}

function ToolCard({ title, text, detail, theme }: { title: string; text: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <details className="min-w-0 max-w-[82%] rounded-2xl border px-3 py-2.5 text-left" style={{ borderColor: theme.node.stroke, background: "transparent", color: theme.node.text }}>
            <summary className="cursor-pointer list-none">
                <div className="flex items-center gap-2 text-xs font-medium">
                    <Wrench className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {detail ? <span className="font-normal" style={{ color: theme.node.muted }}>详情</span> : null}
                </div>
                <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                    {text}
                </div>
            </summary>
            {detail ? <DetailBlock detail={detail} theme={theme} /> : null}
        </details>
    );
}

function DetailBlock({ detail, theme }: { detail: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <pre className="thin-scrollbar mt-2 max-h-52 overflow-auto rounded-lg border p-2 text-[11px] leading-4" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
            {JSON.stringify(detail, null, 2)}
        </pre>
    );
}

function WorkingMessage({ theme, logs, onOpenLog }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; logs: number; onOpenLog: () => void }) {
    return (
        <div className="flex items-start gap-2.5">
            <OpenAiAvatar theme={theme} />
            <div className="min-w-0 max-w-[82%]">
                <div className="inline-flex items-center gap-2 text-sm" style={{ color: theme.node.muted }}>
                    <LoaderCircle className="size-4 animate-spin" />
                    <span>working...</span>
                    <button type="button" className="text-xs underline-offset-2 hover:underline" onClick={onOpenLog}>
                        运行日志{logs ? ` ${logs}` : ""}
                    </button>
                </div>
            </div>
        </div>
    );
}

function OpenAiAvatar({ theme }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <span className="grid size-8 shrink-0 place-items-center" role="img" aria-label="OpenAI">
            <span className="size-5 opacity-80" style={{ background: theme.node.text, WebkitMask: "url(/icons/openai.svg) center / contain no-repeat", mask: "url(/icons/openai.svg) center / contain no-repeat" }} />
        </span>
    );
}

function UserAvatar({ user, theme }: { user: AuthUser | null; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const avatarUrl = user?.avatarUrl?.trim();
    return (
        <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full" style={{ color: theme.node.text }}>
            {avatarUrl ? <img src={avatarUrl} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : <UserRound className="size-4" />}
        </span>
    );
}

function MessageAttachments({ attachments }: { attachments: AgentAttachment[] }) {
    return (
        <div className="mt-2 grid grid-cols-3 gap-1.5">
            {attachments.map((item) => (
                <img key={item.id} src={item.dataUrl || item.url} alt={item.name} className="aspect-square w-full rounded-lg object-cover" />
            ))}
        </div>
    );
}

async function postState(endpoint: string, token: string, clientId: string, snapshot: CanvasAgentSnapshot) {
    try {
        await fetch(`${endpoint}/canvas/state?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot) });
    } catch {}
}

async function postToolResult(endpoint: string, token: string, clientId: string, body: { requestId: string; result?: unknown; error?: string }) {
    await fetch(`${endpoint}/canvas/result?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function formatAgentEvent(event: AgentEventPayload): Omit<AgentChatItem, "id"> | null {
    const item = event.item;
    if (event.type === "item.completed" && item?.type === "error") return { role: "error", title: "错误", text: normalizeText(item.message), detail: item };
    if ((event.type === "item.updated" || event.type === "item.completed") && item?.type === "agent_message") return { role: "assistant", title: "Codex", text: stringText(item.text), meta: usageText(event), streamId: item.id };
    if (event.type === "item.completed" && isMcpToolItem(item) && isReadTool(String(item?.tool || ""))) return { role: "tool", title: `${toolName(String(item?.tool || ""))}完成`, text: item?.error?.message || toolSummary(item), detail: toolDetail(item) };
    const text = eventText(event);
    if (text) return { role: "assistant", title: "Codex", text, meta: usageText(event) };
    return null;
}

function parseEventData<T>(event: Event) {
    try {
        return JSON.parse((event as MessageEvent).data) as T;
    } catch {
        return null;
    }
}

function formatLogText(logs: AgentEventLog[], context: AgentLogContext) {
    const head = [
        "Infinite Canvas Agent 诊断日志",
        `Canvas Agent: ${context.endpoint}`,
        `连接: ${context.connected ? "在线" : context.enabled ? "连接中" : "未启用"}`,
        `状态: ${context.activity}`,
        `waiting: ${context.waiting}`,
        `sending: ${context.sending}`,
        `messages: ${context.messages}`,
        `pendingTool: ${context.pendingTool ? toolName(context.pendingTool) : "none"}`,
        `logs: ${logs.length}`,
    ].join("\n");
    const body = logs.map((item, index) => {
        const detail = item.raw == null ? item.text : JSON.stringify(item.raw, null, 2);
        return [`#${index + 1} ${item.time} ${item.title}`, detail].filter(Boolean).join("\n");
    }).join("\n\n---\n\n");
    return [head, body || "暂无事件日志"].join("\n\n");
}

function formatLogJson(logs: AgentEventLog[], context: AgentLogContext) {
    return JSON.stringify({ context, logs: logs.map(({ time, title, text, raw }) => ({ time, title, text, raw })) }, null, 2);
}

function eventText(event: AgentEventPayload) {
    return event.type === "item.completed" && event.item?.type === "agent_message" ? stringText(event.item.text) : "";
}

function usageText(event: AgentEventPayload) {
    const usage = event.usage;
    if (!usage || typeof usage !== "object") return undefined;
    const total = numberField(usage, "total_tokens");
    const input = numberField(usage, "input_tokens");
    const output = numberField(usage, "output_tokens");
    if (total) return `${total} tok`;
    if (input || output) return `${input || 0}/${output || 0} tok`;
    return undefined;
}

function activityText(event: AgentEventPayload) {
    const name = event.type || "";
    if (name === "thread.started") return "已创建会话";
    if (name === "turn.started") return "思考中";
    if (name === "turn.completed") return "完成";
    if (name === "turn.failed" || name === "error") return "出错";
    if (name === "item.started") return isMcpToolItem(event.item) ? `调用${toolName(String(event.item?.tool || ""))}` : "执行步骤";
    if (name === "item.completed") return isMcpToolItem(event.item) ? "工具完成" : "更新消息";
    return "";
}

function eventTitle(event: AgentEventPayload) {
    const item = event.item;
    if (event.type === "thread.started") return "已创建 Codex 会话";
    if (event.type === "turn.started") return "开始处理";
    if (event.type === "turn.completed") return "本轮完成";
    if (event.type === "stream.summary") return "流式摘要";
    if (event.type === "turn.failed" || event.type === "error") return "本轮失败";
    if (event.type === "item.started" && isMcpToolItem(item)) return `调用工具：${toolName(String(item?.tool || ""))}`;
    if (event.type === "item.completed" && isMcpToolItem(item)) return `工具完成：${toolName(String(item?.tool || ""))}`;
    if (event.type === "item.completed" && item?.type === "agent_message") return "Codex 回复";
    return event.type || "Codex 事件";
}

function shouldLogAgentEvent(event: AgentEventPayload) {
    const itemType = event.item?.type || "";
    return !["item.updated"].includes(event.type || "") && !["reasoning"].includes(itemType) && !(event.type === "item.started" && itemType === "agent_message");
}

function toolName(name: string) {
    if (name === "canvas_apply_ops") return "画布操作";
    if (name === "canvas_get_state") return "读取画布";
    if (name === "canvas_get_selection") return "读取选区";
    if (name === "canvas_export_snapshot") return "导出快照";
    if (name === "canvas_create_text_node") return "创建文本";
    if (name === "canvas_create_image_prompt_flow") return "创建生图流程";
    return name;
}

function isReadTool(name: string) {
    return name === "canvas_get_state" || name === "canvas_get_selection" || name === "canvas_export_snapshot";
}

function isMcpToolItem(item?: AgentEventItem) {
    return item?.type === "mcp_tool_call";
}

function toolDetail(item?: AgentEventItem) {
    return { server: item?.server, tool: item?.tool, status: item?.status, arguments: item?.arguments, result: parseToolResult(item?.result), error: item?.error };
}

function toolSummary(item?: AgentEventItem) {
    const result = parseToolResult(item?.result);
    const nodeField = objectField(result, "nodes");
    const connectionField = objectField(result, "connections");
    const nodes = Array.isArray(nodeField) ? nodeField : [];
    const connections = Array.isArray(connectionField) ? connectionField : [];
    if (Array.isArray(nodeField) || Array.isArray(connectionField)) return `读取到 ${nodes.length} 个节点，${connections.length} 条连线`;
    return "工具调用完成";
}

function parseToolResult(result: unknown) {
    const content = objectField(result, "content");
    const text = Array.isArray(content) ? content.map((item) => objectField(item, "text")).filter((item): item is string => typeof item === "string").join("\n") : "";
    try {
        return text ? JSON.parse(text) : result;
    } catch {
        return text || result;
    }
}

function normalizeText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error) return value.message;
    if (value == null) return "";
    return JSON.stringify(value, null, 2);
}

function stringText(value: unknown) {
    return typeof value === "string" ? value : "";
}

function objectField(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function numberField(value: unknown, key: string) {
    const field = objectField(value, key);
    return typeof field === "number" ? field : 0;
}

function mergeAgentText(prev: string, next: string) {
    if (!next || prev === next || prev.endsWith(next)) return prev;
    if (next.startsWith(prev)) return next;
    for (let size = Math.min(prev.length, next.length); size > 0; size--) {
        if (prev.endsWith(next.slice(0, size))) return `${prev}${next.slice(size)}`;
    }
    const half = Math.floor(prev.length / 2);
    if (prev.length > 12 && next.length > 12 && prev.slice(half) === next.slice(0, prev.length - half)) return prev;
    return `${prev}${next}`;
}

function promptWithAttachments(text: string, attachments: AgentAttachment[]) {
    if (!attachments.length) return text;
    const names = attachments.map((item) => item.name).join("、");
    return [text, `用户上传了 ${attachments.length} 张图片附件：${names}。`].filter(Boolean).join("\n\n");
}

function attachmentPayloadBytes(attachments: AgentAttachment[]) {
    return attachments.reduce((total, item) => total + item.dataUrl.length, 0);
}

function formatBytes(bytes: number) {
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

function createId() {
    return typeof crypto === "undefined" ? `${Date.now()}-${Math.random()}` : crypto.randomUUID();
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function readDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
        reader.readAsDataURL(file);
    });
}
