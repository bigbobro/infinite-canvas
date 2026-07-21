import { useEffect, useState } from "react";
import { Alert, App, Modal } from "antd";

import { PptVisualDirectionEditor } from "@/components/ppt-visual-direction-editor";
import { createPptStyleContractDraft, samePptStyleContract, validatePptStyleContract } from "@/lib/ppt/style-contract";
import { flushCanvasStore, useCanvasStore, type CanvasProjectPptStyleContract } from "@/stores/canvas/use-canvas-store";

export function CanvasPptVisualDirectionDialog({ open, projectId, onClose }: { open: boolean; projectId: string; onClose: () => void }) {
    const { message } = App.useApp();
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const setDeckStyleContract = useCanvasStore((state) => state.setDeckStyleContract);
    const [draft, setDraft] = useState<CanvasProjectPptStyleContract>();
    const [saving, setSaving] = useState(false);
    const deckBriefVersion = project?.ppt?.deckBrief.version;

    useEffect(() => {
        if (!open) return;
        const latest = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (latest?.ppt) setDraft(createPptStyleContractDraft(latest.ppt.deckBrief.styleContract));
    }, [deckBriefVersion, open, projectId]);

    const save = async () => {
        if (!project?.ppt || !draft || saving) return;
        const issue = validatePptStyleContract(draft)[0];
        if (issue) {
            message.error(issue);
            return;
        }
        if (samePptStyleContract(project.ppt.deckBrief.styleContract, draft)) {
            message.info("视觉方向未变化");
            onClose();
            return;
        }
        const invalidatedCount = project.ppt.pages.filter((page) => Boolean(page.confirmedNodeId)).length;
        setSaving(true);
        try {
            setDeckStyleContract(projectId, project.ppt.deckBrief.version, draft);
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
            onOk={() => void save()}
            onCancel={onClose}
            destroyOnHidden
        >
            <div className="space-y-4 pt-1">
                <Alert type="warning" showIcon title="修改会清除全部页面的已确认状态" description="已有方案、候选稿和编译历史都会保留，你可以重新选择并确认旧候选。" />
                {draft ? <PptVisualDirectionEditor value={draft} onChange={setDraft} /> : null}
            </div>
        </Modal>
    );
}
