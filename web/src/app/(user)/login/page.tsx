"use client";

import { Button } from "antd";
import { ArrowLeft, Settings2 } from "lucide-react";
import Link from "next/link";

import { useConfigStore } from "@/stores/use-config-store";

export default function LoginPage() {
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    return (
        <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-10 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)]">
            <section className="w-full max-w-[440px] text-center">
                <span
                    className="mx-auto mb-4 block size-12 bg-stone-950 dark:bg-stone-100"
                    style={{
                        mask: "url(/logo.svg) center / contain no-repeat",
                        WebkitMask: "url(/logo.svg) center / contain no-repeat",
                    }}
                    aria-label="无限画布"
                />
                <h1 className="text-3xl font-semibold tracking-normal text-stone-950 dark:text-stone-100">无需账号登录</h1>
                <p className="mt-3 text-base leading-7 text-stone-500 dark:text-stone-400">当前版本以浏览器本地数据为主，AI 请求使用你在本机配置的 Base URL 和 API Key 前台直连。</p>
                <div className="mt-8 flex flex-wrap justify-center gap-3">
                    <Button type="primary" icon={<Settings2 className="size-4" />} onClick={() => openConfigDialog(false)}>
                        打开配置
                    </Button>
                    <Link href="/canvas">
                        <Button icon={<ArrowLeft className="size-4" />}>返回画布</Button>
                    </Link>
                </div>
            </section>
        </main>
    );
}
