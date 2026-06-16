import { nanoid } from "nanoid";

import { fetchPrompts, type Prompt, type PromptListResponse } from "@/services/api/prompts";
import { fetchImageModels } from "@/services/api/image";

export type AdminPromptCategory = {
    category: string;
    name: string;
    description: string;
    file: string;
    githubUrl: string;
    remote: boolean;
};

export type AdminUser = {
    id: string;
    username: string;
    email: string;
    displayName: string;
    avatarUrl: string;
    role: "user" | "admin";
    credits: number;
    affCode: string;
    affCount: number;
    inviterId: string;
    linuxDoId: string;
    status: "active" | "ban";
    lastLoginAt: string;
    createdAt: string;
    updatedAt: string;
};

export type AdminUserListResponse = {
    items: AdminUser[];
    total: number;
};

export type AdminCreditLog = {
    id: string;
    userId: string;
    type: string;
    amount: number;
    balance: number;
    relatedId: string;
    remark: string;
    extra: string;
    createdAt: string;
};

export type AdminCreditLogListResponse = {
    items: AdminCreditLog[];
    total: number;
};

export type AdminUserQuery = {
    keyword?: string;
    page?: number;
    pageSize?: number;
};

export async function fetchAdminUsers(token: string, query: AdminUserQuery = {}) {
    return { items: [], total: 0 };
}

export async function saveAdminUser(token: string, user: Partial<AdminUser> & { password?: string }) {
    return { ...emptyAdminUser(), ...user, id: user.id || nanoid() };
}

export async function adjustAdminUserCredits(token: string, id: string, credits: number) {
    return { ...emptyAdminUser(), id, credits };
}

export async function deleteAdminUser(token: string, id: string) {
    return true;
}

export async function fetchAdminCreditLogs(token: string, query: AdminUserQuery = {}) {
    return { items: [], total: 0 };
}

export async function saveAdminCreditLog(token: string, log: Partial<AdminCreditLog>) {
    return { id: log.id || nanoid(), userId: "", type: "", amount: 0, balance: 0, relatedId: "", remark: "", extra: "", createdAt: new Date().toISOString(), ...log };
}

export async function deleteAdminCreditLog(token: string, id: string) {
    return true;
}

export async function fetchAdminPromptCategories(token: string) {
    return promptCategories;
}

export async function syncAdminPromptCategory(token: string, category: string) {
    await fetchPrompts({ category, pageSize: 1 });
    return promptCategories;
}

export type AdminPromptQuery = {
    keyword?: string;
    category?: string;
    tag?: string[];
    page?: number;
    pageSize?: number;
};

