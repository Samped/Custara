import type { NextConfig } from "next";

const pdfTrace = [
  "./node_modules/pdf-parse/**/*",
  "./node_modules/pdfjs-dist/**/*",
  "./node_modules/pdfjs-dist/standard_fonts/**/*",
  "./node_modules/pdfjs-dist/cmaps/**/*",
  "./node_modules/pdfjs-dist/legacy/build/**/*",
  "./node_modules/pdf-lib/**/*",
];

const nextConfig: NextConfig = {
  // Keep native and Node-only libraries out of the Turbopack server bundle.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "pdf-lib", "ssh2", "ssh2-sftp-client"],
  outputFileTracingIncludes: {
    // Broad include so server actions + API routes both ship pdf.js workers on Vercel.
    "/*": pdfTrace,
    "/api/app/upload-invoice": pdfTrace,
    "/app/api/app/upload-invoice": pdfTrace,
    "src/app/api/app/upload-invoice/route.ts": pdfTrace,
    "/api/v1/invoices": pdfTrace,
    "/app/api/v1/invoices": pdfTrace,
    "/api/v1/invoices/bulk": pdfTrace,
  },
};

export default nextConfig;
