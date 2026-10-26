// Conferências do dono em cada fase da esteira. Uma fase com conferência só avança quando todos os itens estão marcados.
export const PHASE_REVIEWS = {
  IDENTITY: {
    title: "Conferência de identidade e antifraude",
    checks: [
      { key: "documentChecked", label: "Documento de identidade conferido (legível, dados batem com o cadastro)" },
      { key: "holderChecked", label: "Titularidade da conta confirmada (extrato em nome do cliente)" },
      { key: "noFraudSigns", label: "Sem sinais de fraude ou adulteração nos documentos" },
    ],
  },
  DOCUMENTS: {
    title: "Conferência da documentação",
    checks: [
      { key: "bankStatementChecked", label: "Extrato bancário conferido (últimos 3 meses, em nome do cliente, sem rasuras)" },
      { key: "payslipChecked", label: "Holerite conferido (último, empresa e valores legíveis)" },
      { key: "incomeMatches", label: "Renda do holerite confere com a renda informada na proposta" },
    ],
  },
  CAPACITY: {
    title: "Análise da movimentação bancária",
    checks: [
      { key: "regularIncome", label: "Entradas regulares e compatíveis com a renda informada" },
      { key: "noOverdraft", label: "Sem saldo negativo nem uso recorrente de limite ou cheque especial" },
      { key: "noSuspiciousActivity", label: "Sem apostas, jogos ou transferências suspeitas" },
      { key: "capacityConfirmed", label: "Capacidade de pagamento da parcela confirmada" },
    ],
  },
} as const;

// Parcela estimada sem juros (valor ÷ prazo) e quanto ela pesa na renda informada. É só um indicador: os limites ficam para o motor de crédito.
export function capacityIndicator(requestedCents: number, termMonths: number, monthlyIncomeCents: number | null, negotiatedInstallmentCents: number | null = null) {
  const installmentCents = negotiatedInstallmentCents ?? Math.ceil(requestedCents / termMonths);
  const incomeShare = monthlyIncomeCents && monthlyIncomeCents > 0 ? Math.round((installmentCents / monthlyIncomeCents) * 1000) / 10 : null;
  return { installmentCents, incomeShare };
}

export type ReviewPhase = keyof typeof PHASE_REVIEWS;
export const reviewOf = (phase: string) => (phase in PHASE_REVIEWS ? PHASE_REVIEWS[phase as ReviewPhase] : null);
