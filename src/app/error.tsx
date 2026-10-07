"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";

// Erro inesperado ao montar uma página (por exemplo, o banco caiu no meio da requisição). Mostra "tente novamente"
// no lugar da página: não redireciona, não encerra a sessão e não altera nenhum dado.
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => { console.error("[crediai:page-error]", error.digest ?? error.name); }, [error]);
  return (
    <main className="setup-page" data-page-error>
      <section className="setup-card" role="alert">
        <div className="auth-kicker"><i /> ERRO AO CARREGAR</div>
        <h1>Não foi possível carregar esta tela</h1>
        <p>Seus dados estão preservados e sua sessão continua aberta. Pode ser uma instabilidade momentânea: tente novamente.</p>
        {error.digest && <p className="setup-note">Código para o suporte: {error.digest}</p>}
        <button type="button" className="auth-submit" disabled={pending} onClick={() => startTransition(() => { router.refresh(); reset(); })}>
          {pending ? "Tentando…" : "Tentar novamente"} <span>→</span>
        </button>
      </section>
    </main>
  );
}
