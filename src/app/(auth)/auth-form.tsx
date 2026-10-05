"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import Image from "next/image";

// Só existe login: contas são criadas pela administração da plataforma, nunca pelo próprio usuário.
export default function AuthForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    let redirecting = false;
    try {
      const result = await authClient.signIn.email({ email, password });

      if (result.error) {
        setError(result.error.message ?? "Não foi possível concluir. Confira seus dados e tente novamente.");
        return;
      }
      redirecting = true;
      router.replace("/");
      router.refresh();
    } catch {
      setError("Não foi possível conectar ao servidor. Tente novamente.");
    } finally {
      if (!redirecting) setBusy(false);
    }
  }

  return <main className="auth-page"><section className="auth-card auth-card-login">
    <Link className="auth-brand auth-brand-login" href="/" aria-label="CrediAI — início"><Image src="/brand/crediai-logo-transparent.png" width={2172} height={724} alt="CrediAI — Crédito + Inteligência" priority /></Link>
    <div className="auth-kicker"><i /> AMBIENTE PRIVADO</div>
    <h1>Acesse sua conta</h1>
    <p>Entre para acompanhar seu ambiente CrediAI.</p>
    <form onSubmit={submit}>
      <label>E-mail<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
      <label>Senha<input name="password" type="password" autoComplete="current-password" required maxLength={128} /></label>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <button className="auth-submit auth-submit-login" disabled={busy}>{busy ? "Aguarde…" : "Entrar"}<span>→</span></button>
    </form>
    <div className="auth-security">◈ <span>Os dados da sua conta serão mantidos em um ambiente isolado.</span></div>
  </section><div className="auth-orbit auth-orbit-one" /><div className="auth-orbit auth-orbit-two" /></main>;
}
