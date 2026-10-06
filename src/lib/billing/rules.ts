// Regras comerciais das assinaturas dos clientes SaaS. Funções puras (sem banco), usadas pelas telas, pelas ações
// da administração e, no futuro, por uma rotina automática de cobrança/suspensão. Datas no formato AAAA-MM-DD.

export type CommercialCondition = "STANDARD" | "CUSTOM" | "COURTESY";
export const DEFAULT_GRACE_DAYS = 5;

export const CONDITION_LABEL: Record<CommercialCondition, string> = {
  STANDARD: "Padrão",
  CUSTOM: "Personalizada",
  COURTESY: "Cortesia",
};

// Situação comercial exibida na Central. Não depende de atividade de uso (último acesso).
export type CommercialStatus =
  | "OWNER" // conta da administração: sem cobrança, qualquer que seja o status gravado
  | "TRIALING" // em teste, dentro do período
  | "TRIAL_EXPIRED" // teste terminou sem ativação (o acesso já é bloqueado pela regra de teste)
  | "ACTIVE" // ativo e em dia (ou sem cobrança, no caso de cortesia)
  | "PAST_DUE" // vencido, dentro da tolerância: mantém o acesso
  | "SUSPENSION_DUE" // vencido além da tolerância: pode ser suspenso
  | "SUSPENDED"
  | "CLOSED";

export type SubscriptionSnapshot = {
  isPlatformOwner: boolean;
  tenantStatus: string;
  subscriptionStatus: string | null;
  trialEndsAt: string | null; // expires_at (ISO completo) do período de teste
  nextDueDate: string | null;
  graceDays: number;
};

export type CommercialState = {
  status: CommercialStatus;
  daysToDue: number | null; // dias até o próximo vencimento (0 = vence hoje)
  daysOverdue: number | null; // dias desde o vencimento (1 = venceu ontem)
  graceEndsOn: string | null; // último dia com acesso garantido pela tolerância
};

const DAY_MS = 86_400_000;
const parse = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
export const daysBetweenIso = (fromIso: string, toIso: string) => Math.round((parse(toIso) - parse(fromIso)) / DAY_MS);
export function addDaysIso(iso: string, days: number) {
  return new Date(parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
}
export const isIsoDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parse(value)) && new Date(parse(value)).toISOString().startsWith(value);

// Soma meses mantendo o dia escolhido no primeiro vencimento (anchorDay). Em meses mais curtos usa o último dia:
// primeiro vencimento em 31/01 → 28/02 (ou 29/02) → 31/03 → 30/04 …
export function addMonthsAnchored(iso: string, months: number, anchorDay = Number(iso.slice(8, 10))) {
  const [year, month] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchorDay, lastDay));
  return target.toISOString().slice(0, 10);
}

// Depois de uma mensalidade paga, o próximo vencimento é um mês depois do vencimento pago, no dia do primeiro vencimento.
export function nextDueAfterPayment(paidDueDate: string, firstDueDate: string) {
  return addMonthsAnchored(paidDueDate, 1, Number(firstDueDate.slice(8, 10)));
}

// Vencimento: no próprio dia ainda está em dia. A partir do dia seguinte fica Vencido, com acesso, por graceDays dias.
// Passada a tolerância, fica marcado para suspensão (a suspensão em si é uma ação do SUPER_ADMIN ou da rotina futura).
export function commercialState(sub: SubscriptionSnapshot, today: string, now = new Date()): CommercialState {
  const none = { daysToDue: null, daysOverdue: null, graceEndsOn: null };
  if (sub.isPlatformOwner) return { status: "OWNER", ...none };
  if (sub.tenantStatus === "CLOSED") return { status: "CLOSED", ...none };
  if (sub.tenantStatus === "SUSPENDED") return { status: "SUSPENDED", ...none };
  if (sub.tenantStatus === "TRIALING" || sub.subscriptionStatus === "TRIALING") {
    const expired = sub.trialEndsAt !== null && Date.parse(sub.trialEndsAt) <= now.getTime();
    return { status: expired ? "TRIAL_EXPIRED" : "TRIALING", ...none };
  }
  if (!sub.nextDueDate) return { status: "ACTIVE", ...none };
  const graceEndsOn = addDaysIso(sub.nextDueDate, sub.graceDays);
  const diff = daysBetweenIso(today, sub.nextDueDate);
  if (diff >= 0) return { status: "ACTIVE", daysToDue: diff, daysOverdue: null, graceEndsOn };
  const daysOverdue = -diff;
  return { status: daysOverdue <= sub.graceDays ? "PAST_DUE" : "SUSPENSION_DUE", daysToDue: null, daysOverdue, graceEndsOn };
}

// Para a rotina automática futura: quais assinaturas já passaram da tolerância.
export function shouldSuspend(state: CommercialState) {
  return state.status === "SUSPENSION_DUE";
}

export type CommercialTerms = {
  condition: CommercialCondition;
  contractedCents: number;
  standardCents: number;
  activatedAt: string;
  firstDueDate: string | null;
  graceDays: number;
};

// Regras do valor contratado:
// - Padrão: igual ao preço padrão do plano no momento da ativação (depois disso fica guardado e não acompanha o plano).
// - Personalizada: qualquer valor maior que zero (desconto, acréscimo, cliente antigo, promoção).
// - Cortesia: R$ 0,00 e sem vencimento, mantendo os recursos do plano.
export function validateTerms(terms: CommercialTerms): string | null {
  if (!Number.isSafeInteger(terms.contractedCents) || terms.contractedCents < 0) return "Informe um valor contratado válido.";
  if (terms.contractedCents > 10_000_000) return "O valor contratado parece alto demais. Confira o valor.";
  if (terms.condition === "STANDARD" && terms.contractedCents !== terms.standardCents) return "Na condição Padrão o valor contratado é o preço padrão do plano. Para outro valor, escolha Personalizada.";
  if (terms.condition === "STANDARD" && terms.standardCents <= 0) return "Este plano ainda não tem preço padrão. Use Personalizada ou Cortesia.";
  if (terms.condition === "CUSTOM" && terms.contractedCents <= 0) return "Para valor R$ 0,00 escolha a condição Cortesia.";
  if (terms.condition === "COURTESY" && terms.contractedCents !== 0) return "Na Cortesia o valor contratado é R$ 0,00.";
  if (!isIsoDay(terms.activatedAt)) return "Informe a data de ativação.";
  if (!Number.isInteger(terms.graceDays) || terms.graceDays < 0 || terms.graceDays > 60) return "A tolerância deve ser de 0 a 60 dias.";
  if (terms.condition !== "COURTESY") {
    if (!terms.firstDueDate || !isIsoDay(terms.firstDueDate)) return "Informe o primeiro vencimento.";
    if (terms.firstDueDate < terms.activatedAt) return "O primeiro vencimento não pode ser antes da ativação.";
    if (daysBetweenIso(terms.activatedAt, terms.firstDueDate) > 366) return "O primeiro vencimento deve ser em até um ano após a ativação.";
  }
  return null;
}