export type AdminAsset = {
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

export type AdminAssetListResponse = {
    items: AdminAsset[];
    tags: string[];
    total: number;
};

export async function fetchAdminPrompts(token: string, query: AdminPromptQuery = {}) {
    return fetchPrompts(query);
}

export async function saveAdminPrompt(token: string, prompt: Partial<Prompt>) {
    const now = new Date().toISOString();
    return { id: prompt.id || nanoid(), title: "", coverUrl: "", prompt: "", tags: [], category: "", githubUrl: "", preview: "", createdAt: now, updatedAt: now, ...prompt };
}

export async function deleteAdminPrompt(token: string, id: string) {
    return true;
}

export async function deleteAdminPrompts(token: string, ids: string[]) {
    return true;
}

export type AdminAssetQuery = {
    keyword?: string;
    type?: string;
    tag?: string[];
    page?: number;
    pageSize?: number;
};

export async function fetchAdminAssets(token: string, query: AdminAssetQuery = {}) {
    return { items: [], tags: [], total: 0 };
}

export async function saveAdminAsset(token: string, asset: Partial<AdminAsset>) {
    return { id: asset.id || nanoid(), title: "", type: "text", coverUrl: "", tags: [], category: "", description: "", content: "", url: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...asset };
}

export async function deleteAdminAsset(token: string, id: string) {
    return true;
}

export type AdminModelChannel = {
    protocol: "openai";
    name: string;
    baseUrl: string;
    apiKey: string;
    models: string[];
    weight: number;
    enabled: boolean;
    remark: string;
};

export type AdminPublicModelChannelSettings = {
    availableModels: string[];
    modelCosts: AdminModelCost[];
    defaultModel: string;
    defaultImageModel: string;
    defaultVideoModel: string;
    defaultTextModel: string;
    systemPrompt: string;
    allowCustomChannel: boolean;
};

export type AdminModelCost = {
    model: string;
    credits: number;
};

export type AdminPublicSettings = {
    modelChannel: AdminPublicModelChannelSettings;
    auth: {
        allowRegister: boolean;
        linuxDo: {
            enabled: boolean;
        };
    };
};

export type AdminPrivateSettings = {
    channels: AdminModelChannel[];
    promptSync: {
        enabled: boolean;
        cron: string;
    };
    auth: {
        linuxDo: {
            clientId: string;
            clientSecret: string;
        };
    };
};

export type AdminSettings = {
    public: AdminPublicSettings;
    private: AdminPrivateSettings;
};

export async function fetchAdminSettings(token: string) {
    return defaultAdminSettings();
}

export async function saveAdminSettings(token: string, settings: AdminSettings) {
    return settings;
}

export type AdminChannelActionRequest = {
    index?: number;
    channel: AdminModelChannel;
    model?: string;
};

export async function fetchChannelModels(token: string, payload: AdminChannelActionRequest) {
    return fetchImageModels({ ...defaultAiConfig(), baseUrl: payload.channel.baseUrl, apiKey: payload.channel.apiKey || "local", model: payload.model || "", models: payload.channel.models });
}

export async function testChannelModel(token: string, payload: AdminChannelActionRequest) {
    return "前台直连配置已保存，请在前台生成时验证模型可用性";
}

const promptCategories: AdminPromptCategory[] = [
    { category: "gpt-image-2-prompts", name: "GPT Image 2 Prompts", description: "", file: "", githubUrl: "https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts", remote: true },
    { category: "awesome-gpt-image", name: "Awesome GPT Image", description: "", file: "", githubUrl: "https://github.com/ZeroLu/awesome-gpt-image", remote: true },
    { category: "awesome-gpt4o-image-prompts", name: "Awesome GPT-4o Image Prompts", description: "", file: "", githubUrl: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts", remote: true },
    { category: "youmind-gpt-image-2", name: "YouMind GPT Image 2", description: "", file: "", githubUrl: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2", remote: true },
    { category: "youmind-nano-banana-pro", name: "YouMind Nano Banana Pro", description: "", file: "", githubUrl: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts", remote: true },
    { category: "davidwu-gpt-image2-prompts", name: "DavidWu GPT Image2 Prompts", description: "", file: "", githubUrl: "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts", remote: true },
];

function emptyAdminUser(): AdminUser {
    const now = new Date().toISOString();
    return { id: "", username: "", email: "", displayName: "", avatarUrl: "", role: "user", credits: 0, affCode: "", affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", createdAt: now, updatedAt: now };
}

function defaultAdminSettings(): AdminSettings {
    return {
        public: {
            modelChannel: { availableModels: [], modelCosts: [], defaultModel: "", defaultImageModel: "", defaultVideoModel: "", defaultTextModel: "", systemPrompt: "", allowCustomChannel: true },
            auth: { allowRegister: false, linuxDo: { enabled: false } },
        },
        private: { channels: [], promptSync: { enabled: false, cron: "" }, auth: { linuxDo: { clientId: "", clientSecret: "" } } },
    };
}

function defaultAiConfig() {
    return {
        channelMode: "local" as const,
        baseUrl: "",
        apiKey: "",
        model: "",
        imageModel: "",
        videoModel: "",
        textModel: "",
        audioModel: "",
        audioVoice: "",
        audioFormat: "",
        audioSpeed: "",
        audioInstructions: "",
        videoSeconds: "",
        vquality: "",
        videoGenerateAudio: "",
        videoWatermark: "",
        systemPrompt: "",
        models: [],
        imageModels: [],
        videoModels: [],
        textModels: [],
        audioModels: [],
        quality: "",
        size: "",
        count: "",
        canvasImageCount: "",
    };
}
