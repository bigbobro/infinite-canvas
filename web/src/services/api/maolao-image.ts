/**
 * 猫佬（maolao）渠道的异步生图任务。
 *
 * 协议：POST /images/tasks 提交 → GET /images/tasks/{id} 轮询 → GET .../content/{i} 取图。
 * 该渠道的 gpt-image-2 在同步端点直接 model_not_found，异步是唯一可用路径。
 *
 * 二开功能，独立于上游 image.ts；上游只保留两处单行分流（requestGeneration / requestEdit）。
 */
import axios from "axios";
import { nanoid } from "nanoid";

import { blobToDataUrl } from "@/services/image-storage";
import { delay } from "@/services/api/request";
import { buildApiUrl, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

/** 与上游 image.ts 的图片响应体同构：result.data[] 就是标准的 {url, revised_prompt}。 */
type ImagePayloadLike = { data?: Array<Record<string, unknown>>; created?: number };

export type MaolaoRequestOptions = {
    signal?: AbortSignal;
    onProgress?: (progress: string) => void;
    /**
     * 异步任务已创建、尚未开始轮询时回调。调用方可在此持久化 task 句柄；
     * 返回的 Promise 会被 await，确保落盘完成后才开始轮询。
     */
    onTaskCreated?: (handle: ImageTaskHandle) => void | Promise<void>;
};

export type ImageTaskHandle = { taskId: string; expiresAt?: number };

const POLL_INTERVAL_MS = 2500;
/**
 * ≈20 分钟。不可低于服务端预算：实测猫佬单次请求预算为 660 秒（超时记 504
 * "image request exceeded total budget of 660 seconds"），且超时后服务端会自行重试，
 * 总时长可超 660 秒。客户端若先放弃，用户会看到「超时」但任务仍跑完并照常计费 —— 钱花了、图没拿到。
 */
const MAX_ATTEMPTS = 480;
/** 轮询 GET 连续失败达此次数才判定任务失败；期间远端任务仍在正常执行。 */
const MAX_CONSECUTIVE_ERRORS = 5;
/** 轮询 GET 必须有超时：axios 默认无限等待，挂起的请求会让轮询循环卡死而非重试。 */
const POLL_TIMEOUT_MS = 15000;
/** 取图是大 blob 下载，给足时间但不可无限。 */
const CONTENT_TIMEOUT_MS = 120000;

type ImageTaskResponse = {
    task_id?: string;
    status?: "queued" | "processing" | "succeeded" | "failed";
    progress?: string;
    /** 实测只在 status=succeeded 的响应里出现，提交与 processing 响应均无此字段。 */
    expires_at?: number;
    result?: ImagePayloadLike;
    error?: string | { message?: string };
};

function taskUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function taskHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function readImageTaskError(error: ImageTaskResponse["error"]) {
    if (typeof error === "string") return error;
    return error?.message || "";
}

function isAbortError(error: unknown) {
    return axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError");
}

export async function createImageTask(config: AiConfig, payload: unknown, params?: Record<string, string>, options?: MaolaoRequestOptions): Promise<ImageTaskHandle> {
    const response = await axios.post<ImageTaskResponse>(taskUrl(config, "/images/tasks"), payload, {
        headers: taskHeaders(config, payload instanceof FormData ? undefined : "application/json"),
        ...(params ? { params } : {}),
        signal: options?.signal,
    });
    const taskId = response.data?.task_id;
    if (!taskId) throw new Error("图片任务没有返回任务 ID");
    return { taskId, expiresAt: response.data?.expires_at };
}

export async function waitForImageTask(config: AiConfig, taskId: string, options?: MaolaoRequestOptions): Promise<ImageTaskResponse> {
    let consecutiveErrors = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const task = (
                await axios.get<ImageTaskResponse>(taskUrl(config, `/images/tasks/${encodeURIComponent(taskId)}`), {
                    headers: taskHeaders(config),
                    timeout: POLL_TIMEOUT_MS,
                    signal: options?.signal,
                })
            ).data;
            consecutiveErrors = 0;
            if (task.status === "succeeded") return task;
            if (task.status === "failed") throw new Error(readImageTaskError(task.error) || "图片生成失败");
            options?.onProgress?.(task.progress || "");
        } catch (error) {
            // 取消是用户意图；404 表示任务不存在，重试无用；任务 failed 抛的是普通 Error，同样直接上抛。
            if (isAbortError(error) || !axios.isAxiosError(error)) throw error;
            if (error.response?.status === 404) throw new Error("图片任务不存在或已失效");
            consecutiveErrors += 1;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) throw error;
        }
        await delay(POLL_INTERVAL_MS, options?.signal);
    }
    throw new Error("图片生成超时，请稍后重试");
}

/**
 * 取图。刻意忽略 result.data[].url —— 实测其形态不稳定（有时是相对路径，有时是随机
 * 第三方 CDN 绝对地址，域名每次不同且 CORS 不可控）。content/{index} 端点始终可用，
 * 走同网关，CORS 已验证。
 */
async function fetchImageTaskContents(config: AiConfig, taskId: string, count: number, signal?: AbortSignal) {
    const images = [];
    for (let index = 0; index < count; index += 1) {
        try {
            const response = await axios.get<Blob>(taskUrl(config, `/images/tasks/${encodeURIComponent(taskId)}/content/${index}`), {
                headers: taskHeaders(config),
                responseType: "blob",
                timeout: CONTENT_TIMEOUT_MS,
                signal,
            });
            images.push({ id: nanoid(), dataUrl: await blobToDataUrl(response.data) });
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 410) throw new Error("生成结果已过期，请重新生成");
            throw error;
        }
    }
    if (!images.length) throw new Error("接口没有返回图片");
    return images;
}

/** 提交 → 轮询 → 取图。config 须已由 resolveModelRequestConfig 解析（含 baseUrl/apiKey）。 */
export async function requestMaolaoImageTask(config: AiConfig, payload: unknown, params?: Record<string, string>, options?: MaolaoRequestOptions) {
    const handle = await createImageTask(config, payload, params, options);
    // 先让调用方落盘 task 句柄，再开始轮询 —— 否则此刻刷新页面就再也找不回远端任务。
    await options?.onTaskCreated?.(handle);
    const task = await waitForImageTask(config, handle.taskId, options);
    // 张数以实际交付为准：该渠道存在偶发少交付（请求 n 张只生成 1 张，仍按 n 计费）。
    const delivered = task.result?.data?.length || 0;
    return await fetchImageTaskContents(config, handle.taskId, delivered, options?.signal);
}

/**
 * 恢复一个已存在的任务：跳过提交，直接轮询并取图。用于页面重载后续轮询。
 * model 需为 encodeChannelModel 编码值，据此解析出任务所属渠道。
 */
export async function resumeImageTask(config: AiConfig, model: string, taskId: string, options?: MaolaoRequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, model);
    const task = await waitForImageTask(requestConfig, taskId, options);
    const delivered = task.result?.data?.length || 0;
    return await fetchImageTaskContents(requestConfig, taskId, delivered, options?.signal);
}
