"use client";

/**
 * `TabStrip` — 36px row of tab pills below `TopNav`.
 *
 * Order is load-bearing — it matches the sequence in the README and the
 * brief. Each tab links to its own route via Next.js `Link`. Active state
 * is derived from `usePathname()`; we mark a tab active when the path
 * starts with that tab's prefix (so deep links like `/audit/<id>` keep
 * Audit highlighted).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Tab {
  href: string;
  label: string;
  /** Tabs that are not yet implemented carry `placeholder: true` so we
   *  can dim them slightly without making them un-clickable. */
  placeholder?: boolean;
}

const TABS: Tab[] = [
  { href: "/overview", label: "Overview" },
  { href: "/workspaces", label: "Workspaces" },
  { href: "/people", label: "People" },
  { href: "/entities", label: "Entities" },
  { href: "/connections", label: "Apps & Connections" },
  { href: "/trust-keys", label: "Trust & Keys" },
  { href: "/connectors", label: "Connectors" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/intelligence", label: "Intelligence" },
  { href: "/audit", label: "Audit" },
];

export function TabStrip() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Pod admin sections"
      className="
        flex h-9 shrink-0 items-center gap-1 px-3
        border-b border-foreground/[0.05]
        overflow-x-auto
      "
    >
      {TABS.map((tab) => {
        const active =
          pathname === tab.href || pathname?.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={[
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1",
              "text-[12.5px] font-medium tracking-tight",
              "transition-colors",
              active
                ? "bg-foreground/[0.07] text-foreground"
                : "text-foreground/55 hover:bg-content2/50 hover:text-foreground",
              tab.placeholder && !active ? "opacity-70" : "",
            ].join(" ")}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
