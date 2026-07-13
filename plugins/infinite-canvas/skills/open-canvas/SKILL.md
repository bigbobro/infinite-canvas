---
name: open-canvas
description: 下载、安装并打开 Infinite Canvas，自动连接本地 Canvas Agent。用户要求打开、启动、进入或使用 Infinite Canvas 画布时使用。
---

# Open Infinite Canvas

用户要求打开 Infinite Canvas 时直接执行，不要先搜索目录、扫描端口、检查进程归属、读取配置文件或让用户手动复制 URL 和 token。

## 选择项目目录

只分两种情况：

### 当前就在 Infinite Canvas 项目中

当前目录存在 `web/package.json` 和 `plugins/infinite-canvas/.codex-plugin/plugin.json` 时，直接把当前目录作为项目目录。

### 当前不在 Infinite Canvas 项目中

固定使用 `~/plugins/infinite-canvas`：

```bash
mkdir -p ~/plugins
git clone https://github.com/basketikun/infinite-canvas.git ~/plugins/infinite-canvas
cd ~/plugins/infinite-canvas
```

如果该目录已经存在就直接进入，不要再查找其他副本。

## 一步启动

进入项目目录后依次执行：

1. 安装当前项目内的 Codex 插件：

```bash
codex plugin marketplace add "$(pwd)"
codex plugin add infinite-canvas@infinite-canvas-local
```

2. 安装前端依赖并启动开发服务：

```bash
cd web
bun install
bun run dev
```

保持开发服务运行，直接采用 Vite 输出的 `Local` 地址作为画布地址，不要另外探测端口。

3. 在项目根目录启动网页连接所需的本地 Agent，并把 Vite 输出的地址传给它：

```bash
CANVAS_URL=<Vite Local 地址> npx -y @basketikun/canvas-agent
```

安装插件后，插件会自动启动 `npx -y @basketikun/canvas-agent mcp`；上面的命令只负责启动网页要连接的 HTTP Agent，两者都需要，不要再手动添加 MCP。

4. 从 Agent 启动输出中直接取得 `Local URL` 和 `Connect token`，立即在浏览器打开：

```text
<Vite Local 地址>/canvas?mode=new&agentUrl=<Local URL>&agentToken=<Connect token>
```

网页会自动新建画布并连接 Agent，不要再点击“新建画布”，也不要在打开后追加连接检查。

如果插件是本轮对话中刚安装的，完成安装和服务启动后告知用户新开一个 Codex 对话即可加载 MCP；不要因此重复安装或重启前端。

## 打开模式

默认使用 `mode=new`。只有用户明确要求时才替换为：

- 最近画布：`mode=recent`
- 自己选择：`mode=choose`

某条启动命令直接报错时，报告该错误并处理明确原因；不要提前执行额外诊断流程。
