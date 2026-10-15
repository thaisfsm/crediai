// Dados bancários e chave Pix de clientes e investidores (regras puras, usadas no navegador, no servidor e nos testes).
// Tudo é opcional: o cadastro não exige conta bancária. O que for informado tem o formato conferido; CPF/CNPJ do titular
// e chaves Pix de CPF/CNPJ passam pelos dígitos verificadores. Estes dados nunca entram na auditoria nem em logs.
import { normalizeEmail } from "./contacts";
import { cnpjProblem, cpfProblem, formatCpfCnpj, formatPhone, normalizePhone, onlyDigits } from "./finance/format";

export const BANK_ACCOUNT_TYPES = { CHECKING: "Conta corrente", SAVINGS: "Conta poupança", PAYMENT: "Conta de pagamento", SALARY: "Conta salário" } as const;
export type BankAccountType = keyof typeof BANK_ACCOUNT_TYPES;
export const PIX_KEY_TYPES = { CPF: "CPF", CNPJ: "CNPJ", EMAIL: "E-mail", PHONE: "Celular", RANDOM: "Chave aleatória" } as const;
export type PixKeyType = keyof typeof PIX_KEY_TYPES;

// Nomes dos campos (iguais nas colunas do cliente e do investidor, em camelCase).
export const bankKeys = ["bankHolderName", "bankHolderDocument", "bankName", "bankBranch", "bankAccount", "bankAccountType", "pixKeyType", "pixKey"] as const;
export type BankKey = (typeof bankKeys)[number];
export type BankValues = Record<BankKey, string | null>;
export const bankLabels: Record<BankKey, string> = {
  bankHolderName: "Titular da conta", bankHolderDocument: "CPF/CNPJ do titular", bankName: "Banco", bankBranch: "Agência",
  bankAccount: "Conta", bankAccountType: "Tipo de conta", pixKeyType: "Tipo da chave Pix", pixKey: "Chave Pix",
};

type Failure = { ok: false; error: string };
type Read = (key: string, max: number) => string;
const pick = <T extends string>(options: Record<T, string>, value: string) => (Object.keys(options) as T[]).find((key) => key === value) ?? null;

// Chave aleatória do Pix (EVP): UUID, gravado em minúsculas.
const RANDOM_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Chave Pix conforme o tipo. CPF, CNPJ e celular gravados só com dígitos; e-mail em minúsculas; aleatória em minúsculas.
export function normalizePixKey(type: PixKeyType, value: string): { ok: true; value: string } | Failure {
  const clean = value.trim();
  if (type === "CPF") { const problem = cpfProblem(clean); return problem || !onlyDigits(clean) ? { ok: false, error: `Chave Pix: ${problem ?? "informe o CPF."}` } : { ok: true, value: onlyDigits(clean) }; }
  if (type === "CNPJ") { const problem = cnpjProblem(clean); return problem || !onlyDigits(clean) ? { ok: false, error: `Chave Pix: ${problem ?? "informe o CNPJ."}` } : { ok: true, value: onlyDigits(clean) }; }
  if (type === "EMAIL") { const email = normalizeEmail(clean); return email.ok && email.value ? { ok: true, value: email.value } : { ok: false, error: "Chave Pix: informe um e-mail válido, por exemplo nome@exemplo.com." }; }
  if (type === "PHONE") {
    // Aceita o número com ou sem +55 na frente.
    const digits = onlyDigits(clean).replace(/^55(?=\d{10,11}$)/, "");
    const phone = normalizePhone(digits);
    return phone.ok && phone.value ? { ok: true, value: phone.value } : { ok: false, error: "Chave Pix: informe o celular com DDD, por exemplo (11) 98765-4321." };
  }
  const key = clean.toLowerCase();
  return RANDOM_KEY.test(key) ? { ok: true, value: key } : { ok: false, error: "Chave Pix: a chave aleatória tem 32 letras e números, no formato 123e4567-e89b-12d3-a456-426614174000." };
}

export function formatPixKey(type: string | null, key: string | null) {
  if (!key) return null;
  if (type === "CPF" || type === "CNPJ") return formatCpfCnpj(key);
  if (type === "PHONE") return formatPhone(key);
  return key;
}

// Lê e confere os dados bancários de um formulário. Campos vazios ficam null.
export function bankFields(read: Read): { ok: true; values: BankValues } | Failure {
  const value = (key: BankKey, max: number) => read(key, max) || null;
  const values: BankValues = {
    bankHolderName: value("bankHolderName", 160), bankHolderDocument: null, bankName: value("bankName", 120),
    bankBranch: null, bankAccount: null, bankAccountType: null, pixKeyType: null, pixKey: null,
  };
  const holderDocument = read("bankHolderDocument", 40);
  if (holderDocument) {
    const digits = onlyDigits(holderDocument);
    const problem = digits.length === 14 ? cnpjProblem(digits) : cpfProblem(digits);
    if (problem) return { ok: false, error: `CPF/CNPJ do titular: ${problem}` };
    values.bankHolderDocument = digits;
  }
  const branch = read("bankBranch", 20).replace(/\s/g, "");
  if (branch && !/^\d{1,5}(-[\dXx])?$/.test(branch)) return { ok: false, error: "Agência: use só números, com o dígito depois do traço se houver, por exemplo 1234 ou 1234-5." };
  values.bankBranch = branch ? branch.toUpperCase() : null;
  const account = read("bankAccount", 30).replace(/\s/g, "");
  if (account && !/^\d{1,20}(-[\dXx])?$/.test(account)) return { ok: false, error: "Conta: use só números, com o dígito depois do traço, por exemplo 12345-6." };
  values.bankAccount = account ? account.toUpperCase() : null;
  const accountType = read("bankAccountType", 20);
  if (accountType) {
    const type = pick(BANK_ACCOUNT_TYPES, accountType);
    if (!type) return { ok: false, error: "Escolha o tipo de conta na lista." };
    values.bankAccountType = type;
  }
  const pixKey = read("pixKey", 160);
  const pixTypeInput = read("pixKeyType", 20);
  if (pixKey) {
    const type = pick(PIX_KEY_TYPES, pixTypeInput);
    if (!type) return { ok: false, error: "Escolha o tipo da chave Pix (CPF, CNPJ, e-mail, celular ou chave aleatória)." };
    const normalized = normalizePixKey(type, pixKey);
    if (!normalized.ok) return normalized;
    values.pixKeyType = type;
    values.pixKey = normalized.value;
  }
  return { ok: true, values };
}

// Resumo da conta em uma linha para a ficha; null quando nada foi preenchido.
export function bankSummary(values: BankValues) {
  const account = [values.bankName, values.bankBranch && `ag. ${values.bankBranch}`, values.bankAccount && `conta ${values.bankAccount}`,
    values.bankAccountType && BANK_ACCOUNT_TYPES[values.bankAccountType as BankAccountType]].filter(Boolean).join(" · ");
  const holder = [values.bankHolderName, values.bankHolderDocument && formatCpfCnpj(values.bankHolderDocument)].filter(Boolean).join(" · ");
  return { account: account || null, holder: holder || null, pix: values.pixKey ? `${PIX_KEY_TYPES[values.pixKeyType as PixKeyType] ?? "Chave"}: ${formatPixKey(values.pixKeyType, values.pixKey)}` : null };
}
