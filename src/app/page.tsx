import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { BrandLogo } from "@/components/app/BrandLogo";
import { ThemeToggle } from "@/components/app/ThemeProvider";
import { BrandDot, PageAtmosphere } from "@/components/app/GridAtmosphere";
import { CopyButton } from "@/components/app/CopyButton";
import { HeroFilm } from "@/components/app/HeroFilm";
import { HeroType } from "@/components/app/HeroType";
import { PlatformInsights } from "@/components/app/PlatformInsights";
import { getPlatformMetrics } from "@/domain/platformMetrics";

const cliInstall = `npm run build --prefix cli
npm i -g ./cli`;

const features = [
  {
    index: "01",
    title: "Accounts payable",
    body: "Ingest, extract, and risk-score invoices with clear evidence.",
  },
  {
    index: "02",
    title: "Controlled disbursement",
    body: "Policy checks, dual control, and idempotent payment intents.",
  },
  {
    index: "03",
    title: "Enterprise controls",
    body: "Versioned policies, encrypted credentials, and append-only audit.",
  },
];

export default async function HomePage() {
  const [user, platformMetrics] = await Promise.all([
    getSessionUser(),
    getPlatformMetrics().catch((err) => {
      console.error("[platform-metrics]", err);
      return null;
    }),
  ]);

  return (
    <PageAtmosphere>
      <header className="app-header">
        <div className="shell flex h-14 items-center justify-between">
          <BrandLogo href="/" size={36} wordmarkClassName="text-[1.05rem]" />
          <div className="flex items-center gap-2.5">
            <Link href="/docs" className="btn btn-secondary">
              Docs
            </Link>
            <ThemeToggle />
            {user ? (
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

      <main>
        <section className="hero-stage shell">
          <div className="hero-copy">
            <h1>
              Custara
              <BrandDot />
            </h1>
            <HeroType text="From vendor invoice to authorized payment." />
            <p className="hero-explain">
              Extract and risk-score every bill, enforce dual-control approvals, then settle only when
              policy clears — with a complete audit trail.
            </p>
            <div className="hero-actions">
              <Link href="/login" className="btn btn-black">
                Sign in
              </Link>
              <Link href="/docs" className="hero-api">
                Documentation
              </Link>
              <Link href="/app/developers" className="hero-api">
                API
              </Link>
            </div>
            <div className="hero-cli">
              <div className="hero-cli-head">
                <span>CLI</span>
                <span className="hero-cli-actions">
                  <Link href="/docs/cli">Install guide</Link>
                  <CopyButton value={cliInstall} label="Copy" className="btn btn-secondary hero-cli-copy" />
                </span>
              </div>
              <pre className="hero-cli-cmd">
                <code>{cliInstall}</code>
              </pre>
            </div>
          </div>
          <div className="hero-visual">
            <HeroFilm />
          </div>
        </section>

        {platformMetrics ? <PlatformInsights metrics={platformMetrics} /> : null}

        <div className="shell pb-24 md:pb-32">
          <section className="feature-row mt-2">
            {features.map((feature) => (
              <div key={feature.index} className="feature-item">
                <span className="feature-index">{feature.index}</span>
                <div>
                  <h2 className="font-[family-name:var(--font-display)] text-[1.05rem] font-semibold tracking-[-0.03em]">
                    {feature.title}
                  </h2>
                  <p className="mt-1.5 max-w-[34rem] text-[0.92rem] leading-relaxed text-muted">{feature.body}</p>
                </div>
              </div>
            ))}
          </section>
        </div>
      </main>
    </PageAtmosphere>
  );
}
