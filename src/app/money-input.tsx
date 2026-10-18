"use client";
import type { InputHTMLAttributes } from "react";
import { centsToInput, parseMoneyToCents } from "@/lib/finance/format";

// Campo de dinheiro: ao sair do campo, "10000" vira "10.000,00". Valor que não é dinheiro fica como digitado
// (a validação segue no servidor); funciona com campo controlado e não controlado.
export function MoneyInput({ onBlur, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input inputMode="decimal" {...props} onBlur={(event) => {
    onBlur?.(event);
    const input = event.currentTarget;
    const cents = parseMoneyToCents(input.value);
    if (cents === null) return;
    const formatted = centsToInput(cents);
    if (formatted === input.value) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, formatted);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }} />;
}
