import { notFound } from "next/navigation";
import { DocsFrame } from "@/components/docs/DocsFrame";
import { getSessionUser } from "@/lib/auth";
import { findDoc, normalizeDocSource, readDocSource } from "@/lib/docs";

export const dynamic = "force-dynamic";

export default async function DocsIndexPage() {
  const page = findDoc("");
  if (!page) notFound();
  const [user, source] = await Promise.all([
    getSessionUser().catch(() => null),
    readDocSource(page.file),
  ]);
  return <DocsFrame page={page} source={normalizeDocSource(source)} signedIn={Boolean(user)} />;
}
