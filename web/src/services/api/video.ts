import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type VideoResponse = { id: string; status?: string; error?: { message?: string } };

function aiApiUrl(config: AiConfig, path: string) {
    return config.channelMode === "remote" ? `/api/v1${path}` : buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    const token = useUserStore.getState().token;
    return config.channelMode === "remote" ? (token ? { Authorization: `Bearer ${token}` } : undefined) : { Authorization: `Bearer ${config.apiKey}` };
}

function refreshRemoteUser(config: AiConfig) {
    if (config.channelMode === "remote") void useUserStore.getState().hydrateUser();
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = []) {
    const model = config.model || config.videoModel;
    const body = new FormData();
    body.append("model", model);
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    if (config.vquality) body.append("vquality", config.vquality);
    if (references[0]) body.append("input_reference", dataUrlToFile({ ...references[0], dataUrl: await imageToDataUrl(references[0]) }));
    const created = await axios.post<VideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config) });
    for (;;) {
        const video = await axios.get<VideoResponse>(aiApiUrl(config, `/videos/${created.data.id}`), { headers: aiHeaders(config), params: config.channelMode === "remote" ? { model } : undefined });
        if (video.data.status === "completed") break;
        if (video.data.status === "failed" || video.data.status === "cancelled") throw new Error(video.data.error?.message || "视频生成失败");
        await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${created.data.id}/content`), { headers: aiHeaders(config), params: config.channelMode === "remote" ? { model } : undefined, responseType: "blob" });
    refreshRemoteUser(config);
    return content.data;
}

function normalizeVideoSeconds(value: string) {
    return String(Math.max(1, Math.floor(Number(value) || 6)));
}

function normalizeVideoSize(value: string) {
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}
