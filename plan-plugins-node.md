# 画布节点插件系统设计方案

> 目标:让画布支持自定义节点(SVG、3D 全景、导演台、Markdown、HTML 渲染等),插件可从远程 URL 动态安装,插件节点可与画布及其他节点交互。

## 一、现状梳理(设计依据)

- **渲染架构**:纯 DOM + CSS transform(`web/src/components/canvas/infinite-canvas.tsx:188-195`),每个节点是绝对定位 div,插件节点渲染真 React 组件毫无障碍。
- **节点模型**:`CanvasNodeData.type` 是封闭枚举 `CanvasNodeType`(`web/src/types/canvas.ts:12-19`),metadata 是扁平可选字段袋——对扩展友好。
- **已有雏形**:`web/src/components/canvas/canvas-node.tsx:420-427` 的 `nodeContentRenderers` 已经是 `type → 渲染器` 映射,注册表化就是把它开放。
- **关键分散点**(所有按 type 分支的地方,都是要收敛到注册表的接口):
  - 默认尺寸/初始 metadata:`web/src/constant/canvas.ts` NODE_SPECS
  - 内容渲染:`canvas-node.tsx` NodeContent
  - 等比缩放判断:`canvas-node.tsx:262`
  - 双击行为:`canvas-node.tsx:340-354`
  - hover 工具栏按钮:`web/src/components/canvas/canvas-node-hover-toolbar.tsx:106-152`
  - 创建菜单 ×2:`web/src/pages/canvas/project.tsx:172-236`(NodeCreateMenu / ConnectionCreateMenu)
  - 小地图颜色:`web/src/components/canvas/canvas-mini-map.tsx:116`
  - 节点信息弹窗类型名:`canvas-node-hover-toolbar.tsx:257`
  - 上游输入采集(节点作为生成输入):`web/src/lib/canvas/canvas-resource-references.ts:93-96`、`web/src/components/canvas/canvas-node-generation.ts`
  - Agent 操作校验:`web/src/lib/canvas/canvas-agent-ops.ts:45`(add_node 只认枚举)
- **持久化**:zustand persist → localforage,节点是纯 JSON,`type` 改成 string 后旧结构天然兼容(项目未上线,无需迁移逻辑)。
- **一个重要复用点**:`canvas-agent-ops.ts` 的 `applyCanvasAgentOps` 已经是一套完整的"画布操作指令集"(增删节点/连线/选择/视口/触发生成),**插件上下文直接复用这套 op API**,插件就拥有了和 AI Agent 同级的画布操作能力,零新增协议。

## 二、总体设计

已确认的决策:

- **信任/运行模型**:ESM 直连加载,插件代码在页面内全权执行,安装时弹确认警告(不做 iframe 沙箱运行时;但 HTML 节点渲染内容本身用 sandbox iframe 隔离)。
- **内置节点也迁到同一注册表**,统一架构。
- **示例插件**:Markdown / HTML / SVG / 3D 全景 四个节点。

```
┌─ 插件管理 UI (安装/启用/禁用/删除, URL 安装)
│        │
├─ use-plugin-store (zustand+localforage: {id,url,version,enabled,source缓存})
│        │
├─ plugin-loader (fetch源码 → blob URL import → 校验 manifest → 注册)
│        │
├─ node-registry (Map<type, CanvasNodeDefinition> + 版本计数器触发UI更新)
│    ↑ 内置6种节点 + first-party插件(markdown/html/svg/panorama) + 远程插件
│        │
└─ canvas-node.tsx / 创建菜单 / 工具栏 / 小地图 / 生成输入采集 → 全部查注册表
```

### 1. 核心类型 `web/src/types/canvas-plugin.ts`

