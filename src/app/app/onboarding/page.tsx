import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { BrandLogo } from "@/components/app/BrandLogo";
import { PageAtmosphere } from "@/components/app/GridAtmosphere";
import { BUSINESS_TYPES, completeCompanyOnboarding } from "@/domain/onboarding";
import { COUNTRY_OPTIONS, currencyFromCountry } from "@/lib/currency";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  let user;
  try {
    user = await requireSessionUser();
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: user.organizationId },
  });

  if (user.role !== "admin") {
    return (
    <PageAtmosphere className="app-shell flex min-h-screen items-center justify-center px-4 py-10">
      <div className="login-panel">
        <BrandLogo href={null} size={30} wordmarkClassName="text-[0.95rem]" />
          <h1 className="mt-6 page-title">Setup required</h1>
          <p className="mt-2 page-subtitle">
            An admin must complete company setup for {org.name}. Refresh after setup.
          </p>
        </div>
      </PageAtmosphere>
    );
  }

  async function registerCompany(formData: FormData) {
    "use server";
    const session = await requireSessionUser(["admin"]);
    try {
      await completeCompanyOnboarding({
        organizationId: session.organizationId,
        actorId: session.id,
        name: String(formData.get("name") || ""),
        legalName: String(formData.get("legalName") || ""),
        businessType: String(formData.get("businessType") || ""),
        industry: String(formData.get("industry") || ""),
        country: String(formData.get("country") || ""),
        website: String(formData.get("website") || ""),
      });
    } catch (e) {
      redirect(
        `/app/onboarding?error=${encodeURIComponent(e instanceof Error ? e.message : "Could not save")}`,
      );
    }
    redirect("/app/onboarding/mfa");
  }

  const defaultName = org.name.endsWith("'s workspace") ? "" : org.name;

  return (
    <PageAtmosphere className="app-shell flex min-h-screen items-center justify-center px-4 py-10">
      <div className="login-panel" style={{ width: "min(520px, 100%)" }}>
        <BrandLogo href={null} size={30} wordmarkClassName="text-[0.95rem]" />
        <h1 className="mt-6 page-title">Company profile</h1>
        <p className="mt-2 page-subtitle">Required before workspace access.</p>

        {params.error ? <p className="mt-4 text-sm text-danger">{params.error}</p> : null}

        <form action={registerCompany} className="mt-7 space-y-4">
          <div>
            <label className="mb-1.5 block text-[0.78rem] font-semibold" htmlFor="name">
              Company / brand name
            </label>
            <input
              id="name"
              name="name"
              required
              minLength={2}
              className="input"
              placeholder="Acme Labs"
              defaultValue={defaultName}
              autoFocus
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[0.78rem] font-semibold" htmlFor="legalName">
              Legal name <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id="legalName"
              name="legalName"
              className="input"
              placeholder="Acme Labs Ltd"
              defaultValue={org.legalName || ""}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-[0.78rem] font-semibold" htmlFor="businessType">
                Business type
              </label>
              <select
                id="businessType"
                name="businessType"
                required
                className="input"
                defaultValue={org.businessType || "startup"}
              >
                {BUSINESS_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[0.78rem] font-semibold" htmlFor="country">
                Business location{" "}
                <span className="font-normal text-muted">(sets dashboard currency)</span>
              </label>
              <select
                id="country"
                name="country"
                className="input"
                defaultValue={org.country || ""}
              >
                <option value="">Not set — dashboard defaults to USD</option>
                {COUNTRY_OPTIONS.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label} ({currencyFromCountry(c.code)})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[0.78rem] font-semibold" htmlFor="industry">
              Industry <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id="industry"
              name="industry"
              className="input"
              placeholder="Fintech, logistics, SaaS…"
              defaultValue={org.industry || ""}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[0.78rem] font-semibold" htmlFor="website">
              Website <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id="website"
              name="website"
              className="input"
              placeholder="https://acme.example"
              defaultValue={org.website || ""}
            />
          </div>

          <button type="submit" className="btn btn-black w-full">
            Continue
          </button>
          <p className="text-[0.78rem] text-muted">Signed in as {user.email}</p>
        </form>
      </div>
    </PageAtmosphere>
  );
}
