// Formatação e conversão compartilhadas entre servidor e navegador.
export const TIME_ZONE = "America/Sao_Paulo";

export function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function splitMoney(cents: number) {
  const formatted = formatMoney(cents);
  const comma = formatted.lastIndexOf(",");
  return { whole: formatted.slice(0, comma), fraction: formatted.slice(comma) };
}

export function formatRate(bps: number) {
  return `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
}

// Aceita "20.000,00", "20000", "20000.5", "R$ 1.000,00".
export function parseMoneyToCents(input: string) {
  const clean = input.replace(/[R$\s]/g, "");
  if (!clean) return null;
  const normalized = clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

// Aceita "30", "30%", "2,5". Retorna pontos-base (1% = 100).
export function parseRateToBps(input: string) {
  const normalized = input.replace(/[%\s]/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

export function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function todayIso(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export function formatDate(iso: string) {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

const monthShort = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
export function dayAndMonth(iso: string) {
  const [, month, day] = iso.split("-");
  return { day, month: monthShort[Number(month) - 1] };
}

export function shortDate(iso: string) {
  const { day, month } = dayAndMonth(iso);
  return `${day} ${month.toLowerCase()}`;
}

export function initialsOf(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

export const onlyDigits = (value: string) => value.replace(/\D/g, "");

// Máscara progressiva enquanto o usuário digita: 411.797.058-58.
export function maskCpf(value: string) {
  const digits = onlyDigits(value).slice(0, 11);
  return digits.replace(/^(\d{3})(\d)/, "$1.$2").replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");
}

// Máscara progressiva: (11) 3456-7890 para fixo (10 dígitos) e (11) 98765-4321 para celular (11 dígitos).
export function maskPhone(value: string) {
  const digits = onlyDigits(value).slice(0, 11);
  if (digits.length <= 2) return digits ? `(${digits}` : "";
  const area = `(${digits.slice(0, 2)}) `;
  const rest = digits.slice(2);
  const split = digits.length === 11 ? 5 : 4;
  return rest.length > split ? `${area}${rest.slice(0, split)}-${rest.slice(split)}` : `${area}${rest}`;
}

// Exibição de valores gravados: formata quando o valor tem o tamanho esperado e mostra como está
// qualquer valor antigo fora do padrão, para não esconder dados de clientes já cadastrados.
export function formatCpf(stored: string | null) {
  if (!stored) return null;
  return onlyDigits(stored).length === 11 ? maskCpf(stored) : stored;
}

export function formatPhone(stored: string | null) {
  if (!stored) return null;
  const length = onlyDigits(stored).length;
  return length === 10 || length === 11 ? maskPhone(stored) : stored;
}

// Validação mínima: bloqueia só formatos obviamente inválidos (tamanho errado, todos os dígitos iguais, DDD inexistente).
export function normalizeCpf(value: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const digits = onlyDigits(value);
  if (!digits) return { ok: true, value: null };
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return { ok: false, error: "O CPF precisa ter 11 dígitos, por exemplo 411.797.058-58." };
  return { ok: true, value: digits };
}

export function normalizePhone(value: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const digits = onlyDigits(value);
  if (!digits) return { ok: true, value: null };
  if ((digits.length !== 10 && digits.length !== 11) || digits[0] === "0" || digits[1] === "0" || /^(\d)\1+$/.test(digits)) {
    return { ok: false, error: "Informe o telefone com DDD: (11) 98765-4321 para celular ou (11) 3456-7890 para fixo." };
  }
  return { ok: true, value: digits };
}

// Valor em centavos para preencher um campo de dinheiro: 30000 -> "300,00".
export function centsToInput(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
