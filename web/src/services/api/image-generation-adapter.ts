import { requestEdit, requestGeneration } from "@/services/api/image";
import { resumeImageTask } from "@/services/api/maolao-image";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type ImageGenerationProviderEvent = { type: "task_created"; taskId: string; expiresAt?: number } | { type: "progress"; progress: string };

export type ImageGenerationProviderInput = {
    config: AiConfig;
    prompt: string;
    references: ReferenceImage[];
    signal?: AbortSignal;
    onEvent?: (event: ImageGenerationProviderEvent) => void | Promise<void>;
};

export type ImageGenerationProviderResult = {
    dataUrl: string;
    resultIdentity: string;
    remoteTaskId?: string;
};

export type ImageGenerationProviderAdapter = {
    submit: (input: ImageGenerationProviderInput) => Promise<ImageGenerationProviderResult>;
    resume: (input: Omit<ImageGenerationProviderInput, "prompt" | "references"> & { remoteTaskId: string }) => Promise<ImageGenerationProviderResult>;
};

export const imageGenerationProviderAdapter: ImageGenerationProviderAdapter = {
    async submit({ config, prompt, references, signal, onEvent }) {
        let remoteTaskId: string | undefined;
        const events = createEventQueue(onEvent);
        const options = {
            signal,
            onTaskCreated: async (handle: { taskId: string; expiresAt?: number }) => {
                remoteTaskId = handle.taskId;
                events.push({ type: "task_created", taskId: handle.taskId, expiresAt: handle.expiresAt });
                await events.drain();
            },
            onProgress: (progress: string) => {
                events.push({ type: "progress", progress });
            },
        };
        const image = await (async () => {
            try {
                return references.length ? await requestEdit({ ...config, count: "1" }, prompt, references, undefined, options).then((items) => items[0]) : await requestGeneration({ ...config, count: "1" }, prompt, options).then((items) => items[0]);
            } finally {
                await events.drain();
            }
        })();
        if (!image) throw new Error("图片接口没有返回结果");
        return { dataUrl: image.dataUrl, resultIdentity: remoteTaskId ? `${remoteTaskId}:0` : image.id, remoteTaskId };
    },

    async resume({ config, remoteTaskId, signal, onEvent }) {
        const events = createEventQueue(onEvent);
        const image = await (async () => {
            try {
                return await resumeImageTask(config, config.model, remoteTaskId, {
                    signal,
                    onProgress: (progress) => events.push({ type: "progress", progress }),
                }).then((items) => items[0]);
            } finally {
                await events.drain();
            }
        })();
        if (!image) throw new Error("图片任务没有可恢复的结果");
        return { dataUrl: image.dataUrl, resultIdentity: `${remoteTaskId}:0`, remoteTaskId };
    },
};

function createEventQueue(onEvent: ImageGenerationProviderInput["onEvent"]) {
    let failure: unknown;
    let queue: Promise<void> = Promise.resolve();
    return {
        push(event: ImageGenerationProviderEvent) {
            queue = queue
                .then(async () => {
                    await onEvent?.(event);
                })
                .catch((error) => {
                    failure ??= error;
                });
        },
        async drain() {
            await queue;
            if (failure) throw failure;
        },
    };
}
