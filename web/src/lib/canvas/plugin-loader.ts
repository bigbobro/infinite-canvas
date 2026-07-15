import { registerNodeDefinitions, unregisterPluginNodes } from "@/lib/canvas/node-registry";
import { getPluginRuntime } from "@/lib/canvas/plugin-runtime";
import { usePluginStore, type InstalledPlugin } from "@/stores/canvas/use-plugin-store";
import type { CanvasPlugin } from "@/types/canvas-plugin";

const cleanups = new Map<string, () => void>();

// 远程插件默认导出可以是 CanvasPlugin,或接收 runtime 返回 CanvasPlugin 的工厂
// (工厂形式用 runtime.React,无需 bundle 自带 React)
async function evaluatePluginSource(source: string): Promise<CanvasPlugin> {
    const blob = new Blob([source], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
        const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown; plugin?: unknown };
        const exported = mod.default ?? mod.plugin;
        const plugin = typeof exported === "function" ? (exported as (runtime: unknown) => unknown)(getPluginRuntime()) : exported;
        assertPlugin(plugin);
        return plugin;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function assertPlugin(plugin: unknown): asserts plugin is CanvasPlugin {
    const value = plugin as Partial<CanvasPlugin> | null;
    if (!value || typeof value !== "object") throw new Error("插件未导出有效对象");
    if (!value.id || !Array.isArray(value.nodes) || !value.nodes.length) throw new Error("插件缺少 id 或 nodes");
}

export function activatePlugin(plugin: CanvasPlugin) {
    registerNodeDefinitions(plugin.nodes, plugin.id);
    const runtime = getPluginRuntime();
    const disposers: Array<() => void> = [];
    // 插件声明的样式:启用时注入,禁用/卸载时清理
    if (plugin.css) disposers.push(runtime.injectCSS(plugin.css, plugin.id));
    const cleanup = plugin.setup?.(runtime);
    if (typeof cleanup === "function") disposers.push(cleanup);
    if (disposers.length) cleanups.set(plugin.id, () => disposers.forEach((dispose) => dispose()));
}

export function deactivatePlugin(pluginId: string) {
    cleanups.get(pluginId)?.();
    cleanups.delete(pluginId);
    unregisterPluginNodes(pluginId);
}

async function fetchPluginSource(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载失败 (HTTP ${response.status})`);
    return response.text();
}

// 从 URL 安装(或覆盖更新)一个插件,成功后立即启用
export async function installPluginFromUrl(url: string) {
    const source = await fetchPluginSource(url);
    const plugin = await evaluatePluginSource(source);
    deactivatePlugin(plugin.id); // 覆盖旧版本
    usePluginStore.getState().upsert({ id: plugin.id, name: plugin.name || plugin.id, version: plugin.version || "0.0.0", description: plugin.description, url, source, enabled: true });
    activatePlugin(plugin);
    return plugin;
}

export async function updatePlugin(record: InstalledPlugin) {
    return installPluginFromUrl(record.url);
}

export async function setPluginEnabled(record: InstalledPlugin, enabled: boolean) {
    usePluginStore.getState().setEnabled(record.id, enabled);
    if (!enabled) {
        deactivatePlugin(record.id);
        return;
    }
    const plugin = await evaluatePluginSource(record.source);
    activatePlugin(plugin);
}

export function uninstallPlugin(id: string) {
    deactivatePlugin(id);
    usePluginStore.getState().remove(id);
}

let loaded = false;

// 应用启动时加载已安装且启用的插件
export async function ensurePluginsLoaded() {
    if (loaded) return;
    loaded = true;
    await usePluginStore.persist.rehydrate();
    const records = usePluginStore.getState().plugins.filter((record) => record.enabled);
    await Promise.all(
        records.map(async (record) => {
            try {
                activatePlugin(await evaluatePluginSource(record.source));
            } catch (error) {
                console.error(`[plugin] 加载失败: ${record.id}`, error);
            }
        }),
    );
    await loadDevPlugins();
}

// 本地开发:VITE_DEV_PLUGINS 里的 URL 每次启动都重新拉取(不缓存、不落库),
// 配合 watch 构建即可「改代码→刷新页面」看到最新插件,无需反复安装。
async function loadDevPlugins() {
    const raw = import.meta.env.VITE_DEV_PLUGINS;
    if (!raw) return;
    const urls = raw.split(",").map((item) => item.trim()).filter(Boolean);
    await Promise.all(
        urls.map(async (url) => {
            try {
                const source = await fetchPluginSource(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`);
                const plugin = await evaluatePluginSource(source);
                deactivatePlugin(plugin.id);
                activatePlugin(plugin);
                console.info(`[plugin] dev 插件已加载: ${plugin.id} (${url})`);
            } catch (error) {
                console.error(`[plugin] dev 插件加载失败: ${url}`, error);
            }
        }),
    );
}
