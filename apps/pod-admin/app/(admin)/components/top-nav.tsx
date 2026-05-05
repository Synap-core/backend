"use client";

/**
 * `TopNav` — 44px pod-admin header. Three slots:
 *
 *   • Left   — Synap mark · "Pod Admin" · pod hostname
 *   • Center — ⌘K Search trigger — opens the global SearchModal palette
 *   • Right  — refresh-timestamp chip · user avatar with sign-out popover
 *
 * The whole bar is non-sticky on purpose: in a dashboard the operator
 * scrolls the body, not the chrome. Sticky chrome with no shadow ends up
 * looking detached from the content; we bake depth via the inset ring
 * on the body cards instead.
 */

import {
  Avatar,
  Button,
  Chip,
  Kbd,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@heroui/react";
import { LogOut, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";

const POD_URL = process.env.NEXT_PUBLIC_POD_URL ?? "";

interface TopNavProps {
  /** Operator email (from middleware-injected header on first paint). */
  operatorEmail?: string;
  /** Pod hostname rendered next to the brand. */
  podHost?: string;
  /** Last-refreshed timestamp (server provides via cookie/header). */
  lastRefreshed?: Date | null;
  /** Manual refresh — invalidates the page's queries. */
  onRefresh?: () => void;
  /** Open the global ⌘K search palette. */
  onOpenSearch?: () => void;
}

export function TopNav({
  operatorEmail,
  podHost,
  lastRefreshed,
  onRefresh,
  onOpenSearch,
}: TopNavProps) {
  const initials = (operatorEmail ?? "?").charAt(0).toUpperCase();
  const refreshedLabel = useRelativeTime(lastRefreshed ?? null);

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
      {/* Left — brand */}
      <div className="flex min-w-0 items-center gap-2">
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
          Pod Admin
        </span>
        {podHost && (
          <span className="hidden font-mono text-[11px] text-foreground/45 sm:inline">
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
            text-[12.5px] text-foreground/55
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

      {/* Right — refresh + user avatar */}
      <div className="ml-auto flex items-center gap-1.5">
        {refreshedLabel && (
          <Chip
            size="sm"
            radius="sm"
            variant="flat"
            className="hidden text-[11px] text-foreground/55 sm:inline-flex"
          >
            {refreshedLabel}
          </Chip>
        )}

        {onRefresh && (
          <Button
            isIconOnly
            variant="light"
            size="sm"
            radius="full"
            aria-label="Refresh"
            onPress={onRefresh}
            className="text-foreground/55 hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        )}

        <Popover placement="bottom-end" backdrop="opaque">
          <PopoverTrigger>
            <Button
              isIconOnly
              variant="light"
              size="sm"
              radius="full"
              aria-label="User menu"
              className="ml-1 p-0"
            >
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
                  <p className="text-[11px] text-foreground/55">Pod admin</p>
                </div>
              )}
              <div className="h-px bg-foreground/[0.05]" />
              <button
                type="button"
                onClick={handleSignOut}
                className="
                  flex items-center gap-2 px-3 py-2 text-left
                  text-[12.5px] text-foreground/85
                  hover:bg-content2/60
                  rounded-md
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

/**
 * Tick a "Updated 3m ago" label every 30s. Returns null while the input
 * is null so the chip doesn't render placeholder text.
 */
function useRelativeTime(date: Date | null): string | null {
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  if (!date) return null;
  const diff = Date.now() - date.getTime();
  if (diff < 30_000) return "Just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ago`;
}
