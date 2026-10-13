// Simulação de renegociação (Etapa H, parte 1). SÓ LEITURA: nada aqui grava, encerra operação ou mexe no capital.
// A gravação (Etapa H, parte 2) depende das decisões D-H1 a D-H4. A simulação segue as propostas da Etapa A:
//  • D-H1: o ponto de partida é o saldo atual de cada operação pelas regras de hoje (principal em aberto + juros em
//    aberto), com desconto ou acréscimo informado explicitamente.
//  • D-H2: o principal da nova operação é o principal em aberto das antigas (não sai dinheiro novo); os juros em aberto
//    entram como valor fixo, sem contar como recebidos.
//  • Juros simples sobre o PRINCIPAL: os juros novos nunca incidem sobre juros em aberto (sem juros sobre juros).
import { dueDates, simpleInterest } from "./rules";
import type { OperationView } from "./portfolio";

export type RenegotiationModality = "SINGLE" | "INSTALLMENT";
export type RenegotiationFrequency = "MONTHLY" | "BIWEEKLY";
export type RenegotiationTerms = {
  modality: RenegotiationModality; frequency: RenegotiationFrequency; rateBps: number; count: number; firstDueDate: string;
  // Positivo = acréscimo; negativo = desconto.
  adjustmentCents: number;
};

// Posição atual das operações escolhidas (só as em aberto entram).
export function renegotiationPosition(operations: OperationView[]) {
  const open = operations.filter((operation) => operation.status === "OPEN");
  const sum = (pick: (operation: OperationView) => number) => open.reduce((total, operation) => total + pick(operation), 0);
  return {
    count: open.length,
    principalOpenCents: sum((operation) => operation.principalRemainingCents),
    interestOpenCents: sum((operation) => operation.interestRemainingCents),
    balanceCents: sum((operation) => operation.balanceCents),
    overdueCount: open.filter((operation) => operation.state === "OVERDUE").length,
    receivedCents: sum((operation) => operation.paidCents),
  };
}
export type RenegotiationPosition = ReturnType<typeof renegotiationPosition>;

export function simulateRenegotiation(position: RenegotiationPosition, terms: RenegotiationTerms) {
  const baseCents = position.principalOpenCents;
  const carriedInterestCents = position.interestOpenCents;
  const renegotiatedCents = position.balanceCents + terms.adjustmentCents;
  const periods = terms.modality === "INSTALLMENT" ? terms.count : 1;
  // Juros novos: taxa simples do período sobre o principal em aberto, vezes a quantidade de períodos.
  const newInterestCents = simpleInterest({ principalCents: baseCents, rateBps: terms.rateBps, periods });
  const totalCents = renegotiatedCents + newInterestCents;
  const dates = dueDates(terms.frequency, terms.firstDueDate, periods);
  const installmentCents = Math.floor(totalCents / periods);
  const payments = dates.map((dueDate, index) => ({ number: index + 1, dueDate, amountCents: index === periods - 1 ? totalCents - installmentCents * (periods - 1) : installmentCents }));
  const warnings: string[] = [];
  if (renegotiatedCents < baseCents) warnings.push("O desconto passa dos juros em aberto: parte do principal emprestado deixaria de voltar.");
  if (position.balanceCents !== baseCents + carriedInterestCents) warnings.push("O saldo das operações não bate com principal + juros em aberto; confira as operações escolhidas.");
  return {
    baseCents, carriedInterestCents, adjustmentCents: terms.adjustmentCents, renegotiatedCents, newInterestCents, totalCents, payments,
    // Na renovação do pagamento único, cada novo período cobraria de novo a taxa sobre o principal em aberto.
    periodInterestCents: simpleInterest({ principalCents: baseCents, rateBps: terms.rateBps }),
    warnings,
  };
}
