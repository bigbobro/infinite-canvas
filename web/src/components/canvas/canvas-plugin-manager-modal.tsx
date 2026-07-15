import { useState } from "react";
import { App, Button, Input, Modal, Popconfirm, Switch } from "antd";
import { AlertTriangle, Puzzle, RefreshCw, Trash2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { installPluginFromUrl, setPluginEnabled, uninstallPlugin, updatePlugin } from "@/lib/canvas/plugin-loader";
import { useThemeStore } from "@/stores/use-theme-store";
import { usePluginStore, type InstalledPlugin } from "@/stores/canvas/use-plugin-store";

export function CanvasPluginManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message } = App.useApp();
    const plugins = usePluginStore((state) => state.plugins);
    const [url, setUrl] = useState("");
    const [installing, setInstalling] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);

    const handleInstall = async () => {
        const target = url.trim();
        if (!target) return;
        setInstalling(true);
        try {
            const plugin = await installPluginFromUrl(target);
            message.success(`已安装插件 ${plugin.name}`);
            setUrl("");
        } catch (error) {
            message.error(`安装失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setInstalling(false);
        }
    };

    const runOnPlugin = async (record: InstalledPlugin, action: () => Promise<void>, successText: string) => {
        setBusyId(record.id);
        try {
            await action();
            message.success(successText);
        } catch (error) {
            message.error(`${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusyId(null);
        }
    };

    return (
        <Modal title="节点插件" open={open} onCancel={onClose} footer={null} centered width={640}>
            <div className="space-y-4">
                <div className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: "#f59e0b55", background: "#f59e0b14", color: theme.node.text }}>
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    <span>插件代码会在当前页面内直接执行，可访问本地数据（包含 AI API Key）。请仅安装你信任来源的插件。</span>
                </div>

                <div className="flex gap-2">
                    <Input
                        placeholder="输入插件 JS 文件 URL，例如 https://.../plugin.js"
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                        onPressEnter={handleInstall}
                        allowClear
                    />
                    <Button type="primary" loading={installing} onClick={handleInstall} icon={<Puzzle className="size-4" />}>
                        安装
                    </Button>
                </div>

                <div className="thin-scrollbar max-h-[46vh] space-y-2 overflow-auto">
                    {plugins.length === 0 ? (
                        <div className="py-10 text-center text-sm" style={{ color: theme.node.muted }}>
                            还没有安装任何插件
                        </div>
                    ) : (
                        plugins.map((record) => (
                            <div key={record.id} className="flex items-center gap-3 rounded-xl border px-3 py-2.5" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                                <span className="grid size-9 shrink-0 place-items-center rounded-lg" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }}>
                                    <Puzzle className="size-4" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 text-sm font-medium" style={{ color: theme.node.text }}>
                                        <span className="truncate">{record.name}</span>
                                        <span className="rounded-full px-1.5 py-0.5 text-[10px]" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }}>
                                            v{record.version}
                                        </span>
                                        {record.local && (
                                            <span className="rounded-full px-1.5 py-0.5 text-[10px]" style={{ background: "#22c55e22", color: "#16a34a" }}>
                                                本地
                                            </span>
                                        )}
                                    </div>
                                    <div className="truncate text-xs" style={{ color: theme.node.muted }}>
                                        {record.description || record.url}
                                    </div>
                                </div>
                                <Switch
                                    size="small"
                                    checked={record.enabled}
                                    loading={busyId === record.id}
                                    onChange={(checked) => runOnPlugin(record, () => setPluginEnabled(record, checked), checked ? "已启用" : "已禁用")}
                                />
                                {!record.local && (
                                    <>
                                        <Button type="text" size="small" icon={<RefreshCw className="size-4" />} loading={busyId === record.id} title="从来源更新" onClick={() => runOnPlugin(record, async () => void (await updatePlugin(record)), "已更新")} />
                                        <Popconfirm title="卸载该插件？" okText="卸载" cancelText="取消" onConfirm={() => uninstallPlugin(record.id)}>
                                            <Button type="text" size="small" danger icon={<Trash2 className="size-4" />} title="卸载" />
                                        </Popconfirm>
                                    </>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </Modal>
    );
}
