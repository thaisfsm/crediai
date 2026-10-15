import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Documentos do cliente vão por Server Action e podem ter até 5 MB (mais a margem do formulário).
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  // Fontes embutidas no PDF do contrato de investimento (lidas do disco pelo servidor).
  outputFileTracingIncludes: { "/investidores/**/*": ["./src/lib/investors/fonts/*.ttf"] },
  // Cabeçalhos de segurança em todas as respostas: nenhuma página do CrediAI pode ser aberta dentro de um site de fora
  // (clique disfarçado em "excluir", "bloquear" etc.), o endereço não vaza para outros sites e o navegador usa só HTTPS.
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};

export default nextConfig;
