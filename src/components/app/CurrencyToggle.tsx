"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DISPLAY_CURRENCIES } from "@/lib/currency";

/** JSON fetch (not FormData) so wallet extensions cannot structuredClone-crash the toggle. */
export function CurrencyToggle({ value }: { value: string }) {
  const router = useRouter();
  const [current, setCurrent] = useState(value);
  const [busy, setBusy] = useState(false);

  async function onChange(next: string) {
    if (next === current || busy) return;
    const prev = current;
    setCurrent(next);
    setBusy(true);
    try {
      const res = await fetch("/api/app/display-currency", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ displayCurrency: next }),
      });
      if (!res.ok) {
        setCurrent(prev);
        return;
      }
      router.refresh();
    } catch {
      setCurrent(prev);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="currency-toggle">
      <label className="sr-only" htmlFor="displayCurrency">
        Dashboard currency
      </label>
      <select
        id="displayCurrency"
        className="input currency-toggle-select"
        value={current}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        title="Dashboard display currency"
        aria-label="Dashboard currency"
      >
        {DISPLAY_CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.code}
          </option>
        ))}
      </select>
    </div>
  );
}
