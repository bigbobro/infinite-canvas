import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Empty, Input, Modal, Popconfirm, Progress, Segmented, Steps } from "antd";
import { ArrowLeft, ArrowRight, FolderOpen, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";

import { PptVisualDirectionEditor } from "@/components/ppt-visual-direction-editor";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useCanvasStore, type CanvasProject, type CanvasProjectPptStyleContract } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { hasUnresolvedPptGeneration } from "@/lib/ppt/generation-ledger";
import { resolveImageUrl } from "@/services/image-storage";
import { extractPptPages, generatePptOutline, previewExtractPages, previewOutlinePages, type PptOutlinePage } from "@/lib/ppt/outline-prompt";
import { buildPptDeckProject, type BuildPptDeckParams } from "@/lib/ppt/deck-builder";
import { buildPptPageWorkspace } from "@/lib/ppt/page-workspace";
import { createPptVisualDirectionPresetContract, findPptVisualDirectionInstructions } from "@/lib/ppt/style-contract";
import type { CanvasNodeData } from "@/types/canvas";

type PptWizardMode = NonNullable<BuildPptDeckParams["mode"]>;
type PptDeck = CanvasProject & { ppt: NonNullable<CanvasProject["ppt"]> };

const { TextArea } = Input;

/** 封面 URL:先同步用节点 content(本会话生成的图直接可用);img 报错(跨会话 blob 已死)时
 *  经 storageKey 异步重试一次,再失败才回排版化封面——绝不把本来能显示的图降级。 */
function useDeckCover(node: CanvasNodeData | null) {
    const [cover, setCover] = useState<string | null>(() => node?.metadata?.content || null);
    const retriedRef = useRef(false);
    useEffect(() => {
        retriedRef.current = false;
        setCover(node?.metadata?.content || null);
    }, [node]);
    const onCoverError = () => {
        if (!retriedRef.current && node?.metadata?.storageKey) {
            retriedRef.current = true;
            void resolveImageUrl(node.metadata.storageKey, "").then((url) => setCover(url || null));
        } else {
            setCover(null);
        }
    };
    return { cover, onCoverError };
}

/** 每次新增页卡的浮现 stagger 延迟；封顶避免页数很多时尾部等太久。 */
function revealDelay(index: number) {
    return `${Math.min(index, 8) * 60}ms`;
}

export default function PptPage() {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const effectiveConfig = useEffectiveConfig();
    const projects = useCanvasStore((state) => state.projects);
    const importProject = useCanvasStore((state) => state.importProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);

    const decks = useMemo(() => projects.filter((project): project is PptDeck => Boolean(project.ppt)), [projects]);

    const [wizardOpen, setWizardOpen] = useState(false);
    const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
    const deletingDeckIdRef = useRef<string | null>(null);

    const confirmDeleteDeck = (deck: CanvasProject) => {
        if (hasUnresolvedPptGeneration(deck.nodes)) {
            message.warning("该 PPT 仍有生成请求待处理，暂不能删除");
            return;
        }
        // 防重入:连点删除会让 modal.confirm 排队弹出第二个同款确认框(实测)。
        if (deletingDeckIdRef.current === deck.id) return;
        deletingDeckIdRef.current = deck.id;
        modal.confirm({
            title: "删除画布？",
            content: `将删除「${deck.title}」，里面的节点和连线也会一起移除，同时会从「我的画布」移除。`,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            afterClose: () => {
                deletingDeckIdRef.current = null;
            },
            onOk: () => {
                const latest = useCanvasStore.getState().projects.find((project) => project.id === deck.id);
                if (latest && hasUnresolvedPptGeneration(latest.nodes)) {
                    message.warning("该 PPT 仍有生成请求待处理，暂不能删除");
                    return;
                }
                deleteProjects([deck.id]);
                cleanupImages();
                message.success("已删除");
            },
        });
    };

    const saveRename = () => {
        if (renameTarget) renameProject(renameTarget.id, renameTarget.title);
        setRenameTarget(null);
    };

    if (wizardOpen) {
        return (
            <PptWizard
                effectiveConfig={effectiveConfig}
                onCancel={() => setWizardOpen(false)}
                onCreated={(id) => {
                    setWizardOpen(false);
                    navigate(`/canvas/${id}`);
                }}
                importProject={importProject}
                message={message}
            />
        );
    }

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">PPT 工作台</p>
                        <h1 className="mt-3 text-3xl font-semibold">我的 PPT</h1>
                        <p className="mt-2 text-sm text-stone-500">材料生成分页大纲，确定视觉方向后批量出图，交付页面图片或图片版 PPT。</p>
                    </div>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setWizardOpen(true)}>
                        新建 PPT
                    </Button>
                </header>

                {decks.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {decks.map((deck) => (
                            <DeckCard key={deck.id} deck={deck} onOpen={() => navigate(`/canvas/${deck.id}`)} onRename={() => setRenameTarget({ id: deck.id, title: deck.title })} onDelete={() => confirmDeleteDeck(deck)} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center gap-4 border-y border-stone-200 text-center dark:border-stone-800">
                        <p className="text-sm text-stone-500">从一份材料开始你的第一份 deck</p>
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setWizardOpen(true)}>
                            新建 PPT
                        </Button>
                    </section>
                )}
            </div>

            <Modal title="重命名" open={renameTarget !== null} onCancel={() => setRenameTarget(null)} onOk={saveRename} okText="保存">
                <Input value={renameTarget?.title ?? ""} onChange={(event) => setRenameTarget((prev) => (prev ? { ...prev, title: event.target.value } : prev))} onPressEnter={saveRename} autoFocus />
            </Modal>
        </main>
    );
}

