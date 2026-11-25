"use client";

// Partes do formulário de cadastro de cliente reaproveitadas fora do painel (formulário público da proposta):
// campo com máscara, dados bancários/Pix, endereço com busca de CEP e nome da empresa pelo CNPJ. Não chamam ações do servidor.
import { useRef, useState, type FormEvent, type InputHTMLAttributes } from "react";
import { BankNameInput } from "./bank-name-input";
import { BANK_ACCOUNT_TYPES, PIX_KEY_TYPES, formatPixKey, type BankValues, type PixKeyType } from "@/lib/bank-account";
import { cnpjProblem, cpfProblem, maskCnpj, maskCpf, onlyDigits } from "@/lib/finance/format";
import { addressPartLabels, addressParts, brazilianStates, maskCep, type AddressPart } from "@/lib/finance/client-profile";

// Campo com máscara (CPF, telefone, CEP) que guarda o valor digitado já formatado. Com "validate", a mensagem aparece
// enquanto o usuário digita e o navegador não envia o formulário com o valor inválido (o servidor confere de novo).
// Um valor antigo, reenviado sem alteração, não é bloqueado na tela (o servidor mantém o cadastro antigo como está).
export function MaskedInput({ name, mask, initial, validate, ...props }: { name: string; mask: (value: string) => string; initial: string; validate?: (value: string) => string | null } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "defaultValue">) {
  const [value, setValue] = useState(initial);
  const problem = validate && value !== initial ? validate(value) : null;
  return (
    <>
      <input name={name} value={value} aria-invalid={problem ? true : undefined}
        ref={(input) => { input?.setCustomValidity(problem ?? ""); }}
        onChange={(event) => setValue(mask(event.target.value))} {...props} />
      {problem && <small className="field-error" role="alert">{problem}</small>}
    </>
  );
}

