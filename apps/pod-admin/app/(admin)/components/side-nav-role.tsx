"use client";

/**
 * The viewer's console role, as the proxy found it (`x-pod-console-role`,
 * read by the `(admin)` layout). It decides what the nav, the ⌘K palette and
 * Home OFFER — never what data is readable: every procedure behind those
 * re-checks the session and role server-side, so a forged role only shows
 * links that 403.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { ConsoleRole } from "../../../lib/route-policy";

// Default to the smaller console: a component rendered outside the provider
// must never offer admin pages.
const ConsoleRoleContext = createContext<ConsoleRole>("member");

export function ConsoleRoleProvider({
  role,
  children,
}: {
  role: ConsoleRole;
  children: ReactNode;
}) {
  return (
    <ConsoleRoleContext.Provider value={role}>
      {children}
    </ConsoleRoleContext.Provider>
  );
}

export function useConsoleRole(): ConsoleRole {
  return useContext(ConsoleRoleContext);
}
