"use client";

/**
 * Client-side wrapper for the admin layout. Owns three pieces of cross-cut
 * state shared across the chrome:
 *
 *   1. `lastRefreshed` — drives the TopNav refresh chip.
 *   2. `handleRefresh` — invalidates queries on the active route.
 *   3. `searchOpen`    — controls the global ⌘K palette.
 *
 * The TopNav reads operator email + pod host from the parent server
 * layout (cookie / header — not state), and gets the dynamic state
 * (refresh + search trigger) as props.
 *
 * The ⌘K listener is attached at this level so it works regardless of
 * which tab the user is on. We listen at `window` rather than a deeper
 * element so input fields can still accept the `K` keystroke when the
 * meta key isn't held.
 */

import { useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { SearchModal } from "./search-modal";
import { TopNav } from "./top-nav";

/**
 * Operator identity context — exposes the signed-in operator's email to
 * any client component below the AdminShell. The email is injected
 * server-side from `middleware.ts` (`x-pod-admin-email`) and threaded
 * through the layout so action handlers (e.g. People → Remove user) can
 * compare against the target row to disable destructive self-actions.
 */
const OperatorEmailContext = createContext<string | undefined>(undefined);

export function useOperatorEmail(): string | undefined {
  return useContext(OperatorEmailContext);
}

interface AdminShellProps {
  operatorEmail?: string;
  podHost?: string;
  children: ReactNode;
}

export function AdminShell({
  operatorEmail,
  podHost,
  children,
}: AdminShellProps) {
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(
    () => new Date()
  );
  const [searchOpen, setSearchOpen] = useState(false);

  // Refresh: invalidate everything and stamp the chip. We invalidate
  // globally rather than per-route because the cards on Overview pull
  // from many routers — narrowing would require predicate plumbing the
  // chip doesn't really need.
  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries();
    setLastRefreshed(new Date());
  }, [queryClient]);

  // Whenever the route changes, stamp `lastRefreshed` so the chip resets
  // and reflects the page we're now on.
  useEffect(() => {
    setLastRefreshed(new Date());
  }, [pathname]);

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
    <OperatorEmailContext.Provider value={operatorEmail}>
      <div className="flex h-screen min-h-0 flex-col">
        <TopNav
          operatorEmail={operatorEmail}
          podHost={podHost}
          lastRefreshed={lastRefreshed}
          onRefresh={handleRefresh}
          onOpenSearch={() => setSearchOpen(true)}
        />
        {children}
        <SearchModal isOpen={searchOpen} onClose={() => setSearchOpen(false)} />
      </div>
    </OperatorEmailContext.Provider>
  );
}
