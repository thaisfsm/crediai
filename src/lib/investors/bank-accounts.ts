// Contas bancárias do investidor (migração 0024): regras puras, usadas no navegador, no servidor e nos testes.
// Uma conta tem os dados de banco (código e/ou nome, agência, conta, dígitos, tipo) e/ou uma chave Pix. Só se exige o
// que se aplica: quem informa banco precisa informar agência e conta; quem usa só Pix não precisa de agência. Estes dados
// nunca vão para a auditoria nem para logs, e na tela aparecem mascarados (só os últimos dígitos).
import { BANK_ACCOUNT_TYPES, PIX_KEY_TYPES, normalizePixKey, type BankAccountType, type PixKeyType } from "../bank-account";
import { cnpjProblem, cpfProblem, onlyDigits } from "../finance/format";

export type BankAccountValues = {
  bankCode: string | null; bankName: string | null; branch: string | null; branchDigit: string | null; account: string | null; accountDigit: string | null;
  accountType: BankAccountType | null; holderName: string | null; holderDocument: string | null; pixKeyType: PixKeyType | null; pixKey: string | null;
  isPreferred: boolean; notes: string | null;
};
type Read = (key: string, max: number) => string;
type Failure = { ok: false; error: string };
const pick = <T extends string>(options: Record<T, string>, value: string) => (Object.keys(options) as T[]).find((key) => key === value) ?? null;

export function bankAccountFields(read: Read): { ok: true; values: BankAccountValues } | Failure {
  const text = (key: string, max: number) => read(key, max).replace(/\s+/g, " ").trim() || null;
  const bankCode = read("bankCode", 10).replace(/\s/g, "");
  if (bankCode && !/^\d{3}$/.test(bankCode)) return { ok: false, error: "Código do banco: 3 números, por exemplo 341 ou 001." };
  const branch = read("branch", 10).replace(/\s/g, "");
  if (branch && !/^\d{1,5}$/.test(branch)) return { ok: false, error: "Agência: só números, até 5, sem o dígito (ele vai no campo ao lado)." };
  const branchDigit = read("branchDigit", 2).replace(/\s/g, "").toUpperCase();
  if (branchDigit && !/^[0-9X]$/.test(branchDigit)) return { ok: false, error: "Dígito da agência: um número ou X." };
  const account = read("account", 25).replace(/\s/g, "");
  if (account && !/^\d{1,20}$/.test(account)) return { ok: false, error: "Conta: só números, sem o dígito (ele vai no campo ao lado)." };
  const accountDigit = read("accountDigit", 2).replace(/\s/g, "").toUpperCase();
  if (accountDigit && !/^[0-9X]$/.test(accountDigit)) return { ok: false, error: "Dígito da conta: um número ou X." };
  const typeInput = read("accountType", 20);
  const accountType = typeInput ? pick(BANK_ACCOUNT_TYPES, typeInput) : null;
  if (typeInput && !accountType) return { ok: false, error: "Escolha o tipo de conta na lista." };
  const bankName = text("bankName", 120);
  const hasBankData = Boolean(bankCode || bankName || branch || branchDigit || account || accountDigit || accountType);
  if (hasBankData && (!(bankCode || bankName) || !branch || !account)) return { ok: false, error: "Para a conta bancária, informe o banco (código ou nome), a agência e a conta. Para usar só Pix, deixe esses campos em branco." };

  let holderDocument: string | null = null;
  const holderInput = read("holderDocument", 40);
  if (holderInput) {
    const digits = onlyDigits(holderInput);
    const problem = digits.length === 14 ? cnpjProblem(holderInput) : cpfProblem(holderInput);
    if (problem) return { ok: false, error: `CPF/CNPJ do titular: ${problem}` };
    holderDocument = digits;
  }
  let pixKeyType: PixKeyType | null = null;
  let pixKey: string | null = null;
  const pixInput = read("pixKey", 160);
  if (pixInput) {
    pixKeyType = pick(PIX_KEY_TYPES, read("pixKeyType", 20));
    if (!pixKeyType) return { ok: false, error: "Escolha o tipo da chave Pix (CPF, CNPJ, e-mail, celular ou chave aleatória)." };
    const normalized = normalizePixKey(pixKeyType, pixInput);
    if (!normalized.ok) return normalized;
    pixKey = normalized.value;
  }
  if (!hasBankData && !pixKey) return { ok: false, error: "Informe a conta bancária (banco, agência e conta), a chave Pix ou os dois." };
  return {
    ok: true,
    values: {
      bankCode: bankCode || null, bankName, branch: branch || null, branchDigit: branchDigit || null, account: account || null, accountDigit: accountDigit || null,
      accountType, holderName: text("holderName", 160), holderDocument, pixKeyType, pixKey, isPreferred: read("isPreferred", 4) === "1", notes: text("notes", 500),
    },
  };
}

// Máscaras para a tela: só os últimos dígitos da conta e do documento; e-mail com o começo do nome e o domínio.
const tail = (value: string, keep: number) => `•••${value.slice(-keep)}`;
export function maskAccountNumber(account: string | null, digit: string | null) {
  if (!account) return null;
  return `${account.length > 3 ? tail(account, 3) : account}${digit ? `-${digit}` : ""}`;
}
export function maskPixKey(type: string | null, key: string | null) {
  if (!key) return null;
  if (type === "EMAIL") { const [user, domain] = key.split("@"); return `${user.slice(0, 2)}•••@${domain ?? ""}`; }
  if (type === "CPF") return `•••.${key.slice(3, 6)}.•••-${key.slice(-2)}`;
  if (type === "CNPJ") return `••.${key.slice(2, 5)}.•••/${key.slice(8, 12)}-••`;
  if (type === "PHONE") return `(${key.slice(0, 2)}) •••••-${key.slice(-4)}`;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
export const maskDocument = (document: string | null) => (document ? tail(document, 4) : null);

export type BankAccountRow = BankAccountValues & { id: string; archivedAt: string | null };
// Uma linha legível e mascarada da conta, para listas, seleção no contrato e o histórico.
type AccountIdentity = { bankCode: string | null; bankName: string | null; branch: string | null; branchDigit: string | null; account: string | null; accountDigit: string | null; pixKeyType: string | null; pixKey: string | null };
export function bankAccountLabel(row: AccountIdentity) {
  const bank = [row.bankCode, row.bankName].filter(Boolean).join(" ");
  const parts = [
    bank || null,
    row.branch ? `ag. ${row.branch}${row.branchDigit ? `-${row.branchDigit}` : ""}` : null,
    row.account ? `conta ${maskAccountNumber(row.account, row.accountDigit)}` : null,
    row.pixKey ? `Pix ${PIX_KEY_TYPES[row.pixKeyType as PixKeyType] ?? ""} ${maskPixKey(row.pixKeyType, row.pixKey)}`.replace(/\s+/g, " ") : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

// A forma de pagamento do contrato precisa servir na conta escolhida: Pix exige chave Pix; transferência exige banco,
// agência e conta. Dinheiro e "outra" não exigem conta.
export function accountFitsMethod(method: string | null, account: Pick<BankAccountRow, "pixKey" | "account" | "branch"> | null) {
  if (!account || !method) return null;
  if (method === "PIX" && !account.pixKey) return "A conta escolhida não tem chave Pix. Escolha outra conta ou outra forma de pagamento.";
  if (method === "TRANSFER" && !(account.account && account.branch)) return "A conta escolhida não tem banco, agência e conta para transferência. Escolha outra conta ou outra forma de pagamento.";
  return null;
}
