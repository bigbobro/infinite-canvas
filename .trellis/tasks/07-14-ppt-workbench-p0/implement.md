# 执行计划：PPT 工作台 P0

> 按序执行，每步有独立验证；步骤间是硬依赖，不并行。分支 `feat/ppt-workbench-p0`，提交前缀 `feat(ppt): …`。

## Step 1：类型与数据模型

- [ ] `web/src/types/canvas.ts`：`CanvasNodeMetadata` 追加 `pptPageIndex?: number`、`pptRole?: "outline" | "style" | "page"`。
- [ ] `web/src/stores/canvas/use-canvas-store.ts`：定义 `CanvasProjectPpt` 类型（含 pages，字段见 design.md）；`CanvasProject` 加 `ppt?: CanvasProjectPpt`；`importProject` 透传 `source.ppt`；`updateProject` 的 patch Pick 加 `"ppt"`。
- 验证：`cd web && npm run typecheck` 通过；现有画布打开/保存无回归。

## Step 2：lib/ppt 核心逻辑（纯逻辑，不碰 UI）

- [ ] `web/src/lib/ppt/outline-prompt.ts`：`generatePptOutline(config, material, requirements, onDelta)` → 调 `requestImageQuestion`，返回解析后的 `{pages:[{title,outline,visualHint}]}`；JSON 解析容错 + 失败抛可读错误。
- [ ] `web/src/lib/ppt/deck-builder.ts`：`buildPptDeckProject({title, sourceMaterial, requirements, style, pages, uploadedRefs})` → 返回完整 `Partial<CanvasProject>`（nodes/connections/ppt），布局与节点形状按 design.md；不直接操作 store（调用方用 `importProject`）。
- [ ] `web/src/lib/ppt/deck-export.ts`：`resolvePageImageNode(project, page)`（确认图优先，否则 config 下游最新成功图）+ `exportPptDeckImages(project)` → zip 下载。
- 验证：typecheck；用一段临时脚本或在向导接通后验证 deck-builder 产物可被画布正常打开、连线正确。

## Step 3：/ppt 向导页

- [ ] `web/src/pages/ppt/index.tsx`：deck 列表（扫描 `useCanvasStore.projects` 中带 `ppt` 字段的工程：标题/页数/进度/打开）+ 三步向导（材料与要求 → 大纲流式生成与编辑（改标题/要点/增删页）→ 风格描述 + 参考图上传）→ 确认建图（参考图先 `uploadImage`，`buildPptDeckProject` → `importProject` → `navigate('/canvas/'+id)`）。
- [ ] `web/src/router.tsx` +1 路由；`web/src/constant/navigation-tools.ts` +1 项。
- [ ] 文本模型取 `useEffectiveConfig` 的 `textModel`，生图参数沿用全局 config 默认。
- 验证：typecheck；dev server 走通向导全流程（无 key 时至少到建图跳转）。

## Step 4：画布 PPT 面板

- [ ] `web/src/components/canvas/canvas-ppt-panel.tsx`：仅当 `currentProject.ppt` 存在时渲染；页状态列表（缩略图/状态/确认标记）、全部生成（首页锚定默认开 + 跳过选项）、单页重生成、确认此页/取消确认、打包下载；生成经 `useAgentStore` 的 `canvasContext.applyOps` 下发 `run_generation`（锚定完成后先 `connect_nodes` 再批量）；确认写回经 `useCanvasStore.updateProject`。
- [ ] `web/src/pages/canvas/project.tsx`：1 import + 1 JSX 挂载（侵入上限 2 行语义，位置参考现有面板挂载处）。
- 验证：typecheck；面板五动作在真实画布上冒烟。

## Step 5：全量检查与文档同步

- [ ] `cd web && npm run typecheck && npm run format:check`（不跑 build，AGENTS.md 约定）。
- [ ] 六步闭环冒烟（有 key 则真实生成 1–2 页验证锚定与 zip；无 key 验证到请求层参数正确）。
- [ ] 防回归：非 PPT 工程的画布行为不变；删除其他工程/素材后 deck 图片不被误删（storageKey used-set 覆盖验证）。
- [ ] 侵入点核对：实际改动 = design.md 侵入点表；有出入 → 更新设计文档 §7.4 清单。
- [ ] 文档：CHANGELOG `Unreleased` 追加 `[新增]`；`docs/content/docs/progress/pending-test.mdx` 记录可测试变更；`todo.mdx` 检查。

## 回滚点

- Step 1–2 纯追加，回滚 = revert 对应提交。
- Step 3–4 独立新文件 + 单点注册，回滚 = 删文件 + revert 注册行。
- 每个 Step 一个提交，禁止跨 Step 混提交。
