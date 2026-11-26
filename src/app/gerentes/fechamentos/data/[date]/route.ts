import { withPlatformContext, withTenantContext } from "@/lib/auth/guards";
import { isIsoDate } from "@/lib/finance/format";
import { contractFonts } from "@/lib/investors/contract-fonts";
import { renderClosingPdf } from "@/lib/managers/closing-pdf";
import { loadClosingReportsByDate } from "@/lib/managers/queries";

// Relatório CONSOLIDADO em PDF de todos os fechamentos de comissão de uma data (um grupo por gerente, com o total de cada um e o total
// geral). Mesmo escopo do relatório de um fechamento: tenant da sessão, ou ?tenantId= para o MASTER. Sem fechamentos na data: 404.
export async function GET(request: Request, { params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  const url = new URL(request.url);
  const tenantParam = url.searchParams.get("tenantId");
  if (!isIsoDate(date) || (tenantParam !== null && !/^[A-Za-z0-9_-]{1,80}$/.test(tenantParam))) return notFound();
  const generatedAt = new Date();
  const loaded = tenantParam
    ? await withPlatformContext(async (tx, { session }) => ({ reports: await loadClosingReportsByDate(tx, tenantParam, date, generatedAt), user: session.user.name }))
    : await withTenantContext(async (tx, { tenantId, session }) => ({ reports: await loadClosingReportsByDate(tx, tenantId, date, generatedAt), user: session.user.name }));
  if (loaded.reports.length === 0) return notFound();
  const bytes = await renderClosingPdf({ tenantName: loaded.reports[0].tenantName, generatedAt, generatedBy: loaded.user, reports: loaded.reports, consolidatedDate: date }, await contractFonts());
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${url.searchParams.has("baixar") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(`fechamento-comissao-consolidado-${date}.pdf`)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

const notFound = () => new Response("Nenhum fechamento nesta data.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" } });
