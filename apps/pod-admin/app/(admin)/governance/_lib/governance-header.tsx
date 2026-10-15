"use client";

/**
 * `GovernanceHeader` — the Governance tab's title and its two sub-pages:
 * Agents & work (`/governance/agents`, the agent × work matrix) and Activity
 * (`/audit`, unchanged URL — every existing deep link into it keeps working).
 */

import Link from "next/link";

const PAGES = [
  { key: "agents", href: "/governance/agents", label: "Agents & work" },
  { key: "activity", href: "/audit", label: "Activity" },
] as const;

export function GovernanceHeader({
  active,
  hint,
}: {
  active: (typeof PAGES)[number]["key"];
  hint: string;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          Governance
        </h1>
        <p className="text-[13px] text-foreground/55">{hint}</p>
      </div>
      <nav
        aria-label="Governance pages"
        className="flex gap-4 border-b border-foreground/[0.05]"
      >
        {PAGES.map((page) => {
          const isActive = page.key === active;
          return (
            <Link
              key={page.key}
              href={page.href}
              aria-current={isActive ? "page" : undefined}
              className={[
                "-mb-px border-b-2 px-1 pb-2 text-[12.5px] font-medium transition-colors",
                isActive
                  ? "border-primary text-foreground"
                  : "border-transparent text-foreground/55 hover:text-foreground",
              ].join(" ")}
            >
              {page.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
