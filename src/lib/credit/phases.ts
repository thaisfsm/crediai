// Fases da esteira de crédito, na ordem em que a proposta caminha.
export const PROPOSAL_PHASES = [
  { key: "RECEIVED", label: "Proposta recebida", hint: "Cliente preencheu a proposta e enviou os documentos." },
  { key: "IDENTITY", label: "Identidade e antifraude", hint: "Conferir o documento e a titularidade da conta." },
  { key: "DOCUMENTS", label: "Documentação validada", hint: "Conferir extrato bancário e holerite." },
  { key: "CAPACITY", label: "Análise de capacidade de pagamento", hint: "Analisar a movimentação bancária." },
  { key: "ENGINE", label: "Motor de crédito", hint: "Cálculos e regras da política de crédito." },
  { key: "APPROVAL", label: "Aprovação e oferta", hint: "Aprovar e apresentar as condições ao cliente." },
  { key: "ACCEPTANCE", label: "Aceite do cliente", hint: "Cliente aceita as condições aprovadas." },
] as const;

export type ProposalPhase = (typeof PROPOSAL_PHASES)[number]["key"];
export const PHASE_KEYS = PROPOSAL_PHASES.map((phase) => phase.key) as ProposalPhase[];
