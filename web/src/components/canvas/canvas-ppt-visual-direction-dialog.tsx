import { useEffect, useState } from "react";
import { Alert, App, Button, Modal } from "antd";

import { PptVisualDirectionEditor } from "@/components/ppt-visual-direction-editor";
import { createPptStyleContractDraft, samePptStyleContract, validatePptStyleContract } from "@/lib/ppt/style-contract";
import { flushCanvasStore, useCanvasStore, type CanvasProject, type CanvasProjectPptStyleContract } from "@/stores/canvas/use-canvas-store";

function getStructuredPpt(project: CanvasProject | undefined) {
    const ppt = project?.ppt;
    if (ppt?.compilePolicy !== "structured" || !ppt.deckBrief || !Array.isArray(ppt.pages) || !Array.isArray(ppt.pageSpecs)) return undefined;
    return ppt;
}

export function CanvasPptVisualDirectionDialog({ open, projectId, onClose }: { open: boolean; projectId: string; onClose: () => void }) {
    const { message } = App.useApp();
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const setDeckStyleContract = useCanvasStore((state) => state.setDeckStyleContract);
    const [draft, setDraft] = useState<CanvasProjectPptStyleContract>();
    const [saving, setSaving] = useState(false);
    const structuredPpt = getStructuredPpt(project);
    const deckBriefVersion = structuredPpt?.deckBrief.version;

    useEffect(() => {
        if (!open) return;
        const latest = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        const latestPpt = getStructuredPpt(latest);
        setDraft(latestPpt ? createPptStyleContractDraft(latestPpt.deckBrief.styleContract) : undefined);
    }, [deckBriefVersion, open, projectId]);

    const save = async () => {
        if (!structuredPpt || !draft || saving) return;
        const latestPpt = getStructuredPpt(useCanvasStore.getState().projects.find((item) => item.id === projectId));
        if (!latestPpt) {
            message.error("当前工程已不能编辑视觉方向");
            return;
        }
        if (latestPpt.deckBrief.version !== deckBriefVersion) {
            message.error("PPT 全局规格已变更，请刷新后重试");
            return;
        }
        const issue = validatePptStyleContract(draft)[0];
        if (issue) {
            message.error(issue);
            return;
        }
        if (samePptStyleContract(latestPpt.deckBrief.styleContract, draft)) {
            message.info("视觉方向未变化");
            onClose();
            return;
        }
        const invalidatedCount = latestPpt.pages.filter((page) => Boolean(page.confirmedNodeId)).length;
        setSaving(true);
        try {
            setDeckStyleContract(projectId, latestPpt.deckBrief.version, draft);
            await flushCanvasStore();
            message.success(invalidatedCount ? `视觉方向已更新，${invalidatedCount} 页需要重新确认` : "视觉方向已更新");
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "视觉方向保存失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            title="视觉方向"
            open={open}
            width={760}
            okText="保存视觉方向"
            cancelText="取消"
            confirmLoading={saving}
            closable={!saving}
            mask={{ closable: !saving }}
            keyboard={!saving}
            cancelButtonProps={{ disabled: saving }}
            footer={structuredPpt ? undefined : <Button onClick={onClose}>关闭</Button>}
            onOk={() => void save()}
            onCancel={onClose}
            destroyOnHidden
        >
            <div className="space-y-4 pt-1">
                {structuredPpt ? (
                    <>
                        <Alert type="warning" showIcon title="修改会清除全部页面的已确认状态" description="已有方案、候选稿和编译历史都会保留，你可以重新选择并确认旧候选。" />
                        {draft ? <PptVisualDirectionEditor value={draft} onChange={setDraft} /> : null}
                    </>
                ) : project?.ppt?.compilePolicy === "verbatim" ? (
                    <Alert type="info" showIcon title="逐字规格不使用视觉方向 Contract" description="这类工程保留已定稿文字，不单独设置整套视觉方向。" />
                ) : (
                    <Alert type="error" showIcon title="无法读取视觉方向" description="当前工程缺少可用的 PPT 内容规格。" />
                )}
            </div>
        </Modal>
    );
}
