// 二开：PPT Annotate。pin 列表 → prompt 文本。
// 模板照搬 research/annotate_exp.py 的 B2_PROMPT（已实测 7 次真实 API 调用验证有效，见父任务 prd.md E30）。
// 「其余……完全保持不变」「不得保留标记」两句是实测过的措辞，不要改动。
// 不给物体名、不加视觉识别步骤——E30 已证仅给位置即可准确命中，加识别步骤只会白花一次调用。

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

/** 空文本的 pin 会被忽略；若过滤后无有效 pin 返回空字符串（调用方需自行拦截）。 */
export function buildAnnotatePrompt(pins: AnnotatePin[]) {
    const validPins = pins.filter((pin) => pin.text.trim());
    if (!validPins.length) return "";
    const lines = validPins.map((pin, index) => `${circledNumber(index)} 标记所指的那个图标 → ${pin.text.trim()}；`);
    return ["这张图上有红色圆形编号标记。请按标记修改，其余所有元素、文字、配色、版式完全保持不变：", ...lines, "保持线性风格、颜色、大小、位置一致。不要改动任何文字。", "输出图中【不得保留】这些红色编号标记。"].join("\n");
}
