/**
 * `/open/<id>` — the resolver page for an id that arrived WITHOUT a kind.
 *
 * Every MCP tool result and create response links `${PUBLIC_URL}/open/<id>`.
 * The public route can only type what changes its own HTTP answer, so for a
 * human browser it 302s every other uuid here (`apps/api/src/open-dispatch.ts`,
 * `podAdminResolveTarget`). This page asks `diagnose.resolveOpen` — the
 * user-floored "what is this id?" door the desktop uses — WITH the reader's
 * cookie, then replaces itself with `/open/<kind>/<id>` (hosted, or the named
 * "opens in the app" card) or `/proposal/<id>`.
 *
 * WHY the segment is called `type`: Next.js requires one slug name per level,
 * and `/open/[type]/[id]` already owns this one. Here the single segment IS
 * the id.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";
import { ReceiverIdentityProvider } from "../../_lib/receiver-shell";
import { ResolveOpen } from "./resolve-open";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Opening…" };

export default async function OpenBareIdPage({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const { type: id } = await params;
  const h = await headers();
  return (
    <ReceiverIdentityProvider
      podHost={h.get("host") ?? undefined}
      identity={h.get("x-pod-admin-email") ?? undefined}
    >
      <ResolveOpen id={id.trim()} />
    </ReceiverIdentityProvider>
  );
}
