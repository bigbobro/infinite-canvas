export type AssetLibraryItem = {
    id: string;
    title: string;
    type: "text" | "image" | "video";
    coverUrl: string;
    tags: string[];
    category: string;
    description: string;
    content: string;
    url: string;
    createdAt: string;
    updatedAt: string;
};

export type AssetLibraryResponse = {
    items: AssetLibraryItem[];
    tags: string[];
    total: number;
};

export type AssetLibraryQuery = {
    keyword?: string;
    type?: string;
    tag?: string[];
    page?: number;
    pageSize?: number;
};

export async function fetchAssetLibrary(query: AssetLibraryQuery = {}) {
    const items: AssetLibraryItem[] = [];
    const filtered = items.filter((item) => {
        const keyword = query.keyword?.trim().toLowerCase();
        if (query.type && item.type !== query.type) return false;
        if (query.tag?.length && !query.tag.some((tag) => item.tags.includes(tag))) return false;
        if (!keyword) return true;
        return [item.title, item.description, item.content, item.url, item.category, ...item.tags].join(" ").toLowerCase().includes(keyword);
    });
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.max(1, Number(query.pageSize) || filtered.length || 1);
    return {
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
        tags: Array.from(new Set(filtered.flatMap((item) => item.tags).filter(Boolean))),
        total: filtered.length,
    };
}
