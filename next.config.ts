import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native and Node-only libraries out of the Turbopack server bundle.
  serverExternalPackages: ["pdf-parse", "ssh2", "ssh2-sftp-client"],
};

export default nextConfig;
