import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { App, Button, Input, Modal, theme } from "antd";
import { Trash2, WandSparkles, X } from "lucide-react";
import { nanoid } from "nanoid";

import { requestEdit } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { compileCandidateEdit, type AnnotatePin } from "@/lib/canvas/annotate-prompt";
import type { PptGenerationModule } from "@/lib/ppt/generation-execution";
import { createPptCandidateEditPlan } from "@/lib/ppt/generation-plan";
import { isPptControlledNode } from "@/lib/ppt/generation-ledger";
import { buildPptPageWorkspace } from "@/lib/ppt/page-workspace";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAnnotateStore } from "@/stores/use-annotate-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { buildImageGenerationMetadata } from "@/lib/canvas/canvas-node-factory";
import { persistImageTaskToStore } from "@/pages/canvas/use-canvas-image-tasks";
import { CanvasNodeType, type PptCandidateEditSnapshot } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

// 二开：PPT Annotate 宿主组件（方案 B，用户拍板 2026-07-15，见任务 design.md §1）。
// 自持状态 + 自走生成路径，不侵入 project.tsx 的 8 触点老范式（照抄蒙版对话框会把 project.tsx 从 2 触点炸到 9）。

function loadImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("读取图片失败"));
        image.src = dataUrl;
    });
}

