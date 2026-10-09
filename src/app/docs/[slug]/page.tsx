import { notFound } from "next/navigation";
import { DocsFrame } from "@/components/docs/DocsFrame";
import { getSessionUser } from "@/lib/auth";
import { DOC_PAGES, findDoc, normalizeDocSource, readDocSource } from "@/lib/docs";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return DOC_PAGES.filter((page) => page.slug).map((page) => ({ slug: page.slug }));
}

export default async function DocsChapterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = findDoc(slug);
  if (!page) notFound();
  const [user, source] = await Promise.all([
    getSessionUser().catch(() => null),
    readDocSource(page.file),
  ]);
  return <DocsFrame page={page} source={normalizeDocSource(source)} signedIn={Boolean(user)} />;
}
