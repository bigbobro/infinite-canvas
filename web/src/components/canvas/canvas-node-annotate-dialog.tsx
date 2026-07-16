import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { App, Button, Input, Modal } from "antd";
import { RotateCcw, Trash2, WandSparkles, X } from "lucide-react";
import { nanoid } from "nanoid";

import { requestEdit } from "@/services/api/image";
import { uploadImage } from "@/services/image-storage";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { buildAnnotatePrompt, type AnnotatePin } from "@/lib/canvas/annotate-prompt";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAnnotateStore } from "@/stores/use-annotate-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { buildGenerationConfig, buildImageGenerationMetadata } from "@/pages/canvas/project";
import { CanvasNodeType } from "@/types/canvas";
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

export function CanvasNodeAnnotateDialog() {
    const { message } = App.useApp();
    const annotateNodeId = useAnnotateStore((state) => state.annotateNodeId);
    const close = useAnnotateStore((state) => state.close);
    const canvasContext = useAgentStore((state) => state.canvasContext);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    const node = useMemo(() => (annotateNodeId ? (canvasContext?.snapshot.nodes.find((item) => item.id === annotateNodeId) ?? null) : null), [annotateNodeId, canvasContext?.snapshot.nodes]);
    const dataUrl = node?.metadata?.content;
    const open = Boolean(annotateNodeId && node && dataUrl);

    const [pins, setPins] = useState<AnnotatePin[]>([]);
    const [submitting, setSubmitting] = useState(false);

    // 节点被删除或没有图片内容 → 自动关闭，避免对话框卡在无效状态。
    useEffect(() => {
        if (annotateNodeId && (!node || !dataUrl)) close();
    }, [annotateNodeId, node, dataUrl, close]);

    useEffect(() => {
        if (!open) return;
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

    const submit = async () => {
        if (!node || !dataUrl || !canvasContext) return;
        const validPins = pins.filter((pin) => pin.text.trim());
        if (!validPins.length) {
            message.warning("请至少填写一个标记的修改内容");
            return;
        }
        const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1", size: node.metadata?.size || "auto" };
        if (!isAiConfigReady(generationConfig, generationConfig.model)) {
            openConfigDialog(true);
            return;
        }
        setSubmitting(true);
        try {
            const sourceImage = await loadImage(dataUrl);
            const markedDataUrl = drawMarkedImage(sourceImage, validPins);
            if (!markedDataUrl) {
                message.error("标记渲染失败");
                return;
            }
            const skipped = pins.length - validPins.length;
            const prompt = buildAnnotatePrompt(validPins);
            const source: ReferenceImage = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata?.mimeType || "image/png", dataUrl, storageKey: node.metadata?.storageKey };
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
            const childId = nanoid();

            canvasContext.applyOps([
                {
                    type: "add_node",
                    id: childId,
                    nodeType: CanvasNodeType.Image,
                    title: "标注改图结果",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { prompt, status: "loading", ...generationMetadata },
                },
                { type: "connect_nodes", fromNodeId: node.id, toNodeId: childId },
            ]);
            close();
            if (skipped > 0) message.info(`已忽略 ${skipped} 个未填写的标记`);

            const markedReference: ReferenceImage = { id: `${node.id}-annotate`, name: "annotate.png", type: "image/png", dataUrl: markedDataUrl };
            try {
                const generated = await requestEdit(generationConfig, prompt, [markedReference], undefined).then((items) => items[0]);
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
                            prompt,
                            ...generationMetadata,
                        },
                    },
                ]);
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "标注改图失败";
                message.error(errorDetails);
                canvasContext.applyOps([{ type: "update_node", id: childId, metadata: { status: "error", errorDetails } }]);
            }
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal title={null} open={open} onCancel={handleClose} footer={null} width={980} centered destroyOnHidden>
            {node && dataUrl ? (
                <div className="grid gap-5 lg:grid-cols-[minmax(360px,1fr)_320px]">
                    <div className="flex min-h-[360px] items-center justify-center rounded-xl border border-black/10 bg-transparent p-0 dark:border-white/10">
                        <div className="relative inline-block max-w-full cursor-crosshair select-none overflow-hidden rounded-lg bg-transparent" onClick={addPin}>
                            <img src={dataUrl} alt="" className="block max-h-[68vh] max-w-full bg-transparent" draggable={false} />
                            {pins.map((pin, index) => (
                                <div
                                    key={pin.id}
                                    className="absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white text-xs font-bold text-white shadow"
                                    style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%`, background: "rgb(220, 30, 30)" }}
                                    onClick={(event) => event.stopPropagation()}
                                >
                                    {index + 1}
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="flex min-h-[360px] flex-col gap-4">
                        <div>
                            <h2 className="text-xl font-semibold">标注改图</h2>
                            <div className="mt-2 text-sm opacity-60">点击左侧图片放置标记，逐点填写修改内容，可放多个一次提交</div>
                        </div>

                        <div className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto">
                            {pins.length === 0 ? <div className="text-sm opacity-50">在左侧图片上点击以放置标记</div> : null}
                            {pins.map((pin, index) => (
                                <div key={pin.id} className="flex items-center gap-2">
                                    <span className="grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold text-white" style={{ background: "rgb(220, 30, 30)" }}>
                                        {index + 1}
                                    </span>
                                    <Input placeholder="改成什么" value={pin.text} disabled={submitting} onChange={(event) => updatePinText(pin.id, event.target.value)} />
                                    <Button type="text" disabled={submitting} icon={<Trash2 className="size-4" />} onClick={() => removePin(pin.id)} />
                                </div>
                            ))}
                        </div>

                        <div className="mt-auto flex items-center justify-between gap-2">
                            <Button icon={<RotateCcw className="size-4" />} disabled={submitting || !pins.length} onClick={clearPins}>
                                清空
                            </Button>
                            <div className="flex items-center gap-2">
                                <Button icon={<X className="size-4" />} disabled={submitting} onClick={handleClose}>
                                    取消
                                </Button>
                                <Button type="primary" loading={submitting} icon={<WandSparkles className="size-4" />} onClick={() => void submit()}>
                                    AI 修改
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
