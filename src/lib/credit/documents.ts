// Documentos obrigatórios da proposta enviada pelo cliente (cada um vira uma coluna "kind" em credit_proposal_document).
export const PROPOSAL_DOCUMENTS = [
  { kind: "ID_DOCUMENT", label: "Documento de identidade (RG ou CNH)" },
  { kind: "PROOF_OF_ADDRESS", label: "Comprovante de residência" },
  { kind: "BANK_STATEMENT", label: "Extrato bancário (últimos 3 meses)" },
  { kind: "PAYSLIP", label: "Holerite (último)" },
] as const;

export type ProposalDocumentKind = (typeof PROPOSAL_DOCUMENTS)[number]["kind"];
export const PROPOSAL_DOCUMENT_KINDS = PROPOSAL_DOCUMENTS.map((doc) => doc.kind) as ProposalDocumentKind[];
export const PROPOSAL_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
