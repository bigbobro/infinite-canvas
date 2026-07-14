# 目录结构与文件落位

> 判断「这段代码该放哪」的规则。来源：`AGENTS.md` 前端规范 + 现有代码实际布局。

---

## web/src 各目录职责

| 目录 | 职责 | 参考实例 |
|------|------|----------|
| `pages/` | 路由页面，按目录组织，入口 `index.tsx` | `pages/image/index.tsx`（863 行自包含工作台） |
| `layouts/` | 页面布局 | `layouts/user-layout.tsx` |
| `components/` | 跨页面复用组件 | `components/model-picker.tsx`、`components/image-settings-panel.tsx` |
| `components/canvas/` | 画布专用组件（节点弹窗、工具栏、面板） | `canvas-node-mask-edit-dialog.tsx`、`canvas-local-agent-panel.tsx` |
| `components/ui/` | shadcn/radix 基础组件 | `components/ui/select.tsx` |
| `stores/` | Zustand 全局状态 | `use-config-store.ts`、`use-agent-store.ts` |
| `stores/canvas/` | 画布状态 | `use-canvas-store.ts`、`use-canvas-ui-store.ts` |
| `services/` | 存储与同步服务 | `image-storage.ts`、`file-storage.ts`、`webdav-sync.ts` |
| `services/api/` | **所有外部 HTTP 请求** | `api/image.ts`（生图/文本 LLM 双格式抽象）、`api/video.ts` |
| `lib/` | 纯工具函数 | `lib/zip.ts`、`lib/image-utils.ts` |
| `lib/canvas/` | 画布工具函数 | `canvas-agent-ops.ts`、`canvas-resource-references.ts`、`canvas-export.ts` |
| `lib/agent/` | Agent 站点工具 | `agent-site-tools.ts` |
| `types/` | 跨模块类型契约 | `types/canvas.ts`、`types/canvas-export.ts` |
| `constant/` | 常量与规格表 | `constant/canvas.ts`（节点默认规格）、`constant/navigation-tools.ts`（顶部导航） |
| `hooks/` | 多页面真实复用的全局 hook | `use-copy-text.ts`、`use-version-check.ts` |
| `router.tsx` | 全部路由注册 | 新页面在此 +1 行，并在 `constant/navigation-tools.ts` +1 项 |

## 落位规则

- **页面私有的东西留在页面目录里**：页面私有 hook 放页面目录下；页面私有组件放该页面目录的 `components/`（实例：`pages/prompts/components/prompt-detail-dialog.tsx`）。只有多页面真实复用才提升到外层 `components/`、`hooks/`。
- **工作台页面是自包含的**：`pages/image/index.tsx` 与 `pages/video/index.tsx` 是孪生结构，内部辅助组件（LogPanel/LogCard 等）各自持有一份，不强行抽共享。新增工作台页面沿用这个模式。
- **画布四件套**：画布页面 `pages/canvas/`、画布组件 `components/canvas/`、画布状态 `stores/canvas/`、画布工具 `lib/canvas/`。画布相关代码不要散落到别处。
- 新增路由页面的固定动作：`pages/<name>/index.tsx` → `router.tsx` 注册 → `constant/navigation-tools.ts` 加导航项（`NavigationToolSlug` 类型自动推导，顶部导航与移动端抽屉自动渲染）。

## 反模式

- ❌ 只做转发的组件（只 `return <X>{children}</X>` 或换名透传 props）——直接用真实组件。
- ❌ 页面里只有一个主业务组件时再拆 `XxxManager` 组件传一堆 props——直接写在页面入口。
- ❌ 在组件里直接发外部请求——一律经 `services/api/`。
