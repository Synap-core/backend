"use client";

/**
 * Client-side wrapper for the console layout. Owns the cross-cut state the
 * chrome shares:
 *
 *   1. `searchOpen` — controls the global ⌘K palette.
 *   2. `navOpen`    — the phone nav drawer (< md).
 *
 * Above every page: the new devices asking the signed-in person to confirm
 * it's them ("Add this device", founder decision of 9 Nov 2026), so a
 * device they already use sees the request wherever they are. Nothing is
 * drawn when nobody asks.
 *
 * The TopNav reads operator email + pod host from the parent server
 * layout (cookie / header — not state), and gets the search and drawer
 * triggers as props. The viewer's role arrives the same
 * way and is provided to the nav, palette and Home through
 * `ConsoleRoleProvider`; the admin's "All tools" choice through
 * `AllToolsProvider`.
 *
 * The ⌘K listener is attached at this level so it works regardless of
 * which page the user is on. We listen at `window` rather than a deeper
 * element so input fields can still accept the `K` keystroke when the
 * meta key isn't held.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { ConsoleRole } from "../../../lib/route-policy";
import { DeviceLinkRequests } from "../../_lib/presence/device-link/DeviceLinkRequests";
import { AllToolsProvider } from "./all-tools";
import { SearchModal } from "./search-modal";
import { NavDrawer, SideNav } from "./side-nav";
import { ConsoleRoleProvider } from "./side-nav-role";
import { TopNav } from "./top-nav";

/**
 * Operator identity context — exposes the signed-in operator's email to
 * any client component below the AdminShell. The email is injected
 * server-side from `proxy.ts` (`x-pod-admin-email`) and threaded
 * through the layout so action handlers (e.g. Members → Remove user) can
 * compare against the target row to disable destructive self-actions.
 */
const OperatorEmailContext = createContext<string | undefined>(undefined);

export function useOperatorEmail(): string | undefined {
  return useContext(OperatorEmailContext);
}

interface AdminShellProps {
  operatorEmail?: string;
  operatorName?: string;
  podHost?: string;
  role: ConsoleRole;
  children: ReactNode;
}

export function AdminShell({
  operatorEmail,
  operatorName,
  podHost,
  role,
  children,
}: AdminShellProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  // Global ⌘K / Ctrl+K listener.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <ConsoleRoleProvider role={role}>
      <AllToolsProvider email={operatorEmail}>
        <OperatorEmailContext.Provider value={operatorEmail}>
          <div className="flex h-dvh min-h-0 flex-col">
            <TopNav
              operatorEmail={operatorEmail}
              podHost={podHost}
              onOpenSearch={openSearch}
              onOpenNav={() => setNavOpen(true)}
            />
            <div className="flex min-h-0 flex-1">
              <SideNav />
              <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                <DeviceLinkRequests placement="banner" />
                {children}
              </main>
            </div>
            <NavDrawer
              isOpen={navOpen}
              onClose={closeNav}
              onOpenSearch={openSearch}
              podHost={podHost}
              operatorEmail={operatorEmail}
              operatorName={operatorName}
            />
            <SearchModal
              isOpen={searchOpen}
              onClose={() => setSearchOpen(false)}
            />
          </div>
        </OperatorEmailContext.Provider>
      </AllToolsProvider>
    </ConsoleRoleProvider>
  );
}
