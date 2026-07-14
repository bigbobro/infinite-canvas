# 质量门禁与禁止模式

---

## 可用的验证命令（web/ 下）

| 命令 | 作用 | 何时跑 |
|------|------|--------|
| `npm run typecheck` | `tsc --noEmit` | 提交前必过 |
| `npm run format:check` | Prettier 校验（写模式 `npm run format`） | 提交前 |
| `npm run dev` | 本地 dev server（0.0.0.0:3000） | 冒烟自测 |
| `npm run build` | Vite 构建 | **默认不跑**——`AGENTS.md` 约定构建由用户执行 |

**测试现状（诚实记录）**：仓库只有 `web/tests/ime-keyboard.test.ts` 一个测试文件，且 `package.json` 没有接任何测试跑手。不要假设存在测试基建；需要验证行为时用 dev server 手动/脚本冒烟。

## 来自 AGENTS.md 的硬规则（节选，冲突时以 AGENTS.md 为准）

- 先读现有代码再动手，优先沿用既有结构和写法。
- 最少行数实现；不写投机分支、不做未要求的抽象。
- 不改无关文件、不顺手重构；工作区已有用户改动时不回滚不覆盖。
- 通用能力（压缩、日期、解析等）用成熟库，不手写底层（现例：zip 用 `fflate`、日期用 `dayjs`、id 用 `nanoid`）。
- 反复出现的问题/提醒 → 沉淀回 `AGENTS.md` 对应章节（Trellis 侧对应 `.trellis/spec/` 更新）。

## 提交约定

- Conventional Commits 风格中文描述，现例：`feat(agent): …`、`docs(ppt): …`、`chore: …`（见 `git log`）。
- 二开新功能用统一 scope 前缀便于与上游区分（如 PPT 工作台一律 `feat(ppt): …`），详见 `.trellis/spec/project/fork-and-upstream.md`。
- 用户可感知的变更同步 `CHANGELOG.md` 的 `Unreleased`（`[新增]/[调整]/[修复]/[优化]` 前缀），流程见 `.trellis/spec/project/docs-and-release.md`。

## 禁止模式汇总

- ❌ 假设存在后端 / 服务端持久化。
- ❌ 业务数据写 `localStorage` 或把 base64 塞进 store JSON。
- ❌ 硬编码主题颜色（画布 UI）。
- ❌ 转发型组件、Manager 拆分、多层 props 透传。
- ❌ 写旧数据兼容/迁移兜底（项目未上线）。
- ❌ 在文档里把「浏览器本地存储」误写成「云同步」，或过度承诺 Docker 生产部署已验证（`AGENTS.md` 项目注意事项）。
