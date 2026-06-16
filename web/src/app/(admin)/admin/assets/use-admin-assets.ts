"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";

import { deleteAdminAsset, fetchAdminAssets, saveAdminAsset, type AdminAsset } from "@/services/api/admin";

const defaultPageSize = 10;
const localToken = "";

export function useAdminAssets() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [keyword, setKeyword] = useState("");
    const [type, setType] = useState("");
    const [tag, setTag] = useState<string[]>([]);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(defaultPageSize);

    const query = useQuery({
        queryKey: ["admin", "assets", keyword, type, tag, page, pageSize],
        queryFn: () => fetchAdminAssets(localToken, { keyword, type, tag, page, pageSize }),
        retry: false,
    });

    const saveMutation = useMutation({
        mutationFn: (asset: Partial<AdminAsset>) => saveAdminAsset(localToken, asset),
        onSuccess: async (_, asset) => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "assets"] });
            message.success(asset.id ? "素材已保存" : "素材已新增");
        },
        onError: (error) => {
            message.error(error instanceof Error ? error.message : "保存失败");
        },
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => deleteAdminAsset(localToken, id),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "assets"] });
            message.success("素材已删除");
        },
        onError: (error) => {
            message.error(error instanceof Error ? error.message : "删除失败");
        },
    });

    useEffect(() => {
        if (query.isError) {
            const errorMessage = query.error instanceof Error ? query.error.message : "读取素材失败";
            message.error(errorMessage);
        }
    }, [message, query.error, query.isError]);

    const updateFilters = (next: Partial<{ keyword: string; type: string; tag: string[]; page: number; pageSize: number }>) => {
        const queryState = { keyword, type, tag, page, pageSize, ...next };
        if (next.keyword !== undefined || next.type !== undefined || next.tag !== undefined || next.pageSize !== undefined) queryState.page = 1;
        setKeyword(queryState.keyword);
        setType(queryState.type);
        setTag(queryState.tag);
        setPage(queryState.page);
        setPageSize(queryState.pageSize);
    };

    const data = query.data;

    return {
        assets: data?.items || [],
        tags: data?.tags || [],
        keyword,
        kind: type,
        tag,
        page,
        pageSize,
        total: data?.total || 0,
        isLoading: query.isFetching || saveMutation.isPending || deleteMutation.isPending,
        searchAssets: (value = keyword) => updateFilters({ keyword: value }),
        changeKind: (value: string) => updateFilters({ type: value, tag: [] }),
        changeTag: (value: string[]) => updateFilters({ tag: value }),
        changePage: (value: number) => updateFilters({ page: value }),
        changePageSize: (value: number) => updateFilters({ pageSize: value }),
        resetFilters: () => updateFilters({ keyword: "", type: "", tag: [], page: 1, pageSize: defaultPageSize }),
        refreshAssets: () => query.refetch(),
        saveAsset: (asset: Partial<AdminAsset>) => saveMutation.mutateAsync(asset),
        deleteAsset: (id: string) => deleteMutation.mutateAsync(id),
    };
}
