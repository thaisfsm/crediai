"use client";

import { useId, type InputHTMLAttributes } from "react";
import { BANKS, bankOptionLabel } from "@/lib/banks";

// Campo "Banco" com sugestões: ao digitar o nome ou o código aparecem os bancos que combinam (o texto escolhido contém os
// dois, ex.: "341 - Itaú Unibanco"). Continua livre para digitar qualquer outro banco.
export function BankNameInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "list" | "autoComplete">) {
  const listId = useId();
  return (
    <>
      <input {...props} list={listId} autoComplete="off" />
      <datalist id={listId}>{BANKS.map((bank) => <option key={bank[0]} value={bankOptionLabel(bank)} />)}</datalist>
    </>
  );
}
