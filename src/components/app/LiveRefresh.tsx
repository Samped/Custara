"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/** Reload server data when invoices, payments, or the wallet balance change. */
export function LiveRefresh() {
  const router = useRouter();
  const rev = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;

    async function tick() {
      try {
        const res = await fetch("/api/app/live", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { rev?: string };
        if (!body.rev) return;
        if (rev.current == null) {
          rev.current = body.rev;
          return;
        }
        if (body.rev !== rev.current) {
          rev.current = body.rev;
          router.refresh();
        }
      } catch {
        // Keep the last good snapshot if the network blips.
      }
    }

    void tick();
    const timer = setInterval(() => {
      if (!stopped && document.visibilityState === "visible") void tick();
    }, 3000);
    const onFocus = () => {
      void tick();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [router]);

  return null;
}
