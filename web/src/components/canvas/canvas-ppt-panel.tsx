import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { App, Button, Checkbox, Tooltip } from "antd";
import { nanoid } from "nanoid";
import { CheckCircle2, ChevronRight, Download, Layers, LoaderCircle, RotateCcw, Sparkles, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { pageTakes, useCanvasStore, type CanvasProjectPptPage } from "@/stores/canvas/use-canvas-store";
import { PPT_PAGE_PROMPT } from "@/lib/ppt/deck-builder";
import { exportPptDeckImages, resolvePageImageNode } from "@/lib/ppt/deck-export";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

// 新增线路时新节点的行间距，与 deck-builder.ts 的 ROW_GAP 保持一致的间距感（该常量未导出，各自维护）。
const ROW_GAP = 48;

export function CanvasPptPanel() {
    const { message } = App.useApp();
    const params = useParams<{ id: string }>();
    const projectId = params.id || "";
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const updateProject = useCanvasStore((state) => state.updateProject);
    const canvasContext = useAgentStore((state) => state.canvasContext);
    const [open, setOpen] = useState(true);
    const [skipAnchorOverride, setSkipAnchorOverride] = useState<boolean | null>(null);
    const [exporting, setExporting] = useState(false);

    const nodeById = useMemo(() => new Map((currentProject?.nodes || []).map((node) => [node.id, node])), [currentProject?.nodes]);

    const ppt = currentProject?.ppt;
    if (!ppt || !currentProject) return null;

    // 生图模式（extract）的 config 节点靠 composerContent: "" 挡住 project.tsx:2014 的 prompt 回写，
    // 面板可以停传 PPT_PAGE_PROMPT；老模式（outline，含未标记 mode 的存量 deck）没有这道挡板，
    // 必须继续传常量，否则第 2 次生成起上游大纲会被重复拼接进被污染的 prompt 字段（design.md §4.1）。
    const isExtractMode = ppt.mode === "extract";
    const buildRunGenerationOp = (configNodeId: string): CanvasAgentOp => (isExtractMode ? { type: "run_generation", nodeId: configNodeId, mode: "image" } : { type: "run_generation", nodeId: configNodeId, mode: "image", prompt: PPT_PAGE_PROMPT });

    const pages = ppt.pages;
    const confirmedCount = pages.filter((page) => page.confirmedNodeId).length;
    const styleNodeIds = currentProject.nodes.filter((node) => node.metadata?.pptRole === "style").map((node) => node.id);
    // 生图模式且无风格节点 = 每页已自带风格，没有需要向后传播的全局视觉 → 锚定默认关（AC8）；
    // 用户手动勾/取消后以其选择为准。
    const skipAnchor = skipAnchorOverride ?? (isExtractMode && styleNodeIds.length === 0);

    const runGeneration = (page: CanvasProjectPptPage) => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        const configNodeId = pageTakes(page).at(-1)?.configNodeId;
        if (!configNodeId || !nodeById.has(configNodeId)) {
            message.warning(`第 ${page.index} 页结构缺失，请先新增线路`);
            return;
        }
        canvasContext.applyOps([buildRunGenerationOp(configNodeId)]);
    };

    const generateAll = (targetPages: CanvasProjectPptPage[]) => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        const ops: CanvasAgentOp[] = targetPages
            .map((page) => pageTakes(page).at(-1)?.configNodeId)
            .filter((configNodeId): configNodeId is string => configNodeId != null && nodeById.has(configNodeId))
            .map((configNodeId) => buildRunGenerationOp(configNodeId));
        if (!ops.length) {
            message.warning("没有可生成的页面");
            return;
        }
        canvasContext.applyOps(ops);
    };

    const setPageConfirmed = (page: CanvasProjectPptPage, confirmedNodeId?: string) => {
        updateProject(projectId, { ppt: { ...ppt, pages: pages.map((item) => (item.index === page.index ? { ...item, confirmedNodeId } : item)) } });
    };

    const firstPage = pages.find((page) => page.index === 1) || pages[0];
    const firstPageImageNode = firstPage ? resolvePageImageNode(currentProject, firstPage) : null;
    const firstConfirmed = Boolean(firstPage?.confirmedNodeId && firstPageImageNode?.id === firstPage.confirmedNodeId);
    const anchorPending = !skipAnchor && pages.length > 1 && !ppt.anchorConfirmed;

    const confirmAnchorAndGenerateRest = () => {
        if (!canvasContext || !firstPage?.confirmedNodeId) return;
        const anchorNodeId = firstPage.confirmedNodeId;
        const restConfigNodeIds = pages
            .filter((page) => page.index !== firstPage.index)
            .map((page) => pageTakes(page).at(-1)?.configNodeId)
            .filter((configNodeId): configNodeId is string => configNodeId != null && nodeById.has(configNodeId));
        if (!restConfigNodeIds.length) return;
        const ops: CanvasAgentOp[] = [
            ...restConfigNodeIds.map((configNodeId): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId: anchorNodeId, toNodeId: configNodeId })),
            ...restConfigNodeIds.map((configNodeId): CanvasAgentOp => buildRunGenerationOp(configNodeId)),
        ];
        canvasContext.applyOps(ops);
        updateProject(projectId, { ppt: { ...ppt, anchorConfirmed: true } });
    };

    let batchLabel = "全部生成";
    let batchAction = () => generateAll(pages);
    if (anchorPending && firstPage) {
        if (!firstConfirmed) {
            batchLabel = "生成第 1 页（锚定）";
            batchAction = () => runGeneration(firstPage);
        } else {
            batchLabel = "确认后生成其余页";
            batchAction = confirmAnchorAndGenerateRest;
        }
    }

    // 新增线路：追加一条平行的 outline/config，不销毁已有的（U3 情况②）。原 outline/config
    // 节点、已确认图、锚定状态都保持不动——旧线路仍是合法候选（design.md §2）。
    const addPageTake = (page: CanvasProjectPptPage) => {
        if (!canvasContext) {
            message.warning("画布尚未就绪，请稍后再试");
            return;
        }
        const outlineId = nanoid();
        const configId = nanoid();
        // 生图模式（extract）下 page.outline 已是原稿逐字切片，不加「标题：」「视觉建议：」前缀，
        // 与 deck-builder.ts 的 outlineContent 组装规则保持一致（design.md §5）。新线路的初始内容
        // 复制自当前 page.outline（用户拍板：要「改」不要「重写」）。
        const outlineContent = isExtractMode ? page.outline : [`标题：${page.title}`, page.outline, page.visualHint ? `视觉建议：${page.visualHint}` : ""].filter(Boolean).join("\n\n");
        const configMetadata: CanvasNodeMetadata = { prompt: isExtractMode ? "" : PPT_PAGE_PROMPT, size: "16:9", count: 1, pptPageIndex: page.index, pptRole: "page" };
        if (isExtractMode) configMetadata.composerContent = "";

        // 新节点摆在最新一条线路的下方一行，避免叠在既有节点上；取不到位置就交给 add_node 的默认摆位。
        const latestTake = pageTakes(page).at(-1);
        const latestOutlineNode = latestTake ? nodeById.get(latestTake.anchorNodeId) : undefined;
        const latestConfigNode = latestTake ? nodeById.get(latestTake.configNodeId) : undefined;
        const outlinePosition = latestOutlineNode ? { x: latestOutlineNode.position.x, y: latestOutlineNode.position.y + latestOutlineNode.height + ROW_GAP } : undefined;
        const configPosition = latestConfigNode ? { x: latestConfigNode.position.x, y: latestConfigNode.position.y + latestConfigNode.height + ROW_GAP } : undefined;

        const ops: CanvasAgentOp[] = [
            { type: "add_node", id: outlineId, nodeType: CanvasNodeType.Text, title: `第${page.index}页大纲`, position: outlinePosition, metadata: { content: outlineContent, status: "success", pptPageIndex: page.index, pptRole: "outline" } },
            { type: "add_node", id: configId, nodeType: CanvasNodeType.Config, title: `第${page.index}页生成配置`, position: configPosition, metadata: configMetadata },
            { type: "connect_nodes", fromNodeId: outlineId, toNodeId: configId },
            ...styleNodeIds.map((id): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId: id, toNodeId: configId })),
        ];
        canvasContext.applyOps(ops);
        updateProject(projectId, {
            ppt: {
                ...ppt,
                pages: pages.map((item) => (item.index === page.index ? { ...item, takes: [...pageTakes(item), { anchorNodeId: outlineId, configNodeId: configId }], anchorNodeId: undefined, configNodeId: undefined } : item)),
            },
        });
        message.success(`第 ${page.index} 页已新增线路`);
    };

    const handleExport = async () => {
        setExporting(true);
        try {
            await exportPptDeckImages(currentProject);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "打包下载失败");
        } finally {
            setExporting(false);
        }
    };

    if (!open) {
        return (
            <Tooltip title="展开 PPT 面板" placement="left">
                <button
                    type="button"
                    className="absolute right-4 top-20 z-40 grid size-10 place-items-center rounded-full border shadow-lg backdrop-blur transition hover:scale-105"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    onClick={() => setOpen(true)}
                    aria-label="展开 PPT 面板"
                >
                    <Layers className="size-4" />
                </button>
            </Tooltip>
        );
    }

    return (
        <div
            className="absolute right-4 top-20 z-40 flex max-h-[calc(100%-140px)] w-[380px] flex-col overflow-hidden rounded-xl border shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: theme.toolbar.border }}>
                <div className="flex min-w-0 items-center gap-2">
                    <Layers className="size-4 shrink-0" />
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">PPT 面板</div>
                        <div className="truncate text-[11px]" style={{ color: theme.node.muted }}>
                            {confirmedCount}/{pages.length} 页已确认
                        </div>
                    </div>
                </div>
                <button type="button" className="grid size-7 place-items-center rounded-md" style={{ color: theme.node.muted }} onClick={() => setOpen(false)} aria-label="收起 PPT 面板">
                    <X className="size-4" />
                </button>
            </div>

            <div className="flex items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: theme.toolbar.border }}>
                <Checkbox checked={!skipAnchor} disabled={pages.length <= 1} onChange={(event) => setSkipAnchorOverride(!event.target.checked)}>
                    <span className="text-xs" style={{ color: theme.node.muted }}>
                        首页锚定
                    </span>
                </Checkbox>
                <Button size="small" type="primary" icon={<Sparkles className="size-3.5" />} disabled={!canvasContext} onClick={batchAction}>
                    {batchLabel}
                </Button>
            </div>

            <div className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                {pages.map((page) => (
                    <PptPageRow
                        key={page.index}
                        page={page}
                        theme={theme}
                        configNode={nodeById.get(pageTakes(page).at(-1)?.configNodeId ?? "")}
                        imageNode={resolvePageImageNode(currentProject, page)}
                        onGenerate={() => runGeneration(page)}
                        onConfirm={(nodeId) => setPageConfirmed(page, nodeId)}
                        onAddTake={() => addPageTake(page)}
                    />
                ))}
            </div>

            <div className="border-t px-3 py-2.5" style={{ borderColor: theme.toolbar.border }}>
                <Button block icon={exporting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} disabled={exporting} onClick={() => void handleExport()}>
                    打包下载
                </Button>
            </div>
        </div>
    );
}

