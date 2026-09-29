"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isSignup = mode === "signup";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "");
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    const result = isSignup
      ? await authClient.signUp.email({ name, email, password })
      : await authClient.signIn.email({ email, password });

    if (result.error) {
      setError(result.error.message ?? "Não foi possível concluir. Confira seus dados e tente novamente.");
      setBusy(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return <main className="auth-page"><section className="auth-card">
    <Link className="auth-brand" href="/"><span className="auth-symbol">C<span>AI</span></span><span>CrediAI<small>CRÉDITO + INTELIGÊNCIA</small></span></Link>
    <div className="auth-kicker"><i /> AMBIENTE PRIVADO</div>
    <h1>{isSignup ? "Comece sua carteira" : "Acesse sua conta"}</h1>
    <p>{isSignup ? "Crie seu espaço privado no CrediAI." : "Entre para acompanhar seu ambiente CrediAI."}</p>
    <form onSubmit={submit}>
      {isSignup && <label>Nome completo<input name="name" autoComplete="name" required minLength={2} maxLength={120} /></label>}
      <label>E-mail<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
      <label>Senha<input name="password" type="password" autoComplete={isSignup ? "new-password" : "current-password"} required minLength={isSignup ? 12 : 1} maxLength={128} />{isSignup && <small>Use ao menos 12 caracteres.</small>}</label>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <button className="auth-submit" disabled={busy}>{busy ? "Aguarde…" : isSignup ? "Criar conta" : "Entrar"}<span>→</span></button>
    </form>
    <div className="auth-switch">{isSignup ? "Já tem acesso?" : "Ainda não tem acesso?"} <a href={isSignup ? "/login" : "/signup"}>{isSignup ? "Entrar" : "Criar conta"}</a></div>
    <div className="auth-security">◈ <span>Os dados da sua conta serão mantidos em um ambiente isolado.</span></div>
  </section><div className="auth-orbit auth-orbit-one" /><div className="auth-orbit auth-orbit-two" /></main>;
}
