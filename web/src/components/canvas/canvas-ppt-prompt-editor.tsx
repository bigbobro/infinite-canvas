import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Input, Modal } from "antd";
import { LoaderCircle, RotateCcw, Sparkles, Square, WandSparkles } from "lucide-react";

import { auditPptPageCopyReadiness, type PptPageRewriteSpec } from "@/lib/ppt/content-plan";
import { requestImageQuestion } from "@/services/api/image";
import { buildPptPageRewriteMessages, requirePptPageRewriteResult } from "@/services/api/ppt-content";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

type Props = {
    open: boolean;
    initialValue: string;
    lockedTake: boolean;
    textModelReady: boolean;
    contentForm?: string;
    onSave: (value: string, rewrite?: PptPageRewriteSpec) => void;
    onSaveAndGenerate: (value: string, rewrite?: PptPageRewriteSpec) => void;
    onCancel: () => void;
};

const CONTENT_FORM_LABELS: Record<PptPageRewriteSpec["contentForm"], string> = {
    cover: "封面页",
    comparison: "对比页",
    architecture: "架构页",
    process: "流程页",
    timeline: "时间线",
    data: "数据页",
    narrative: "内容页",
    closing: "收尾页",
};

export function CanvasPptPromptEditor({ open, initialValue, lockedTake, textModelReady, contentForm, onSave, onSaveAndGenerate, onCancel }: Props) {
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const [editorDraft, setEditorDraft] = useState(initialValue);
    const [instruction, setInstruction] = useState("");
    const [undoDraft, setUndoDraft] = useState<string>();
    const [structuredRewrite, setStructuredRewrite] = useState<PptPageRewriteSpec>();
    const [aiRunning, setAiRunning] = useState(false);
    const [errorDetails, setErrorDetails] = useState("");
    const requestTokenRef = useRef(0);
    const controllerRef = useRef<AbortController | null>(null);
    const editorChanged = editorDraft !== initialValue || Boolean(structuredRewrite);
    const copyReadinessIssues = auditPptPageCopyReadiness(editorDraft);

    useEffect(() => {
        if (open) {
            controllerRef.current?.abort();
            requestTokenRef.current += 1;
            controllerRef.current = null;
            setEditorDraft(initialValue);
            setInstruction("");
            setUndoDraft(undefined);
            setStructuredRewrite(undefined);
            setAiRunning(false);
            setErrorDetails("");
        } else {
            controllerRef.current?.abort();
            requestTokenRef.current += 1;
            controllerRef.current = null;
            setAiRunning(false);
        }
    }, [open]);

    useEffect(
        () => () => {
            controllerRef.current?.abort();
            requestTokenRef.current += 1;
        },
        [],
    );

    const invalidateAiRequest = () => {
        controllerRef.current?.abort();
        controllerRef.current = null;
        requestTokenRef.current += 1;
        setAiRunning(false);
    };

    const updateDraft = (value: string) => {
        if (aiRunning) invalidateAiRequest();
        setEditorDraft(value);
        setStructuredRewrite(undefined);
        setErrorDetails("");
    };

    const updateInstruction = (value: string) => {
        if (aiRunning) invalidateAiRequest();
        setInstruction(value);
        setErrorDetails("");
    };

    const rewriteWithAi = async () => {
        if (controllerRef.current || !textModelReady || !editorDraft.trim() || !instruction.trim()) return;
        const controller = new AbortController();
        controllerRef.current = controller;
        const token = requestTokenRef.current + 1;
        requestTokenRef.current = token;
        const beforeRewrite = editorDraft;
        setAiRunning(true);
        setErrorDetails("");
        const messages = buildPptPageRewriteMessages(beforeRewrite, instruction, contentForm);
        try {
            // requestImageQuestion 优先读 config.model，必须显式覆盖为文本模型。
            const requestConfig = { ...effectiveConfig, model: effectiveConfig.textModel || effectiveConfig.model };
            const answer = await requestImageQuestion(requestConfig, messages, () => undefined, { signal: controller.signal });
            if (controller.signal.aborted || requestTokenRef.current !== token) return;
            const rewritten = requirePptPageRewriteResult(answer);
            setUndoDraft(beforeRewrite);
            setStructuredRewrite(rewritten);
            setEditorDraft(rewritten.canonicalText);
            setInstruction("");
        } catch (error) {
            if (controller.signal.aborted || requestTokenRef.current !== token) return;
            setErrorDetails(error instanceof Error ? error.message : "AI 改写失败，请重试");
        } finally {
            if (requestTokenRef.current === token) {
                controllerRef.current = null;
                setAiRunning(false);
            }
        }
    };

    const closeEditor = () => {
        invalidateAiRequest();
        onCancel();
    };

    const commit = (saveAndGenerate: boolean) => {
        if (!editorDraft.trim()) {
            message.warning("方案提示词不能为空");
            return;
        }
        invalidateAiRequest();
        const rewrite = structuredRewrite?.canonicalText === editorDraft ? structuredRewrite : undefined;
        if (saveAndGenerate) onSaveAndGenerate(editorDraft, rewrite);
        else onSave(editorDraft, rewrite);
    };

    return (
        <Modal title={lockedTake ? "调整提示词并派生新方案" : "调整方案提示词"} open={open} onCancel={closeEditor} footer={null} width="min(88vw, 1280px)" centered destroyOnHidden maskClosable={false}>
            <div className="space-y-4">
                <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">页面规格</span>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                            {editorDraft.split("\n").length} 行 · {editorDraft.length} 字
                        </span>
                    </div>
                    <Input.TextArea
                        className="thin-scrollbar !h-[min(60vh,720px)] !resize-none overflow-y-auto font-mono text-sm leading-6"
                        style={{ maxHeight: "max(240px, calc(100dvh - 300px))" }}
                        value={editorDraft}
                        placeholder="填写这一方案的页面规格"
                        aria-label="方案页面规格"
                        onChange={(event) => updateDraft(event.target.value)}
                    />
                    {copyReadinessIssues.length ? <Alert className="mt-3" type="warning" showIcon message="当前文案不适合直接生图" description={copyReadinessIssues.map((issue) => issue.message).join("；")} /> : null}
                    {structuredRewrite ? (
                        <div className="mt-2 text-xs text-muted-foreground" role="status">
                            AI 结构：{CONTENT_FORM_LABELS[structuredRewrite.contentForm]} · {structuredRewrite.blocks.length} 个内容块 · {structuredRewrite.visualEncoding.length} 条信息表达
                        </div>
                    ) : null}
                </div>

                <div className="rounded-xl border border-border/70 bg-muted/35 p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-sm font-medium">
                            <WandSparkles className="size-4" aria-hidden="true" />
                            AI 辅助
                        </div>
                        <Button
                            size="small"
                            type="text"
                            icon={<RotateCcw className="size-3.5" />}
                            disabled={undoDraft === undefined || aiRunning}
                            onClick={() => {
                                invalidateAiRequest();
                                setEditorDraft(undoDraft || "");
                                setUndoDraft(undefined);
                                setStructuredRewrite(undefined);
                                setErrorDetails("");
                            }}
                        >
                            撤销上次 AI 改写
                        </Button>
                    </div>
                    <div className="flex items-center gap-2">
                        <Input
                            value={instruction}
                            disabled={!textModelReady}
                            placeholder={textModelReady ? "例如：压缩长段落，整理成四个 PPT 信息块" : "先在配置中设置文本模型"}
                            onChange={(event) => updateInstruction(event.target.value)}
                            onPressEnter={() => void rewriteWithAi()}
                        />
                        {aiRunning ? (
                            <Button danger icon={<Square className="size-3.5 fill-current" />} onClick={invalidateAiRequest}>
                                取消改写
                            </Button>
                        ) : (
                            <Button type="primary" icon={<Sparkles className="size-3.5" />} disabled={!textModelReady || !instruction.trim() || !editorDraft.trim()} onClick={() => void rewriteWithAi()}>
                                AI 改写
                            </Button>
                        )}
                    </div>
                    {!textModelReady ? (
                        <button type="button" className="mt-2 text-xs font-medium underline underline-offset-2" onClick={() => openConfigDialog(true)}>
                            先在配置中设置文本模型
                        </button>
                    ) : aiRunning ? (
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                            正在改写；你仍可手动编辑，输入后本次请求会立即取消
                        </div>
                    ) : null}
                    {errorDetails ? <Alert className="mt-3" type="error" showIcon message="AI 改写失败" description={errorDetails} /> : null}
                </div>

                <div className="flex justify-end gap-2 border-t pt-4">
                    <Button onClick={closeEditor}>取消</Button>
                    {lockedTake ? (
                        <>
                            <Button disabled={!editorDraft.trim() || !editorChanged} onClick={() => commit(false)}>
                                保存为新方案
                            </Button>
                            <Button type="primary" icon={<Sparkles className="size-4" />} disabled={!editorDraft.trim() || !editorChanged} onClick={() => commit(true)}>
                                保存并生成新方案
                            </Button>
                        </>
                    ) : (
                        <Button type="primary" disabled={!editorDraft.trim() || !editorChanged} onClick={() => commit(false)}>
                            保存
                        </Button>
                    )}
                </div>
            </div>
        </Modal>
    );
}
