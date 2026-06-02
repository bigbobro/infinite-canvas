"use client";

import { App, Button, Form, Input, Modal, Segmented } from "antd";
import { useState } from "react";

import { ModelPicker } from "@/components/model-picker";
import { fetchImageModels } from "@/services/api/image";
import { filterModelsByCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";

export function AppConfigModal() {
    const { message } = App.useApp();
    const [loadingModels, setLoadingModels] = useState(false);
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const effectiveConfig = useEffectiveConfig();
    const modelChannel = publicSettings?.modelChannel;
    const allowCustomChannel = modelChannel?.allowCustomChannel === true;
    const effectiveMode = allowCustomChannel ? config.channelMode : "remote";
    const modelConfig = effectiveMode === "remote" ? effectiveConfig : config;

    const finishConfig = () => {
        setConfigDialogOpen(false);
        if (effectiveMode === "local" && (!config.baseUrl.trim() || !config.apiKey.trim())) return;
        if (!modelConfig.imageModel.trim() || !modelConfig.videoModel.trim() || !modelConfig.textModel.trim()) return;
        if (!allowCustomChannel && config.channelMode !== "remote") updateConfig("channelMode", "remote");
        message.success(shouldPromptContinue ? "配置已保存，请继续刚才的请求" : "配置已保存");
        clearPromptContinue();
    };

    const refreshModels = async () => {
        if (effectiveMode === "remote") return;
        if (!config.baseUrl.trim() || !config.apiKey.trim()) {
            message.error("请先填写 Base URL 和 API Key");
            return;
        }
        setLoadingModels(true);
        try {
            const models = await fetchImageModels(config);
            const imageModels = filterModelsByCapability(models, "image");
            const videoModels = filterModelsByCapability(models, "video");
            const textModels = filterModelsByCapability(models, "text");
            updateConfig("models", models);
            if (imageModels.length && !imageModels.includes(config.imageModel)) updateConfig("imageModel", imageModels[0]);
            if (videoModels.length && !videoModels.includes(config.videoModel)) updateConfig("videoModel", videoModels[0]);
            if (textModels.length && !textModels.includes(config.textModel)) updateConfig("textModel", textModels[0]);
            message.success("模型列表已更新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingModels(false);
        }
    };

    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">配置</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">模型和密钥</div>
                </div>
            }
            open={isConfigOpen}
            width={760}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            footer={
                <Button type="primary" onClick={finishConfig}>
                    完成
                </Button>
            }
        >
            <div className="pt-1">
                <Form layout="vertical" requiredMark={false}>
                    {allowCustomChannel ? (
                        <Form.Item label="渠道模式" className="mb-4">
                            <Segmented
                                block
                                size="middle"
                                value={effectiveMode}
                                onChange={(value) => updateConfig("channelMode", value as AiConfig["channelMode"])}
                                options={[
                                    { label: "本地直连", value: "local" },
                                    { label: "云端渠道", value: "remote" },
                                ]}
                            />
                        </Form.Item>
                    ) : null}
                    {effectiveMode === "local" ? (
                        <>
                            <div className="grid gap-4 md:grid-cols-2">
                                <Form.Item label="Base URL" className="mb-4">
                                    <Input value={config.baseUrl} onChange={(event) => updateConfig("baseUrl", event.target.value)} />
                                </Form.Item>
                                <Form.Item label="API Key" className="mb-4">
                                    <Input.Password value={config.apiKey} onChange={(event) => updateConfig("apiKey", event.target.value)} />
                                </Form.Item>
                            </div>
                            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">模型列表</div>
                                    <div className="mt-1 text-xs text-stone-500">当前已保存 {config.models.length} 个模型</div>
                                </div>
                                <Button size="small" loading={loadingModels} onClick={() => void refreshModels()}>
                                    拉取模型列表
                                </Button>
                            </div>
                        </>
                    ) : (
                        <div className="mb-4 rounded-lg border border-stone-200 p-3 text-sm text-stone-500 dark:border-stone-800">
                            <div className="font-medium text-stone-900 dark:text-stone-100">云端渠道</div>
                            <div className="mt-1">由系统后台渠道转发请求，当前可用 {modelChannel?.availableModels.length || 0} 个模型。</div>
                        </div>
                    )}
                    <div className="grid gap-4 md:grid-cols-3">
                        <Form.Item label="默认生图模型" className="mb-4">
                            <ModelPicker config={modelConfig} value={modelConfig.imageModel} onChange={(model) => updateConfig("imageModel", model)} capability="image" fullWidth />
                        </Form.Item>
                        <Form.Item label="默认视频模型" className="mb-4">
                            <ModelPicker config={modelConfig} value={modelConfig.videoModel} onChange={(model) => updateConfig("videoModel", model)} capability="video" fullWidth />
                        </Form.Item>
                        <Form.Item label="默认文本模型" className="mb-4">
                            <ModelPicker config={modelConfig} value={modelConfig.textModel} onChange={(model) => updateConfig("textModel", model)} capability="text" fullWidth />
                        </Form.Item>
                    </div>
                    <div className="grid gap-4 md:grid-cols-3">
                        <Form.Item label="画布默认生图张数" extra="新建画布生图和配置节点默认使用，单个节点仍可单独覆盖。" className="mb-4">
                            <Input
                                type="number"
                                min={1}
                                max={15}
                                value={config.canvasImageCount}
                                onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                            />
                        </Form.Item>
                    </div>
                    {effectiveMode === "local" ? (
                        <Form.Item label="系统提示词" className="mb-0">
                            <Input.TextArea rows={3} value={config.systemPrompt} placeholder="例如：你是一位擅长电影感写实摄影的视觉导演。" onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                        </Form.Item>
                    ) : null}
                </Form>
            </div>
        </Modal>
    );
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}
