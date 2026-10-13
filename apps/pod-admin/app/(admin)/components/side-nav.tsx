"use client";

/**
 * The console's navigation, in three widths, from ONE list (`lib/console-nav.ts`):
 *
 *   • ≥ lg     — 224px grouped sidebar (collapsible to the rail; the choice
 *                is remembered per browser);
 *   • md – lg  — 56px icon rail, labels in tooltips;
 *   • < md     — `NavDrawer`, a left drawer opened from TopNav's menu button:
 *                Search first (the top bar has no room for it on a phone),
 *                then the same groups with 44px touch rows, the viewer last.
 *
 * Width is CSS (no layout flash on first paint), the collapse choice included
 * (`lib/nav-collapsed.ts`); JS only decides whether the rail's tooltips are
 * live. Members see Home + Review only (D8) — the role
 * shapes the offer, never the data.
 */

import {
  Avatar,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  Kbd,
  Tooltip,
} from "@heroui/react";
import {
  Activity,
  AppWindow,
  Bot,
  Building2,
  Database,
  HardDrive,
  House,
  Inbox,
  KeyRound,
  Laptop,
  LayoutTemplate,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  RefreshCw,
  ScrollText,
  Search,
  Shapes,
  ShieldCheck,
  Sparkles,
  Store,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import {
  activeNavId,
  navForRole,
  type NavIconName,
  type NavId,
  type NavItem,
} from "../../../lib/console-nav";
import {
  NAV_COLLAPSED_ATTR,
  NAV_COLLAPSED_KEY,
} from "../../../lib/nav-collapsed";
import {
  useConsoleBadges,
  type BadgeTone,
  type NavBadge,
} from "./side-nav-badges";
import { useConsoleRole } from "./side-nav-role";
import { LG_UP, useMediaQuery } from "../../../lib/use-media-query";

const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  House,
  Inbox,
  MessagesSquare,
  Zap,
  Activity,
  LayoutTemplate,
  Building2,
  Shapes,
  Database,
  Bot,
  Laptop,
  AppWindow,
  KeyRound,
  Users,
  Plug,
  Sparkles,
  Store,
  ShieldCheck,
  HardDrive,
  RefreshCw,
  ScrollText,
};

const BADGE_PILL: Record<BadgeTone, string> = {
  down: "bg-status-down/15 text-status-down",
  stale: "bg-status-stale/15 text-status-stale",
  review: "bg-primary/15 text-primary",
};

const BADGE_DOT: Record<BadgeTone, string> = {
  down: "bg-status-down",
  stale: "bg-status-stale",
  review: "bg-primary",
};

// ─── Preferences ────────────────────────────────────────────────────

/**
 * The ≥lg collapse choice. The pre-paint script already put it on `<html>`;
 * state starts false on server and client alike (no hydration mismatch) and
 * reads the attribute once mounted — it only drives aria and tooltips, the
 * widths follow the attribute in CSS.
 */
function useCollapsedPreference(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(document.documentElement.hasAttribute(NAV_COLLAPSED_ATTR));
  }, []);
  const update = (next: boolean) => {
    setCollapsed(next);
    document.documentElement.toggleAttribute(NAV_COLLAPSED_ATTR, next);
    try {
      window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Not remembered this time; the toggle still works.
    }
  };
  return [collapsed, update];
}

// ─── Desktop sidebar / rail ─────────────────────────────────────────

