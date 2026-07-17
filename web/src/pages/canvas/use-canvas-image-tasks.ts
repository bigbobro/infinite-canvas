/**
 * 猫佬（maolao）异步生图任务在画布上的持久化与重载续轮询。
 *
 * 上游画布把生成视为一次性请求：刷新即丢（`resetInterruptedGeneration` 直接标 error）。
 * 异步渠道下任务在远端继续跑且已计费，丢掉句柄就再也取不回结果 —— PPT 批量场景尤其疼。
 * 本 hook 负责：提交后立刻落盘 task 句柄；重载后为仍在 loading 的节点接管轮询。
 *
 * 二开功能，独立于上游 project.tsx；上游只保留 1 处 import + 1 处调用。
 */
import { useCallback, useEffect, useRef } from "react";

import { resumeImageTask, type ImageTaskHandle } from "@/services/api/maolao-image";

/** 转出给画布使用，使上游 project.tsx 只需引入本 hook 一个模块。 */
export type { ImageTaskHandle };
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { flushCanvasStore, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type UseCanvasImageTasksParams = {
    projectId: string;
    projectLoaded: boolean;
    effectiveConfig: AiConfig;
    nodesRef: React.RefObject<CanvasNodeData[]>;
    setNodes: React.Dispatch<React.SetStateAction<CanvasNodeData[]>>;
    /** 复用画布既有的请求登记表，使「停止生成」能同样中断续轮询。 */
    startGenerationRequest: (targetNodeId: string, originNodeId: string, runningId?: string, controller?: AbortController) => AbortController;
    finishGenerationRequest: (targetNodeId: string, controller: AbortController) => void;
    isGenerationCanceled: (error: unknown) => boolean;
    imageMetadata: (image: UploadedImage) => CanvasNodeMetadata;
};

export function useCanvasImageTasks({
    projectId,
    projectLoaded,
    effectiveConfig,
    nodesRef,
    setNodes,
    startGenerationRequest,
    finishGenerationRequest,
    isGenerationCanceled,
    imageMetadata,
}: UseCanvasImageTasksParams) {
    /** 正在续轮询的节点，防止 effect 重跑时对同一任务挂起多个轮询循环。 */
    const resumingNodeIdsRef = useRef(new Set<string>());

    /**
     * 落盘 task 句柄。直接补丁到 store 而非依赖 nodes → store 的 effect：
     * effect 要等下一次渲染，而此刻必须落盘完成才能开始轮询 —— 中间刷新就再也找不回远端任务。
     */
    const persistImageTask = useCallback(
        async (nodeId: string, handle: ImageTaskHandle, model: string) => {
            const withTask = (node: CanvasNodeData) =>
                node.id === nodeId ? { ...node, metadata: { ...node.metadata, imageTask: { taskId: handle.taskId, model, expiresAt: handle.expiresAt } } } : node;
            setNodes((prev) => prev.map(withTask));
            const store = useCanvasStore.getState();
            const project = store.projects.find((item) => item.id === projectId);
            if (project) store.updateProject(projectId, { nodes: project.nodes.map(withTask) });
            await flushCanvasStore();
        },
        [projectId, setNodes],
    );

    // 页面重载后恢复异步任务：resetInterruptedGeneration 已保留其 loading 状态，此处接管轮询。
    useEffect(() => {
        if (!projectLoaded) return;
        nodesRef.current?.forEach((node) => {
            const task = node.metadata?.imageTask;
            if (node.metadata?.status !== "loading" || !task) return;
            if (resumingNodeIdsRef.current.has(node.id)) return; // effect 重跑 / StrictMode 双调用时避免挂多个轮询
            resumingNodeIdsRef.current.add(node.id);
            const controller = startGenerationRequest(node.id, node.id, node.id);
            const rootId = node.metadata?.batchRootId;
            void (async () => {
                try {
                    const images = await resumeImageTask(effectiveConfig, task.model, task.taskId, { signal: controller.signal });
                    const uploaded = await uploadImage(images[0].dataUrl);
                    setNodes((prev) => {
                        const root = rootId ? prev.find((item) => item.id === rootId) : undefined;
                        // 根节点尚无主图时，用第一个恢复成功的子图回填，与首次生成的行为一致。
                        const fillRoot = Boolean(root && root.metadata?.status === "loading" && !root.metadata.primaryImageId);
                        return prev.map((item) => {
                            if (item.id === node.id) return { ...item, metadata: { ...item.metadata, ...imageMetadata(uploaded) } };
                            if (fillRoot && item.id === rootId) return { ...item, metadata: { ...item.metadata, ...imageMetadata(uploaded), primaryImageId: node.id } };
                            return item;
                        });
                    });
                } catch (error) {
                    if (isGenerationCanceled(error)) return;
                    const errorDetails = error instanceof Error ? error.message : "恢复生成失败";
                    setNodes((prev) => {
                        // 若根节点还在等主图、且已无其他子任务在跑，一并判错，避免它永久转圈。
                        const othersPending = Boolean(rootId && prev.some((item) => item.metadata?.batchRootId === rootId && item.id !== node.id && item.metadata?.status === "loading"));
                        return prev.map((item) => {
                            if (item.id === node.id) return { ...item, metadata: { ...item.metadata, status: "error" as const, errorDetails, imageTask: undefined } };
                            if (rootId && item.id === rootId && item.metadata?.status === "loading" && !item.metadata.primaryImageId && !othersPending)
                                return { ...item, metadata: { ...item.metadata, status: "error" as const, errorDetails, imageTask: undefined } };
                            return item;
                        });
                    });
                } finally {
                    resumingNodeIdsRef.current.delete(node.id);
                    finishGenerationRequest(node.id, controller);
                }
            })();
        });
    }, [effectiveConfig, finishGenerationRequest, imageMetadata, isGenerationCanceled, nodesRef, projectLoaded, setNodes, startGenerationRequest]);

    return { persistImageTask };
}

/** 猫佬任务结果保留约 1 小时，过期后 content 返回 410，续轮询已无意义。 */
export function isImageTaskExpired(task: { expiresAt?: number }) {
    return typeof task.expiresAt === "number" && task.expiresAt * 1000 <= Date.now();
}
