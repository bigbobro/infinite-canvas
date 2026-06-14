import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 17371;
export const CONFIG_DIR = path.join(os.homedir(), ".infinite-canvas");
export const CONFIG_FILE = path.join(CONFIG_DIR, "canvas-agent.json");
export const VERSION = "0.1.0";
export const AGENT_PROMPT = "你正在帮助用户操作 Infinite Canvas 网页画布。需要改动画布时优先使用已配置的 infinite-canvas MCP 工具：先 canvas_get_state 读取当前画布，再用 canvas_apply_ops 提交 JSON 操作。不要模拟鼠标点击，不要要求用户手动复制 JSON。";

export type CanvasAgentConfig = { url: string; token: string; origins?: string[] };

export function loadConfig(create = false): CanvasAgentConfig {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as CanvasAgentConfig;
    } catch {
        const config = { url: `http://127.0.0.1:${Number(process.env.PORT) || DEFAULT_PORT}`, token: crypto.randomBytes(18).toString("hex") };
        if (create) saveConfig(config);
        return config;
    }
}

export function saveConfig(config: CanvasAgentConfig) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
