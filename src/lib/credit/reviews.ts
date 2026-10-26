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
} as const;

export type ReviewPhase = keyof typeof PHASE_REVIEWS;
export const reviewOf = (phase: string) => (phase in PHASE_REVIEWS ? PHASE_REVIEWS[phase as ReviewPhase] : null);
