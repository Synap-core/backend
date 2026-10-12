import { headers } from "next/headers";
import type { ReactNode } from "react";
import { CONSOLE_ROLE_HEADER, parseConsoleRole } from "../../lib/route-policy";
import { AdminShell } from "./components/admin-shell";

/**
 * `(admin)` layout — wraps every console page in TopNav + the side nav.
 *
 * Server-renders the chrome and pulls the viewer's identity and role from
 * headers the proxy injects (`x-pod-admin-email`, `x-pod-console-role`).
 * The role only shapes the nav (members see Home + Review, D8); every read
 * behind the pages is gated server-side regardless. The shell is a client
 * component because its refresh, search and drawer need browser APIs.
 */

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const h = await headers();
  const operatorEmail = h.get("x-pod-admin-email") ?? undefined;
  const operatorName = h.get("x-pod-admin-name") ?? undefined;
  const role = parseConsoleRole(h.get(CONSOLE_ROLE_HEADER));

  // Pod host — read from the inbound `host` header (works in any deploy
  // shape: dev :4040, prod *.synap.live, custom domain).
  const podHost = h.get("host") ?? undefined;

  return (
    <AdminShell
      operatorEmail={operatorEmail}
      operatorName={operatorName}
      podHost={podHost}
      role={role}
    >
      {children}
    </AdminShell>
  );
}
