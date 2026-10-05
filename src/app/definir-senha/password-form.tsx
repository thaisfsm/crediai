"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import SignOutButton from "@/app/sign-out-button";
import { changeTemporaryPasswordAction } from "./actions";

export default function PasswordForm({ email }: { email: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const result = await changeTemporaryPasswordAction(new FormData(event.currentTarget)).catch(() => ({ ok: false as const, error: "Não foi possível conectar ao servidor. Tente novamente." }));
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return <main className="auth-page"><section className="auth-card auth-card-login">
    <div className="auth-kicker"><i /> PRIMEIRO ACESSO</div>
    <h1>Defina sua nova senha</h1>
    <p>Você entrou com uma senha provisória ({email}). Para continuar, crie uma senha pessoal.</p>
    <form onSubmit={submit}>
      <label>Senha provisória<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></label>
      <label>Nova senha<input name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /><small>Use ao menos 12 caracteres.</small></label>
      <label>Confirme a nova senha<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <button className="auth-submit auth-submit-login" disabled={busy}>{busy ? "Aguarde…" : "Salvar nova senha"}<span>→</span></button>
    </form>
    <div className="auth-switch"><SignOutButton label="Sair" /></div>
  </section><div className="auth-orbit auth-orbit-one" /><div className="auth-orbit auth-orbit-two" /></main>;
}
