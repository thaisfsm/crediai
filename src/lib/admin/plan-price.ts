import { formatMoney } from "@/lib/finance/format";

// Preço mensal do plano, lido de plan.price_in_cents. Zero quer dizer que o valor ainda não foi configurado.
export function planPriceLabel(priceInCents: number, compact = false) {
  if (priceInCents <= 0) return "valor não configurado";
  const money = formatMoney(priceInCents);
  return `${compact && priceInCents % 100 === 0 ? money.replace(/,00$/, "") : money}/mês`;
}

export function planLabel(name: string, priceInCents: number, compact = false) {
  return `${name} · ${planPriceLabel(priceInCents, compact)}`;
}
