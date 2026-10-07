import { redirect } from "next/navigation";

/** Collections live under Cash → Collections. */
export default function CollectionsRedirectPage() {
  redirect("/app/cash?tab=collections");
}
