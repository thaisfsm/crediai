import type { Metadata } from "next";
import "./globals.css";
import "./tema-claro.gerado.css";
import "./tema-claro.css";
import { THEME_BOOT_SCRIPT } from "./theme";

export const metadata: Metadata = {
  title: "CrediAI | Gestão inteligente da sua carteira",
  description: "Uma visão clara e inteligente da sua carteira de crédito.",
  applicationName: "CrediAI",
  icons: { icon: "/icon.svg", shortcut: "/icon.svg" },
};

// O script do <head> aplica o tema salvo antes da primeira pintura (sem piscar); por isso o <html> pode
// chegar ao navegador com data-theme diferente do HTML do servidor.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} /></head>
      <body>{children}</body>
    </html>
  );
}
