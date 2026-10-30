"use client";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { forgetThemeUser } from "./theme-toggle";

export default function SignOutButton({ label = "Sair" }: { label?: string }) {
  const router = useRouter();
  return <button className="auth-submit" onClick={async () => { await authClient.signOut(); forgetThemeUser(); router.replace("/login"); router.refresh(); }}>{label}<span>→</span></button>;
}
