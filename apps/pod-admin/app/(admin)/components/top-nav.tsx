"use client";

/**
 * `TopNav` — 44px Pod Console header. Three slots:
 *
 *   • Left   — (phone: nav menu button) · Synap mark · "Pod Console" · pod
 *              hostname
 *   • Center — ⌘K Search trigger — opens the global SearchModal palette
 *   • Right  — user avatar menu (personal pages — Security, My connections,
 *              My computers, My vault — account links, sign out)
 *
 * Only global controls live here. Page freshness ("last checked · Check
 * again") belongs to the page it describes — Home's status line.
 *
 * The whole bar is non-sticky on purpose: in a dashboard the operator
 * scrolls the body, not the chrome. Sticky chrome with no shadow ends up
 * looking detached from the content; we bake depth via the inset ring
 * on the body cards instead.
 */

import {
  Avatar,
  Button,
  Kbd,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@heroui/react";
import {
  ArrowUpRight,
  ExternalLink,
  LogOut,
  Menu,
  Search,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { publicPodUrl } from "../../../lib/public-pod-url";
import { openIn, type AccountPage } from "../../../lib/open-in";
import { useRecoveryCodesState } from "./recovery-codes-nudge";
import { useConsoleRole } from "./side-nav-role";

/** The account surfaces a pod cannot host itself. Order is most-reached-first. */
const ACCOUNT_LINKS: { page: AccountPage; label: string }[] = [
  { page: "pod", label: "Pod & plan" },
  { page: "billing", label: "Billing" },
  { page: "support", label: "Support" },
];

/** Self-service pages about YOU (not the pod), beside Security. */
const PERSONAL_LINKS: { href: string; label: string }[] = [
  { href: "/my-connections", label: "My connections" },
  { href: "/my-computers", label: "My computers" },
  { href: "/my-notifications", label: "My notifications" },
  { href: "/my-vault", label: "My vault" },
];

const POD_URL = publicPodUrl();

interface TopNavProps {
  /** Operator email (from middleware-injected header on first paint). */
  operatorEmail?: string;
  /** Pod hostname rendered next to the brand. */
  podHost?: string;
  /** Open the global ⌘K search palette. */
  onOpenSearch?: () => void;
  /** Open the phone nav drawer (the side nav is hidden below md). */
  onOpenNav?: () => void;
}

export function TopNav({
  operatorEmail,
  podHost,
  onOpenSearch,
  onOpenNav,
}: TopNavProps) {
  const role = useConsoleRole();
  const initials = (operatorEmail ?? "?").charAt(0).toUpperCase();
  // A persistent ⚠ until recovery codes are saved (the Overview card is
  // skippable; this mark is not).
  const codesMissing = useRecoveryCodesState() === "not_set";

  const handleSignOut = async () => {
    try {
      const res = await fetch(
        `${POD_URL}/.ory/kratos/public/self-service/logout/browser`,
        {
          credentials: "include",
          headers: { Accept: "application/json" },
        }
      );
      if (res.ok) {
        const data = (await res.json()) as { logout_url?: string };
        if (data.logout_url) {
          window.location.assign(data.logout_url);
          return;
        }
      }
    } catch {
      // Fall through.
    }
    window.location.reload();
  };

  return (
    <header
      className="
        flex h-11 shrink-0 items-center gap-3 px-4
        border-b border-foreground/[0.05]
      "
    >
      {/* Left — brand. Below md the side nav is hidden, so the menu button
          (and the drawer it opens, which also carries Search) is the way in. */}
      <div className="flex min-w-0 items-center gap-2">
        {onOpenNav && (
          <Button
            isIconOnly
            variant="light"
            size="sm"
            radius="md"
            aria-label="Open navigation"
            onPress={onOpenNav}
            className="-ml-1.5 h-11 w-11 min-w-11 text-foreground/65 md:hidden"
          >
            <Menu className="h-5 w-5" />
          </Button>
        )}
        <span
          aria-hidden
          className="
            glass-icon
            flex h-6 w-6 items-center justify-center
          "
          style={{ background: "linear-gradient(135deg, #10B981, #34D399)" }}
        >
          <span className="text-[10px] font-semibold text-white/95">S</span>
        </span>
        <span className="text-[13px] font-medium tracking-tight text-foreground">
          Pod Console
        </span>
        {podHost && (
          <span className="hidden font-mono text-[11px] text-foreground/65 sm:inline">
            {podHost}
          </span>
        )}
      </div>

      {/* Center — search trigger.  Reads as a disabled-looking input but
          is actually a button: clicking opens the ⌘K palette mounted by
          AdminShell, which is also bound to the meta-K shortcut. */}
      <div className="mx-auto hidden w-full max-w-md items-center md:flex">
        <button
          type="button"
          onClick={onOpenSearch}
          aria-label="Open search (⌘K)"
          className="
            group flex h-8 w-full items-center gap-2 rounded-md
            bg-content2/40 px-3
            ring-1 ring-inset ring-foreground/[0.06]
            text-[12.5px] text-foreground/65
            transition-colors hover:bg-content2/60 hover:text-foreground/85
            focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
          "
        >
          <Search className="h-3.5 w-3.5 shrink-0 text-foreground/45" />
          <span className="flex-1 text-left">Search this pod…</span>
          <Kbd keys={["command"]} className="shrink-0">
            K
          </Kbd>
        </button>
      </div>

      {/* Right — user avatar */}
      <div className="ml-auto flex items-center gap-1.5">
        <Popover placement="bottom-end">
          <PopoverTrigger>
            <Button
              isIconOnly
              variant="light"
              size="sm"
              radius="full"
              aria-label={
                codesMissing
                  ? "User menu — recovery codes not saved"
                  : "User menu"
              }
              className="relative ml-1 p-0"
            >
              {codesMissing ? (
                <span
                  aria-hidden
                  className="absolute right-0 top-0 z-10 h-2 w-2 rounded-full bg-warning ring-2 ring-background"
                />
              ) : null}
              <Avatar
                size="sm"
                showFallback
                fallback={
                  <span className="text-[10px] font-medium">{initials}</span>
                }
                className="h-6 w-6"
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="min-w-[220px] max-w-[320px] p-0">
            <div className="flex flex-col p-1">
              {operatorEmail && (
                <div className="px-3 pb-2 pt-2">
                  <p className="truncate text-[12px] font-medium text-foreground">
                    {operatorEmail}
                  </p>
                  <p className="text-[11px] text-foreground/65">
                    {role === "admin" ? "Pod admin" : "Member"}
                  </p>
                </div>
              )}
              <div className="h-px bg-foreground/[0.05]" />

              {/* A pod owner sitting in their pod's console could not reach
                  their plan, an invoice, support, or a single documentation
                  page: `openIn` knew these destinations, and nothing linked to
                  them. "Handed off" only counts if a door exists. These live on
                  the landing site because a pod cannot host its own billing. */}
              <a
                href="/settings/security"
                className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-[12.5px] text-foreground/85 hover:bg-content2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Security
                {codesMissing ? (
                  <span className="flex items-center gap-1 text-[11px] text-warning">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    Save recovery codes
                  </span>
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5 text-foreground/40" />
                )}
              </a>
              {/* Your own keys/apps and your own vault: self-service pages
                  every member may open, which nothing linked to before. */}
              {PERSONAL_LINKS.map(({ href, label }) => (
                <a
                  key={href}
                  href={href}
                  className="flex items-center rounded-md px-3 py-2 text-[12.5px] text-foreground/85 hover:bg-content2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {label}
                </a>
              ))}
              <div className="h-px bg-foreground/[0.05]" />

              {ACCOUNT_LINKS.map(({ page, label }) => (
                <a
                  key={page}
                  href={openIn({ kind: "account", page }).href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-[12.5px] text-foreground/85 hover:bg-content2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {label}
                  <ArrowUpRight
                    className="h-3 w-3 text-foreground/40"
                    strokeWidth={1.75}
                  />
                </a>
              ))}
              <a
                href={openIn({ kind: "guide", slug: "quickstart" }).href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-[12.5px] text-foreground/85 hover:bg-content2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Documentation
                <ExternalLink className="h-3 w-3 text-foreground/40" />
              </a>

              <div className="h-px bg-foreground/[0.05]" />
              <button
                type="button"
                onClick={handleSignOut}
                className="
                  flex items-center gap-2 px-3 py-2 text-left
                  text-[12.5px] text-foreground/85
                  hover:bg-content2/60
                  rounded-md
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
                "
              >
                <LogOut className="h-3.5 w-3.5" strokeWidth={2} />
                Sign out
              </button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </header>
  );
}
