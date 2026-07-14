# 前端开发规范（web/）

> 适用范围：`web/` 目录下的 Vite + React SPA。这是本仓库唯一的产品应用。

---

## 项目形态（先建立正确心智）

- **纯前端应用，没有业务后端。** 唯一网络出口：用户自配的 AI 供应商（OpenAI 兼容 / Gemini，浏览器直连）、可选 WebDAV 备份、可选本机 canvas-agent（127.0.0.1，SSE）。不要写任何假设服务端存在的代码。
- 技术栈：Vite、React 19、TypeScript、React Router 7、Ant Design 6、Tailwind 4、Zustand、localforage。
- 持久化全部在浏览器 IndexedDB（经 localforage），数据结构见 `docs/content/docs/development/canvas-data-structure.mdx`。
- **项目尚未上线，不需要兼容旧数据**：本地存储结构调整直接按新设计改，不写迁移兜底（`AGENTS.md` 基本原则）。

`AGENTS.md` 是项目级 AI 行为约定的事实源，本目录规范与它冲突时以 `AGENTS.md` 为准。

---

## 规范索引

| 文件 | 内容 |
|------|------|
| [directory-structure.md](./directory-structure.md) | 目录职责与文件落位规则 |
| [component-guidelines.md](./component-guidelines.md) | 组件、样式、主题（含画布 UI 规范） |
| [hook-guidelines.md](./hook-guidelines.md) | 全局 hook 与页面私有 hook 的边界 |
| [state-management.md](./state-management.md) | Zustand store 模式、持久化、命令总线 |
| [type-safety.md](./type-safety.md) | 类型契约与推导模式 |
| [canvas-guidelines.md](./canvas-guidelines.md) | 画布核心：节点/连线/storageKey/生成管线/agent ops |
| [quality-guidelines.md](./quality-guidelines.md) | 质量门禁、验证命令、禁止模式 |

---

## Pre-Development Checklist

开写代码前确认：

1. 读过 `AGENTS.md`（基本原则 + 前端规范 + 画布 UI 规范）。
2. 改动涉及画布（节点/连线/生成/存储）→ 先读 [canvas-guidelines.md](./canvas-guidelines.md) 和 `docs/content/docs/development/canvas-data-structure.mdx`。
3. 改动会碰到上游文件 → 先读 `.trellis/spec/project/fork-and-upstream.md`，确认是否需要更新侵入点清单。
4. 需要的状态/动作是否已有 store 或全局 hook（`web/src/stores/`、`web/src/hooks/`）——先复用，不要重造。
5. 外部请求一律进 `web/src/services/api/`，不要在组件里直接 axios。

## Quality Check

- `cd web && npm run typecheck`（tsc --noEmit，唯一的类型门禁）。
- `cd web && npm run format:check`（Prettier；本项目没有配置 ESLint）。
- 默认**不**执行 `npm run build`——`AGENTS.md` 约定构建由用户自己做。
- 用户可感知的变更 → 按 `.trellis/spec/project/docs-and-release.md` 同步 CHANGELOG 与 progress 文档。