```ts
export type CanvasNodeDefinition = {
    type: string;                          // 内置 "image";插件 "<pluginId>:<name>"
    title: string;                         // 菜单名/默认标题
    icon: ReactNode;
    description?: string;
    defaultSize: { width: number; height: number };
    defaultMetadata?: CanvasNodeMetadata;
    minimapColor?: string;
    showInCreateMenu?: boolean;            // 默认 true
    hasSourceHandle?: boolean;             // 右侧连接点,Config 为 false
    keepAspectRatio?: (node: CanvasNodeData) => boolean;
    // 作为上游输入被消费时输出什么(接入生成/引用体系)
    resource?: (node: CanvasNodeData) => { kind: "text" | "image" | "video" | "audio"; text?: string; url?: string } | null;
    // 渲染
    Content: ComponentType<{ node: CanvasNodeData; ctx: CanvasNodeContext }>;
    Panel?: ComponentType<{ node: CanvasNodeData; ctx: CanvasNodeContext; onClose: () => void }>;  // 节点下方面板
    toolbar?: (node: CanvasNodeData, ctx: CanvasNodeContext) => Array<{ id; title; label; icon; onClick; danger? }>;
    onDoubleClick?: (node: CanvasNodeData, ctx: CanvasNodeContext) => boolean;  // true=已处理
};

export type CanvasPlugin = {
    id: string;                            // 唯一,kebab-case
    name: string;
    version: string;
    minAppVersion?: string;
    nodes: CanvasNodeDefinition[];
    setup?: (app: CanvasPluginApp) => void | (() => void);  // 可选初始化/清理
};
```

### 2. 节点上下文 `CanvasNodeContext`(节点交互的核心接口)

由 project.tsx 构建、经 CanvasNode 注入每个节点渲染器:

```ts
export type CanvasNodeContext = {
    // 自身数据
    updateMetadata(patch: CanvasNodeMetadata): void;
    updateNode(patch: Partial<Pick<CanvasNodeData, "title" | "width" | "height">>): void;
    // 图访问与操作(复用 CanvasAgentOp 指令集 → 插件可增删节点/连线/触发生成)
    getNode(id: string): CanvasNodeData | null;
    getUpstream(): CanvasNodeData[];       // 输入节点(含 resource 解析结果)
    getDownstream(): CanvasNodeData[];
    applyOps(ops: CanvasAgentOp[]): void;
    // 节点间/插件间通信
    on(event: string, handler: (payload: unknown) => void): () => void;
    emit(event: string, payload?: unknown): void;   // 轻量事件总线,内置事件: node:updated / connection:added ...
    // 环境
    theme: CanvasTheme;                    // 当前主题 token,保证插件 UI 跟主题
    scale: number;                         // 当前缩放
    storage: { get; set; remove };         // localforage 命名空间 "plugin:<id>"
};
```

### 3. 插件运行时与远程加载

- `web/src/lib/canvas/plugin-runtime.ts`:启动时挂 `window.InfiniteCanvas = { React, ReactDOM, version }`。远程插件构建时把 `react` external 到该全局(提供 esbuild 示例配置),避免双 React 实例;插件自己的重依赖(如 three)可从 esm.sh 动态 import。
- `web/src/lib/canvas/plugin-loader.ts`:
  - `installPlugin(url)`:fetch 源码 → `import(blobUrl)` 校验 default export → 存入 store(**缓存源码**,离线可用、版本固定)→ 注册。
  - `loadInstalledPlugins()`:应用启动时从 store 恢复所有 enabled 插件。
  - `unloadPlugin(id)`:从注册表移除其节点类型;画布上遗留节点渲染成"缺少插件"占位节点(数据完整保留,重装即恢复)。
- `web/src/stores/canvas/use-plugin-store.ts`:插件记录持久化。
- 安装时 Modal 明确警告:插件代码将在页面内完整执行、可访问本地数据(含 API Key),仅安装可信来源。

### 4. 注册表 `web/src/lib/canvas/node-registry.ts`

