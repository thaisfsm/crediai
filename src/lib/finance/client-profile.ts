// Campos do cadastro completo do cliente: endereços, referências e avalista. Usado pelo formulário, pela ação de
// gravação e pela ficha do cliente, para que os três tratem sempre os mesmos campos.
export const addressKinds = { residential: "Endereço residencial", business: "Endereço comercial" } as const;
export type AddressKind = keyof typeof addressKinds;
export const addressParts = ["Cep", "Street", "Number", "Complement", "District", "City", "State"] as const;
export type AddressPart = (typeof addressParts)[number];
export const addressPartLabels: Record<AddressPart, string> = {
  Cep: "CEP", Street: "Logradouro", Number: "Número", Complement: "Complemento", District: "Bairro", City: "Cidade", State: "Estado",
};

export const referenceSlots = [1, 2] as const;
export const referenceParts = ["Name", "Phone", "Relationship"] as const;
export const referencePartLabels = { Name: "Nome", Phone: "Telefone", Relationship: "Grau de parentesco" } as const;
export const guarantorParts = ["Name", "Document", "Phone", "Notes"] as const;
export const guarantorPartLabels = { Name: "Nome do avalista", Document: "CPF do avalista", Phone: "Telefone do avalista", Notes: "Observação sobre o avalista" } as const;

type AddressKey = `${AddressKind}${AddressPart}`;
type ReferenceKey = `reference${(typeof referenceSlots)[number]}${(typeof referenceParts)[number]}`;
type GuarantorKey = `guarantor${(typeof guarantorParts)[number]}`;
export type ClientProfileKey = AddressKey | ReferenceKey | GuarantorKey;
export type ClientProfile = Record<ClientProfileKey, string | null>;

export const addressKey = (kind: AddressKind, part: AddressPart) => `${kind}${part}` as AddressKey;
export const referenceKey = (slot: (typeof referenceSlots)[number], part: (typeof referenceParts)[number]) => `reference${slot}${part}` as ReferenceKey;
export const guarantorKey = (part: (typeof guarantorParts)[number]) => `guarantor${part}` as GuarantorKey;

export const clientProfileKeys: ClientProfileKey[] = [
  ...(Object.keys(addressKinds) as AddressKind[]).flatMap((kind) => addressParts.map((part) => addressKey(kind, part))),
  ...referenceSlots.flatMap((slot) => referenceParts.map((part) => referenceKey(slot, part))),
  ...guarantorParts.map(guarantorKey),
];

export const brazilianStates = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];

// CEP com máscara 01310-100.
export function maskCep(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

// Endereço em uma linha para a ficha do cliente; null quando nada foi preenchido.
export function formatAddress(profile: ClientProfile, kind: AddressKind) {
  const get = (part: AddressPart) => profile[addressKey(kind, part)];
  const street = [get("Street"), get("Number")].filter(Boolean).join(", ");
  const parts = [street + (get("Complement") ? ` (${get("Complement")})` : ""), get("District"), [get("City"), get("State")].filter(Boolean).join("/"), get("Cep") ? `CEP ${maskCep(get("Cep") ?? "")}` : ""];
  const line = parts.filter(Boolean).join(" · ");
  return line || null;
}