function DeckCard({ deck, onOpen, onRename, onDelete }: { deck: PptDeck; onOpen: () => void; onRename: () => void; onDelete: () => void }) {
    const total = deck.ppt.pages.length;
    const workspaces = useMemo(() => [...deck.ppt.pages].sort((left, right) => left.index - right.index).map((page) => buildPptPageWorkspace(deck, page)), [deck]);
    const confirmedWorkspaces = workspaces.filter((workspace) => workspace.confirmationIssues.length === 0);
    const confirmed = confirmedWorkspaces.length;
    const { cover, onCoverError } = useDeckCover(confirmedWorkspaces[0]?.confirmedNode ?? null);
    const headline = [...deck.ppt.pages].sort((a, b) => a.index - b.index)[0]?.title || deck.title;
    const iconButtonClass =
        "flex size-7 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm transition-colors duration-150 hover:bg-black/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/70 motion-reduce:transition-none";

    return (
        <article
            className="group flex cursor-pointer flex-col overflow-hidden rounded-lg border border-stone-200 bg-card text-left shadow-sm transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:border-stone-800 dark:hover:border-stone-600"
            onClick={onOpen}
        >
            <div className="relative aspect-video w-full overflow-hidden bg-stone-100 dark:bg-stone-900">
                {cover ? (
                    <img src={cover} alt="" onError={onCoverError} className="size-full object-cover transition-transform duration-150 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100" />
                ) : (
                    <div className="flex size-full flex-col items-center justify-center gap-2 px-6 text-center">
                        <span className="text-[10px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">未定稿</span>
                        <span className="line-clamp-3 text-lg font-semibold leading-snug text-stone-600 dark:text-stone-300">{headline}</span>
                    </div>
                )}
                <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none" onClick={(event) => event.stopPropagation()}>
                    <button type="button" className={iconButtonClass} aria-label="打开" onClick={onOpen}>
                        <FolderOpen className="size-3.5" />
                    </button>
                    <button type="button" className={iconButtonClass} aria-label="重命名" onClick={onRename}>
                        <Pencil className="size-3.5" />
                    </button>
                    <button type="button" className={iconButtonClass} aria-label="删除" onClick={onDelete}>
                        <Trash2 className="size-3.5" />
                    </button>
                </div>
            </div>
            <div className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{deck.title}</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-stone-500 dark:text-stone-400">
                        {confirmed}/{total}
                    </span>
                </div>
                <Progress percent={total ? Math.round((confirmed / total) * 100) : 0} size="small" showInfo={false} strokeWidth={2} />
            </div>
        </article>
    );
}