function PptPageRow({
    page,
    theme,
    configNode,
    imageNode,
    onGenerate,
    onConfirm,
    onAddTake,
}: {
    page: CanvasProjectPptPage;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    configNode?: CanvasNodeData;
    imageNode: CanvasNodeData | null;
    onGenerate: () => void;
    onConfirm: (nodeId?: string) => void;
    onAddTake: () => void;
}) {
    const generating = configNode?.metadata?.status === "loading";
    const confirmed = Boolean(page.confirmedNodeId && imageNode?.id === page.confirmedNodeId);

    return (
        <div className="flex gap-2.5 rounded-lg border p-2" style={{ borderColor: theme.node.stroke }}>
            <div className="flex h-[54px] w-[96px] shrink-0 items-center justify-center overflow-hidden rounded-md" style={{ background: theme.node.fill }}>
                {imageNode?.metadata?.content ? (
                    <img src={imageNode.metadata.content} alt={page.title} className="size-full object-cover" />
                ) : generating ? (
                    <LoaderCircle className="size-4 animate-spin" style={{ color: theme.node.muted }} />
                ) : (
                    <span className="text-[10px]" style={{ color: theme.node.faint }}>
                        未生成
                    </span>
                )}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                    <span className="shrink-0 text-[11px] font-medium" style={{ color: theme.node.muted }}>
                        第{page.index}页
                    </span>
                    <span className="truncate text-sm font-medium">{page.title}</span>
                    {confirmed ? <CheckCircle2 className="size-3.5 shrink-0" style={{ color: "#16a34a" }} /> : null}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {!configNode ? (
                        <span className="text-xs" style={{ color: "#dc2626" }}>
                            结构缺失
                        </span>
                    ) : (
                        <>
                            <Button size="small" disabled={generating} icon={generating ? <LoaderCircle className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} onClick={onGenerate}>
                                {generating ? "生成中" : imageNode ? "重新生成" : "生成"}
                            </Button>
                            <Button size="small" disabled={!imageNode || generating} onClick={() => onConfirm(confirmed ? undefined : imageNode?.id)}>
                                {confirmed ? "取消确认" : "确认此页"}
                            </Button>
                        </>
                    )}
                    <Button size="small" icon={<ChevronRight className="size-3" />} onClick={onAddTake}>
                        新增线路
                    </Button>
                </div>
            </div>
        </div>
    );
}
