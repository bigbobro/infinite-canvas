export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Group = "group",
}

// 节点类型放开为字符串,内置类型用 CanvasNodeType,插件类型为 "<pluginId>:<name>"
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type PptGenerationRequestStatus = "draft" | "persisted" | "submitting" | "submitted" | "running" | "submission_unknown" | "succeeded" | "materializing" | "completed" | "recoverable_error" | "failed" | "abandoned";
export type PptGenerationRunStatus = "preparing" | "running" | "needs_attention" | "completed" | "partial" | "failed" | "abandoned";
export type PptGenerationRequestEventSummary = {
    status: PptGenerationRequestStatus;
    at: string;
    error?: string;
};

export type PptGenerationProviderIdentity = {
    channelId: string;
    baseUrl: string;
    apiFormat: "openai" | "gemini" | "maolao";
    model: string;
};

export type PptGenerationRequestTrace = {
    requestId: string;
    runId: string;
    batchId: string;
    pageId: string;
    takeId: string;
    slotIndex: number;
    requestType: "textToImage" | "imageToImage";
    model: string;
    providerIdentity: PptGenerationProviderIdentity;
    compilationSnapshotId?: string;
    status: PptGenerationRequestStatus;
    remoteTaskId?: string;
    remoteTaskExpiresAt?: number;
    resultIdentity?: string;
    billingRisk?: boolean;
    error?: string;
    createdAt: string;
    updatedAt: string;
    recentEvents: PptGenerationRequestEventSummary[];
};

export type PptGenerationRunSummary = {
    runId: string;
    batchId: string;
    pageId: string;
    takeId: string;
    requestIds: string[];
    plannedCount: number;
    status: PptGenerationRunStatus;
    createdAt: string;
    updatedAt: string;
    notifiedAt?: string;
    notifiedTerminalStatus?: PptGenerationRunStatus;
};

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    /** PPT 配置节点的用户可编辑排版要求。回写机制会污染 prompt 字段,可编辑指令必须存这里。 */
    pptLayoutPrompt?: string;
    /** 用户已明确确认的排版要求完整文本；文本一变更即失效。 */
    pptLayoutPromptReviewed?: string;
    /** 显式覆盖真正发送的最终提示词；仍需通过锁定事实校验。 */
    pptCompiledPromptOverride?: string;
    /** 用户已明确确认的 override 完整文本；文本一变更即失效。 */
    pptCompiledPromptReviewedOverride?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    groupId?: string;
    interactive?: boolean; // 插件节点「交互 ⇄ 移动」开关状态(见 CanvasNodeDefinition.interactionToggle)
    pptPageId?: string;
    pptTakeId?: string;
    pptPageIndex?: number;
    pptRole?: "outline" | "style" | "page" | "source";
    /** PPT 生成运行摘要；count>1 只放在 root，count=1 与 request trace 同节点。 */
    pptGenerationRun?: PptGenerationRunSummary;
    /** PPT 实际请求槽的持久化 trace；成功后仍保留在同一候选节点。 */
    pptGenerationRequest?: PptGenerationRequestTrace;
    /** 异步生图任务句柄（猫佬渠道）。持久化后，页面重载可凭此恢复轮询而非丢弃任务。 */
    imageTask?: { taskId: string; model: string; expiresAt?: number };
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
