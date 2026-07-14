# Hook 规范

> 什么该做成全局 hook、什么留在页面里、什么进 store。

---

## 三层边界

1. **全局 hook（`web/src/hooks/`）**：多个页面重复出现的 UI 副作用动作。
   - 实例：`use-copy-text.ts`（复制文本并提示）、`use-version-check.ts`。
   - 典型候选：下载并提示、统一确认弹窗。
2. **页面私有 hook**：放在对应页面目录下，不进外层 `hooks/`。只有出现第二个真实使用方时才提升。
3. **store（`web/src/stores/`）**：只放真正需要**共享/订阅**的状态。UI 副作用动作不要塞进 store。

## 判断规则

- 「这个动作有没有状态需要被多个组件订阅？」有 → store；没有 → hook。
- 「这个 hook 有几个页面在用？」一个 → 页面目录；多个 → `hooks/`。

## 数据获取

- 外部请求的函数封装在 `web/src/services/api/`（如 `requestGeneration`、`requestImageQuestion`），hook/组件只负责调用与状态管理。
- 依赖已存在 `@tanstack/react-query`，但现有代码大多直接以 async 函数 + 本地 state 管理请求（见 `pages/image/index.tsx` 的 `generate()`）。跟随所在文件的既有模式，不要在同一个页面混两种风格。

## 反模式

- ❌ 为单页面使用把 hook 放进全局 `hooks/`。
- ❌ 把「复制/下载/弹提示」这类一次性动作做成 store action。
- ❌ 在 hook 里直接操作 localforage 业务数据——业务持久化走 `services/`（`image-storage.ts`、`file-storage.ts`）或 store 的 persist 层。
