import { loadInvestmentDocumentFile } from "@/lib/investors/queries";

// Visualizar (inline) ou baixar (?baixar=1) um documento de investimento. Só quem enxerga o investimento enxerga o
// arquivo: usuário do próprio tenant ou o MASTER (RLS + filtro por tenant_id em loadInvestmentDocumentFile).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const document = await loadInvestmentDocumentFile(id);
  if (!document) return new Response("Documento não encontrado.", { status: 404 });
  const download = new URL(request.url).searchParams.has("baixar");
  return new Response(new Uint8Array(document.content), {
    headers: {
      "Content-Type": document.contentType,
      "Content-Length": String(document.sizeBytes),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
