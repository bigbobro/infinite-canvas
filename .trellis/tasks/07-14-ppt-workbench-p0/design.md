# 技术设计：PPT 工作台 P0

> **权威设计文档：`docs/content/docs/development/ppt-workbench-design.mdx`**（含架构选型理由、完整数据模型、侵入点清单 §7.4、关键代码坐标附录）。本文件只提炼实现所需的硬契约，冲突时以设计文档为准。

## 架构一句话

`/ppt` 向导承载步骤 1–3（材料→大纲→风格），确认后**程序化构造 `CanvasProject` 经 `useCanvasStore.importProject()` 入库**并跳转画布；画布内 `canvas-ppt-panel` 承载步骤 4–6，生成动作**只通过 `useAgentStore` 的 `canvasContext.applyOps` 下发 `run_generation` ops**（与双 Agent 同一收敛点）；精修零新代码。

## 数据模型（新增，全部可选字段）

```ts
// CanvasProject（stores/canvas/use-canvas-store.ts）追加
ppt?: {
    sourceMaterial: string;
    requirements: string;
    style: { description: string; references: Array<{ storageKey: string }> }; // 必须是对象数组：collectImageStorageKeys 只收集对象上的 storageKey 字段，裸 string[] 不进 used-set 会被清理误删
    pages: Array<{
        index: number;          // 1 起
        title: string;
        outline: string;
        visualHint: string;
        anchorNodeId: string;   // 该页大纲文本节点
        configNodeId: string;   // 该页生成配置节点
        confirmedNodeId?: string; // 用户确认的最终图像节点
    }>;
    anchorConfirmed?: boolean;  // 首页锚定是否已完成
};

// CanvasNodeMetadata（types/canvas.ts）追加
pptPageIndex?: number;
pptRole?: "outline" | "style" | "page";
```

`importProject` / `updateProject` 需透传 `ppt` 字段（`updateProject` 的 patch Pick 联合加 `"ppt"`）。

## 画布工程形状（deck-builder 产出）

- 左列风格区：1 个「风格说明」文本节点（`pptRole:"style"`，content=风格描述）+ N 个参考图图片节点（经 `uploadImage` 入库，metadata 用 `imageMetadata` 形状）。
- 每页一列（横向排布）：大纲文本节点（`pptRole:"outline"`，content=标题+要点+视觉建议）→ 连线 → 生成配置节点（`generationMode:"image"`、`pptRole:"page"`、`pptPageIndex`、`size:"16:9"`、`count:1`）。风格区全部节点连入每页 config。**config 的 prompt 只保留版式与生成指令（`PPT_PAGE_PROMPT`）**：大纲/风格内容由上游文本节点经 `buildNodeGenerationContext` 拼入，保持单一来源（画布上改文本节点后重新生成即生效），避免与上游文本双重拼接。
- 生成结果节点由既有 `handleGenerateNode` 管线自动创建连线，**不要预建结果节点**。
- 节点默认尺寸用 `constant/canvas.ts` 的 `getNodeSpec`，布局坐标自定（列宽留足节点宽度 + 间距）。

## 面板行为契约

- 数据源：`currentProject.ppt.pages` 为纲；每页运行态从画布 nodes/connections 防御性解析（页 config 缺失 → 显示「重建此页」，不崩溃）。
- 「每页当前图」= `confirmedNodeId` 存在且节点还在 → 该节点；否则该页 config 下游最新 `status:"success"` 的 image 节点。
- 全部生成（锚定开）：先 `run_generation` 第 1 页 config → 等用户确认第 1 页 → 把确认图节点 `connect_nodes` 连入 2–N 页 config → 批量 `run_generation`；「跳过锚定」= 直接批量全页。
- 单页重生成：对该页 config 再次 `run_generation`。
- 打包下载：按 `pages[].index` 排序收集各页当前图的 `storageKey` → `getImageBlob` → `createZip`（复用 `lib/canvas/canvas-export.ts` 的 `safeFileName`/扩展名推断范式）→ `saveAs`，命名 `{两位序号}_{safeFileName(页标题)}.{ext}`。
- 确认/取消确认：写回 `ppt.pages[].confirmedNodeId`（经 `updateProject`）。

## 大纲生成契约（outline-prompt）

- 调 `services/api/image.ts` 的 `requestImageQuestion(config, messages, onDelta)`（流式）。
- 要求模型输出 JSON：`{pages:[{title, outline, visualHint}]}`；解析需容错（剥 ```json 围栏、找首个 `{`…末个 `}`）；解析失败给用户可读错误并允许重试。
- 页数由材料/要求推导，向导中可增删。

## 侵入点（唯一允许改动的上游文件，即设计文档 §7.4 清单第 1–5 项）

| 文件 | 改动 |
|---|---|
| `web/src/types/canvas.ts` | +2 可选 metadata 字段 |
| `web/src/stores/canvas/use-canvas-store.ts` | `CanvasProject` +`ppt` 字段；`importProject`/`updateProject` 透传 |
| `web/src/router.tsx` | +1 路由 `/ppt` |
| `web/src/constant/navigation-tools.ts` | +1 导航项（lucide 图标，label「PPT 工作台」） |
| `web/src/pages/canvas/project.tsx` | 1 import + 1 JSX 挂载 PPT 面板（上限 2 行语义）；另有 1 处独立修复：`createConnectedNode` 删除与参数类型无交集的 `!== CanvasNodeType.Group` 永真比较（上游遗留 TS2367 导致 typecheck 不过，行为不变，已登记设计文档 §7.4 第 7 行） |

新文件：`web/src/pages/ppt/index.tsx`、`web/src/components/canvas/canvas-ppt-panel.tsx`、`web/src/lib/ppt/outline-prompt.ts`、`web/src/lib/ppt/deck-builder.ts`、`web/src/lib/ppt/deck-export.ts`。

## 关键风险与对策

- storageKey 清理误删：deck 的 `style.references` 与页图都挂在画布工程 JSON 内，`collectImageStorageKeys` 递归收集**对象上的** storageKey 字段（裸 string[] 不会被收集，故风格参考图必须存成 `{storageKey}` 对象数组），`ppt` 字段随工程持久化即被 used-set 覆盖；check 阶段验证「删素材/其他工程后 deck 图片仍在」。
- 并发：P0 沿用现状（无上限），9 页量级可接受；失败靠单页重试兜底。
- UI 主题：面板遵守 `.trellis/spec/frontend/component-guidelines.md` 画布 UI 规范（不硬编码颜色、极简扁平）。
