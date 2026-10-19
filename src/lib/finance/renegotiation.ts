// Simulação de renegociação (Etapa H, parte 1). SÓ LEITURA: nada aqui grava, encerra operação ou mexe no capital.
// A gravação (Etapa H, parte 2) depende das decisões D-H1 a D-H4. A simulação segue as propostas da Etapa A:
//  • D-H1: o ponto de partida é o saldo atual de cada operação pelas regras de hoje (principal em aberto + juros em
//    aberto), com desconto ou acréscimo informado explicitamente.
//  • D-H2: o principal da nova operação é o principal em aberto das antigas (não sai dinheiro novo); os juros em aberto
//    entram como valor fixo, sem contar como recebidos.
//  • Juros simples sobre o PRINCIPAL: os juros novos nunca incidem sobre juros em aberto (sem juros sobre juros).
import { BIWEEKLY_INSTALLMENT_RULE, BIWEEKLY_RULE, INSTALLMENT_RULE, calculateOperation, dueDates, installmentDueDate, simpleInterest } from "./rules";
import type { OperationView } from "./portfolio";

export type RenegotiationModality = "SINGLE" | "INSTALLMENT";
export type RenegotiationFrequency = "MONTHLY" | "BIWEEKLY";
export type RenegotiationTerms = {
  modality: RenegotiationModality; frequency: RenegotiationFrequency; rateBps: number; count: number; firstDueDate: string;
  // Positivo = acréscimo; negativo = desconto.
  adjustmentCents: number;
  // Multa somada só à ÚLTIMA parcela (a parcela pulada que vai para o final). Opcional; conta como juros do contrato.
  penaltyCents?: number;
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
    // Juros já recebidos nas operações escolhidas: lucro realizado que continua registrado nelas.
    interestReceivedCents: sum((operation) => operation.interestPaidCents),
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
  const penaltyCents = Math.max(0, terms.penaltyCents ?? 0);
  const totalCents = renegotiatedCents + newInterestCents + penaltyCents;
  const dates = dueDates(terms.frequency, terms.firstDueDate, periods);
  // As parcelas iguais dividem o total sem a multa; a última leva o resto e a multa.
  const installmentCents = Math.floor((totalCents - penaltyCents) / periods);
  const payments = dates.map((dueDate, index) => ({ number: index + 1, dueDate, amountCents: index === periods - 1 ? totalCents - installmentCents * (periods - 1) : installmentCents }));
  const warnings: string[] = [];
  if (renegotiatedCents < baseCents) warnings.push("O desconto passa dos juros em aberto: parte do principal emprestado deixaria de voltar.");
  if (position.balanceCents !== baseCents + carriedInterestCents) warnings.push("O saldo das operações não bate com principal + juros em aberto; confira as operações escolhidas.");
  // Cenário atual × proposta. O ajuste age primeiro sobre os juros em aberto; um desconto maior que eles reduz o principal
  // (o aviso acima). O principal da proposta é o mesmo dinheiro já emprestado: nenhuma saída nova de caixa.
  const interestAfterAdjustment = carriedInterestCents + terms.adjustmentCents;
  const comparison = {
    principal: { current: baseCents, proposal: baseCents + Math.min(0, interestAfterAdjustment) },
    interest: { current: carriedInterestCents, proposal: Math.max(0, interestAfterAdjustment) + newInterestCents + penaltyCents },
    total: { current: position.balanceCents, proposal: totalCents },
    // Lucro realizado não muda na renegociação: os juros recebidos continuam nas antigas e os novos só contam quando pagos.
    realizedProfit: { current: position.interestReceivedCents, proposal: position.interestReceivedCents },
    capitalOutflowCents: 0,
  };
  return {
    comparison,
    baseCents, carriedInterestCents, adjustmentCents: terms.adjustmentCents, penaltyCents, renegotiatedCents, newInterestCents, totalCents, payments,
    // Na renovação do pagamento único, cada novo período cobraria de novo a taxa sobre o principal em aberto.
    periodInterestCents: simpleInterest({ principalCents: baseCents, rateBps: terms.rateBps }),
    warnings,
  };
}

