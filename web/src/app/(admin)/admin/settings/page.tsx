"use client";

import { Button, Card, Typography } from "antd";
import { Database, Settings2, Sparkles } from "lucide-react";
import Link from "next/link";

import { useConfigStore } from "@/stores/use-config-store";

export default function AdminSettingsPage() {
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    return (
        <div className="p-6">
            <div className="grid gap-4 lg:grid-cols-3">
                <Card>
                    <Settings2 className="mb-4 size-6 text-stone-700 dark:text-stone-200" />
                    <Typography.Title level={4} className="!mb-2">
                        前台直连配置
                    </Typography.Title>
                    <Typography.Paragraph type="secondary">模型 Base URL、API Key、默认模型和 WebDAV 同步都保存在浏览器本地，不再通过后台渠道转发。</Typography.Paragraph>
                    <Button type="primary" onClick={() => openConfigDialog(false)}>
                        打开配置弹窗
                    </Button>
                </Card>
                <Card>
                    <Sparkles className="mb-4 size-6 text-stone-700 dark:text-stone-200" />
                    <Typography.Title level={4} className="!mb-2">
                        第三方提示词
                    </Typography.Title>
                    <Typography.Paragraph type="secondary">提示词由 Next.js route 从开源仓库拉取，并缓存在当前运行实例的内存里；页面和管理列表都读取同一份缓存。</Typography.Paragraph>
                    <Link href="/admin/prompts">
                        <Button>查看提示词</Button>
                    </Link>
                </Card>
                <Card>
                    <Database className="mb-4 size-6 text-stone-700 dark:text-stone-200" />
                    <Typography.Title level={4} className="!mb-2">
                        本地数据
                    </Typography.Title>
                    <Typography.Paragraph type="secondary">画布项目、我的素材、生成记录和 AI Key 默认留在浏览器本地；需要跨设备时请在配置弹窗里使用 WebDAV 同步。</Typography.Paragraph>
                    <Link href="/canvas">
                        <Button>前往画布</Button>
                    </Link>
                </Card>
            </div>
        </div>
    );
}
