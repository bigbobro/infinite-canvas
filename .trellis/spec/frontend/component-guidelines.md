# 组件与样式规范

> 来源：`AGENTS.md` 前端规范 + 画布 UI 规范，附代码实例。

---

## 组件基本约定

- 只用函数组件 + hooks；不引入新的大型状态管理方案。
- 组件短小直接：少拆不必要的组件、少做多层 props 透传。全局 store/hook 里已有的状态和动作，在需要处直接取用（如 `useEffectiveConfig()`、`useThemeStore()`），不要为了「纯组件」层层传参。
- 图标优先 `lucide-react` 或项目已用的 Ant Design 图标（实例：`constant/navigation-tools.ts` 全部用 lucide）。
- 页面文案保持中文。
- Ant Design 版本为 v6：写 antd 相关代码先对齐项目内既有写法，其次参考 https://ant.design/llms-full.txt 。

## 样式

- 组件私有样式用 Tailwind className 或少量内联 style；**不要为单个组件新增全局 CSS**。
- 全局 CSS 只放基础变量、重置、跨页面通用样式和第三方组件必要覆盖。
- 复杂逻辑抽成同目录工具函数或小组件，不要堆在组件里。

## 画布 UI 规范（做 canvas 相关 UI 必读）

- **必须遵循画布主题**：优先使用 `canvasThemes`、`useThemeStore` 或 antd `ConfigProvider` token。❌ 禁止硬编码黑白、stone、slate 等颜色——会导致浅色/深色主题不一致（`AGENTS.md` 明令禁止的历史错误）。
- 新增画布按钮、弹窗、浮层时复用已有工具栏、节点面板、Modal 的视觉风格（参考 `components/canvas/` 下现有弹窗：`canvas-node-mask-edit-dialog.tsx`、`canvas-node-angle-dialog.tsx` 等）。
- 画布顶部工具栏走极简扁平风格：无边框、无阴影、无胶囊背景，仅保留轻微 hover 反馈。
- 图片节点尺寸逻辑必须尊重原始比例（`naturalWidth/naturalHeight`），除非功能明确要求自由变形（`metadata.freeResize`）。
- 批量生成、多图展示、助手面板等交互保持简洁，不要占用过多画布空间。

## 反模式

- ❌ 页面私有组件自己写 `dark ? ... : ...` 主题分支——主题统一在 `lib/app-theme.ts`、`AppProviders` 或全局 CSS 作用域配置。
- ❌ 为「兼容更多场景」写大量分支——只实现当前明确需要的功能。
- ❌ 顺手重构无关组件、改无关格式。
