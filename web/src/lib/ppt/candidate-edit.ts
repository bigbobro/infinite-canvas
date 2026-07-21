import type { PptCandidateEditSnapshot } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

/** 候选改图计划、执行与确认血缘共用的持久化快照校验。 */
export function isPptCandidateEditSnapshot(snapshot: PptCandidateEditSnapshot | undefined, sourceNodeId: string): snapshot is PptCandidateEditSnapshot {
    if (
        !snapshot ||
        typeof sourceNodeId !== "string" ||
        !sourceNodeId.trim() ||
        typeof snapshot.baseNodeId !== "string" ||
        snapshot.baseNodeId !== sourceNodeId ||
        typeof snapshot.globalInstruction !== "string" ||
        !Array.isArray(snapshot.annotations) ||
        typeof snapshot.finalPrompt !== "string" ||
        !snapshot.finalPrompt.trim()
    )
        return false;
    if (!snapshot.globalInstruction.trim() && !snapshot.annotations.length) return false;
    if (snapshot.globalInstruction.trim() && !snapshot.finalPrompt.includes(snapshot.globalInstruction.trim())) return false;
    return snapshot.annotations.every(
        (annotation, index) =>
            annotation !== null &&
            typeof annotation === "object" &&
            Number.isInteger(annotation.index) &&
            annotation.index === index + 1 &&
            Number.isFinite(annotation.x) &&
            annotation.x >= 0 &&
            annotation.x <= 1 &&
            Number.isFinite(annotation.y) &&
            annotation.y >= 0 &&
            annotation.y <= 1 &&
            typeof annotation.instruction === "string" &&
            Boolean(annotation.instruction.trim()) &&
            snapshot.finalPrompt.includes(annotation.instruction.trim()),
    );
}

/** 无点位时冻结原图；有点位时只接受由该原图派生的唯一带标记快照。 */
export function isPptCandidateEditReferenceSnapshot(candidateEdit: PptCandidateEditSnapshot, sourceNodeId: string, sourceStorageKey: string | undefined, references: readonly ReferenceImage[] | undefined) {
    if (!sourceStorageKey || references?.length !== 1) return false;
    const reference = references[0];
    if (!reference || typeof reference.dataUrl !== "string" || !reference.dataUrl.startsWith("data:image/") || typeof reference.type !== "string" || !reference.type.startsWith("image/")) return false;
    return candidateEdit.annotations.length ? reference.id === `${sourceNodeId}-annotate` && reference.storageKey === undefined : reference.id === sourceNodeId && reference.storageKey === sourceStorageKey;
}
