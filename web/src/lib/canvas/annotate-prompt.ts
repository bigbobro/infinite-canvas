// 二开：PPT 整页要求 + 可选点位批注 → 冻结修改快照。
// 不给物体名、不加视觉识别步骤；没有点位时也不得加入任何标记话术。

import type { PptCandidateEditSnapshot } from "@/types/canvas";

export type AnnotatePin = {
    id: string;
    x: number; // 相对坐标 0..1
    y: number; // 相对坐标 0..1
    text: string; // 改成什么
};

const CIRCLED_NUMBERS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

function circledNumber(index: number) {
    return CIRCLED_NUMBERS[index] || `(${index + 1})`;
}

/** 整页要求和有效点位都为空时返回 null；结果可直接作为提交前的冻结快照。 */
export function compileCandidateEdit(baseNodeId: string, globalInstruction: string, pins: AnnotatePin[]): PptCandidateEditSnapshot | null {
    const normalizedGlobalInstruction = globalInstruction.trim();
    const annotations = pins.flatMap((pin) => {
        const instruction = pin.text.trim();
        return instruction ? [{ index: 0, x: pin.x, y: pin.y, instruction }] : [];
    });
    annotations.forEach((annotation, index) => {
        annotation.index = index + 1;
    });
    if (!normalizedGlobalInstruction && !annotations.length) return null;

    const prompt: string[] = [];
    if (annotations.length) {
        prompt.push("这张图上有红色圆形编号标记。请优先按以下点位要求修改：");
        prompt.push(...annotations.map((annotation, index) => `${circledNumber(index)} 标记所指的对象 → ${annotation.instruction}；`));
    }
    if (normalizedGlobalInstruction) {
        prompt.push(annotations.length ? "然后按以下整页要求修改：" : "请按以下整页要求修改这张图：", normalizedGlobalInstruction);
    }
    if (annotations.length && normalizedGlobalInstruction) prompt.push("点位要求与整页要求冲突时，以点位要求为准；整页要求同样适用于所有局部修改。");
    prompt.push("未被上述要求触及的其余所有元素、文字、配色、版式完全保持不变。");
    if (annotations.length) prompt.push("输出图中【不得保留】这些红色编号标记。");

    return { baseNodeId, globalInstruction: normalizedGlobalInstruction, annotations, finalPrompt: prompt.join("\n") };
}

/** 保留旧的点位专用入口；空文本的 pin 会被忽略。 */
export function buildAnnotatePrompt(pins: AnnotatePin[]) {
    return compileCandidateEdit("", "", pins)?.finalPrompt ?? "";
}
