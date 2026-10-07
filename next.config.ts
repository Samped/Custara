import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep pdf-parse on the Node runtime (not the browser bundle) for PDF text extraction.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
