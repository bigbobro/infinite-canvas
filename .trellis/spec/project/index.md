# 项目级横切规范

> 不属于某一个包、但每次开发都可能碰到的约定：fork 上游管理、文档与发版流程。

---

## 项目身份

- 本仓库是 `basketikun/infinite-canvas` 的**二开 fork**（`bigbobro/infinite-canvas`），remote 已配好 `origin` + `upstream`。
- 产品形态：纯前端个人画布工具，部署在 Vercel（Root Directory = `web/`）。
- 当前二开主线：PPT 工作台模块，设计定稿见 `docs/content/docs/development/ppt-workbench-design.mdx`。

## 规范索引

| 文件 | 内容 |
|------|------|
| [fork-and-upstream.md](./fork-and-upstream.md) | 薄接缝原则、上游同步保守评估制、分支与部署流 |
| [docs-and-release.md](./docs-and-release.md) | 文档同步流水线（todo → pending-test → features）与发版流程 |

## Pre-Development Checklist

1. 本次改动会修改上游文件吗？→ 读 [fork-and-upstream.md](./fork-and-upstream.md)，遵守薄接缝原则并维护侵入点清单。
2. 本次改动用户可感知吗？→ 读 [docs-and-release.md](./docs-and-release.md)，安排 CHANGELOG 与 progress 文档同步。
3. 提交是否要推 `main`？→ `main` 即生产（push 触发 Vercel 部署），功能开发走 `feat/*` 分支 + Preview 验收。

## Quality Check

- 涉及上游文件的提交：确认侵入点清单（设计文档 §7.4）已更新。
- 涉及功能变更的提交：确认 `CHANGELOG.md` Unreleased 与 `docs/content/docs/progress/` 已同步。
