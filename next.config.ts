import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native and Node-only libraries out of the Turbopack server bundle.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "pdf-lib", "ssh2", "ssh2-sftp-client"],
  outputFileTracingIncludes: {
    "/api/app/upload-invoice": [
      "./node_modules/pdf-parse/**/*",
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/pdf-lib/**/*",
    ],
    "/api/v1/invoices": [
      "./node_modules/pdf-parse/**/*",
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/pdf-lib/**/*",
    ],
    "/api/v1/invoices/bulk": ["./node_modules/pdf-parse/**/*", "./node_modules/pdfjs-dist/**/*"],
  },
};

export default nextConfig;
