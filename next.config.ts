import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Documentos do cliente vão por Server Action e podem ter até 5 MB (mais a margem do formulário).
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
};

export default nextConfig;
