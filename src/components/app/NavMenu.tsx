"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const nav = [
  { href: "/app", label: "Home", group: "Work", docs: "/docs/home" },
  { href: "/app/inbox", label: "Inbox", group: "Work", docs: "/docs/inbox" },
  { href: "/app/approvals", label: "Approvals", group: "Work", docs: "/docs/approvals" },
  { href: "/app/vendors", label: "Vendors", group: "Work", docs: "/docs/vendors" },
  { href: "/app/payments", label: "Pay", group: "Money", docs: "/docs/pay" },
  { href: "/app/cash", label: "Cash", group: "Money", docs: "/docs/cash" },
  { href: "/app/policies", label: "Controls", group: "Admin", docs: "/docs/controls" },
  { href: "/app/roles", label: "Roles", group: "Admin", docs: "/docs/roles" },
  { href: "/app/security", label: "Security", group: "Admin", docs: "/docs/app-security" },
  { href: "/app/settings", label: "Settings", group: "Admin", docs: "/docs/settings" },
];

function currentLabel(pathname: string) {
  const exact = nav.find((item) => item.href === pathname);
  if (exact) return exact.label;
  const nested = [...nav].reverse().find((item) => item.href !== "/app" && pathname.startsWith(item.href));
  return nested?.label || "Home";
}

export function NavMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const label = currentLabel(pathname);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const groups = ["Work", "Money", "Admin"] as const;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="nav-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="nav-kicker text-muted">Go to</span>
        <span className="text-foreground">{label}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden
          className={`text-muted transition ${open ? "rotate-180" : ""}`}
        >
          <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div className="nav-menu" role="menu">
          {groups.map((group) => (
            <div key={group}>
              <div className="nav-menu-label">{group}</div>
              {nav
                .filter((item) => item.group === group)
                .map((item) => {
                  const active =
                    item.href === "/app"
                      ? pathname === "/app"
                      : pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <div key={item.href} className="nav-menu-row" data-active={active ? "true" : "false"}>
                      <Link href={item.href} role="menuitem">
                        {item.label}
                      </Link>
                      <span className="nav-menu-aside">
                        {active ? <span className="nav-menu-current">Current</span> : null}
                        <Link href={item.docs} className="nav-menu-docs" role="menuitem">
                          Docs
                        </Link>
                      </span>
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
