// Gestão de inadimplência: operações em atraso separadas por faixa de dias de atraso. Função pura, só leitura.
// "Em atraso" é o mesmo das Cobranças: operação em aberto, com obrigação pendente, cujo próximo vencimento em aberto
// já passou. Os dias de atraso contam a partir desse vencimento (o mais antigo ainda não pago).
import type { OperationView } from "./portfolio";

export type DelinquencyBand = "1-30" | "31-60" | "61-90" | "91+";
export const DELINQUENCY_BANDS: { key: DelinquencyBand; label: string; min: number; max: number | null }[] = [
  { key: "1-30", label: "1 a 30 dias", min: 1, max: 30 },
  { key: "31-60", label: "31 a 60 dias", min: 31, max: 60 },
  { key: "61-90", label: "61 a 90 dias", min: 61, max: 90 },
  // 91 dias em diante: PDD (Provisão de Devedores Duvidosos), tratada como prejuízo e passada ao cobrador.
  { key: "91+", label: "91 dias ou mais", min: 91, max: null },
];

export type DelinquentOperation = OperationView & { daysLate: number; band: DelinquencyBand };
export type DelinquencyBandSummary = {
  key: DelinquencyBand; label: string; operations: DelinquentOperation[]; operationCount: number; clientCount: number;
  balanceCents: number; principalRemainingCents: number;
};

export const bandOf = (daysLate: number): DelinquencyBand => DELINQUENCY_BANDS.find((band) => daysLate >= band.min && (band.max === null || daysLate <= band.max))!.key;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const distinctClients = (operations: OperationView[]) => new Set(operations.map((operation) => operation.clientId)).size;

export function delinquencyOverview(operations: OperationView[]) {
  const open = operations.filter((operation) => operation.status === "OPEN");
  const late: DelinquentOperation[] = open
    .filter((operation) => operation.nextOpenDueDate !== null && operation.daysUntilDue < 0)
    .map((operation) => ({ ...operation, daysLate: -operation.daysUntilDue, band: bandOf(-operation.daysUntilDue) }))
    // O atraso mais antigo primeiro; empate pelo nome do cliente.
    .sort((a, b) => b.daysLate - a.daysLate || a.clientName.localeCompare(b.clientName, "pt-BR") || a.id.localeCompare(b.id));
  const bands: DelinquencyBandSummary[] = DELINQUENCY_BANDS.map(({ key, label }) => {
    const items = late.filter((operation) => operation.band === key);
    return {
      key, label, operations: items, operationCount: items.length, clientCount: distinctClients(items),
      balanceCents: sum(items.map((operation) => operation.balanceCents)), principalRemainingCents: sum(items.map((operation) => operation.principalRemainingCents)),
    };
  });
  const receivableCents = sum(open.map((operation) => operation.balanceCents));
  const balanceCents = sum(late.map((operation) => operation.balanceCents));
  return {
    bands, operations: late, operationCount: late.length, clientCount: distinctClients(late), balanceCents,
    principalRemainingCents: sum(late.map((operation) => operation.principalRemainingCents)),
    // Parte do total a receber (saldo das operações em aberto) que está em atraso, em pontos-base (1% = 100).
    receivableCents, shareBps: receivableCents > 0 ? Math.round((balanceCents * 10_000) / receivableCents) : 0,
  };
}
