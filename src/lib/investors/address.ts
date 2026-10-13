// Endereço usado no contrato de investimento (investidor e empresa contratante), com as mesmas partes do endereço
// do cliente: CEP, logradouro, número, complemento, bairro, cidade e UF.
import { addressParts, brazilianStates, maskCep, type AddressPart } from "../finance/client-profile";
import { onlyDigits } from "../finance/format";

type Failure = { ok: false; error: string };
type Read = (key: string, max: number) => string;

export type Address = Record<AddressPart, string | null>;
export const emptyAddress = (): Address => Object.fromEntries(addressParts.map((part) => [part, null])) as Address;
// Partes do endereço exigidas no contrato (o complemento é opcional).
const REQUIRED_ADDRESS_PARTS: AddressPart[] = ["Street", "Number", "District", "City", "State", "Cep"];

// Endereço de um formulário (campos `${prefixo}Cep`, `${prefixo}Street`…). CEP com 8 dígitos e UF válida, quando informados.
export function addressFields(read: Read, prefix: string): { ok: true; value: Address } | Failure {
  const value = emptyAddress();
  for (const part of addressParts) value[part] = read(`${prefix}${part}`, 160) || null;
  if (value.Cep) {
    const cep = onlyDigits(value.Cep);
    if (cep.length !== 8) return { ok: false, error: "O CEP precisa ter 8 dígitos, por exemplo 01310-100." };
    value.Cep = cep;
  }
  if (value.State && !brazilianStates.includes(value.State)) return { ok: false, error: "Escolha o estado (UF) do endereço." };
  return { ok: true, value };
}

// Endereço em uma linha, no formato usado no contrato. null quando nada foi preenchido.
export function addressLine(address: Address) {
  const parts = [
    [address.Street, address.Number].filter(Boolean).join(", "),
    address.Complement,
    address.District,
    [address.City, address.State].filter(Boolean).join("/"),
    address.Cep ? `CEP ${maskCep(address.Cep)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export const addressComplete = (address: Address) => REQUIRED_ADDRESS_PARTS.every((part) => Boolean(address[part]?.trim()));

