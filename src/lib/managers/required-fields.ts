// Campos obrigatórios do cadastro de cliente feito pela gerente de contas: sem eles o cadastro não grava (tela e servidor).
// A gerente responde pelas operações dos clientes que cadastra, então o cadastro precisa estar completo.
export const MANAGER_REQUIRED_FIELDS: Record<string, string> = {
  name: "Nome completo", document: "CPF", phone: "Telefone", whatsapp: "WhatsApp",
  residentialCep: "CEP do endereço residencial", residentialStreet: "Logradouro do endereço residencial", residentialNumber: "Número do endereço residencial",
  residentialDistrict: "Bairro do endereço residencial", residentialCity: "Cidade do endereço residencial", residentialState: "Estado do endereço residencial",
  reference1Name: "Referência 1: nome", reference1Phone: "Referência 1: telefone", reference1Relationship: "Referência 1: grau de parentesco",
  reference2Name: "Referência 2: nome", reference2Phone: "Referência 2: telefone", reference2Relationship: "Referência 2: grau de parentesco",
};

export function missingManagerFields(read: (key: string) => string): string[] {
  return Object.entries(MANAGER_REQUIRED_FIELDS).filter(([key]) => !read(key).trim()).map(([, label]) => label);
}
