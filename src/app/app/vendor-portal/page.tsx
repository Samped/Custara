import { redirect } from "next/navigation";

/** Vendor portal admin lives under Vendors → Portal. */
export default async function VendorPortalRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; error?: string; link?: string }>;
}) {
  const params = await searchParams;
  const q = new URLSearchParams({ tab: "portal" });
  if (params.created) q.set("created", params.created);
  if (params.error) q.set("error", params.error);
  if (params.link) q.set("link", params.link);
  redirect(`/app/vendors?${q.toString()}`);
}
