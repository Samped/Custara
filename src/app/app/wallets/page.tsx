import { redirect } from "next/navigation";

/** Wallets live under Pay → Wallets. */
export default function WalletsRedirectPage() {
  redirect("/app/payments?tab=wallets");
}
