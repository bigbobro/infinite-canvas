# Infinite Canvas 画布节点插件

给画布扩展自定义节点。每个插件是一个**独立目录**,自带 `package.json` / `build.mjs` / `src/index.jsx` / `dist/`,互不耦合,可单独构建、发布、升级。

内置节点只有文本、图片、视频、音频、生成配置、组六种;其余节点(Markdown、SVG、HTML、3D 全景、便利贴……)都是插件。

## 目录约定

```
plugins/canvas/
  markdown/       # 每个插件一个独立目录
    package.json
    build.mjs     # esbuild 构建,产物名取目录名 → dist/markdown.js
    src/index.jsx # 插件源码(默认导出工厂函数)
    README.md
  svg/ html/ panorama/ sticky-note/ ...
```

## 构建 / 发布 / 升级

```bash
cd plugins/canvas/<name>
npm install
npm run build   # → dist/<name>.js,并同步到 web/public/plugins/<name>.js
npm run dev     # watch,改动自动构建并同步
```

把 `dist/<name>.js` 托管到任意静态地址(CDN、GitHub Raw、对象存储),用户在画布「节点插件」管理器填该 URL 安装。升级时重新构建覆盖同一 URL,用户点「更新」即可。

## 本地开发

`npm run dev` 起 watch,产物会同步到 `web/public/plugins/<name>.js`。此后有两种方式在画布里用到它:

**方式一(推荐):自动发现。** 画布启动时会扫描 `web/public/plugins/` 下的插件,自动加入「节点插件」管理器列表,**默认关闭**;打开开关即启用。无需手动填 URL,启用时会按文件重新拉取,配合 watch 改完刷新即最新。

**方式二:`VITE_DEV_PLUGINS`。** 在 `web/.env.local` 声明(逗号分隔多个),这些插件每次刷新页面都**重新拉取并直接激活**(不缓存、不落库、无开关):

```env
VITE_DEV_PLUGINS=/plugins/markdown.js,/plugins/svg.js
```

再起画布 `web`(`npm run dev`)。流程即:改 `src/index.jsx` → watch 自动构建 → 刷新画布看到最新效果,无需反复安装。

## 插件文件构成

每个插件最终打包成**单个 `.js` 文件**(加载器 `fetch 单文件 → import`),但源码可以随意拆分:

- **多个 JS/JSX**:在 `src/index.jsx` 里 `import` 其它模块,esbuild `bundle` 会合并进一个产物。
- **CSS**:写独立 `.css` 文件,`import css from "./styles.css"` 拿到字符串(esbuild 用 `text` loader),放到插件的 `css` 字段即可——启用时自动注入 `<style>`,禁用/卸载时自动清理。也可以在 `setup(app)` 里 `app.injectCSS(css, key)` 手动注入(返回移除函数)。参考 `markdown/`。
- **静态资源**(图片/字体):用远程 URL,或让 esbuild 内联成 dataURL(在 `build.mjs` 的 `loader` 里给对应扩展名配 `dataurl`)。
- **重依赖**(three.js、marked 等):不要打进 bundle,运行时 `await import("https://esm.sh/...")` 动态加载。参考 `panorama/`、`markdown/`。
- **HTML**:HTML 节点是把 HTML 字符串塞进 sandbox iframe 的 `srcDoc`,自带 `<style>`,不需要插件级 CSS。参考 `html/`。

## 插件契约

默认导出**一个工厂函数**,接收宿主 `runtime`(内含宿主 React 实例,避免两份 React),返回插件对象:

```js
export default function (runtime) {
    const { React } = runtime; // 也有 runtime.jsx / runtime.version / runtime.emit / runtime.on / runtime.injectCSS
    return {
        id: "my-plugin",          // 唯一 id
        name: "我的插件",
        version: "1.0.0",
        description: "……",
        css: "…",                 // 可选:插件样式,自动注入/清理
        nodes: [ /* CanvasNodeDefinition[] */ ],
        setup(app) { return () => {}; }, // 可选,返回清理函数;app 含 injectCSS/emit/on
    };
}
```

### CanvasNodeDefinition

```ts
{
    type: string;                 // 建议 "<pluginId>:<name>",全局唯一
    title: string;                // 创建菜单/默认标题
    icon: ReactNode;              // 可以是 emoji 字符串,或 runtime.jsx(...)
    description?: string;
    defaultSize: { width, height };
    defaultMetadata?: object;     // 新建节点初始 metadata(文本内容放 content)
    minimapColor?: string;
    showInCreateMenu?: boolean;   // 默认 true
    hasSourceHandle?: boolean;    // 右侧输出连接点,默认 true
    keepAspectRatio?: (node) => boolean;
    resource?: (node) => { kind: "text"|"image"|"video"|"audio", text?, url? } | null; // 作为上游输入被消费时输出什么
    Content: ({ ctx }) => ReactNode;         // 节点主体渲染
    Panel?: ({ ctx, onClose }) => ReactNode; // 可选:节点下方面板
    toolbar?: (ctx) => Array<{ id, title, label, icon, onClick, danger? }>; // 追加到 hover 工具栏
    onDoubleClick?: (ctx) => boolean;        // 返回 true 表示已处理双击
}
```

### ctx:节点与画布交互接口

`Content` / `Panel` / `toolbar` 都会拿到 `ctx`:

| 能力 | 说明 |
| --- | --- |
| `ctx.node` | 当前节点数据(含 `metadata.content` 等) |
| `ctx.theme` / `ctx.scale` | 当前画布主题 token 与缩放,用来让 UI 跟随主题 |
| `ctx.updateMetadata(patch)` | 更新自身 metadata(如保存内容) |
| `ctx.updateNode(patch)` | 更新自身 title/width/height |
| `ctx.getNode(id)` / `ctx.getNodes()` / `ctx.getConnections()` | 读画布 |
| `ctx.getUpstream()` / `ctx.getDownstream()` | 取上/下游相连节点 |
| `ctx.applyOps(ops)` | 用画布指令集增删节点/连线、选择、触发生成(见下) |
| `ctx.emit(event, payload)` / `ctx.on(event, handler)` | 节点/插件间事件通信 |
| `ctx.storage` | 插件私有持久化(按插件 id 命名空间) |

### 画布指令集(ctx.applyOps)

```js
ctx.applyOps([
    { type: "add_node", id?, nodeType, title?, x?, y?, width?, height?, metadata? },
    { type: "update_node", id, patch?, metadata? },
    { type: "delete_node", id? | ids? },
    { type: "connect_nodes", fromNodeId, toNodeId },
    { type: "delete_connections", id? | ids? | all? },
    { type: "select_nodes", ids },
    { type: "set_viewport", viewport },
    { type: "run_generation", nodeId, mode?, prompt? },
]);
```

## 注意

- 插件代码会在画布页面内**直接执行**,可访问浏览器本地数据(含 AI API Key)。发布前请自审,用户也只应安装可信来源。
- 交互控件记得 `onMouseDown={e => e.stopPropagation()}`(避免触发节点拖拽),滚动区域加 `onWheel={e => e.stopPropagation()}` 与容器 `data-canvas-no-zoom`(避免被画布缩放拦截)。
- 需要重依赖(如 three.js、marked)时,在源码里 `await import("https://esm.sh/...")` 动态加载,不要打进插件体积(参考 `panorama`、`markdown`)。
