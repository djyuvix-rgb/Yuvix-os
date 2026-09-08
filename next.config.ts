import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
  experimental: {
    // Agent runs can be long; allow generous streaming responses.
    proxyTimeout: 300_000,
  },
};

export default nextConfig;
