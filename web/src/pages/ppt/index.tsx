import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Empty, Input, Progress, Steps, Tooltip } from "antd";
import { ArrowLeft, ArrowRight, FolderOpen, Plus, Sparkles, Trash2, Upload } from "lucide-react";

import { useEffectiveConfig } from "@/stores/use-config-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { generatePptOutline, type PptOutlinePage } from "@/lib/ppt/outline-prompt";
import { buildPptDeckProject } from "@/lib/ppt/deck-builder";

const { TextArea } = Input;

export default function PptPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const effectiveConfig = useEffectiveConfig();
    const projects = useCanvasStore((state) => state.projects);
    const importProject = useCanvasStore((state) => state.importProject);

    const decks = useMemo(() => projects.filter((project): project is CanvasProject & { ppt: NonNullable<CanvasProject["ppt"]> } => Boolean(project.ppt)), [projects]);

    const [wizardOpen, setWizardOpen] = useState(false);

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
                                <button
                                    key={deck.id}
                                    type="button"
                                    className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-card p-4 text-left shadow-sm transition hover:border-stone-400 dark:border-stone-800 dark:hover:border-stone-600"
                                    onClick={() => navigate(`/canvas/${deck.id}`)}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="truncate text-base font-semibold">{deck.title}</span>
                                        <FolderOpen className="size-4 shrink-0 text-stone-400" />
                                    </div>
                                    <div className="text-xs text-stone-500">
                                        共 {total} 页 · 已确认 {confirmed} 页
                                    </div>
                                    <Progress percent={total ? Math.round((confirmed / total) * 100) : 0} size="small" showInfo={false} />
                                </button>
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
            const result = await generatePptOutline(effectiveConfig, material, requirements, (text) => setOutlineRaw(text));
            setPages(result.pages);
            message.success(`已生成 ${result.pages.length} 页大纲`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "大纲生成失败，请重试");
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
        try {
            const uploaded = await Promise.all(images.map((file) => uploadImage(file)));
            setStyleRefs((prev) => [...prev, ...uploaded]);
        } catch {
            message.error("参考图上传失败");
        }
    };

    const confirmBuild = async () => {
        if (!pages.length) {
            message.error("大纲为空，请先生成或手动添加分页");
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
                            <span className="text-sm font-medium">PPT 标题</span>
                            <Input value={deckTitle} onChange={(event) => setDeckTitle(event.target.value)} placeholder="例如：2026 年度产品发布提案" />
                        </label>
                        <label className="grid gap-1.5">
                            <span className="text-sm font-medium">材料内容</span>
                            <TextArea value={material} onChange={(event) => setMaterial(event.target.value)} placeholder="粘贴 Markdown 或整份文字材料" autoSize={{ minRows: 8, maxRows: 16 }} />
                        </label>
                        <label className="grid gap-1.5">
                            <span className="text-sm font-medium">PPT 要求（可选）</span>
                            <TextArea value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="例如：9 页以内，专业咨询报告风格" autoSize={{ minRows: 2, maxRows: 6 }} />
                        </label>
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
                            <span className="text-sm font-medium">分页大纲</span>
                            <Button size="small" icon={<Sparkles className="size-3.5" />} loading={outlineLoading} onClick={() => void runOutline()}>
                                {pages.length ? "重新生成" : "生成大纲"}
                            </Button>
                        </div>

                        {outlineLoading ? <div className="thin-scrollbar max-h-40 overflow-y-auto rounded-lg border border-dashed border-stone-300 p-3 text-xs text-stone-500 dark:border-stone-700">{outlineRaw || "生成中..."}</div> : null}

                        {pages.length ? (
                            <div className="flex flex-col gap-3">
                                {pages.map((page, index) => (
                                    <div key={index} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                        <div className="mb-2 flex items-center justify-between gap-2">
                                            <span className="text-xs font-medium text-stone-500">第 {index + 1} 页</span>
                                            <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} onClick={() => removePage(index)} />
                                        </div>
                                        <div className="grid gap-2">
                                            <Input value={page.title} onChange={(event) => updatePage(index, { title: event.target.value })} placeholder="页标题" />
                                            <TextArea value={page.outline} onChange={(event) => updatePage(index, { outline: event.target.value })} placeholder="该页要点" autoSize={{ minRows: 2, maxRows: 4 }} />
                                            <Input value={page.visualHint} onChange={(event) => updatePage(index, { visualHint: event.target.value })} placeholder="视觉建议（可选）" />
                                        </div>
                                    </div>
                                ))}
                                <Button icon={<Plus className="size-3.5" />} onClick={addPage}>
                                    增加一页
                                </Button>
                            </div>
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先生成大纲，或直接手动添加分页">
                                <Button icon={<Plus className="size-3.5" />} onClick={addPage}>
                                    手动添加一页
                                </Button>
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
                            <TextArea value={styleDescription} onChange={(event) => setStyleDescription(event.target.value)} placeholder="例如：专业咨询报告风，深蓝配色，扁平化图标" autoSize={{ minRows: 3, maxRows: 6 }} />
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
