import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Empty, Input, Modal, Popconfirm, Progress, Segmented, Steps, Tooltip } from "antd";
import { ArrowLeft, ArrowRight, FolderOpen, Pencil, Plus, Sparkles, Trash2, Upload } from "lucide-react";

import { useEffectiveConfig } from "@/stores/use-config-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { extractPptPages, generatePptOutline, type PptOutlinePage } from "@/lib/ppt/outline-prompt";
import { buildPptDeckProject, type BuildPptDeckParams } from "@/lib/ppt/deck-builder";

type PptWizardMode = NonNullable<BuildPptDeckParams["mode"]>;

const { TextArea } = Input;

export default function PptPage() {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const effectiveConfig = useEffectiveConfig();
    const projects = useCanvasStore((state) => state.projects);
    const importProject = useCanvasStore((state) => state.importProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);

    const decks = useMemo(() => projects.filter((project): project is CanvasProject & { ppt: NonNullable<CanvasProject["ppt"]> } => Boolean(project.ppt)), [projects]);

    const [wizardOpen, setWizardOpen] = useState(false);
    const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);

    const confirmDeleteDeck = (deck: CanvasProject) => {
        modal.confirm({
            title: "删除画布？",
            content: `将删除「${deck.title}」，里面的节点和连线也会一起移除，同时会从「我的画布」移除。`,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => {
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
                        <p className="mt-2 text-sm text-stone-500">材料生成分页大纲，配置风格后批量出图，交付按页命名的图片压缩包。</p>
                    </div>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setWizardOpen(true)}>
                        新建 PPT
                    </Button>
                </header>

                {decks.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {decks.map((deck) => {
                            const total = deck.ppt.pages.length;
                            const confirmed = deck.ppt.pages.filter((page) => page.confirmedNodeId).length;
                            return (
                                <article
                                    key={deck.id}
                                    className="flex cursor-pointer flex-col gap-3 rounded-lg border border-stone-200 bg-card p-4 text-left shadow-sm transition hover:border-stone-400 dark:border-stone-800 dark:hover:border-stone-600"
                                    onClick={() => navigate(`/canvas/${deck.id}`)}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="truncate text-base font-semibold">{deck.title}</span>
                                        <div className="flex shrink-0 items-center gap-1" onClick={(event) => event.stopPropagation()}>
                                            <Button type="text" size="small" shape="circle" icon={<Pencil className="size-3.5" />} aria-label="重命名" onClick={() => setRenameTarget({ id: deck.id, title: deck.title })} />
                                            <Button type="text" size="small" shape="circle" danger icon={<Trash2 className="size-3.5" />} aria-label="删除" onClick={() => confirmDeleteDeck(deck)} />
                                            <FolderOpen className="size-4 text-stone-400" />
                                        </div>
                                    </div>
                                    <div className="text-xs text-stone-500">
                                        共 {total} 页 · 已确认 {confirmed} 页
                                    </div>
                                    <Progress percent={total ? Math.round((confirmed / total) * 100) : 0} size="small" showInfo={false} />
                                </article>
                            );
                        })}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 PPT 工程" />
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={() => setWizardOpen(true)}>
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
    const [styleDescription, setStyleDescription] = useState("");
    const [styleRefs, setStyleRefs] = useState<UploadedImage[]>([]);
    const [building, setBuilding] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const runOutline = async () => {
        if (!material.trim()) {
            message.error("请先粘贴材料内容");
            return;
        }
        setOutlineLoading(true);
        setOutlineRaw("");
        try {
            if (mode === "extract") {
                const result = await extractPptPages(effectiveConfig, material, (text) => setOutlineRaw(text));
                setPages(result.pages);
                setStyleDescription(result.globalStyle);
                if (result.droppedCount > 0) {
                    const shown = result.droppedTitles.slice(0, 3).join("、");
                    const suffix = result.droppedTitles.length > 3 ? ` 等 ${result.droppedTitles.length} 页` : "";
                    message.warning(`以下内容因边界识别失败被丢弃：${shown}${suffix}，请检查材料或手动补齐`);
                }
                message.success(`已展开 ${result.pages.length} 页`);
            } else {
                const result = await generatePptOutline(effectiveConfig, material, requirements, (text) => setOutlineRaw(text));
                setPages(result.pages);
                message.success(`已生成 ${result.pages.length} 页大纲`);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : mode === "extract" ? "展开分页失败，请重试" : "大纲生成失败，请重试");
        } finally {
            setOutlineLoading(false);
        }
    };

    const updatePage = (index: number, patch: Partial<PptOutlinePage>) => setPages((prev) => prev.map((page, i) => (i === index ? { ...page, ...patch } : page)));
    const removePage = (index: number) => setPages((prev) => prev.filter((_, i) => i !== index));
    const addPage = () => setPages((prev) => [...prev, { title: `第${prev.length + 1}页`, outline: "", visualHint: "" }]);

    const addStyleRefs = async (files: FileList | null) => {
        const images = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!images.length) return;
        const results = await Promise.allSettled(images.map((file) => uploadImage(file)));
        const uploaded: UploadedImage[] = [];
        const failedNames: string[] = [];
        results.forEach((result, index) => {
            if (result.status === "fulfilled") uploaded.push(result.value);
            else failedNames.push(images[index].name);
        });
        if (uploaded.length) setStyleRefs((prev) => [...prev, ...uploaded]);
        if (failedNames.length && uploaded.length) {
            message.warning(`${failedNames.length} 张上传失败：${failedNames.join("、")}`);
        } else if (failedNames.length) {
            message.error(`参考图上传失败：${failedNames.join("、")}`);
        }
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
                style: { description: styleDescription.trim() },
                pages,
                uploadedRefs: styleRefs,
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

                <Steps current={step} size="small" items={[{ title: "材料与要求" }, { title: "大纲编辑" }, { title: "风格配置" }]} />

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
                                <TextArea value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="例如：9 页以内，专业咨询报告风格" autoSize={{ minRows: 2, maxRows: 6 }} />
                            </label>
                        ) : null}
                        <div className="flex justify-end">
                            <Button type="primary" icon={<ArrowRight className="size-4" />} iconPosition="end" onClick={() => setStep(1)}>
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

                        {outlineLoading ? <div className="thin-scrollbar max-h-40 overflow-y-auto rounded-lg border border-dashed border-stone-300 p-3 text-xs text-stone-500 dark:border-stone-700">{outlineRaw || "生成中..."}</div> : null}

                        {pages.length ? (
                            <div className="flex flex-col gap-3">
                                {pages.map((page, index) => (
                                    <div key={index} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                        <div className="mb-2 flex items-center justify-between gap-2">
                                            <span className="text-xs font-medium text-stone-500">第 {index + 1} 页</span>
                                            <Popconfirm title="删除该页？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => removePage(index)}>
                                                <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} />
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
                                            {mode === "outline" ? <Input value={page.visualHint} onChange={(event) => updatePage(index, { visualHint: event.target.value })} placeholder="视觉建议（可选）" /> : null}
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
                            <Button type="primary" icon={<ArrowRight className="size-4" />} iconPosition="end" disabled={!pages.length} onClick={() => setStep(2)}>
                                下一步
                            </Button>
                        </div>
                    </div>
                ) : null}

                {step === 2 ? (
                    <div className="flex flex-col gap-4">
                        <label className="grid gap-1.5">
                            <span className="text-sm font-medium">风格描述</span>
                            {mode === "extract" ? (
                                <p className="text-xs text-stone-500">以下内容是从原文中未被任何一页占用的部分自动摘录（可能混有与风格无关的说明文字），仅供参考。若每页已自带风格，删空即可；否则请自行删减到只剩全局视觉风格（配色、背景、字体等）。</p>
                            ) : null}
                            <TextArea
                                value={styleDescription}
                                onChange={(event) => setStyleDescription(event.target.value)}
                                placeholder="例如：专业咨询报告风，深蓝配色，扁平化图标"
                                autoSize={mode === "extract" ? { minRows: 6, maxRows: 20 } : { minRows: 3, maxRows: 6 }}
                            />
                        </label>

                        <div>
                            <div className="mb-1.5 flex items-center justify-between">
                                <span className="text-sm font-medium">风格参考图（可选）</span>
                                <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                    上传
                                </Button>
                            </div>
                            <div className="hover-scrollbar flex min-h-24 w-full gap-2 overflow-x-auto rounded-lg border border-dashed border-stone-300 p-2 dark:border-stone-700">
                                {styleRefs.map((ref, index) => (
                                    <div key={ref.storageKey} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                        <img src={ref.url} alt={`风格参考图${index + 1}`} className="size-full object-cover" />
                                        <Tooltip title="移除">
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                onClick={() => setStyleRefs((prev) => prev.filter((item) => item.storageKey !== ref.storageKey))}
                                                aria-label="移除参考图"
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </Tooltip>
                                    </div>
                                ))}
                                {!styleRefs.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">暂无参考图</div> : null}
                            </div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                multiple
                                className="hidden"
                                onChange={(event) => {
                                    void addStyleRefs(event.target.files);
                                    event.target.value = "";
                                }}
                            />
                        </div>

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
