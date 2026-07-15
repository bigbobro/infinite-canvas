// Markdown 节点:编辑与渲染 Markdown。marked 从 CDN 按需加载,不打进插件体积。
// styles.css 由 esbuild 以 text 方式打进 bundle,通过 plugin.css 自动注入。
import css from "./styles.css";

let markedPromise;
function loadMarked() {
    if (!markedPromise) markedPromise = import("https://esm.sh/marked@14").then((mod) => mod.marked);
    return markedPromise;
}

export default function markdownPlugin(runtime) {
    const { React } = runtime;
    const { useState, useEffect } = React;

    function MarkdownContent({ ctx }) {
        const [editing, setEditing] = useState(false);
        const [html, setHtml] = useState("");
        const value = ctx.node.metadata?.content || "";

        useEffect(() => {
            let alive = true;
            loadMarked().then((marked) => {
                if (alive) setHtml(marked.parse(value || "*双击右上角按钮编辑 Markdown*"));
            });
            return () => {
                alive = false;
            };
        }, [value]);

        const toggle = { position: "absolute", right: 8, top: 8, zIndex: 20, width: 32, height: 32, display: "grid", placeItems: "center", borderRadius: 8, border: `1px solid ${ctx.theme.node.stroke}`, background: `${ctx.theme.toolbar.panel}dd`, color: ctx.theme.node.text, cursor: "pointer" };

        return (
            <div data-canvas-no-zoom onMouseDown={(e) => e.stopPropagation()} style={{ position: "relative", height: "100%", width: "100%", display: "flex", flexDirection: "column" }}>
                <button type="button" style={toggle} onClick={() => setEditing((v) => !v)} title={editing ? "预览" : "编辑"}>{editing ? "👁" : "✎"}</button>
                {editing ? (
                    <textarea autoFocus value={value} placeholder="# 输入 Markdown" onChange={(e) => ctx.updateMetadata({ content: e.target.value })} onWheel={(e) => e.stopPropagation()} style={{ height: "100%", width: "100%", resize: "none", background: "transparent", padding: 16, fontFamily: "monospace", fontSize: 14, outline: "none", border: "none", color: ctx.theme.node.text }} />
                ) : (
                    <div className="cnv-md" onWheel={(e) => e.stopPropagation()} style={{ color: ctx.theme.node.text }} dangerouslySetInnerHTML={{ __html: html }} />
                )}
            </div>
        );
    }

    return {
        id: "markdown",
        name: "Markdown 节点",
        version: "1.0.0",
        description: "在画布中编辑与渲染 Markdown",
        css,
        nodes: [
            {
                type: "markdown:doc",
                title: "Markdown",
                icon: "📝",
                description: "编辑与渲染 Markdown",
                defaultSize: { width: 360, height: 300 },
                defaultMetadata: { content: "" },
                minimapColor: "#6366f1",
                resource: (node) => ({ kind: "text", text: node.metadata?.content }),
                Content: MarkdownContent,
            },
        ],
    };
}
