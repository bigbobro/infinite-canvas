import { build, context } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const name = basename(root); // 目录名即插件产物名,如 markdown → markdown.js
const distDir = join(root, "dist");
// 本地开发同步到 web/public/plugins,便于用 /plugins/<name>.js 安装或走 VITE_DEV_PLUGINS
const publicDir = join(root, "..", "..", "..", "web", "public", "plugins");
const watch = process.argv.includes("--watch");

const syncToPublic = {
    name: "sync-to-public",
    setup(builder) {
        builder.onEnd(async (result) => {
            if (result.errors.length) return;
            await mkdir(publicDir, { recursive: true });
            await cp(join(distDir, `${name}.js`), join(publicDir, `${name}.js`));
            console.log(`[${name}] synced → web/public/plugins/${name}.js`);
        });
    },
};

const options = {
    entryPoints: [join(root, "src", "index.jsx")],
    outfile: join(distDir, `${name}.js`),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    // 经典 JSX 转换 → React.createElement,使用源码里 runtime 解构出的 React
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    loader: { ".js": "jsx", ".jsx": "jsx", ".css": "text" },
    // 通过 runtime.React 使用宿主 React,自身不打包 React
    external: ["react", "react-dom"],
    minify: !watch,
    plugins: [syncToPublic],
};

if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log(`[${name}] watching src/ ...`);
} else {
    await build(options);
    console.log(`[${name}] built → dist/${name}.js`);
}
