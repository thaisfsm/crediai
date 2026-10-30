"use client";

import { useEffect, useSyncExternalStore } from "react";
import { THEME_USER_KEY, themeKey, type Theme } from "./theme";
import { Icon } from "./ui-icon";

function applyTheme(theme: Theme) {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
}

function readSaved(userId: string): Theme {
  try { return localStorage.getItem(themeKey(userId)) === "light" ? "light" : "dark"; } catch { return "dark"; }
}

// Ao sair da conta: o próximo login começa no tema padrão até a preferência dele ser lida.
export function forgetThemeUser() {
  try { localStorage.removeItem(THEME_USER_KEY); } catch { /* armazenamento indisponível */ }
  applyTheme("dark");
}

const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};
const currentTheme = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

export function ThemeToggle({ userId }: { userId: string }) {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "dark" as Theme);
  // Este navegador passa a ser deste usuário: aplica a preferência dele (se outro usuário usou antes, troca aqui).
  useEffect(() => {
    try { localStorage.setItem(THEME_USER_KEY, userId); } catch { /* armazenamento indisponível */ }
    applyTheme(readSaved(userId));
  }, [userId]);
  const next: Theme = theme === "light" ? "dark" : "light";
  const label = next === "light" ? "Usar tema claro" : "Usar tema escuro";
  return (
    <button type="button" className="icon-button theme-toggle" aria-label={label} title={label} onClick={() => {
      try { localStorage.setItem(themeKey(userId), next); localStorage.setItem(THEME_USER_KEY, userId); } catch { /* vale só nesta visita */ }
      applyTheme(next);
    }}>
      <Icon name={next === "light" ? "sun" : "moon"} size={17} />
    </button>
  );
}
