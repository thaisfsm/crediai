import { loadInvestmentContractFile } from "@/lib/investors/queries";

// Visualizar (inline) ou baixar (?baixar=1) o PDF de uma versão do contrato GERADO pelo sistema (sem assinaturas).
// Só quem enxerga o investimento enxerga o arquivo: usuário do próprio tenant ou o MASTER (RLS + filtro por tenant_id).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Ids do sistema: letras, números e "_" (qualquer outra coisa nem chega ao banco).
  if (!/^[A-Za-z0-9_]{1,80}$/.test(id)) return new Response("Contrato não encontrado.", { status: 404 });
  const contract = await loadInvestmentContractFile(id);
  if (!contract) return new Response("Contrato não encontrado.", { status: 404 });
  const download = new URL(request.url).searchParams.has("baixar");
  return new Response(new Uint8Array(contract.content), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(contract.sizeBytes),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(contract.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