export function SideNav() {
  const role = useConsoleRole();
  const badges = useConsoleBadges();
  const pathname = usePathname() ?? "";
  const active = activeNavId(pathname);
  const [collapsed, setCollapsed] = useCollapsedPreference();
  const wide = useMediaQuery(LG_UP);
  // The rail shows below lg always, and at lg when the owner collapsed it.
  const rail = collapsed || !wide;

  return (
    <nav
      aria-label="Console"
      className={[
        "hidden shrink-0 flex-col overflow-y-auto border-r border-foreground/[0.05] px-2 py-3 md:flex",
        "w-14 lg:w-56 lg:nav-collapsed:w-14",
      ].join(" ")}
    >
      {navForRole(role).map((group) => (
        <div key={group.id}>
          {group.label ? (
            <>
              {/* Rail: a hairline between groups; wide: the group's name. */}
              <div
                aria-hidden
                className="mx-2 my-2 h-px bg-foreground/[0.06] lg:hidden lg:nav-collapsed:block"
              />
              <p className="hidden px-2.5 pb-1.5 pt-3.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-foreground/45 lg:block lg:nav-collapsed:hidden">
                {group.label}
              </p>
            </>
          ) : null}
          <ul className="flex flex-col gap-px">
            {group.items.map((item) => (
              <li key={item.id}>
                <SidebarLink
                  item={item}
                  active={active === item.id}
                  badge={badges[item.id as NavId]}
                  rail={rail}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="mt-auto hidden pt-3 lg:block">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          aria-pressed={collapsed}
          className={[
            "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] text-foreground/65",
            "transition-colors hover:bg-content2/50 hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            "nav-collapsed:justify-center nav-collapsed:px-0",
          ].join(" ")}
        >
          <PanelLeftOpen
            className="hidden h-4 w-4 shrink-0 nav-collapsed:block"
            aria-hidden
          />
          <PanelLeftClose
            className="h-4 w-4 shrink-0 nav-collapsed:hidden"
            aria-hidden
          />
          <span className="nav-collapsed:hidden">Collapse</span>
        </button>
      </div>
    </nav>
  );
}

function SidebarLink({
  item,
  active,
  badge,
  rail,
}: {
  item: NavItem;
  active: boolean;
  badge: NavBadge | undefined;
  rail: boolean;
}) {
  const Icon = NAV_ICONS[item.icon];
  // Wide-only pieces: hidden in the rail (md–lg, or collapsed at lg).
  const wideOnly = "hidden lg:inline-flex lg:nav-collapsed:hidden";
  const railOnly = "lg:hidden lg:nav-collapsed:block";

  return (
    <Tooltip
      content={badge ? `${item.label} · ${badge.text}` : item.label}
      placement="right"
      delay={300}
      closeDelay={0}
      isDisabled={!rail}
    >
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={[
          "relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] tracking-tight transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          "justify-center px-0 lg:justify-start lg:px-2.5",
          "lg:nav-collapsed:justify-center lg:nav-collapsed:px-0",
          active
            ? "bg-foreground/[0.07] font-semibold text-foreground"
            : "font-medium text-foreground/65 hover:bg-content2/50 hover:text-foreground",
        ].join(" ")}
      >
        <Icon className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
        <span className="sr-only lg:not-sr-only lg:nav-collapsed:sr-only">
          {item.label}
        </span>
        {badge && (
          <>
            <BadgePill badge={badge} className={`ml-auto ${wideOnly}`} />
            <span
              aria-hidden
              className={`absolute right-1.5 top-1 h-1.5 w-1.5 rounded-full ${BADGE_DOT[badge.tone]} ${railOnly}`}
            />
          </>
        )}
      </Link>
    </Tooltip>
  );
}

function BadgePill({
  badge,
  className = "",
}: {
  badge: NavBadge;
  className?: string;
}) {
  return (
    <span
      className={[
        "h-[18px] min-w-5 items-center justify-center rounded-lg px-1.5 text-[11px] font-semibold tabular-nums",
        BADGE_PILL[badge.tone],
        className,
      ].join(" ")}
    >
      {badge.text}
    </span>
  );
}

// ─── Phone drawer ───────────────────────────────────────────────────

interface NavDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSearch: () => void;
  podHost?: string;
  operatorEmail?: string;
  operatorName?: string;
}

export function NavDrawer({
  isOpen,
  onClose,
  onOpenSearch,
  podHost,
  operatorEmail,
  operatorName,
}: NavDrawerProps) {
  const role = useConsoleRole();
  const badges = useConsoleBadges();
  const pathname = usePathname() ?? "";
  const active = activeNavId(pathname);

  const who = operatorName ?? operatorEmail ?? "Signed in";
  const initial = who.charAt(0).toUpperCase();

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      placement="left"
      size="xs"
      classNames={{
        base: "max-w-[300px] rounded-none",
        // A 44px target: HeroUI's default ✕ is too small for a thumb.
        closeButton:
          "right-2 top-2 flex h-11 w-11 items-center justify-center text-foreground/65",
      }}
    >
      <DrawerContent>
        <DrawerHeader className="flex flex-col gap-0.5 pb-2 pl-4 pr-14 pt-4">
          <span className="text-[13.5px] font-semibold text-foreground">
            Pod Console
          </span>
          {podHost && (
            <span className="truncate font-mono text-[11px] text-foreground/65">
              {podHost}
            </span>
          )}
        </DrawerHeader>
        <DrawerBody className="gap-0 px-2 py-1">
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenSearch();
            }}
            className="mb-2 flex h-11 w-full items-center gap-3 rounded-lg bg-content2/40 px-3 text-left text-[13px] text-foreground/65 ring-1 ring-inset ring-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden />
            <span className="flex-1">Search</span>
            <Kbd keys={["command"]} className="hidden shrink-0 sm:inline-flex">
              K
            </Kbd>
          </button>
          <nav aria-label="Console">
            {navForRole(role).map((group) => (
              <div key={group.id}>
                {group.label && (
                  <p className="px-3 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-foreground/45">
                    {group.label}
                  </p>
                )}
                <ul className="flex flex-col gap-px">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <DrawerLink
                        item={item}
                        active={active === item.id}
                        badge={badges[item.id as NavId]}
                        onNavigate={onClose}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </DrawerBody>
        <DrawerFooter className="border-t border-foreground/[0.05] px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Avatar
              size="sm"
              showFallback
              fallback={
                <span className="text-[11px] font-medium">{initial}</span>
              }
              className="h-8 w-8 shrink-0"
            />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium text-foreground">
                {who}
              </span>
              <span className="text-[11.5px] text-foreground/65">
                {role === "admin" ? "Pod admin" : "Member"}
              </span>
            </div>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function DrawerLink({
  item,
  active,
  badge,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  badge: NavBadge | undefined;
  onNavigate: () => void;
}) {
  const Icon = NAV_ICONS[item.icon];
  return (
    <Link
      href={item.href}
      // Navigating closes the drawer: a drawer left over the page the reader
      // asked for would hide it (also when they tap the page they are on).
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={[
        "flex h-11 items-center gap-3 rounded-lg px-3 text-[14px] transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        active
          ? "bg-foreground/[0.07] font-semibold text-foreground"
          : "font-medium text-foreground/75 hover:bg-content2/50 hover:text-foreground",
      ].join(" ")}
    >
      <Icon
        className="h-[18px] w-[18px] shrink-0"
        strokeWidth={2}
        aria-hidden
      />
      <span className="flex-1">{item.label}</span>
      {badge && <BadgePill badge={badge} className="inline-flex" />}
    </Link>
  );
}
