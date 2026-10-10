// Regras puras da auditoria administrativa (sem banco): nomes das ações, o que pode ser gravado e a diferença entre
// o antes e o depois. Usadas pelo registro (audit.ts), pela tela de Auditoria e pelos testes.

export const AUDIT_ACTIONS = {
  SAAS_CLIENT_CREATED: "Cliente SaaS criado",
  USER_CREATED: "Usuário criado",
  ADMIN_USER_CREATED: "Usuário administrativo criado",
  SAAS_CLIENT_UPDATED: "Dados do cliente SaaS alterados",
  SUBSCRIPTION_ACTIVATED: "Assinatura ativada",
  PLAN_CHANGED: "Plano alterado",
  COMMERCIAL_TERMS_CHANGED: "Condição comercial alterada",
  CONTRACTED_PRICE_CHANGED: "Valor contratado alterado",
  SUBSCRIPTION_PAYMENT_REGISTERED: "Mensalidade registrada como paga",
  SAAS_CLIENT_SUSPENDED: "Cliente SaaS suspenso",
  SAAS_CLIENT_REACTIVATED: "Cliente SaaS reativado",
  USER_BLOCKED: "Acesso bloqueado",
  USER_UNBLOCKED: "Acesso liberado",
  PASSWORD_RESET: "Senha redefinida",
  PLAN_CREATED: "Plano criado no catálogo",
  PLAN_UPDATED: "Plano do catálogo alterado",
  INVESTOR_CREATED: "Investidor cadastrado",
  INVESTOR_UPDATED: "Dados do investidor alterados",
  INVESTOR_STATUS_CHANGED: "Status do investidor alterado",
  INVESTMENT_CREATED: "Investimento cadastrado",
  INVESTMENT_UPDATED: "Dados do investimento alterados",
  INVESTMENT_STATUS_CHANGED: "Status do investimento alterado",
  INVESTMENT_DOCUMENT_UPLOADED: "Documento do investimento enviado",
  INVESTMENT_DOCUMENT_REPLACED: "Documento do investimento substituído",
} as const;
export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const AUDIT_ENTITIES: Record<string, string> = {
  tenant: "Cliente SaaS", subscription: "Assinatura", user: "Usuário", plan: "Plano", subscription_charge: "Mensalidade",
  investor: "Investidor", investment: "Investimento", investment_document: "Documento do investimento",
};

// Nunca gravar segredos: qualquer chave com estes nomes é descartada do antes/depois.
const SECRET_KEY = /pass(word)?|hash|token|secret/i;

export type AuditSnapshot = Record<string, unknown>;

// Copia só valores simples (texto, número, booleano, nulo, data), sem segredos e sem chaves indefinidas.
export function cleanSnapshot(values: Record<string, unknown> | null | undefined): AuditSnapshot | null {
  if (!values) return null;
  const result: AuditSnapshot = {};
  for (const [key, value] of Object.entries(values)) {
    if (SECRET_KEY.test(key) || value === undefined) continue;
    if (value instanceof Date) result[key] = value.toISOString();
    else if (value === null || ["string", "number", "boolean"].includes(typeof value)) result[key] = value;
  }
  return result;
}

// Campos que mudaram entre o antes e o depois (os iguais ficam de fora).
export function changedFields(before: AuditSnapshot | null, after: AuditSnapshot | null) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((key) => (before?.[key] ?? null) !== (after?.[key] ?? null)).sort();
}

// Primeiro endereço de x-forwarded-for (o cliente; os seguintes são proxies), ou x-real-ip.
export function clientIp(forwardedFor: string | null, realIp: string | null) {
  const first = forwardedFor?.split(",")[0]?.trim();
  const ip = first || realIp?.trim() || null;
  return ip ? ip.slice(0, 64) : null;
}

export const AUDIT_FIELD_LABELS: Record<string, string> = {
  name: "Nome", email: "E-mail", tenantName: "Nome do ambiente", contactPhone: "Telefone", status: "Status", planId: "Plano", planName: "Plano",
  contractedPriceCents: "Valor contratado (centavos)", commercialCondition: "Condição comercial", activatedAt: "Data de ativação",
  firstDueDate: "Primeiro vencimento", nextDueDate: "Próximo vencimento", graceDays: "Tolerância (dias)", expiresAt: "Fim do teste",
  active: "Acesso liberado", mustChangePassword: "Precisa trocar a senha", role: "Papel", priceInCents: "Preço padrão (centavos)",
  description: "Descrição", dueDate: "Vencimento", amountCents: "Valor (centavos)", paidAt: "Pago em", sessionsClosed: "Sessões encerradas",
  document: "CPF/CNPJ", phone: "Telefone", whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Facebook", notes: "Observações",
  investorId: "Investidor", investorName: "Investidor", agreedRateBps: "Taxa combinada (pontos-base)", ratePeriod: "Período da taxa",
  startDate: "Início", maturityDate: "Vencimento do contrato", dueDay: "Dia de vencimento", kind: "Tipo de documento", fileName: "Arquivo",
  contentType: "Formato", sizeBytes: "Tamanho (bytes)", replacedDocumentId: "Documento substituído",
};
