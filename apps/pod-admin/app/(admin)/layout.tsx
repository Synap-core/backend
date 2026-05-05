import { headers } from "next/headers";
import type { ReactNode } from "react";
import { TabStrip } from "./components/tab-strip";
import { AdminShell } from "./components/admin-shell";

/**
 * `(admin)` layout — wraps every operator surface in TopNav + TabStrip.
 *
 * Server-renders the chrome and pulls operator identity from headers
 * injected by `middleware.ts` (`x-pod-admin-email` etc.). The TopNav
 * itself is a client component because its refresh + sign-out actions
 * need browser APIs; we pass the email + pod host via props.
 */

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const h = await headers();
  const operatorEmail = h.get("x-pod-admin-email") ?? undefined;

  // Pod host — read from the inbound `host` header (works in any deploy
  // shape: dev :4040, prod *.synap.live, custom domain).
  const podHost = h.get("host") ?? undefined;

  return (
    <AdminShell operatorEmail={operatorEmail} podHost={podHost}>
      <TabStrip />
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </AdminShell>
  );
}
