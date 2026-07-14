# 状态管理规范

> Zustand store 的既有模式与持久化约定。

---

## Store 一览（先复用，再新建）

| Store | 职责 |
|-------|------|
| `stores/canvas/use-canvas-store.ts` | 画布工程列表与 CRUD（`CanvasProject` 类型定义在此） |
| `stores/canvas/use-canvas-ui-store.ts` | 画布 UI 状态 |
| `stores/use-config-store.ts` | AI 供应商配置、渠道（channel）、模型解析——改生成参数相关先读它 |
| `stores/use-asset-store.ts` | 「我的素材」 |
| `stores/use-theme-store.ts` | 主题 |
| `stores/use-user-store.ts` | 用户偏好 |
| `stores/use-agent-store.ts` | 本机 Agent 面板：SSE 连接、消息、`canvasContext`（画布操作桥） |
| `stores/use-workbench-agent-store.ts` | 工作台命令总线（Agent → 工作台页面） |

## 持久化模式（照抄 use-canvas-store）

业务数据持久化的标准写法见 `stores/canvas/use-canvas-store.ts`：

- `zustand/middleware` 的 `persist` + 自定义 `PersistStorage` 包装 `localForageStorage`；
- 写盘做 400ms 防抖 + 引用相等短路（`queuedPersistState.projects === nextState.projects` 则跳过）；
- `partialize` 只持久化数据字段，不持久化瞬态；
- `onRehydrateStorage` 里置 `hydrated: true`，消费方以此判断可用。

存储介质规则（`AGENTS.md`）：业务数据（列表、生成记录、图片、大 JSON）→ localforage/IndexedDB；`localStorage` 只放极小的简单配置。

## 二进制与大对象

- 图片/视频 Blob **绝不进 store JSON**：经 `services/image-storage.ts` 的 `uploadImage()` / `services/file-storage.ts` 入库，store 里只存 `storageKey` + 展示 URL。细节见 [canvas-guidelines.md](./canvas-guidelines.md)。
- 工作台生成历史用独立 localforage 实例（`image_generation_logs` / `video_generation_logs`，见 `pages/image/index.tsx`），序列化时清空 dataUrl 只留 storageKey。

## 跨模块通信的两个既有模式

1. **canvasContext 桥**（`use-agent-store.ts:10` `AgentCanvasContext`）：画布页挂载时 `setCanvasContext({snapshot, applyOps, undoOps})`，卸载时置 null。任何组件想程序化操作画布（建节点/连线/触发生成），消费这个 context 下发 ops，**不要**直接 import 画布内部函数。
2. **命令总线**（`use-workbench-agent-store.ts`）：`dispatchImage/dispatchVideo({prompt, run})` 用递增 nonce 下发，页面按 nonce 判断新命令。给工作台页加外部驱动能力时沿用此模式。

## 反模式

- ❌ 新增全局状态管理方案（Redux/Jotai/MobX 等）。
- ❌ 在 store JSON 里保存 base64 / dataUrl 大字段。
- ❌ 绕过 400ms 防抖模式自己写高频落盘。
