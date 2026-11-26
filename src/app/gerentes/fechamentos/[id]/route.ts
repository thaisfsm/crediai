import { withPlatformContext, withTenantContext } from "@/lib/auth/guards";
import { contractFonts } from "@/lib/investors/contract-fonts";
import { renderClosingPdf } from "@/lib/managers/closing-pdf";
import { closingFileName } from "@/lib/managers/closing-report";
import { loadClosingReport } from "@/lib/managers/queries";

const VALID_ID = /^[A-Za-z0-9_-]{1,80}$/;

// Relatório em PDF de UM fechamento de comissão (visualizar, ou baixar com ?baixar=1). Gerado na hora a partir do que foi gravado no
// fechamento, sem gravar nada. Dono da carteira: só fechamentos do próprio tenant (o tenant vem da sessão, nunca da URL). MASTER pela
// administração: ?tenantId= de um cliente SaaS (withPlatformContext exige SUPER_ADMIN na sessão e no banco). Fora do escopo: 404.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const tenantParam = url.searchParams.get("tenantId");
  if (!VALID_ID.test(id) || (tenantParam !== null && !VALID_ID.test(tenantParam))) return notFound();
  const loaded = tenantParam
    ? await withPlatformContext(async (tx, { session }) => ({ report: await loadClosingReport(tx, tenantParam, id), user: session.user.name }))
    : await withTenantContext(async (tx, { tenantId, session }) => ({ report: await loadClosingReport(tx, tenantId, id), user: session.user.name }));
  const { report } = loaded;
  if (!report) return notFound();
  const bytes = await renderClosingPdf(report, await contractFonts(), loaded.user);
  const fileName = closingFileName(report.managerName, report.payout.paidOn, report.period.sequence);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${url.searchParams.has("baixar") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

const notFound = () => new Response("Fechamento não encontrado.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" } });
