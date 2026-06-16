export const AUTH_TOKEN_KEY = "infinite-canvas-auth-token-v1";

export type UserRole = "guest" | "user" | "admin";

export type AuthUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: UserRole;
    credits: number;
    createdAt: string;
    updatedAt: string;
};

export type AuthSession = {
    token: string;
    user: AuthUser;
};

export type AuthPayload = {
    username: string;
    password: string;
};

export async function login(payload: AuthPayload) {
    const now = new Date().toISOString();
    return { token: "", user: { id: "local-user", username: payload.username || "local", displayName: payload.username || "本地用户", avatarUrl: "", role: "user" as const, credits: 0, createdAt: now, updatedAt: now } };
}

export async function register(payload: AuthPayload) {
    return login(payload);
}

export async function fetchCurrentUser(token?: string) {
    return { id: "local-user", username: "local", displayName: "本地用户", avatarUrl: "", role: "user" as const, credits: 0, createdAt: "", updatedAt: "" };
}
