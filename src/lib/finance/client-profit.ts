// Histórico de lucro de um cliente em TODOS os ciclos da carteira (juros efetivamente recebidos). Só leitura, sem conta nova:
// usa o que o extrato de cada operação já calculou. Operações excluídas nunca entram.
import type { OperationView } from "./portfolio";

export type ClientProfitOperation = {
  id: string; code: string; loanDate: string; cycleNumber: number | null; status: OperationView["status"];
  principalCents: number; carriedCents: number; interestReceivedCents: number; receivedCents: number; principalRemainingCents: number; balanceCents: number;
};

type OperationLike = Pick<OperationView, "id" | "code" | "clientId" | "loanDate" | "status" | "principalCents" | "interestPaidCents" | "paidCents" | "principalRemainingCents" | "balanceCents"> & { cycleNumber?: number; renegotiatedPrincipalCents?: number | null };

export function clientProfitHistory(operations: OperationLike[], clientId: string) {
  const rows: ClientProfitOperation[] = operations
    .filter((operation) => operation.clientId === clientId && operation.status !== "CANCELED")
    .map((operation) => ({
      id: operation.id, code: operation.code, loanDate: operation.loanDate, cycleNumber: operation.cycleNumber ?? null, status: operation.status,
      principalCents: operation.principalCents, carriedCents: operation.status === "RENEGOTIATED" ? operation.renegotiatedPrincipalCents ?? 0 : 0, interestReceivedCents: operation.interestPaidCents, receivedCents: operation.paidCents,
      principalRemainingCents: operation.principalRemainingCents, balanceCents: operation.balanceCents,
    }))
    .sort((a, b) => b.loanDate.localeCompare(a.loanDate) || a.code.localeCompare(b.code));
  const sum = (pick: (row: ClientProfitOperation) => number, only?: (row: ClientProfitOperation) => boolean) => rows.filter(only ?? (() => true)).reduce((total, row) => total + pick(row), 0);
  const interestReceivedCents = sum((row) => row.interestReceivedCents);
  const principalOpenCents = sum((row) => row.principalRemainingCents, (row) => row.status === "OPEN");
  return {
    rows,
    operationCount: rows.length,
    paidCount: rows.filter((row) => row.status === "PAID").length,
    openCount: rows.filter((row) => row.status === "OPEN").length,
    // Principal renegociado passa para o contrato novo: conta uma vez só.
    principalLentCents: sum((row) => row.principalCents - row.carriedCents),
    interestReceivedCents,
    // Lucro só dos contratos já quitados (o que o cliente fechou e deixou de lucro).
    paidContractsProfitCents: sum((row) => row.interestReceivedCents, (row) => row.status === "PAID"),
    principalOpenCents,
    // Quanto do principal hoje em aberto já está "coberto" pelo lucro recebido (0 quando não há principal em aberto).
    coveragePercent: principalOpenCents > 0 ? Math.round((interestReceivedCents / principalOpenCents) * 100) : null,
    // Se o lucro já recebido é maior que o principal em aberto, a parte em risco é só o que excede o lucro.
    exposureAfterProfitCents: Math.max(0, principalOpenCents - interestReceivedCents),
  };
}
export type ClientProfitHistory = ReturnType<typeof clientProfitHistory>;
