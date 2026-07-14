# Fork 维护与上游同步

> 本仓库长期跟随上游 `basketikun/infinite-canvas` 演化，同时承载自己的二开功能。本文是所有「动上游文件」和「合并上游」操作的行为准则。

---

## 薄接缝原则（写二开代码的第一约束）

- **新功能 100% 住在新文件里**（新目录、新组件、新 lib），让上游怎么改都不与二开冲突。
- 对上游文件只做**追加式单点修改**：加可选字段、数组尾部加项、单行挂载。禁止在上游文件里铺展业务逻辑。
- 上游巨型热区 `web/src/pages/canvas/project.tsx`（3263 行）侵入上限：1 个 import + 1 处 JSX 挂载。程序化画布操作走 `canvasContext.applyOps`（见 `frontend/canvas-guidelines.md`）。
- **每一处对上游文件的侵入都必须登记在侵入点清单**：`docs/content/docs/development/ppt-workbench-design.mdx` §7.4（该文档是清单的唯一事实源，本文不复制内容）。新增/移除侵入时同步更新清单。

## 上游同步：保守评估制（用户拍板，2026-07-14）

**上游发版只触发「评估」，绝不自动触发「合并」。**

1. 读上游 release notes + diff 侵入点文件与依赖面（`applyAgentOps` 管线、`services/api/`、存储层）。
2. 上游改动对我们无影响 → 仍要显式决策「并 / 不并」，**默认不并**，只有明确想要该功能/修复时才并。
3. 上游改动影响到我们 → 评估「改 / 不改」：跟进适配，或冻结在当前基线暂缓合并。
4. 每次评估在设计文档 §7.2 的「上游同步决策记录」表追加一行（日期/版本/评估/决策/结果）。

合并时用 `git merge upstream/main`，**不 rebase**（main 已部署且是公开 fork）。合并后固定核对流程：

```
merge → cd web && npm run typecheck → 照侵入点清单逐条核对 → 核心流程冒烟 → 部署
```

## 分支与部署流

- **`main` = 生产**：push 到 main 触发 Vercel 生产部署。main 上的每次变更都是显式决策。
- 功能开发走 `feat/*` 分支（如 `feat/ppt-*`），push 得到 Vercel Preview 部署，验收后再合 main。
- 二开提交统一 scope 前缀（PPT 工作台一律 `feat(ppt): …`），`git log --grep="(ppt)"` 可分离二开提交。
- Vercel 已配 Ignored Build Step：`git diff HEAD^ HEAD --quiet -- .`（在 Root Directory=`web/` 下执行），web 外的改动不触发构建。⚠️ **该命令只比较一次 push 的最后一个 commit**：把含 `web/` 改动的提交放最后再 push，或分开 push；被误跳过时去 Vercel 手动 Redeploy。

## 反模式

- ❌ 「上游发版了，顺手合一下」——没有评估记录的合并一律不做。
- ❌ 在上游文件里写二开业务逻辑（哪怕「只是几行」）。
- ❌ 新增侵入点却不更新清单——下次合并冲突时无人知道这行是谁的。
- ❌ rebase main、force push main。
