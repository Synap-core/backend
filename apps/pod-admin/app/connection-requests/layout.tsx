import { headers } from "next/headers";
import type { ReactNode } from "react";

import { ReceiverIdentityProvider } from "../_lib/receiver-shell";

/**
 * Pod identity for the whole connection-request flow.
 *
 * The other inbound routes get `podHost` / `identity` from a server half that
 * reads `headers()` and passes them as props. These two pages cannot do that:
 * `/connection-requests/new` is a client component *because* it owns the
 * redemption secret that arrives in the URL FRAGMENT and must never reach the
 * server. Splitting it would mean moving that code, which is not worth a
 * header.
 *
 * A layout is the door that already exists for exactly this. It reads the
 * headers ONCE, on the server, for every route in the segment, and publishes
 * them through the context `ReceiverShell` already falls back to — so
 * `/new`, `/[requestId]` and `/error` all print the same pod, and the page
 * that owns the secret keeps every line of it.
 *
 * `[requestId]` passes explicit props and those still win; this only fills in
 * where nothing was passed.
 */
export default async function ConnectionRequestsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const h = await headers();
  return (
    <ReceiverIdentityProvider
      podHost={h.get("host") ?? undefined}
      identity={h.get("x-pod-admin-email") ?? undefined}
    >
      {children}
    </ReceiverIdentityProvider>
  );
}
