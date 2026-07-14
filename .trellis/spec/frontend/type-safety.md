# 类型安全规范

> 类型契约在哪里、怎么扩展。

---

## 核心契约文件

- `web/src/types/canvas.ts`：画布世界的全部契约——`CanvasNodeType` 枚举、`CanvasNodeData`、`CanvasNodeMetadata`、`CanvasConnection`、助手会话类型。画布相关的新类型优先加在这里，不要另开文件。
- `web/src/types/canvas-export.ts`：导出/导入 zip 的文件格式（`CanvasExportFile` 带 `version` 字段）。
- `web/src/stores/canvas/use-canvas-store.ts`：`CanvasProject` 类型与 store 定义在同一文件（项目惯例：store 拥有自己的聚合根类型）。

## 扩展模式

- **`CanvasNodeMetadata` 是全可选字段袋**：新节点能力通过追加可选字段实现（现例：批量的 `isBatchRoot`/`batchChildIds`、分组的 `groupId`）。不要改已有字段语义，不要加必填字段。
- **常量表推导类型**：用 `as const` 数组 + `(typeof arr)[number]` 派生联合类型，加一项常量类型自动跟上。实例：`constant/navigation-tools.ts` 的 `NavigationToolSlug`。
- **不写旧数据兼容**：项目未上线（`AGENTS.md`），本地存储结构改动直接改类型与实现，不保留旧字段、不写迁移分支。唯一例外是既有代码已经在做的图片 storageKey 补水迁移（`docs/content/docs/development/canvas-data-structure.mdx`），维持现状即可。

## 校验边界

- 外部输入（AI 接口响应、Agent 下发的 ops、导入的 zip）在进入 store 前做防御性归一化。实例：`lib/canvas/canvas-agent-ops.ts` 的 `applyCanvasAgentOps` 对每个 op 做 `op?.type` 判空、节点存在性检查、连接去重；`readZip` 后按 `CanvasExportFile.version` 解析。
- zod 只在 canvas-agent 包用于 MCP 工具入参（`canvas-agent/src/schemas.ts`）；web 端没有引入运行时校验库，保持手写归一化的既有风格。

## 验证

`cd web && npm run typecheck`（`tsc --noEmit`）。
