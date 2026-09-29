"use client";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export default function SignOutButton({ label = "Sair" }: { label?: string }) {
  const router = useRouter();
  return <button className="auth-submit" onClick={async () => { await authClient.signOut(); router.replace("/login"); router.refresh(); }}>{label}<span>→</span></button>;
}
