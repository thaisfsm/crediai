import { bankKeys } from "../bank-account";
import { addressKey, addressParts, companyKeys, contactKeys, guarantorKey, guarantorParts, personalKeys, referenceKey, referenceParts, referenceSlots, type ClientProfileKey } from "../finance/client-profile";

// Formulário público da proposta (link do cliente): as etapas com os campos do cadastro de Clientes que o próprio cliente preenche.
// Fica de fora só o que é interno do dono: observações, marcação de cassino online, gerente de contas/comissão e a escolha do
// avalista na base de clientes (que mostraria outros clientes). Nome, CPF e telefone ficam na própria proposta (etapa "Proposta").
// Usado pela tela (navegador), pelo servidor e pelos testes, para que os três tratem sempre os mesmos campos.
export const CLIENT_DATA_STEPS = [
  { key: "personal", label: "Dados pessoais e contatos", keys: [...personalKeys, ...contactKeys] },
  { key: "home", label: "Endereço residencial", keys: addressParts.map((part) => addressKey("residential", part)) },
  { key: "work", label: "Trabalho e empresa", keys: [...companyKeys, ...addressParts.map((part) => addressKey("business", part))] },
  { key: "bank", label: "Dados bancários e Pix", keys: [...bankKeys] },
  { key: "references", label: "Referências e avalista", keys: [...referenceSlots.flatMap((slot) => referenceParts.map((part) => referenceKey(slot, part))), ...guarantorParts.map(guarantorKey)] },
] as const satisfies readonly { key: string; label: string; keys: readonly ClientProfileKey[] }[];
export type ClientDataStepKey = (typeof CLIENT_DATA_STEPS)[number]["key"];
export const CLIENT_DATA_KEYS: ClientProfileKey[] = CLIENT_DATA_STEPS.flatMap((step) => [...step.keys]);
export const isClientDataStep = (value: string): value is ClientDataStepKey => CLIENT_DATA_STEPS.some((step) => step.key === value);

// Obrigatórios para enviar (além de nome, CPF, telefone, renda e os 4 documentos da proposta). O resto é opcional,
// mas o que for informado passa pelas mesmas validações do cadastro de Clientes.
export const REQUIRED_CLIENT_DATA: { key: ClientProfileKey; label: string; step: ClientDataStepKey }[] = [
  { key: "birthDate", label: "Data de nascimento", step: "personal" },
  { key: "residentialCep", label: "CEP residencial", step: "home" },
  { key: "residentialStreet", label: "Logradouro residencial", step: "home" },
  { key: "residentialNumber", label: "Número residencial", step: "home" },
  { key: "residentialDistrict", label: "Bairro residencial", step: "home" },
  { key: "residentialCity", label: "Cidade residencial", step: "home" },
  { key: "residentialState", label: "Estado (UF) residencial", step: "home" },
];

export type ClientData = Partial<Record<ClientProfileKey, string>>;

// Etapas com algo preenchido (para a barra de progresso e para o dono ver onde o cliente parou).
export function filledSteps(data: ClientData | null | undefined): ClientDataStepKey[] {
  return CLIENT_DATA_STEPS.filter((step) => step.keys.some((key) => Boolean(data?.[key]))).map((step) => step.key);
}

// O que ainda falta para enviar: campos obrigatórios do cadastro e da proposta. Lista vazia = pode enviar.
export function missingForSubmit(data: ClientData | null | undefined, proposal: { applicantName: string; cpf: string; phone: string | null; monthlyIncomeCents: number | null }) {
  const missing: string[] = [];
  if (proposal.applicantName.trim().length < 3) missing.push("Nome completo");
  if (!proposal.cpf) missing.push("CPF");
  if (!proposal.phone) missing.push("Telefone");
  if (!proposal.monthlyIncomeCents) missing.push("Renda mensal");
  for (const field of REQUIRED_CLIENT_DATA) if (!data?.[field.key]) missing.push(field.label);
  return missing;
}
