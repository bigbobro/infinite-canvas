# Agent 工具开发规范

> 新增或修改一个 Agent 工具时，改动横跨 canvas-agent 和 web 两个包。这条链路上任何一环漏改都会导致工具「注册了但不可用」或「可用但 Agent 不知道怎么用」。

---

## 工具的完整链路（新增工具照单走一遍）

以既有的 `workbench_image_generate` 为模板：

1. **`canvas-agent/src/schemas.ts`**：`toolNames` 加名字 + `toolInputSchemas` 加 zod 入参 + `toolDescriptions` 加中文说明。
2. **`canvas-agent/src/canvas-session.ts`**：site 工具白名单加名字。
3. **`web/src/lib/agent/agent-site-tools.ts`**：`SITE_TOOL_NAMES` 加名字 + `runSiteTool(name, input, navigate)` 实现网页侧逻辑（直接读写对应 store；数据都在浏览器本地）。
4. 需要驱动工作台页面时：**`web/src/stores/use-workbench-agent-store.ts`** 加命令通道（`dispatchXxx`，递增 nonce 模式），页面按 nonce 判新命令执行。
5. **`canvas-agent/src/config.ts`** 的 `AGENT_PROMPT` 与 `site_navigate` 工具说明同步新页面/新能力，让 Agent 知道它存在。

## 双副本同步纪律（本包最大的风险点）

画布操作工具在 **online Agent（纯前端）和 local Agent（MCP）两侧各有一份手写定义**，最终都收敛到 `applyAgentOps` 执行。历史教训：两份副本容易漂移。

- 改任何画布工具的语义/参数时，两侧同时检查：`canvas-agent/src/schemas.ts` 与 web 端 online Agent 的工具定义。
- op 的执行语义只有一个事实源：`web/src/lib/canvas/canvas-agent-ops.ts` 的 `applyCanvasAgentOps`。新工具优先复用既有 op，而不是发明新执行路径。

## 安全边界

- 只监听 `127.0.0.1`，Origin + token 鉴权（网页 `use-agent-store.ts` 持 EventSource 连接）。不要放宽监听地址或跳过鉴权。
- 画布写操作必须保留网页侧确认流程（`web/src/components/canvas/canvas-local-agent-panel.tsx` 的待确认 `pendingTool` 机制），新增写类工具不得绕过。

## 验证

- `cd canvas-agent && npm run build` 过类型。
- 联调冒烟：`npm run dev` 起服务 → 网页 Agent 面板连上 → 用 MCP 客户端（或 Codex）调新工具走通一次真实往返。
