# 文档同步与发版流程

> 事实源是 `AGENTS.md` 的「文档规范」与「发版本流程」两节，本文提炼成可执行流水线并补充文件坐标。冲突时以 `AGENTS.md` 为准。

---

## 文档地图

| 文件 | 用途 |
|------|------|
| `README.md` | 只放项目介绍、核心功能、快速开始、文档入口 |
| `docs/index.md` | 给 AI 的文档索引（不放进 `docs/content/docs/`） |
| `docs/content/docs/overview/features.mdx` | 正式功能说明（用户确认测试通过后才更新） |
| `docs/content/docs/progress/todo.mdx` | 后续待办 |
| `docs/content/docs/progress/pending-test.mdx` | 已实现、待用户测试确认的变更 |
| `docs/content/docs/development/` | 开发文档（数据结构、设计文档；新文件要注册进同目录 `meta.json`） |
| `CHANGELOG.md` | `Unreleased` 段做版本级归纳 |

## 功能变更的文档流水线

```
实现完成 → todo.mdx 移除该项 → pending-test.mdx 记录可测试变更
        → CHANGELOG.md Unreleased 追加一句中文归纳（[新增]/[调整]/[修复]/[优化] 前缀）
用户确认测试通过 → 更新 features.mdx
```

- 每次任务完成前都检查 `todo.mdx` 和 `pending-test.mdx` 是否需要更新；没有变化也要确认过。
- 纯内部重构、格式化、无用户可感知影响的小改动可不记 CHANGELOG。
- `pending-test.mdx` 记实现细节，CHANGELOG 只留版本级归纳，不逐条照搬。
- 文档不写具体日期，除非用户明确要求。
- 文档措辞红线：数据在浏览器本地（不是云同步）；API Key 存浏览器本地、前端直连；Docker 生产部署未完全验证（`AGENTS.md` 项目注意事项）。

## 发版流程（顺序执行）

1. 把 `CHANGELOG.md` 的 `Unreleased` 整理成新版本记录，保留空的 `Unreleased` 标题。
2. 提升版本号，更新根目录 `VERSION`。
3. 全部未提交代码提交到 Git。
4. 给该提交打版本 tag（如 `v0.0.5`）。
5. 发版流程中不执行编译、测试或构建（除非用户明确要求）。

## 设计文档惯例

功能级设计定稿放 `docs/content/docs/development/<feature>-design.mdx` 并注册进 `meta.json`（现例：`ppt-workbench-design.mdx`）。设计文档内维护该功能的侵入点清单与决策记录，作为跨会话 handoff 锚点。