// 气泡渲染参数照搬 research/annotate_exp.py 的 make_marked()（已实测验证有效，不要乱改）。
function drawMarkedImage(image: HTMLImageElement, pins: AnnotatePin[]) {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const radius = Math.max(18, canvas.width / 46);
    pins.forEach((pin, index) => {
        const x = pin.x * canvas.width;
        const y = pin.y * canvas.height;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = "rgb(220, 30, 30)";
        context.fill();
        context.lineWidth = Math.max(2, radius / 7);
        context.strokeStyle = "#fff";
        context.stroke();
        context.fillStyle = "#fff";
        context.font = `bold ${Math.round(radius * 1.15)}px sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(String(index + 1), x, y);
    });
    return canvas.toDataURL("image/png");
}

function CandidateEditSummary({ snapshot }: { snapshot: PptCandidateEditSnapshot }) {
    const { token } = theme.useToken();
    return (
        <div className="space-y-2 rounded-lg border p-3 text-xs" style={{ borderColor: token.colorBorderSecondary }}>
            <div className="font-medium">修改清单</div>
            {snapshot.globalInstruction ? (
                <div>
                    <span className="font-medium">整页：</span>
                    <span className="whitespace-pre-wrap">{snapshot.globalInstruction}</span>
                </div>
            ) : null}
            {snapshot.annotations.map((annotation) => (
                <div key={annotation.index}>
                    <span className="font-medium">点位 {annotation.index}：</span>
                    <span>{annotation.instruction}</span>
                </div>
            ))}
            <details>
                <summary className="cursor-pointer font-medium">查看最终提示词</summary>
                <pre className="thin-scrollbar mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-md p-2 leading-5" style={{ background: token.colorFillTertiary }}>
                    {snapshot.finalPrompt}
                </pre>
            </details>
        </div>
    );
}

export function CanvasNodeAnnotateDialog({ pptGenerationModule }: { pptGenerationModule?: PptGenerationModule }) {
    const { message, modal } = App.useApp();
    const { token } = theme.useToken();
    const annotateNodeId = useAnnotateStore((state) => state.annotateNodeId);
    const close = useAnnotateStore((state) => state.close);
    const canvasContext = useAgentStore((state) => state.canvasContext);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    const node = useMemo(() => (annotateNodeId ? (canvasContext?.snapshot.nodes.find((item) => item.id === annotateNodeId) ?? null) : null), [annotateNodeId, canvasContext?.snapshot.nodes]);
    const dataUrl = node?.metadata?.content;
    const open = Boolean(annotateNodeId && node && dataUrl);

    const [globalInstruction, setGlobalInstruction] = useState("");
    const [pins, setPins] = useState<AnnotatePin[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const candidateEdit = useMemo(() => (node ? compileCandidateEdit(node.id, globalInstruction, pins) : null), [globalInstruction, node, pins]);
    const pinSubmissionNumbers = useMemo(() => {
        let next = 0;
        return new Map(pins.map((pin) => [pin.id, pin.text.trim() ? ++next : undefined]));
    }, [pins]);

    // 节点被删除或没有图片内容 → 自动关闭，避免对话框卡在无效状态。
    useEffect(() => {
        if (annotateNodeId && (!node || !dataUrl)) close();
    }, [annotateNodeId, node, dataUrl, close]);

    useEffect(() => {
        if (!open) return;
        setGlobalInstruction("");
        setPins([]);
        setSubmitting(false);
    }, [dataUrl, open]);

    const addPin = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (submitting) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - rect.left) / Math.max(1, rect.width);
        const y = (event.clientY - rect.top) / Math.max(1, rect.height);
        setPins((prev) => [...prev, { id: nanoid(), x, y, text: "" }]);
    };

    const updatePinText = (id: string, text: string) => setPins((prev) => prev.map((pin) => (pin.id === id ? { ...pin, text } : pin)));
    const removePin = (id: string) => setPins((prev) => prev.filter((pin) => pin.id !== id));
    const clearPins = () => setPins([]);

    const handleClose = () => {
        if (submitting) return;
        close();
    };

    const submitPrepared = async ({
        snapshot,
        reference,
        source,
        generationConfig,
        plan,
    }: {
        snapshot: PptCandidateEditSnapshot;
        reference: ReferenceImage;
        source: ReferenceImage;
        generationConfig: ReturnType<typeof buildGenerationConfig>;
        plan?: ReturnType<typeof createPptCandidateEditPlan>;
    }) => {
        if (!node || !canvasContext) return;
        setSubmitting(true);
        try {
            if (plan) {
                if (!pptGenerationModule) return;
                try {
                    const result = await pptGenerationModule.startCandidateEdit(plan);
                    void result.settled.catch((error) => message.error(error instanceof Error ? error.message : "修改稿状态保存失败"));
                    close();
                    message.info("已开始生成 1 张修改稿");
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "修改稿启动失败");
                }
                return;
            }
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
            const childId = nanoid();

            canvasContext.applyOps([
                {
                    type: "add_node",
                    id: childId,
                    nodeType: CanvasNodeType.Image,
                    title: "修改稿",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { prompt: snapshot.finalPrompt, status: "loading", ...generationMetadata },
                },
                { type: "connect_nodes", fromNodeId: node.id, toNodeId: childId },
            ]);
            close();

            try {
                const generated = await requestEdit(generationConfig, snapshot.finalPrompt, [reference], undefined, {
                    // [二开] maolao 异步渠道：任务创建后立刻落盘句柄，否则此刻刷新就再也找不回
                    // 远端任务（已计费）。applyOps 同步 UI state，persistImageTaskToStore 立即写盘。
                    onTaskCreated: async (handle) => {
                        canvasContext.applyOps([{ type: "update_node", id: childId, metadata: { imageTask: { taskId: handle.taskId, model: generationConfig.model, expiresAt: handle.expiresAt } } }]);
                        await persistImageTaskToStore(canvasContext.snapshot.projectId, childId, handle, generationConfig.model);
                    },
                }).then((items) => items[0]);
                const uploaded = await uploadImage(generated.dataUrl);
                const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                canvasContext.applyOps([
                    {
                        type: "update_node",
                        id: childId,
                        patch: { width: size.width, height: size.height },
                        metadata: {
                            content: uploaded.url,
                            storageKey: uploaded.storageKey,
                            status: "success",
                            naturalWidth: uploaded.width,
                            naturalHeight: uploaded.height,
                            bytes: uploaded.bytes,
                            mimeType: uploaded.mimeType,
                            prompt: snapshot.finalPrompt,
                            ...generationMetadata,
                            // 图已落地，任务句柄失去意义；不置空会在下次加载时被误当作待恢复任务。
                            imageTask: undefined,
                        },
                    },
                ]);
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "修改稿生成失败";
                message.error(errorDetails);
                canvasContext.applyOps([{ type: "update_node", id: childId, metadata: { status: "error", errorDetails, imageTask: undefined } }]);
            }
        } finally {
            setSubmitting(false);
        }
    };

    const confirmSubmit = async () => {
        if (!node || !dataUrl || !canvasContext || !candidateEdit) {
            message.warning("请填写整页要求或至少一个点位要求");
            return;
        }
        const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1", size: node.metadata?.size || "auto" };
        if (!isAiConfigReady(generationConfig, generationConfig.model)) {
            openConfigDialog(true);
            return;
        }
        setSubmitting(true);
        try {
            const validPins = pins.filter((pin) => pin.text.trim());
            const source: ReferenceImage = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata?.mimeType || "image/png", dataUrl, storageKey: node.metadata?.storageKey };
            let reference = source;
            if (validPins.length) {
                const markedDataUrl = drawMarkedImage(await loadImage(dataUrl), validPins);
                if (!markedDataUrl) {
                    message.error("点位渲染失败");
                    return;
                }
                reference = { id: `${node.id}-annotate`, name: "annotate.png", type: "image/png", dataUrl: markedDataUrl };
            }
            const project = useCanvasStore.getState().projects.find((item) => item.id === canvasContext.snapshot.projectId);
            const page = project?.ppt?.pages.find((item) => item.pageId === node.metadata?.pptPageId);
            const take = project && page ? buildPptPageWorkspace(project, page).takes.find((item) => item.takeId === node.metadata?.pptTakeId) : undefined;
            const isPptCandidate = Boolean(take?.candidates.some((item) => item.id === node.id));
            if (isPptControlledNode(node) && !isPptCandidate) {
                message.warning("PPT 共享素材请在 PPT 工作台中调整，不能从结构画布直接改图");
                return;
            }
            if (isPptCandidate && (!pptGenerationModule || !project || !page || !take)) {
                message.error("PPT 修改稿暂时无法建立可靠生成记录");
                return;
            }
            const plan = isPptCandidate ? createPptCandidateEditPlan({ project: project!, effectiveConfig, pageId: page!.pageId, takeId: take!.takeId, sourceNodeId: node.id, candidateEdit, reference }) : undefined;
            const repeatBillingRisk = Boolean(take?.requiresRepeatBillingConfirmation);
            modal.confirm({
                title: repeatBillingRisk ? "仍要生成修改稿？" : "生成修改稿？",
                content: (
                    <div className="space-y-3">
                        <p>{repeatBillingRisk ? "上一次请求可能已经产生费用且结果无法取回。本次可能重复计费；旧运行、基图和候选稿都会保留。" : "基图和已确认最终版不会改变，新结果会追加为候选稿。"}</p>
                        <div className="text-sm opacity-70">将生成 1 张修改稿 · 1 次图生图 API 调用</div>
                        <CandidateEditSummary snapshot={candidateEdit} />
                    </div>
                ),
                okText: "生成修改稿",
                cancelText: "取消",
                width: 680,
                onOk: () => submitPrepared({ snapshot: candidateEdit, reference, source, generationConfig, plan }),
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "修改稿准备失败");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal title="按要求改图" classNames={{ header: "sr-only" }} open={open} onCancel={handleClose} footer={null} width="min(96vw, 1600px)" centered destroyOnHidden>
            {node && dataUrl ? (
                <div className="grid max-h-[82vh] min-h-0 gap-5 overflow-y-auto lg:h-[min(82vh,900px)] lg:grid-cols-[minmax(0,1fr)_420px] lg:overflow-hidden" data-canvas-no-zoom onKeyDown={(event) => event.stopPropagation()}>
                    <div className="flex min-h-[320px] min-w-0 items-center justify-center overflow-hidden rounded-xl border bg-transparent lg:min-h-0" style={{ borderColor: token.colorBorderSecondary }}>
                        <div className="relative inline-block max-w-full cursor-crosshair select-none overflow-hidden rounded-lg bg-transparent" onClick={addPin}>
                            <img src={dataUrl} alt="待标注原图" className="block max-w-full bg-transparent object-contain" style={{ maxHeight: "min(78vh, 860px)" }} draggable={false} />
                            {pins.map((pin, index) => {
                                const submissionNumber = pinSubmissionNumbers.get(pin.id);
                                const label = submissionNumber ? `提交点位 ${submissionNumber}` : `未填写点位 ${index + 1}，提交时将忽略`;
                                return (
                                    <div
                                        key={pin.id}
                                        className="absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white text-xs font-bold text-white shadow"
                                        style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%`, background: "rgb(220, 30, 30)" }}
                                        onClick={(event) => event.stopPropagation()}
                                        role="img"
                                        aria-label={label}
                                        title={label}
                                    >
                                        {submissionNumber ?? "–"}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div className="flex min-h-[320px] min-w-0 flex-col gap-4 lg:min-h-0">
                        <div>
                            <h2 className="text-xl font-semibold">按要求改图</h2>
                            <div className="mt-2 text-sm opacity-60">先写整页要求；需要指向具体位置时，再点击左侧图片添加点位</div>
                        </div>

                        <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium">整页要求</span>
                                <Button type="text" size="small" disabled={submitting || !globalInstruction} onClick={() => setGlobalInstruction("")}>
                                    清除文字
                                </Button>
                            </div>
                            <Input.TextArea value={globalInstruction} disabled={submitting} autoSize={{ minRows: 3, maxRows: 5 }} placeholder="描述这张页面要怎么改" onChange={(event) => setGlobalInstruction(event.target.value)} />
                        </div>

                        <div className="flex min-h-0 flex-1 flex-col gap-2">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium">点位要求（可选）</span>
                                <Button type="text" size="small" disabled={submitting || !pins.length} onClick={clearPins}>
                                    清除点位
                                </Button>
                            </div>
                            <div className="thin-scrollbar min-h-[72px] flex-1 space-y-2 overflow-y-auto pr-1 lg:min-h-0">
                                {pins.length === 0 ? <div className="text-sm opacity-50">不添加点位也可以直接生成修改稿</div> : null}
                                {pins.map((pin, index) => {
                                    const submissionNumber = pinSubmissionNumbers.get(pin.id);
                                    return (
                                        <div key={pin.id} className="flex items-center gap-2">
                                            <span
                                                className="grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold text-white"
                                                style={{ background: "rgb(220, 30, 30)" }}
                                                title={submissionNumber ? `提交点位 ${submissionNumber}` : "未填写将在提交时忽略"}
                                            >
                                                {submissionNumber ?? "–"}
                                            </span>
                                            <Input aria-label={`放置点位 ${index + 1} 的修改内容`} placeholder="未填写将忽略" value={pin.text} disabled={submitting} onChange={(event) => updatePinText(pin.id, event.target.value)} />
                                            <Button type="text" aria-label={`删除放置点位 ${index + 1}`} title={`删除放置点位 ${index + 1}`} disabled={submitting} icon={<Trash2 className="size-4" />} onClick={() => removePin(pin.id)} />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {candidateEdit ? <CandidateEditSummary snapshot={candidateEdit} /> : <div className="rounded-lg border border-dashed p-3 text-xs opacity-50">填写整页要求或点位要求后，可在这里查看修改清单和最终提示词</div>}

                        <div className="mt-auto flex items-center justify-between gap-2">
                            <span className="text-xs opacity-60">1 张修改稿 · 1 次图生图 API</span>
                            <div className="flex items-center gap-2">
                                <Button icon={<X className="size-4" />} disabled={submitting} onClick={handleClose}>
                                    取消
                                </Button>
                                <Button type="primary" loading={submitting} disabled={!candidateEdit} icon={<WandSparkles className="size-4" />} onClick={() => void confirmSubmit()}>
                                    生成修改稿
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
