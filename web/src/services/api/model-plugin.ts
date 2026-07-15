import axios from "axios";

import { buildApiUrl, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type RequestOptions = { signal?: AbortSignal };

export type PluginHttpOptions = {
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
    responseType?: "json" | "blob" | "text" | "arraybuffer";
};

export type PluginHttp = {
    url: (path: string) => string;
    post: (path: string, body?: unknown, options?: PluginHttpOptions) => Promise<unknown>;
    get: (path: string, options?: PluginHttpOptions) => Promise<unknown>;
};

export type PluginPollOptions = { intervalMs?: number; timeoutMs?: number };

export type PluginConfigView = {
    baseUrl: string;
    apiKey: string;
    model: string;
    apiFormat: string;
    systemPrompt: string;
};

export type RunPluginArgs = {
    capability: ModelCapability;
    script: string;
    config: AiConfig;
    input: Record<string, unknown>;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
};

function pluginHeaders(config: AiConfig, extra?: Record<string, string>, hasJsonBody = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (config.apiFormat === "gemini") headers["x-goog-api-key"] = config.apiKey;
    else headers.Authorization = `Bearer ${config.apiKey}`;
    if (hasJsonBody) headers["Content-Type"] = "application/json";
    return { ...headers, ...extra };
}

function pluginUrl(config: AiConfig, path: string) {
    if (/^https?:/i.test(path)) return path;
    return buildApiUrl(config.baseUrl, path.startsWith("/") ? path : `/${path}`);
}

function createPluginHttp(config: AiConfig, options?: RequestOptions): PluginHttp {
    const request = async (method: "get" | "post", path: string, body: unknown, opts?: PluginHttpOptions) => {
        const isForm = typeof FormData !== "undefined" && body instanceof FormData;
        const response = await axios.request({
            method,
            url: pluginUrl(config, path),
            data: method === "post" ? body : undefined,
            params: opts?.params,
            headers: pluginHeaders(config, opts?.headers, method === "post" && !isForm && body !== undefined),
            responseType: opts?.responseType || "json",
            signal: options?.signal,
        });
        return response.data;
    };
    return {
        url: (path) => pluginUrl(config, path),
        post: (path, body, opts) => request("post", path, body, opts),
        get: (path, opts) => request("get", path, undefined, opts),
    };
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function createPoll(signal?: AbortSignal) {
    return async function poll<T, R>(request: () => Promise<T>, extract: (value: T) => R | null | undefined | false, options?: PluginPollOptions): Promise<R> {
        const intervalMs = options?.intervalMs ?? 2500;
        const timeoutMs = options?.timeoutMs ?? 300000;
        const deadline = performance.now() + timeoutMs;
        for (;;) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const result = extract(await request());
            if (result !== null && result !== undefined && result !== false) return result;
            if (performance.now() >= deadline) throw new Error("插件轮询超时，请检查调用脚本或稍后重试");
            await sleep(intervalMs, signal);
        }
    };
}

/**
 * Run a user-authored model call script. The script body runs as an async function with these locals:
 *   input   —— normalized request input for this capability (prompt / references / messages / params / body)
 *   config  —— { baseUrl, apiKey, model, apiFormat, systemPrompt }
 *   http    —— { url(path), post(path, body, opts), get(path, opts) } bound to the model's channel
 *   poll    —— poll(request, extract, { intervalMs, timeoutMs }) resolves with the first truthy extract result
 *   sleep   —— sleep(ms)
 *   signal  —— AbortSignal for cancellation
 *   onDelta —— (text) => void, push streaming text (text capability only)
 * The script must `return` the result; each caller normalizes it to its capability's shape.
 */
export async function runModelPlugin<T = unknown>(args: RunPluginArgs): Promise<T> {
    const configView: PluginConfigView = {
        baseUrl: args.config.baseUrl,
        apiKey: args.config.apiKey,
        model: args.config.model,
        apiFormat: args.config.apiFormat,
        systemPrompt: args.config.systemPrompt,
    };
    const http = createPluginHttp(args.config, { signal: args.signal });
    const poll = createPoll(args.signal);
    const runner = new Function(
        "input",
        "config",
        "http",
        "poll",
        "sleep",
        "signal",
        "onDelta",
        `"use strict"; return (async () => {\n${args.script}\n})();`,
    ) as (input: unknown, config: PluginConfigView, http: PluginHttp, poll: ReturnType<typeof createPoll>, sleep: (ms: number) => Promise<void>, signal: AbortSignal | undefined, onDelta?: (text: string) => void) => Promise<T>;
    try {
        return await runner(args.input, configView, http, poll, (ms: number) => sleep(ms, args.signal), args.signal, args.onDelta);
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (axios.isCancel(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`模型调用脚本执行失败：${message}`);
    }
}

export const PLUGIN_TEMPLATES: Record<ModelCapability, string> = {
    image: `// 输入：input.prompt / input.references(dataURL[]) / input.body(默认请求体) / input.params
// 返回：dataURL 或 URL 字符串，或它们的数组，或 [{ dataUrl }]
const data = await http.post("/images/generations", {
  ...input.body,
  model: config.model,
  prompt: input.prompt,
});
return (data.data || []).map((item) => item.b64_json ? \`data:image/png;base64,\${item.b64_json}\` : item.url);`,
    video: `// 输入：input.prompt / input.references(dataURL[]) / input.params
// 返回：{ url } 或 { blob } 或视频 URL 字符串
const task = await http.post("/videos", {
  model: config.model,
  prompt: input.prompt,
  seconds: input.params.seconds,
});
return await poll(
  () => http.get(\`/videos/\${task.id}\`),
  (state) => state.status === "completed" ? { url: state.video_url || state.url } : null,
  { intervalMs: 2500, timeoutMs: 300000 },
);`,
    audio: `// 输入：input.prompt / input.params(voice/format/speed/instructions)
// 返回：Blob，或 base64/dataURL 字符串
return await http.post("/audio/speech", {
  model: config.model,
  input: input.prompt,
  voice: input.params.voice,
  response_format: input.params.format,
  speed: Number(input.params.speed),
}, { responseType: "blob" });`,
    text: `// 输入：input.messages([{role,content}]) / input.body
// 用 onDelta(text) 推送流式文本；返回最终完整文本
const data = await http.post("/chat/completions", {
  model: config.model,
  messages: input.messages,
});
const text = data.choices?.[0]?.message?.content || "";
onDelta(text);
return text;`,
};

/** Normalize whatever an image script returns into the app's generated-image shape. */
export function normalizePluginImages(result: unknown): string[] {
    const items = Array.isArray(result) ? result : [result];
    const urls = items
        .map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object") {
                const record = item as Record<string, unknown>;
                if (typeof record.dataUrl === "string") return record.dataUrl;
                if (typeof record.url === "string") return record.url;
                if (typeof record.b64_json === "string") return `data:image/png;base64,${record.b64_json}`;
            }
            return "";
        })
        .filter(Boolean);
    if (!urls.length) throw new Error("模型调用脚本没有返回图片");
    return urls;
}
