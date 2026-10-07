import { destroySession, type SessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { BrandLogo } from "./BrandLogo";
import { NavMenu } from "./NavMenu";
import { ThemeToggle } from "./ThemeProvider";
import { PageAtmosphere } from "./GridAtmosphere";
import { CurrencyToggle } from "./CurrencyToggle";
import { MfaBanner } from "./MfaBanner";

export function AppShell({
  user,
  children,
  title,
  subtitle,
}: {
  user: SessionUser;
  children: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  async function logout() {
    "use server";
    await destroySession();
    redirect("/login");
  }

  return (
    <PageAtmosphere>
      <div className="app-shell">
        <header className="app-header">
          <div className="shell flex h-12 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <BrandLogo href="/app" size={30} wordmarkClassName="text-[0.95rem]" />
              <div className="hidden h-3.5 w-px bg-[var(--line)] sm:block" aria-hidden />
              <NavMenu />
            </div>
            <div className="flex items-center gap-2 text-[0.78rem]">
              <span className="badge bg-accent-soft text-accent">
                {user.paymentMode === "live" ? "live rails" : "simulated"}
              </span>
              <CurrencyToggle value={user.displayCurrency} />
              <ThemeToggle />
              <div className="user-chip">
                <p className="user-chip-name">{user.name}</p>
                <p className="user-chip-meta">
                  {user.role} · {user.organizationName}
                </p>
              </div>
              <form action={logout}>
                <button type="submit" className="btn btn-secondary">
                  Log out
                </button>
              </form>
            </div>
          </div>
        </header>

        <main className="shell app-main">
          {!user.mfaEnabled && title !== "Security" ? <MfaBanner /> : null}
          <header className="app-page-head">
            <h1 className="page-title">{title}</h1>
            {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
          </header>
          {children}
        </main>
      </div>
    </PageAtmosphere>
  );
}
