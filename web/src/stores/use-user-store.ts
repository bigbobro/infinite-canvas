"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { AUTH_TOKEN_KEY, type AuthPayload, type AuthUser } from "@/services/api/auth";

type UserStore = {
    token: string;
    user: AuthUser | null;
    isReady: boolean;
    isLoading: boolean;
    setSession: (token: string, user: AuthUser) => void;
    clearSession: () => void;
    hydrateUser: () => Promise<void>;
    login: (payload: AuthPayload) => Promise<AuthUser>;
    register: (payload: AuthPayload) => Promise<AuthUser>;
};

export const useUserStore = create<UserStore>()(
    persist(
        (set, get) => ({
            token: "",
            user: null,
            isReady: false,
            isLoading: false,
            setSession: (token, user) => set({ token, user, isReady: true }),
            clearSession: () => set({ token: "", user: null, isReady: true }),
            hydrateUser: async () => {
                set({ token: "", user: null, isReady: true, isLoading: false });
            },
            login: async (payload) => {
                set({ isLoading: true });
                const now = new Date().toISOString();
                const user: AuthUser = { id: "local-user", username: payload.username || "local", displayName: payload.username || "本地用户", avatarUrl: "", role: "user", credits: 0, createdAt: now, updatedAt: now };
                set({ token: "", user, isReady: true, isLoading: false });
                return user;
            },
            register: async (payload) => {
                return get().login(payload);
            },
        }),
        {
            name: AUTH_TOKEN_KEY,
            partialize: (state) => ({ token: state.token }),
            onRehydrateStorage: () => (state) => {
                if (state) state.isReady = false;
            },
        },
    ),
);
