/**
 * WebSocket Auth — single-use tickets + cookie-free user resolution
 *
 * Terminal WebSockets must NOT authenticate via the Kratos session cookie:
 * browsers send cookies on cross-origin WS handshakes (no same-origin policy),
 * which makes cookie-authed WS vulnerable to Cross-Site WebSocket Hijacking
 * (CSWSH — e.g. Gitpod CVE-2023-0957). Instead, the browser fetches a short-
 * lived, single-use ticket from the authenticated HTTP endpoint POST
 * /api/ws-ticket, then opens `wss://…?ticket=…`. The ticket is the WS credential.
 *
 * Cookie auth is intentionally absent here — it lives only on the HTTP endpoint
 * that mints tickets. A transitional session token is accepted via the
 * `x-session-token` HEADER only (never the query string, to keep long-lived
 * tokens out of access logs); it is not a CSWSH vector (app storage, not a
 * cookie) and can be removed once all clients use tickets.
 */

import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { getKratosSessionByToken } from "@synap/auth";

const TICKET_TTL_MS = 30_000;

interface TicketEntry {
  userId: string;
  expiresAt: number;
}

// In-memory single-use ticket store (GC'd below). Single-process: a ticket is
// only valid on the instance that minted it — fine for a single-replica pod.
const ticketStore = new Map<string, TicketEntry>();

const gc = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of ticketStore) {
    if (entry.expiresAt < now) ticketStore.delete(key);
  }
}, TICKET_TTL_MS);
gc.unref();

/** Mint a single-use ticket for an authenticated user. */
export function issueWsTicket(userId: string): {
  ticket: string;
  expiresIn: number;
} {
  const ticket = randomBytes(32).toString("hex");
  ticketStore.set(ticket, { userId, expiresAt: Date.now() + TICKET_TTL_MS });
  return { ticket, expiresIn: Math.floor(TICKET_TTL_MS / 1000) };
}

/** Validate + consume a ticket (single-use). Returns the userId, or null. */
function consumeWsTicket(ticket: string): string | null {
  const entry = ticketStore.get(ticket);
  ticketStore.delete(ticket); // single-use regardless of validity
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.userId;
}

/**
 * Resolve the user for a terminal WebSocket upgrade.
 * Priority: single-use ticket (CSWSH-safe) → Kratos session token (x-session-token
 * header, transitional). Cookie auth is deliberately NOT accepted on WS.
 */
export async function resolveUserId(
  req: IncomingMessage
): Promise<string | null> {
  const url = new URL(req.url ?? "", "http://localhost");

  const ticket = url.searchParams.get("ticket");
  if (ticket) {
    // A ticket was presented — it is the sole authority. Invalid/expired → reject.
    return consumeWsTicket(ticket);
  }

  // Transitional non-browser path: session token via the x-session-token HEADER
  // only — never the query string, so a long-lived token can't land in access
  // logs. Not a CSWSH vector (app storage, not a cookie). Removable once unused.
  const token = (req.headers["x-session-token"] as string) || "";
  if (token) {
    const session = await getKratosSessionByToken(token);
    return session?.identity?.id ?? null;
  }

  return null;
}
