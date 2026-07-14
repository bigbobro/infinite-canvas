# canvas-agent 开发规范

> 适用范围：`canvas-agent/` 目录——跑在用户本机的 Node/Bun 桥服务（npm 包 `@basketikun/canvas-agent`，默认 `127.0.0.1:17371`）。

---

## 定位与双重身份

canvas-agent 是「网页 ↔ 本机 AI CLI」的桥，同一份代码有两重身份：

1. **MCP Server**（`src/mcp-server.ts`）：把 `infinite-canvas` 工具集暴露给 Codex / Claude Code 等本机 Agent，让它们操作画布与工作台。
2. **Codex app-server 驱动**：为网页侧边栏 Codex 提供 `codex app-server --stdio` 的进程管理与流式事件转发。

与网页的通信：SSE（网页端 `web/src/stores/use-agent-store.ts` 持 `EventSource`），Origin + token 鉴权。**它不是业务后端**——不存业务数据，所有数据仍在浏览器本地。

## 规范索引

| 文件 | 内容 |
|------|------|
| [tool-development.md](./tool-development.md) | 新增/修改 Agent 工具的完整链路与同步纪律 |

## 源码地图

| 文件 | 职责 |
|------|------|
| `src/schemas.ts` | 工具注册表：`toolNames` + zod `toolInputSchemas` + 中文 `toolDescriptions` |
| `src/canvas-session.ts` | 会话与 site 工具白名单 |
| `src/mcp-server.ts` | MCP 协议层 |
| `src/http-server.ts` | 本机 HTTP/SSE 服务 |
| `src/config.ts` | 配置与 `AGENT_PROMPT`（给 Agent 的使用说明） |
| `src/agents.ts` / `src/tools.ts` / `src/types.ts` | Agent 进程管理 / 工具执行 / 类型 |

## Pre-Development Checklist

1. 改工具先读 [tool-development.md](./tool-development.md)——工具定义横跨 canvas-agent 与 web 两个包，漏一边就是断链。
2. 确认改动是否影响 `web/src/lib/agent/agent-site-tools.ts`（网页侧实现）与 `web/src/stores/use-workbench-agent-store.ts`（命令总线）。
3. 本包由用户本机安装运行，接口变更注意与已发布 npm 版本的网页端兼容提示。

## Quality Check

- `cd canvas-agent && npm run build`（`tsc -p tsconfig.json`，本包无独立 typecheck 脚本，build 即类型检查）。
- 本地联调：`npm run dev`（tsx）+ 网页 Agent 面板连接验证。
