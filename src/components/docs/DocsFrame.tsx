import Link from "next/link";
import { BrandLogo } from "@/components/app/BrandLogo";
import { ThemeToggle } from "@/components/app/ThemeProvider";
import { PageAtmosphere } from "@/components/app/GridAtmosphere";
import { SiteFooter } from "@/components/app/SiteFooter";
import { DOC_PAGES, docHref, docNeighbors, type DocPage } from "@/lib/docs";
import { renderMarkdown } from "./renderMarkdown";

export function DocsFrame({
  page,
  source,
  signedIn,
}: {
  page: DocPage;
  source: string;
  signedIn: boolean;
}) {
  const sections = ["Handbook", "Reference"] as const;

  return (
    <PageAtmosphere>
      <header className="app-header">
        <div className="shell site-header-bar">
          <BrandLogo href="/" size={36} wordmarkClassName="text-[1.05rem]" />
          <div className="site-header-actions">
            <Link href="/docs" className="btn btn-secondary">
              Docs
            </Link>
            <ThemeToggle />
            {signedIn ? (
              <Link href="/app" className="btn btn-secondary">
                Open workspace
              </Link>
            ) : (
              <Link href="/login" className="btn btn-secondary">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="shell docs-shell">
        <aside className="docs-nav">
          {sections.map((section) => (
            <div key={section}>
              <p className="docs-nav-label">{section}</p>
              <ul>
                {DOC_PAGES.filter((item) => item.section === section).map((item) => (
                  <li key={item.file}>
                    <Link
                      href={docHref(item.slug)}
                      className={item.slug === page.slug ? "is-active" : undefined}
                      aria-current={item.slug === page.slug ? "page" : undefined}
                    >
                      {item.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>
        <div className="docs-content">
          <article className="docs-prose">{renderMarkdown(source)}</article>
          <DocsPager page={page} />
        </div>
      </main>
      <SiteFooter />
    </PageAtmosphere>
  );
}

function DocsPager({ page }: { page: DocPage }) {
  const { previous, next } = docNeighbors(page.slug);
  if (!previous && !next) return null;

  return (
    <nav className="docs-pager" aria-label="More documentation">
      {previous ? (
        <Link href={docHref(previous.slug)} className="docs-pager-link is-prev">
          <span>Previous</span>
          <strong>{previous.title}</strong>
        </Link>
      ) : null}
      {next ? (
        <Link href={docHref(next.slug)} className="docs-pager-link is-next">
          <span>Next</span>
          <strong>{next.title}</strong>
        </Link>
      ) : null}
    </nav>
  );
}
