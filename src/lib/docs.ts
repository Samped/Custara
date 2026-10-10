import { readFile } from "fs/promises";
import path from "path";

export type DocPage = {
  slug: string;
  file: string;
  title: string;
  section: "Handbook" | "Reference";
};

export const DOC_PAGES: DocPage[] = [
  { slug: "", file: "README.md", title: "Overview", section: "Handbook" },
  { slug: "getting-started", file: "getting-started.md", title: "Getting started", section: "Handbook" },
  { slug: "invoice-lifecycle", file: "invoice-lifecycle.md", title: "Invoice lifecycle", section: "Handbook" },
  { slug: "console", file: "console.md", title: "Console", section: "Handbook" },
  { slug: "payments-and-treasury", file: "payments-and-treasury.md", title: "Payments and treasury", section: "Handbook" },
  { slug: "security", file: "security.md", title: "Security", section: "Handbook" },
  { slug: "partner-api", file: "partner-api.md", title: "Partner API", section: "Handbook" },
  { slug: "cli", file: "cli.md", title: "CLI", section: "Handbook" },
  { slug: "webhooks", file: "webhooks.md", title: "Webhooks", section: "Handbook" },
  { slug: "connectors", file: "connectors.md", title: "Connectors", section: "Handbook" },
  { slug: "audit", file: "audit.md", title: "Audit", section: "Handbook" },
  { slug: "operations", file: "operations.md", title: "Operations", section: "Handbook" },
  { slug: "agent-payments", file: "agent-payments.md", title: "Agent payments", section: "Reference" },
  { slug: "erp-adapters", file: "erp-adapters.md", title: "ERP adapters", section: "Reference" },
  { slug: "qa-runbook", file: "qa-runbook.md", title: "Release verification", section: "Reference" },
  { slug: "soc2-roadmap", file: "soc2-roadmap.md", title: "SOC 2 readiness", section: "Reference" },
];

export function docHref(slug: string) {
  return slug ? `/docs/${slug}` : "/docs";
}

export function findDoc(slug: string) {
  return DOC_PAGES.find((page) => page.slug === slug) || null;
}

export function docNeighbors(slug: string) {
  const index = DOC_PAGES.findIndex((page) => page.slug === slug);
  if (index < 0) return { previous: null, next: null };
  return {
    previous: index > 0 ? DOC_PAGES[index - 1] : null,
    next: index < DOC_PAGES.length - 1 ? DOC_PAGES[index + 1] : null,
  };
}

export async function readDocSource(file: string) {
  const full = path.join(process.cwd(), "docs", file);
  return readFile(full, "utf8");
}

/** Turn repo-relative markdown links into /docs routes. */
export function docHrefFromMarkdown(raw: string) {
  const href = raw.trim();
  if (!href || href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) {
    return href;
  }
  if (href.startsWith("#")) return href;
  const [pathPart, hash] = href.split("#");
  const cleaned = pathPart.replace(/^\.\//, "");
  if (!cleaned.endsWith(".md") || cleaned.includes("..") || cleaned.includes("/")) return null;
  const base = cleaned.replace(/\.md$/, "");
  const slug = base === "README" ? "" : base;
  if (!DOC_PAGES.some((page) => page.slug === slug)) return null;
  return `${docHref(slug)}${hash ? `#${hash}` : ""}`;
}

/** Files that are hash-prefixed notes, not a heading outline. */
export function normalizeDocSource(source: string) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const hashLines = lines.filter((line) => line.trim() === "#" || /^#\s+\S/.test(line)).length;
  const hasSections = lines.some((line) => line.startsWith("## "));
  if (hasSections || hashLines < 8) return source;
  const title = lines[0];
  const body = lines
    .slice(1)
    .map((line) => line.replace(/^# ?/, ""))
    .join("\n")
    .trim();
  return `${title}\n\n\`\`\`\n${body}\n\`\`\`\n`;
}