模块级 Map + zustand 计数器(注册/卸载时 +1,创建菜单等 UI 响应更新)。`getNodeDefinition(type)`、`listNodeDefinitions()`、`registerNodeDefinitions(defs)`、`unregisterByPlugin(id)`。未知 type 统一走 `MissingPluginContent` 兜底。

## 三、内置节点迁移

1. `types/canvas.ts`:`CanvasNodeData.type` 改为 `string`;`CanvasNodeType` 保留为内置类型字符串常量(所有现有 `CanvasNodeType.Image` 判断照常编译)。
2. 把 `canvas-node.tsx` 中 6 个内容渲染器抽到 `web/src/components/canvas/nodes/`(text/image/video/audio/config/group 各一文件),连同默认尺寸、图标、minimap 颜色、resource 函数一起写成 `CanvasNodeDefinition`,`registerBuiltinNodes()` 启动注册。`canvas-node.tsx` 只留外壳(边框/标题/缩放把手/连接点)。
3. `constant/canvas.ts` 的 `getNodeSpec`/`NODE_DEFAULT_SIZE` 改为读注册表(保留函数签名,减少调用方改动)。
4. 通用分支改查注册表:创建菜单 ×2、小地图颜色、信息弹窗类型名、等比缩放、双击行为、hover 工具栏(内置逻辑保留,追加 `definition.toolbar` 项)。
5. `canvas-resource-references.ts` / `canvas-node-generation.ts` 的输入采集改走 `definition.resource()` → **插件节点(如 Markdown)可以直接作为生成输入连给图片/配置节点**。
6. `canvas-agent-ops.ts` add_node 校验放开为"注册表中存在的 type" → AI Agent 自动获得操作插件节点的能力。
7. project.tsx 中图片生成/批量等**媒体专属业务分支保持不动**(那是生成管线固有逻辑,不属于节点渲染扩展面)。

## 四、示例插件

First-party 插件(`web/src/plugins/nodes/`,与远程插件同一套 API,验证设计):

| 插件 | 实现 | 交互演示 |
|---|---|---|
| **Markdown** | 已有 `streamdown` 依赖渲染;双击编辑源码 | `resource` 输出 text,可连入生成 |
| **HTML** | sandbox iframe `srcdoc`(`allow-scripts`,默认隔离) | 上游文本节点内容可注入渲染 |
| **SVG** | 直接渲染 SVG 源码,面板编辑 | 可从上游文本节点取 SVG 代码 |
| **3D 全景** | 新增 `three` 依赖(动态 import 按需分包),等距柱状全景查看器 | 从上游图片节点取全景图,演示 `getUpstream()` |

远程插件示例:`plugins/examples/hello-node/`——独立 ESM 源码 + esbuild 构建脚本 + README(如何构建、托管、经 URL 安装),打通远程链路验证。

## 五、插件管理 UI

`web/src/components/canvas/canvas-plugin-manager-modal.tsx`:URL 安装(含安全警告)、列表(名称/版本/来源/节点数)、启用开关、更新(重新拉取)、删除。入口挂在画布左上 Dropdown 菜单。遵循画布主题 token。

## 六、实施顺序

1. **注册表 + 类型放开 + 内置迁移**(改动最大,先落地保证现状不回归)
2. **NodeContext + 事件总线**(注入渲染链路)
3. **插件运行时 + loader + store + 管理 UI + 缺失插件占位**
4. **四个示例插件 + 远程示例**
5. **agent ops 放开校验;更新 CHANGELOG(Unreleased)、todo/pending-test 文档;SECURITY.md 补插件安全说明**

## 风险与边界

- **安全**:ESM 直连=插件可读本地 API Key,靠安装警告+可信来源约束(已确认此取舍)。HTML 节点内容本身仍走 sandbox iframe 隔离。
- **React 单例**:远程插件必须 external react 用全局运行时,SDK 文档写清楚,loader 校验失败给出明确报错。
- **project.tsx 不做整体重构**:只替换类型分支为注册表查询,生成管线逻辑原样保留,控制回归面。
