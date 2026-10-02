"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./ui-icon";
import { formatDate, isIsoDate, todayIso } from "@/lib/finance/format";

const monthNames = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const weekDays = ["D", "S", "T", "Q", "Q", "S", "S"];

// Aceita "30/09/2026", "30092026" ou "2026-09-30"; devolve a data ISO ou null.
function parseDate(text: string) {
  const trimmed = text.trim();
  if (isIsoDate(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{2})\/?(\d{2})\/?(\d{4})$/);
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  return isIsoDate(iso) ? iso : null;
}

// Máscara dd/mm/aaaa enquanto o usuário digita.
function maskDate(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join("/");
}

function shiftMonth(month: string, delta: number) {
  const [year, number] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, number - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

// Campo de data com calendário próprio: clicar no campo ou no ícone abre o mês, escolher o dia preenche o campo.
// Também aceita digitar a data. Funciona igual em qualquer navegador e no celular; o formulário recebe a data ISO no
// campo oculto "name". Sem min/max, aceita datas passadas, de hoje e futuras.
export function DateField({ label, name, defaultValue = "", min, max, required, className = "field", onChange }: {
  label: string; name: string; defaultValue?: string; min?: string; max?: string; required?: boolean; className?: string; onChange?: (iso: string) => void;
}) {
  const id = useId();
  const [iso, setIso] = useState(defaultValue);
  const [text, setText] = useState(defaultValue ? formatDate(defaultValue) : "");
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState((defaultValue || todayIso()).slice(0, 7));
  const wrapper = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onPointer); document.removeEventListener("keydown", onKey, true); };
  }, [open]);

  const outOfRange = (value: string) => Boolean((min && value < min) || (max && value > max));
  const choose = (value: string) => {
    setIso(value);
    setText(formatDate(value));
    setMonth(value.slice(0, 7));
    input.current?.setCustomValidity("");
    onChange?.(value);
  };
  const onType = (raw: string) => {
    const next = raw.includes("-") ? raw : maskDate(raw);
    const parsed = parseDate(next);
    if (parsed && !outOfRange(parsed)) {
      choose(parsed);
      return;
    }
    setText(next);
    setIso("");
    input.current?.setCustomValidity(next ? (parsed ? "Data fora do intervalo permitido." : "Informe a data como dd/mm/aaaa.") : "");
  };

  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekDay = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cells = [...Array.from({ length: firstWeekDay }, () => null), ...Array.from({ length: daysInMonth }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`)];
  const today = todayIso();

  return (
    <div className={`${className} date-field`} ref={wrapper}>
      <label htmlFor={id}>{label}</label>
      <div className="date-input">
        <input id={id} ref={input} type="text" inputMode="numeric" autoComplete="off" placeholder="dd/mm/aaaa" value={text} required={required}
          onChange={(event) => onType(event.target.value)} onClick={() => setOpen(true)} aria-haspopup="dialog" />
        <button type="button" className="date-button" aria-label="Abrir calendário" onClick={() => { setOpen((current) => !current); input.current?.focus(); }}>
          <Icon name="calendar" size={16} />
        </button>
      </div>
      <input type="hidden" name={name} value={iso} />
      {open && (
        <div className="date-popover" role="dialog" aria-label="Calendário">
          <div className="date-popover-header">
            <button type="button" className="date-nav" aria-label="Mês anterior" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
            <strong>{monthNames[monthNumber - 1].replace(/^./, (letter) => letter.toUpperCase())} de {year}</strong>
            <button type="button" className="date-nav" aria-label="Próximo mês" onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
          </div>
          <div className="date-grid">
            {weekDays.map((day, index) => <span key={index} className="date-weekday">{day}</span>)}
            {cells.map((value, index) => value === null ? <span key={`blank-${index}`} /> : (
              <button key={value} type="button" className={`date-day${value === iso ? " is-selected" : ""}${value === today ? " is-today" : ""}`}
                aria-label={formatDate(value)} aria-pressed={value === iso} disabled={outOfRange(value)} onClick={() => { choose(value); setOpen(false); }}>
                {Number(value.slice(8))}
              </button>
            ))}
          </div>
          <div className="date-popover-footer">
            <button type="button" className="text-link" disabled={outOfRange(today)} onClick={() => { choose(today); setOpen(false); }}>Hoje</button>
            <button type="button" className="text-link" onClick={() => setOpen(false)}>Fechar</button>
          </div>
        </div>
      )}
    </div>
  );
}
