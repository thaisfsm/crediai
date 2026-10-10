// Contatos e redes sociais de clientes e investidores (regras puras, usadas no navegador, no servidor e nos testes).
// Redes sociais aceitam @usuário ou o endereço do perfil, sem validação além do básico: o valor é guardado como foi
// digitado (sem espaços) e só vira link quando dá para montar um endereço seguro.

export const SOCIAL_NETWORKS = { instagram: "Instagram", facebook: "Facebook" } as const;
export type SocialNetwork = keyof typeof SOCIAL_NETWORKS;

const SOCIAL_HOSTS: Record<SocialNetwork, RegExp> = {
  instagram: /^(www\.)?instagram\.com$/i,
  facebook: /^((www|m|web)\.)?(facebook\.com|fb\.com)$/i,
};

export function normalizeSocial(value: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const clean = value.trim().replace(/\s+/g, "");
  if (!clean) return { ok: true, value: null };
  if (clean.length > 200) return { ok: false, error: "O perfil pode ter no máximo 200 caracteres." };
  return { ok: true, value: clean };
}

// Link do perfil: endereço http(s) do próprio Instagram/Facebook, ou @usuário convertido no endereço da rede.
// Qualquer outro valor (por exemplo um site de terceiros) é exibido como texto, sem link.
export function socialHref(network: SocialNetwork, stored: string | null) {
  if (!stored) return null;
  if (/^https?:\/\//i.test(stored)) {
    try {
      const url = new URL(stored);
      return SOCIAL_HOSTS[network].test(url.hostname) ? url.toString() : null;
    } catch {
      return null;
    }
  }
  if (/^(www\.)?(instagram\.com|facebook\.com|fb\.com)\//i.test(stored)) return socialHref(network, `https://${stored}`);
  const user = stored.replace(/^@/, "");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(user)) return null;
  return network === "instagram" ? `https://instagram.com/${user}` : `https://facebook.com/${user}`;
}

// @usuário para exibir (endereços ficam como estão).
export function socialLabel(stored: string | null) {
  if (!stored) return null;
  return /^https?:\/\//i.test(stored) || stored.includes("/") || stored.startsWith("@") ? stored : `@${stored}`;
}

// E-mail: só o formato básico (algo@dominio.ext), em minúsculas.
export function normalizeEmail(value: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const clean = value.trim().toLowerCase();
  if (!clean) return { ok: true, value: null };
  if (clean.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return { ok: false, error: "Informe um e-mail válido, por exemplo nome@exemplo.com." };
  return { ok: true, value: clean };
}

// Link do WhatsApp para um telefone gravado só com dígitos (DDD + número, Brasil).
export function whatsappHref(stored: string | null) {
  if (!stored) return null;
  const digits = stored.replace(/\D/g, "");
  return digits.length === 10 || digits.length === 11 ? `https://wa.me/55${digits}` : null;
}
