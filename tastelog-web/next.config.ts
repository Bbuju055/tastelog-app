import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const backendUrl = process.env.NEXT_PUBLIC_API_BASE_URL;

    if (!backendUrl) {
      // Fail-closed: no silent fallback that hides config errors.
      // If you want a dev-only fallback, do it explicitly in .env.local.
      console.warn(
        "[next.config.ts] NEXT_PUBLIC_API_BASE_URL is not set. /api rewrites will not be configured."
      );
      return [];
    }

    // Normalize: remove trailing slash
    const destinationBase = backendUrl.replace(/\/+$/, "");

    return [
      {
        source: "/api/:path*",
        destination: `${destinationBase}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