type MessageApi = ReturnType<typeof App.useApp>["message"];

function PptWizard({
    effectiveConfig,
    onCancel,
    onCreated,
    importProject,
    message,
}: {
    effectiveConfig: ReturnType<typeof useEffectiveConfig>;
    onCancel: () => void;
    onCreated: (id: string) => void;
    importProject: (project: Partial<CanvasProject>) => string;
    message: MessageApi;
}) {
    const [step, setStep] = useState(0);
    const [mode, setMode] = useState<PptWizardMode>("outline");
    const [deckTitle, setDeckTitle] = useState("");
    const [material, setMaterial] = useState("");
    const [requirements, setRequirements] = useState("");
    const [outlineRaw, setOutlineRaw] = useState("");
    const [outlineLoading, setOutlineLoading] = useState(false);
    const [pages, setPages] = useState<PptOutlinePage[]>([]);
    const [styleContract, setStyleContract] = useState<CanvasProjectPptStyleContract>(() => createPptVisualDirectionPresetContract());
    const [extractedDirectionHint, setExtractedDirectionHint] = useState("");
    const [building, setBuilding] = useState(false);

    const runOutline = async () => {
        if (!material.trim()) {
            message.error("请先粘贴材料内容");
            return;
        }
        const previousPages = pages;
        setOutlineLoading(true);
        setOutlineRaw("");
        try {
            if (mode === "extract") {
                const result = await extractPptPages(effectiveConfig, material, (text) => {
                    setOutlineRaw(text);
                    setPages(previewExtractPages(text, material));
                });
                setPages(result.pages);
                const extractedDirection = result.globalStyle.trim();
                setExtractedDirectionHint(extractedDirection);
                setStyleContract(extractedDirection ? { source: { kind: "custom" }, direction: extractedDirection, references: [] } : createPptVisualDirectionPresetContract());
                if (result.droppedCount > 0) {
                    const shown = result.droppedTitles.slice(0, 3).join("、");
                    const suffix = result.droppedTitles.length > 3 ? ` 等 ${result.droppedTitles.length} 页` : "";
                    message.warning(`以下内容因边界识别失败被丢弃：${shown}${suffix}，请检查材料或手动补齐`);
                }
                message.success(`已展开 ${result.pages.length} 页`);
            } else {
                const result = await generatePptOutline(effectiveConfig, material, requirements, (text) => {
                    setOutlineRaw(text);
                    setPages(previewOutlinePages(text));
                });
                setPages(result.pages);
                message.success(`已生成 ${result.pages.length} 页大纲`);
            }
        } catch (error) {
            setPages(previousPages);
            message.error(error instanceof Error ? error.message : mode === "extract" ? "展开分页失败，请重试" : "大纲生成失败，请重试");
        } finally {
            setOutlineLoading(false);
        }
    };

    const updatePage = (index: number, patch: Partial<PptOutlinePage>) => setPages((prev) => prev.map((page, i) => (i === index ? { ...page, ...patch, ...(patch.outline === undefined ? {} : { sourceRange: undefined }) } : page)));
    const removePage = (index: number) => setPages((prev) => prev.filter((_, i) => i !== index));
    const addPage = () => setPages((prev) => [...prev, { title: `第${prev.length + 1}页`, outline: "", visualHint: "" }]);

    const continueToOutline = () => {
        const visualRequirement = mode === "outline" ? findPptVisualDirectionInstructions(requirements)[0] : undefined;
        if (visualRequirement) {
            message.warning(`请把视觉描述移到第三步“视觉方向”：${visualRequirement}`);
            return;
        }
        setStep(1);
    };

    const continueToVisualDirection = () => {
        const pageWithVisualOverride = pages.find((page) => findPptVisualDirectionInstructions(page.visualHint)[0]);
        if (pageWithVisualOverride) {
            message.warning(`“${pageWithVisualOverride.title}”的构图建议包含视觉风格，请移到整套“视觉方向”`);
            return;
        }
        setStep(2);
    };

    const confirmBuild = async () => {
        if (!pages.length) {
            message.error(mode === "extract" ? "分页内容为空，请先展开或手动添加分页" : "大纲为空，请先生成或手动添加分页");
            return;
        }
        if (pages.some((page) => !page.title.trim())) {
            message.error("每页需要有标题");
            return;
        }
        setBuilding(true);
        try {
            const title = deckTitle.trim() || `PPT-${new Date().toLocaleDateString()}`;
            const deck = buildPptDeckProject({
                title,
                sourceMaterial: material,
                requirements,
                styleContract,
                pages,
                mode,
            });
            const id = importProject(deck);
            message.success("画布已创建");
            onCreated(id);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "建图失败，请重试");
        } finally {
            setBuilding(false);
        }
    };

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
                <header className="flex items-center gap-3 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <Button type="text" icon={<ArrowLeft className="size-4" />} onClick={onCancel}>
                        返回列表
                    </Button>
                    <h1 className="text-xl font-semibold">新建 PPT</h1>
                </header>

                <Steps current={step} size="small" className="[&_.ant-steps-item-icon-number]:font-mono [&_.ant-steps-item-icon-number]:tabular-nums" items={[{ title: "材料与要求" }, { title: "大纲编辑" }, { title: "视觉方向" }]} />

                {step === 0 ? (
                    <div className="flex flex-col gap-4">
                        <label className="grid gap-1.5">
                            <span className="text-sm font-medium">生成方式</span>
                            <Segmented
                                block
                                value={mode}
                                onChange={(value) => setMode(value as PptWizardMode)}
                                options={[
                                    {
                                        value: "outline",
                                        label: (
                                            <span className="flex min-h-12 flex-col justify-center px-1 py-1 text-left leading-5">
                                                <span className="font-medium">从材料拆大纲</span>
                                                <span className="text-xs opacity-55">工具帮你规划分页与要点，适合还没想清楚具体每页内容</span>
                                            </span>
                                        ),
                                    },
                                    {
                                        value: "extract",
                                        label: (
                                            <span className="flex min-h-12 flex-col justify-center px-1 py-1 text-left leading-5">
                                                <span className="font-medium">已有规格，直接生图</span>
                                                <span className="text-xs opacity-55">你的稿子已写好每页提示词，按原样逐字展开、不改写</span>
                                            </span>
                                        ),
                                    },
                                ]}
                            />
                        </label>
                        <label className="grid gap-1.5">
                            <span className="text-sm font-medium">PPT 标题</span>
                            <Input value={deckTitle} onChange={(event) => setDeckTitle(event.target.value)} placeholder="例如：2026 年度产品发布提案" />
                        </label>
                        <label className="grid gap-1.5">
                            <span className="text-sm font-medium">材料内容</span>
                            <TextArea
                                value={material}
                                onChange={(event) => setMaterial(event.target.value)}
                                placeholder={mode === "extract" ? "粘贴已经写好的完整提示词稿，每页内容按原样展开" : "粘贴 Markdown 或整份文字材料"}
                                autoSize={{ minRows: 8, maxRows: 16 }}
                            />
                        </label>
                        {mode === "outline" ? (
                            <label className="grid gap-1.5">
                                <span className="text-sm font-medium">PPT 要求（可选）</span>
                                <TextArea value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="例如：9 页以内，保留全部数据，禁止二维码" autoSize={{ minRows: 2, maxRows: 6 }} />
                            </label>
                        ) : null}
                        <div className="flex justify-end">
                            <Button type="primary" icon={<ArrowRight className="size-4" />} iconPosition="end" onClick={continueToOutline}>
                                下一步
                            </Button>
                        </div>
                    </div>
                ) : null}

                {step === 1 ? (
                    <div className="flex flex-col gap-4">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{mode === "extract" ? "分页内容" : "分页大纲"}</span>
                            {pages.length ? (
                                <Button size="small" icon={<Sparkles className="size-3.5" />} loading={outlineLoading} onClick={() => void runOutline()}>
                                    {mode === "extract" ? "重新展开" : "重新生成"}
                                </Button>
                            ) : null}
                        </div>

                        {outlineLoading ? (
                            <div className="thin-scrollbar max-h-96 overflow-y-auto rounded-lg border border-dashed border-stone-300 p-3 font-mono text-xs text-stone-500 dark:border-stone-700 dark:text-stone-400">{outlineRaw || "生成中..."}</div>
                        ) : null}

                        {pages.length ? (
                            <div className="flex flex-col gap-3">
                                {pages.map((page, index) => (
                                    <div
                                        key={index}
                                        style={{ animationDelay: revealDelay(index) }}
                                        className="group animate-in fade-in-0 slide-in-from-bottom-2 duration-200 ease-out motion-reduce:animate-none rounded-lg border border-stone-200 p-3 dark:border-stone-800"
                                    >
                                        <div className="mb-2 flex items-center justify-between gap-2">
                                            <span className="font-mono text-xs font-medium tabular-nums text-stone-500">{String(index + 1).padStart(2, "0")}</span>
                                            <Popconfirm title="删除该页？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => removePage(index)}>
                                                <Button
                                                    size="small"
                                                    type="text"
                                                    danger
                                                    icon={<Trash2 className="size-3.5" />}
                                                    className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
                                                    aria-label="删除该页"
                                                />
                                            </Popconfirm>
                                        </div>
                                        <div className="grid gap-2">
                                            <Input value={page.title} onChange={(event) => updatePage(index, { title: event.target.value })} placeholder="页标题" />
                                            <TextArea
                                                value={page.outline}
                                                onChange={(event) => updatePage(index, { outline: event.target.value })}
                                                placeholder={mode === "extract" ? "该页完整提示词" : "该页要点"}
                                                autoSize={mode === "extract" ? { minRows: 4, maxRows: 12 } : { minRows: 2, maxRows: 4 }}
                                            />
                                            {mode === "outline" ? <Input value={page.visualHint} onChange={(event) => updatePage(index, { visualHint: event.target.value })} placeholder="页面构图或素材建议（可选）" /> : null}
                                        </div>
                                    </div>
                                ))}
                                <Button icon={<Plus className="size-3.5" />} onClick={addPage}>
                                    增加一页
                                </Button>
                            </div>
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={mode === "extract" ? "先展开分页，或直接手动添加分页" : "先生成大纲，或直接手动添加分页"}>
                                <div className="flex flex-col items-center gap-2">
                                    <Button type="primary" icon={<Sparkles className="size-3.5" />} loading={outlineLoading} onClick={() => void runOutline()}>
                                        {mode === "extract" ? "展开分页" : "生成大纲"}
                                    </Button>
                                    <Button type="text" icon={<Plus className="size-3.5" />} onClick={addPage}>
                                        手动添加一页
                                    </Button>
                                </div>
                            </Empty>
                        )}

                        <div className="flex justify-between">
                            <Button icon={<ArrowLeft className="size-4" />} onClick={() => setStep(0)}>
                                上一步
                            </Button>
                            <Button type="primary" icon={<ArrowRight className="size-4" />} iconPosition="end" disabled={!pages.length} onClick={continueToVisualDirection}>
                                下一步
                            </Button>
                        </div>
                    </div>
                ) : null}

                {step === 2 ? (
                    <div className="flex flex-col gap-4">
                        <div>
                            <h2 className="text-base font-semibold">选择整套 PPT 的视觉方向</h2>
                            <p className="mt-1 text-sm text-stone-500">先从一个清晰方向开始，之后仍可在工作台调整。</p>
                        </div>
                        <PptVisualDirectionEditor value={styleContract} onChange={setStyleContract} extractedDirectionHint={mode === "extract" ? extractedDirectionHint : undefined} />

                        <div className="flex justify-between">
                            <Button icon={<ArrowLeft className="size-4" />} onClick={() => setStep(1)}>
                                上一步
                            </Button>
                            <Button type="primary" icon={<Sparkles className="size-4" />} loading={building} onClick={() => void confirmBuild()}>
                                生成画布
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>
        </main>
    );
}