// Dados bancários e chave Pix (opcionais), iguais para clientes e investidores. Regras em src/lib/bank-account.ts.
export function BankFieldset({ initial, legend = "Dados bancários e Pix" }: { initial?: Partial<BankValues> | null; legend?: string }) {
  const [pixType, setPixType] = useState<PixKeyType | "">((initial?.pixKeyType as PixKeyType | null) ?? "");
  const holderMask = (value: string) => (onlyDigits(value).length > 11 ? maskCnpj(value) : maskCpf(value));
  const pixInitial = formatPixKey(initial?.pixKeyType ?? null, initial?.pixKey ?? null) ?? "";
  const pixPlaceholder = { CPF: "000.000.000-00", CNPJ: "00.000.000/0000-00", EMAIL: "nome@exemplo.com", PHONE: "(11) 98765-4321", RANDOM: "123e4567-e89b-12d3-a456-426614174000", "": "Escolha o tipo primeiro" }[pixType];
  return (
    <fieldset className="form-section field-wide">
      <legend>{legend}</legend>
      <div className="form-grid">
        <label className="field field-wide"><span>Titular da conta</span><input name="bankHolderName" maxLength={160} defaultValue={initial?.bankHolderName ?? ""} placeholder="Nome como está no banco" /></label>
        <label className="field"><span>CPF/CNPJ do titular</span><MaskedInput name="bankHolderDocument" mask={holderMask} initial={initial?.bankHolderDocument ? holderMask(initial.bankHolderDocument) : ""} validate={(value) => (onlyDigits(value).length > 11 ? cnpjProblem(value) : cpfProblem(value))} inputMode="numeric" placeholder="CPF ou CNPJ" maxLength={20} /></label>
        <label className="field"><span>Banco</span><BankNameInput name="bankName" maxLength={120} defaultValue={initial?.bankName ?? ""} placeholder="Nome ou código, ex.: 341 Itaú" /></label>
        <label className="field"><span>Agência</span><input name="bankBranch" maxLength={20} defaultValue={initial?.bankBranch ?? ""} inputMode="numeric" placeholder="1234" /></label>
        <label className="field"><span>Conta</span><input name="bankAccount" maxLength={30} defaultValue={initial?.bankAccount ?? ""} inputMode="numeric" placeholder="12345-6" /></label>
        <label className="field"><span>Tipo de conta</span><select name="bankAccountType" defaultValue={initial?.bankAccountType ?? ""}><option value="">Não informado</option>{Object.entries(BANK_ACCOUNT_TYPES).filter(([key]) => key === "CHECKING" || key === "SAVINGS" || key === initial?.bankAccountType).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field"><span>Tipo da chave Pix</span><select name="pixKeyType" value={pixType} onChange={(event) => setPixType(event.target.value as PixKeyType | "")}><option value="">Sem chave Pix</option>{Object.entries(PIX_KEY_TYPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field"><span>Chave Pix</span><input name="pixKey" maxLength={160} defaultValue={pixInitial} placeholder={pixPlaceholder} disabled={!pixType} required={Boolean(pixType)} /></label>
      </div>
    </fieldset>
  );
}

type CepLookup = { street: string; district: string; city: string; state: string };
// Consulta o CEP no ViaCEP e, se ele não responder, na BrasilAPI (base dos Correios). null = CEP não encontrado.
async function lookupCep(cep: string): Promise<CepLookup | null> {
  try {
    const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    if (response.ok) {
      const data = await response.json();
      if (data.erro) return null;
      return { street: data.logradouro ?? "", district: data.bairro ?? "", city: data.localidade ?? "", state: data.uf ?? "" };
    }
  } catch {}
  const response = await fetch(`https://brasilapi.com.br/api/cep/v1/${cep}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("cep");
  const data = await response.json();
  return { street: data.street ?? "", district: data.neighborhood ?? "", city: data.city ?? "", state: data.state ?? "" };
}

// Mesmos campos de endereço (com CEP) para outros cadastros: investidor e empresa contratante dos contratos de investimento.
export function AddressFieldset({ legend, nameOf, initialOf }: { legend: string; nameOf: (part: AddressPart) => string; initialOf: (part: AddressPart) => string }) {
  const initial = initialOf;
  const [values, setValues] = useState(() => Object.fromEntries(addressParts.map((part) => [part, part === "Cep" ? maskCep(initial(part)) : initial(part)])) as Record<AddressPart, string>);
  const [lookup, setLookup] = useState<{ tone: "ok" | "error" | "busy"; text: string } | null>(null);
  const set = (part: AddressPart, value: string) => setValues((current) => ({ ...current, [part]: value }));
  const searchCep = async (masked: string) => {
    const cep = onlyDigits(masked);
    if (cep.length !== 8) return;
    setLookup({ tone: "busy", text: "Buscando o endereço pelo CEP…" });
    try {
      const found = await lookupCep(cep);
      if (!found) return setLookup({ tone: "error", text: "CEP não encontrado. Preencha o endereço manualmente." });
      setValues((current) => ({ ...current, Street: found.street || current.Street, District: found.district || current.District, City: found.city || current.City, State: found.state || current.State }));
      setLookup({ tone: "ok", text: "Endereço preenchido pelo CEP. Confira, complete o número e corrija se precisar." });
    } catch {
      setLookup({ tone: "error", text: "Não foi possível consultar o CEP agora. Preencha o endereço manualmente." });
    }
  };
  const field = (part: AddressPart, props: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label key={part} className={`field${part === "Street" ? " field-wide" : ""}`}><span>{addressPartLabels[part]}</span>
      <input name={nameOf(part)} value={values[part]} onChange={(event) => set(part, event.target.value)} maxLength={160} {...props} /></label>
  );
  return (
    <fieldset className="form-section field-wide">
      <legend>{legend}</legend>
      <div className="form-grid">
        <label className="field"><span>CEP</span><input name={nameOf("Cep")} inputMode="numeric" placeholder="00000-000" value={values.Cep}
          onChange={(event) => { const masked = maskCep(event.target.value); set("Cep", masked); if (onlyDigits(masked).length === 8) void searchCep(masked); }} /></label>
        {field("Street", { placeholder: "Rua, avenida…" })}
        {field("Number", { placeholder: "123" })}
        {field("Complement", { placeholder: "Apto, sala (opcional)" })}
        {field("District")}
        {field("City")}
        <label className="field"><span>Estado</span><select name={nameOf("State")} value={values.State} onChange={(event) => set("State", event.target.value)}>
          <option value="">UF</option>{brazilianStates.map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
        {lookup && <p className={`form-feedback field-wide ${lookup.tone === "error" ? "form-feedback-warning" : ""}`} role="status">{lookup.text}</p>}
      </div>
    </fieldset>
  );
}

// Preenchimento pelo CPF: ao completar um CPF válido, procura o CPF nos cadastros da própria carteira (cliente e investidor)
// e preenche só os campos ainda vazios do formulário, sem apagar o que a pessoa já digitou. Não consulta serviço externo.
// No formulário de cliente um CPF já cliente só avisa (CPF é único por carteira); o mesmo vale para o de investidor.
export function setEmptyField(form: HTMLFormElement, name: string, value: string, replaceable?: string): boolean {
  const element = form.elements.namedItem(name);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) return false;
  // Só campo vazio, ou o que ainda tem exatamente o valor que o preenchimento automático anterior pôs (o usuário não mexeu).
  // O CEP tem máscara: compara só os dígitos.
  const same = (a: string, b: string) => a === b || (name.endsWith("Cep") && onlyDigits(a) === onlyDigits(b));
  if (element.value && !(replaceable !== undefined && same(element.value, replaceable))) return false;
  if (same(element.value, value) && element.value) return true;
  setFieldValue(element, value);
  return true;
}
// Troca o valor de um campo como se fosse digitado (o React e as máscaras recebem o evento normalmente).
export function setFieldValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

// Nome da empresa pelo CNPJ: consulta a base pública da BrasilAPI (dado público da Receita) quando o CNPJ digitado é válido
// e preenche só os campos vazios: "Nome da empresa" e o endereço comercial. Falha ou CNPJ não encontrado: avisa e deixa digitar à mão.
export function useCompanyNamePrefill() {
  const [notice, setNotice] = useState<string | null>(null);
  const last = useRef("");
  // Valor que o preenchimento automático pôs em cada campo: um segundo CNPJ pode trocá-lo, desde que o usuário não tenha editado.
  const filled = useRef<Record<string, string>>({});
  const onInput = (event: FormEvent<HTMLFormElement>) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== "businessCnpj") return;
    const form = event.currentTarget;
    const digits = onlyDigits(input.value);
    last.current = digits;
    if (digits.length !== 14 || cnpjProblem(digits)) return setNotice(null);
    setNotice("Buscando o nome da empresa pelo CNPJ…");
    void fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`).then(async (response) => {
      if (last.current !== digits) return;
      if (response.status === 404) return setNotice("CNPJ não encontrado na base pública. Digite o nome da empresa.");
      if (!response.ok) throw new Error("cnpj");
      const data = await response.json() as { razao_social?: string; nome_fantasia?: string; cep?: string; descricao_tipo_de_logradouro?: string; logradouro?: string; numero?: string; complemento?: string; bairro?: string; municipio?: string; uf?: string };
      const name = String(data.razao_social || data.nome_fantasia || "").trim();
      if (!name) return setNotice("A base pública não trouxe o nome. Digite o nome da empresa.");
      const fill = (field: string, value: string) => {
        if (setEmptyField(form, field, value, filled.current[field])) filled.current[field] = value;
        else delete filled.current[field];
      };
      fill("businessCompanyName", name.slice(0, 160));
      // Endereço comercial pelos dados da empresa; só campos vazios. O CEP vai por último: ele dispara a busca de CEP padrão.
      const text = (value?: string) => String(value ?? "").trim();
      const street = [text(data.descricao_tipo_de_logradouro), text(data.logradouro)].filter(Boolean).join(" ");
      const address: Record<string, string> = { Street: street, Number: text(data.numero) === "S/N" ? "" : text(data.numero), Complement: text(data.complemento), District: text(data.bairro), City: text(data.municipio), State: text(data.uf), Cep: onlyDigits(text(data.cep)) };
      for (const part of ["Street", "Number", "Complement", "District", "City", "State", "Cep"]) if (address[part] || filled.current[`business${part}`]) fill(`business${part}`, address[part].slice(0, 160));
      setNotice(`Nome da empresa e endereço comercial preenchidos pela base pública (${name}). Confira antes de gravar.`);
    }).catch(() => { if (last.current === digits) setNotice("Não foi possível consultar o CNPJ agora. Digite o nome da empresa."); });
  };
  return { notice, onInput };
}
