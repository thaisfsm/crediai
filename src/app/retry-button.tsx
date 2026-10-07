"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

// Nova tentativa sem sair da página: refaz a requisição do servidor (router.refresh). Se o próprio JavaScript não
// tiver carregado, o link recarrega a página inteira.
export default function RetryButton({ label = "Tentar novamente", onRetry }: { label?: string; onRetry?: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [attempts, setAttempts] = useState(0);
  return (
    <a
      href=""
      className="auth-submit"
      aria-disabled={pending}
      onClick={(event) => {
        event.preventDefault();
        if (pending) return;
        setAttempts((count) => count + 1);
        startTransition(() => { onRetry?.(); router.refresh(); });
      }}
    >
      {pending ? "Tentando…" : attempts > 0 ? `${label} (${attempts + 1}ª tentativa)` : label} <span>→</span>
    </a>
  );
}
