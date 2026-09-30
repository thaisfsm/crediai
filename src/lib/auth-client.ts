"use client";
import { createAuthClient } from "better-auth/react";

// No navegador, o Better Auth usa a própria origem da página; não depende de variável embutida no build.
export const authClient = createAuthClient({ baseURL: typeof window !== "undefined" ? window.location.origin : undefined });
