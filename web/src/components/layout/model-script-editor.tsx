import { Button, Input, Modal } from "antd";
import { useEffect, useState } from "react";

import { PLUGIN_TEMPLATES } from "@/services/api/model-plugin";
import type { ModelCapability } from "@/stores/use-config-store";

const capabilityLabels: Record<ModelCapability, string> = { image: "生图", video: "视频", text: "文本", audio: "音频" };

const variableHints = [
    "input：本次请求的归一化输入（prompt / references / messages / params / body）",
    "config：{ baseUrl, apiKey, model, apiFormat, systemPrompt }",
    "http：{ url(path), post(path, body, opts), get(path, opts) }，已绑定当前渠道",
    "poll(request, extract, { intervalMs, timeoutMs })：轮询直到 extract 返回真值",
    "sleep(ms)、signal：延时与取消信号；onDelta(text)：推送流式文本（文本模型）",
];

export function ModelScriptEditor({ open, capability, modelName, value, onSave, onClose }: { open: boolean; capability: ModelCapability; modelName: string; value: string; onSave: (script: string) => void; onClose: () => void }) {
    const [draft, setDraft] = useState(value);
    useEffect(() => {
        if (open) setDraft(value);
    }, [open, value]);

    return (
        <Modal
            open={open}
            title={
                <div>
                    <div className="text-base font-semibold">调用脚本 · {modelName}</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">当前能力：{capabilityLabels[capability]}。留空则使用系统默认调用方式。</div>
                </div>
            }
            width={720}
            centered
            onCancel={onClose}
            styles={{ body: { maxHeight: "64vh", overflowY: "auto" } }}
            footer={[
                <Button key="template" onClick={() => setDraft(PLUGIN_TEMPLATES[capability])}>
                    插入模板
                </Button>,
                <Button key="reset" danger onClick={() => setDraft("")}>
                    恢复默认调用
                </Button>,
                <Button key="cancel" onClick={onClose}>
                    取消
                </Button>,
                <Button
                    key="save"
                    type="primary"
                    onClick={() => {
                        onSave(draft.trim());
                        onClose();
                    }}
                >
                    保存
                </Button>,
            ]}
        >
            <div className="mb-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-xs leading-6 text-stone-600 dark:border-stone-800 dark:bg-stone-900/40 dark:text-stone-300">
                <div className="mb-1 font-semibold">可用变量（异步函数体，需 return 结果）</div>
                {variableHints.map((hint) => (
                    <div key={hint}>· {hint}</div>
                ))}
            </div>
            <Input.TextArea value={draft} onChange={(event) => setDraft(event.target.value)} autoSize={{ minRows: 12, maxRows: 24 }} spellCheck={false} placeholder="留空使用系统默认调用；点击“插入模板”查看示例。" style={{ fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)", fontSize: 12 }} />
        </Modal>
    );
}
