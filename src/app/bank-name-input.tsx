"use client";

import { useId, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { BANKS, bankOptionLabel } from "@/lib/banks";

const plain = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// Banco que o texto digitado escolhe: o que tem exatamente esse texto, senão o código que começa com os números digitados,
// senão o primeiro cujo nome (ou código) contém o texto, sem acento e sem diferenciar maiúsculas. Texto sem correspondência
// continua livre, como digitado.
export function matchBank(typed: string) {
  const query = plain(typed);
  if (!query) return null;
  const labels = BANKS.map((bank) => bankOptionLabel(bank));
  return labels.find((label) => plain(label) === query)
    ?? (/^\d+$/.test(query) ? labels.find((label) => label.startsWith(query)) : undefined)
    ?? labels.find((label) => plain(label).includes(query))
    ?? null;
}

// Campo "Banco" com sugestões: ao digitar o nome ou o código aparecem os bancos que combinam (o texto escolhido contém os
// dois, ex.: "341 - Itaú Unibanco"). Enter completa com o banco que combina e vai para o próximo campo (sem enviar o
// formulário); sem correspondência o texto digitado é mantido.
export function BankNameInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "list" | "autoComplete">) {
  const listId = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    props.onKeyDown?.(event);
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const input = event.currentTarget;
    const match = matchBank(input.value);
    if (match) input.value = match;
    const fields = Array.from(input.form?.elements ?? []).filter((element): element is HTMLInputElement | HTMLSelectElement => (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) && !element.disabled && element.type !== "hidden");
    fields[fields.indexOf(input) + 1]?.focus();
  };
  return (
    <>
      <input {...props} list={listId} autoComplete="off" onKeyDown={onKeyDown} />
      <datalist id={listId}>{BANKS.map((bank) => <option key={bank[0]} value={bankOptionLabel(bank)} />)}</datalist>
    </>
  );
}
