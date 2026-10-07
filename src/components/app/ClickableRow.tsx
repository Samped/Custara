"use client";

import { useRouter } from "next/navigation";
import type { ReactNode, MouseEvent } from "react";

/** Table row that navigates on click; ignores clicks on nested links/buttons. */
export function ClickableRow({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();

  function onClick(event: MouseEvent<HTMLTableRowElement>) {
    const target = event.target as HTMLElement | null;
    if (target?.closest("a, button, input, label")) return;
    router.push(href);
  }

  return (
    <tr className="table-row-link" onClick={onClick}>
      {children}
    </tr>
  );
}
