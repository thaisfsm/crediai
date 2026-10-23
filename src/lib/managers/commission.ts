// Comissão do gerente de contas: percentual (pontos-base, 10% = 1000) sobre os JUROS efetivamente recebidos de cada cliente indicado.
// O percentual é livre por cliente (client.account_manager_bps); sem ele vale o padrão do gerente. A parte prevista usa os juros que
// ainda faltam receber nas operações em aberto (só estimativa, nunca é saldo). Só leitura.
import type { OperationView } from "@/lib/finance/portfolio";

export const commissionOf = (baseCents: number, bps: number) => Math.round((baseCents * bps) / 10000);

type OperationLike = Pick<OperationView, "id" | "clientId" | "status" | "state" | "interestPaidCents" | "interestRemainingCents" | "principalRemainingCents" | "balanceCents" | "daysUntilDue">;

export type ClientSituation = "OVERDUE" | "ON_TIME" | "PAID" | "NO_OPERATIONS";

// Situação real do cliente: qualquer operação em atraso pesa mais; só quitado quando nada resta em aberto.
export function clientSituation(operations: Pick<OperationLike, "status" | "state">[]): ClientSituation {
  const live = operations.filter((operation) => operation.status !== "CANCELED");
  if (live.length === 0) return "NO_OPERATIONS";
  const open = live.filter((operation) => operation.status === "OPEN");
  if (open.some((operation) => operation.state === "OVERDUE")) return "OVERDUE";
  if (open.length > 0) return "ON_TIME";
  return "PAID";
}

// Percentual que vale para o cliente: o dele, ou o padrão do gerente.
export const effectiveBps = (clientBps: number | null | undefined, managerBps: number) => clientBps ?? managerBps;

export function managerCommission(clients: { bps: number; operations: OperationLike[] }[], paidOutCents: number) {
  let interestReceivedCents = 0, interestExpectedCents = 0, earnedCents = 0, expectedCents = 0;
  for (const client of clients) {
    const live = client.operations.filter((operation) => operation.status !== "CANCELED");
    const received = live.reduce((total, operation) => total + operation.interestPaidCents, 0);
    const expected = live.filter((operation) => operation.status === "OPEN").reduce((total, operation) => total + operation.interestRemainingCents, 0);
    interestReceivedCents += received; interestExpectedCents += expected;
    earnedCents += commissionOf(received, client.bps); expectedCents += commissionOf(expected, client.bps);
  }
  return {
    interestReceivedCents, interestExpectedCents, earnedCents, expectedCents, paidOutCents,
    // A receber = ganho − já pago. Se foi pago a mais (adiantamento), o saldo é zero e o excedente aparece à parte.
    balanceCents: Math.max(0, earnedCents - paidOutCents), advanceCents: Math.max(0, paidOutCents - earnedCents),
  };
}
