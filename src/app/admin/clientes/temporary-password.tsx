"use client";

import { useState } from "react";

// Mostra a senha provisória só nesta tela, logo depois de criada. Ela não é guardada em lugar nenhum além do hash.
export default function TemporaryPassword({ email, password }: { email: string; password: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(`E-mail: ${email}\nSenha provisória: ${password}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="central-secret" role="status">
      <strong>Senha provisória de {email}</strong>
      <code>{password}</code>
      <p>Copie agora e envie ao cliente por um canal seguro. Ela não será mostrada de novo. No primeiro acesso o cliente terá que criar uma senha pessoal.</p>
      <button type="button" className="central-secondary" onClick={copy}>{copied ? "Copiado" : "Copiar e-mail e senha"}</button>
    </div>
  );
}
