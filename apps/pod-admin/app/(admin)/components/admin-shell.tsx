"use client";

/**
 * Client-side wrapper for the admin layout. Owns the global "last
 * refresh" state shared between TopNav and tab pages, and exposes a
 * react-query invalidation hook through the shell's refresh chip.
 *
 * The TopNav reads its props from the parent server layout (operator
 * email, pod host); this wrapper layers in the dynamic bits.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { TopNav } from "./top-nav";

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
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(
    () => new Date()
  );

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries();
    setLastRefreshed(new Date());
  }, [queryClient]);

  return (
    <div className="flex h-screen min-h-0 flex-col">
      <TopNav
        operatorEmail={operatorEmail}
        podHost={podHost}
        lastRefreshed={lastRefreshed}
        onRefresh={handleRefresh}
      />
      {children}
    </div>
  );
}
