import { and, eq } from "drizzle-orm";
import { withTenantContext } from "@/lib/auth/guards";
import { clientDocuments } from "@/lib/db/schema";

// Download de um documento do cliente. Só o tenant da sessão enxerga o arquivo (RLS + filtro por tenant_id).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const document = await withTenantContext(async (tx, { tenantId }) => {
    const [row] = await tx.select().from(clientDocuments).where(and(eq(clientDocuments.id, id), eq(clientDocuments.tenantId, tenantId)));
    return row;
  });
  if (!document) return new Response("Documento não encontrado.", { status: 404 });
  return new Response(new Uint8Array(document.content), {
    headers: {
      "Content-Type": document.contentType,
      "Content-Length": String(document.sizeBytes),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
