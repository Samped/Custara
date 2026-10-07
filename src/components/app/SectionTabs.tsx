import Link from "next/link";

export type SectionTab = { id: string; label: string; href: string };

/** Sleek underline tabs for consolidated app sections. */
export function SectionTabs({ tabs, active }: { tabs: SectionTab[]; active: string }) {
  return (
    <nav className="section-tabs" aria-label="Section">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            className="section-tab"
            data-active={isActive ? "true" : "false"}
            aria-current={isActive ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
