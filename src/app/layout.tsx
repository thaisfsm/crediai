import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CrediAI | Gestão inteligente da sua carteira",
  description: "Uma visão clara e inteligente da sua carteira de crédito.",
  applicationName: "CrediAI",
  icons: { icon: "/icon.svg", shortcut: "/icon.svg" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
