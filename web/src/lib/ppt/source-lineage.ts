export function hashPptSourceText(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function hashPptContentSource(sourceMaterial: string, requirements: string) {
    return hashPptSourceText(JSON.stringify([sourceMaterial, requirements]));
}
