# 画布核心规范

> 动画布（节点/连线/生成/存储）之前必读。配合 `docs/content/docs/development/canvas-data-structure.mdx`（存储结构的权威文档）。

---

## 数据契约

- 节点：`CanvasNodeData`（`types/canvas.ts`），六种 `CanvasNodeType`：Image/Text/Config/Video/Audio/Group。节点业务状态全部住在 `metadata`（全可选字段袋）。
- 连线：`CanvasConnection` 只有 `{id, fromNodeId, toNodeId}`——**边上没有语义字段**。语义是隐式的：`lib/canvas/canvas-resource-references.ts` 在运行时把上游资源节点分类为参考图/参考视频/参考音频/文本输入。
- 节点默认规格（尺寸/标题/初始 metadata）查 `constant/canvas.ts` 的 `getNodeSpec`，不要自己硬编码。

## storageKey 铁律（最容易踩的坑）

- `metadata.content` 里的图片/视频 URL 是**会话内展示用的 `blob:` URL**，刷新即失效；长期标识是 `metadata.storageKey`。
- 新增图片一律经 `services/image-storage.ts` 的 `uploadImage(input)` 入库，节点 metadata 写入其返回的 `{url, storageKey, width, height, bytes, mimeType}`。
- **引用清理机制**：删除节点/工程/素材/会话会触发 `cleanupImages` → `cleanupUnusedImages`，凡是不在「引用集合」里的 storageKey 对应 Blob 会被物理删除。⚠️ **新增任何持有 storageKey 的数据结构时，必须确认它被 used-set 收集逻辑覆盖**，否则它引用的图片会被清理误删——这是本项目已知的真实 bug 类别（历史案例：工作台生成记录 `image/video_generation_logs` 引用的 blob 曾不在 used-set 内）。

## 生成管线

- 一切生成经 `pages/canvas/project.tsx` 的 `handleGenerateNode`（约 :1953）：构建上下文（`components/canvas/canvas-node-generation.ts` 的 `buildNodeGenerationContext`：prompt 拼接 + 上游参考图收集）→ 调 `services/api/image.ts`（有参考图走 `requestEdit` 图生图，无则 `requestGeneration`）→ 结果**新建下游子节点**并自动连线，不覆盖源节点。
- 精修/迭代（蒙版重绘、多视角、裁剪、放大）每轮都生成新子节点，形成可追溯的迭代链。
- 批量：`count>1` 生成 `isBatchRoot` 根节点 + `batchChildIds` 子节点，`Promise.all` 并发。⚠️ 现状没有并发上限/队列，大批量需求要自带节流或页级重试。

## 程序化操作画布：只走 agent ops

需要用代码建节点/连线/触发生成（面板、Agent、批量工具）时，**统一走声明式 ops**：

- op 类型定义：`lib/canvas/canvas-agent-ops.ts`（`add_node`/`update_node`/`connect_nodes`/`run_generation` 等）；
- 执行入口：`useAgentStore` 暴露的 `canvasContext.applyOps`（画布页挂载时注入，实现在 `project.tsx:716` `applyAgentOps`）；
- 不在画布页上下文时（如向导页建图），直接构造 `CanvasProject` 数据经 `useCanvasStore.importProject()` 入库。

❌ 不要给 `project.tsx`（3263 行巨型组件，上游活跃重构区）新增深度侵入：新功能做成独立组件/独立 lib，`project.tsx` 只留单点挂载。范例：PPT 工作台设计 `docs/content/docs/development/ppt-workbench-design.mdx` §3。

## 删除行为

- 删除节点会级联删除其连线；删除图片组根节点会带走全部子节点（`docs/content/docs/development/canvas-data-structure.mdx`）。写删除逻辑前先确认既有级联规则，不要重复实现。