// Contrato novo que a gravação cria (Etapa H, parte 2), com os mesmos números da simulação. O principal é o principal em
// aberto das antigas (nenhum dinheiro novo); os juros em aberto, o ajuste e os juros novos formam os juros do contrato.
// Parcelado: a parcela é arredondada para cima em centavos (parcela fixa); a diferença, de no máximo count−1 centavos,
// vai para os juros e é informada em roundingCents. Desconto maior que os juros em aberto não grava (devolveria principal).
export function renegotiationContract(position: RenegotiationPosition, terms: RenegotiationTerms, loanDate: string) {
  const sim = simulateRenegotiation(position, terms);
  if (position.principalOpenCents <= 0) return { ok: false as const, error: "As operações escolhidas não têm principal em aberto para renegociar." };
  if (sim.renegotiatedCents < sim.baseCents) return { ok: false as const, error: "O desconto passa dos juros em aberto: parte do principal emprestado deixaria de voltar. Reduza o desconto." };
  if (terms.firstDueDate < loanDate) return { ok: false as const, error: "O primeiro vencimento não pode ser antes de hoje." };
  const principalCents = sim.baseCents;
  if (terms.modality === "INSTALLMENT") {
    // Parcela fixa para cima; a multa (se houver) vai inteira na última, que a agenda calcula como total − parcela × (n − 1).
    const installmentCents = Math.ceil((sim.totalCents - sim.penaltyCents) / terms.count);
    const totalCents = installmentCents * terms.count + sim.penaltyCents;
    const interestCents = totalCents - principalCents;
    return {
      ok: true as const, roundingCents: totalCents - sim.totalCents, sim,
      contract: {
        principalCents, interestCents, totalCents, loanDate, dueDate: installmentDueDate(terms.firstDueDate, terms.count, terms.frequency), modality: "INSTALLMENT" as const, frequency: terms.frequency,
        interestRateBps: terms.rateBps, calculationRule: terms.frequency === "BIWEEKLY" ? BIWEEKLY_INSTALLMENT_RULE : INSTALLMENT_RULE,
        installmentCount: terms.count, installmentCents, firstDueDate: terms.firstDueDate,
      },
    };
  }
  const interestCents = sim.totalCents - principalCents;
  return {
    ok: true as const, roundingCents: 0, sim,
    contract: {
      principalCents, interestCents, totalCents: sim.totalCents, loanDate, dueDate: terms.firstDueDate, modality: "SINGLE" as const, frequency: terms.frequency,
      interestRateBps: terms.rateBps, calculationRule: terms.frequency === "BIWEEKLY" ? BIWEEKLY_RULE : calculateOperation({ principalCents, interestRateBps: terms.rateBps }).calculationRule,
      installmentCount: null, installmentCents: null, firstDueDate: terms.firstDueDate,
    },
  };
}

// "Jogar a parcela para o final": a parcela pulada vai para o fim do cronograma e as demais mantêm as datas. Só vale para a
// primeira parcela ainda não paga (assim as datas das seguintes continuam seguidas, sem buraco). O contrato novo tem as
// parcelas que faltam (a pulada inclusive), taxa 0 (nada de juros novos) e a multa na última; o saldo vem da operação.
export function skipInstallmentPlan(operation: Pick<OperationView, "status" | "modality" | "frequency" | "installments">, number: number) {
  if (operation.status !== "OPEN" || operation.modality !== "INSTALLMENT" || operation.installments.length === 0) return { ok: false as const, error: "Só parcelados em aberto têm parcelas para jogar para o final." };
  const unpaid = operation.installments.filter((item) => item.state !== "PAID");
  const target = unpaid[0];
  if (!target) return { ok: false as const, error: "Todas as parcelas já foram pagas." };
  if (target.number !== number) return { ok: false as const, error: `Jogue primeiro a parcela ${target.number}, a mais antiga em aberto. As datas das seguintes ficam em sequência.` };
  const next = unpaid[1];
  return {
    ok: true as const, count: unpaid.length, frequency: (operation.frequency === "BIWEEKLY" ? "BIWEEKLY" : "MONTHLY") as RenegotiationFrequency,
    // Com parcelas seguintes, o contrato novo começa na próxima; se a pulada era a única, ela só muda de data (próximo período).
    firstDueDate: next ? next.dueDate : dueDates(operation.frequency === "BIWEEKLY" ? "BIWEEKLY" : "MONTHLY", target.dueDate, 2)[1],
    movedFrom: target.dueDate, movedAmountCents: target.amountCents, total: operation.installments.length,
  };
}
