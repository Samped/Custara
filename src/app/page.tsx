import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { BrandLogo } from "@/components/app/BrandLogo";
import { ThemeToggle } from "@/components/app/ThemeProvider";
import { BrandDot, PageAtmosphere } from "@/components/app/GridAtmosphere";

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
  const user = await getSessionUser();

  return (
    <PageAtmosphere>
      <header className="app-header">
        <div className="shell flex h-14 items-center justify-between">
          <BrandLogo href="/" size={36} wordmarkClassName="text-[1.05rem]" />
          <div className="flex items-center gap-2.5">
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

      <main className="shell pb-24 pt-16 md:pb-32 md:pt-24">
        <h1 className="max-w-[18ch] font-[family-name:var(--font-display)] text-[2.6rem] font-semibold leading-[1.05] tracking-[-0.05em] text-foreground md:text-[3.5rem]">
          Custara
          <BrandDot />
        </h1>

        <p className="mt-5 max-w-[22rem] font-[family-name:var(--font-display)] text-[1.4rem] font-medium leading-[1.2] tracking-[-0.035em] text-foreground md:max-w-[28rem] md:text-[1.65rem]">
          From vendor invoice to authorized payment.
        </p>
        <p className="mt-4 max-w-[30rem] text-[0.95rem] leading-relaxed text-muted">
          Extract and risk-score every bill, enforce dual-control approvals, then settle only when
          policy clears — with a complete audit trail.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-5">
          <Link href="/login" className="btn btn-black">
            Sign in
          </Link>
          <Link href="/app/developers" className="btn btn-link-pro">
            API →
          </Link>
        </div>

        <section className="feature-row mt-20 md:mt-28">
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
      </main>
    </PageAtmosphere>
  );
}
