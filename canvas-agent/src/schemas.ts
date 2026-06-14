import { z } from "zod";

const recordSchema = z.record(z.unknown());
const positionSchema = z.object({ x: z.number(), y: z.number() });
const viewportSchema = z.object({ x: z.number(), y: z.number(), k: z.number() });

export const toolNames = ["canvas_get_state", "canvas_get_selection", "canvas_export_snapshot", "canvas_apply_ops", "canvas_create_text_node", "canvas_create_image_prompt_flow"] as const;
export type ToolName = (typeof toolNames)[number];

export const canvasOpSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("add_node"), nodeType: z.enum(["image", "text", "config", "video", "audio"]).optional(), id: z.string().optional(), title: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), position: positionSchema.optional(), metadata: recordSchema.optional() }).passthrough(),
    z.object({ type: z.literal("update_node"), id: z.string(), patch: recordSchema.optional(), metadata: recordSchema.optional() }).passthrough(),
    z.object({ type: z.literal("delete_node"), id: z.string().optional(), ids: z.array(z.string()).optional() }).passthrough(),
    z.object({ type: z.literal("connect_nodes"), id: z.string().optional(), fromNodeId: z.string(), toNodeId: z.string() }).passthrough(),
    z.object({ type: z.literal("set_viewport"), viewport: viewportSchema }).passthrough(),
    z.object({ type: z.literal("select_nodes"), ids: z.array(z.string()) }).passthrough(),
]);

export const toolInputSchemas = {
    canvas_get_state: z.object({}).passthrough(),
    canvas_get_selection: z.object({}).passthrough(),
    canvas_export_snapshot: z.object({}).passthrough(),
    canvas_apply_ops: z.object({ ops: z.array(canvasOpSchema) }),
    canvas_create_text_node: z.object({ text: z.string().optional(), x: z.number().optional(), y: z.number().optional(), title: z.string().optional() }),
    canvas_create_image_prompt_flow: z.object({ prompt: z.string(), x: z.number().optional(), y: z.number().optional() }),
} satisfies Record<ToolName, z.AnyZodObject>;

export const toolDescriptions: Record<ToolName, string> = {
    canvas_get_state: "读取当前网页画布的节点、连线、选区和视口。",
    canvas_get_selection: "读取当前网页画布选中的节点。",
    canvas_export_snapshot: "导出当前画布快照，用于理解布局。",
    canvas_apply_ops: "批量操作当前网页画布。ops 支持 add_node、update_node、delete_node、connect_nodes、set_viewport、select_nodes。",
    canvas_create_text_node: "在当前画布创建文本节点。",
    canvas_create_image_prompt_flow: "创建提示词文本节点和图片生成配置节点，并自动连线。",
};
