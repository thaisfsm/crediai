import Link from "next/link";

// Navegação interna do Financeiro: as movimentações do capital e as contas a pagar (que geram saídas no mesmo capital).
export function FinanceSubnav({ active }: { active: "movimentacoes" | "contas" }) {
  return (
    <nav className="finance-subnav" aria-label="Seções do Financeiro">
      <Link prefetch={false} href="/financeiro" aria-current={active === "movimentacoes" ? "page" : undefined}>Movimentações</Link>
      <Link prefetch={false} href="/contas-a-pagar" aria-current={active === "contas" ? "page" : undefined}>Contas a pagar</Link>
    </nav>
  );
}
