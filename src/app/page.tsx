import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { BrandLogo } from "@/components/app/BrandLogo";
import { ThemeToggle } from "@/components/app/ThemeProvider";
import { BrandDot, PageAtmosphere } from "@/components/app/GridAtmosphere";

const features = [
  {
    index: "01",
    title: "Accounts payable intelligence",
    body: "Extract, match, and score risk with confidence and clear evidence.",
  },
  {
    index: "02",
    title: "Controlled payment execution",
    body: "Idempotent intents, frozen beneficiaries, and sandbox-to-live rails.",
  },
  {
    index: "03",
    title: "Enterprise controls",
    body: "Versioned policies, encrypted bank details, and append-only audit.",
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
                Open console
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
        <p className="eyebrow">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          B2B Finance Agent
        </p>

        <h1 className="mt-5 max-w-[18ch] font-[family-name:var(--font-display)] text-[2.6rem] font-semibold leading-[1.05] tracking-[-0.05em] text-foreground md:text-[3.5rem]">
          Custara
          <BrandDot />
        </h1>

        <p className="mt-4 max-w-[28rem] font-[family-name:var(--font-display)] text-[1.35rem] font-medium leading-[1.25] tracking-[-0.03em] text-foreground md:text-[1.55rem]">
          Privacy-first AP and cash operations for companies and fintechs.
        </p>

        <p className="mt-5 max-w-[32rem] text-[0.98rem] leading-relaxed text-muted">
          Verify invoices against policy, enforce maker-checker approvals, and authorize payment only when
          controls clear — never unconstrained auto-pay.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-5">
          <Link href="/login" className="btn btn-black">
            Open company console
          </Link>
          <Link href="/app/developers" className="btn btn-link-pro">
            Partner API →
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
