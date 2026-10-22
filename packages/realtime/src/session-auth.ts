/**
 * Who is connecting — the ONE server-proven identity check for a USER socket,
 * shared by the `/presence` and `/yjs` namespaces.
 *
 * The handshake carries `{ userId, token }`. The client-asserted `userId` is
 * never trusted on its own: `token` is a Kratos session, validated here, and
 * the identity it resolves to must equal `userId`. The `/yjs` gate used to take
 * `userId` at its word, so anyone who knew a user id could open that user's
 * documents.
 *
 * `token` may also be a Synap app's DEVICE token (`synap_pd_…`): it is
 * resolved by the one lookup (`resolvePersonDeviceSession`)
 * and NEVER sent to Kratos. No other credential is accepted here — API keys
 * have their own socket door (`api-key-auth.ts`, service accounts only).
 */
import { getKratosSessionByCookie, getKratosSessionByToken } from "@synap/auth";
import { db } from "@synap/database";
import {
  isPersonDeviceToken,
  resolvePersonDeviceSession,
} from "@synap/database/person-devices";

export type HandshakeIdentity =
  { ok: true; userId: string } | { ok: false; error: string };

export async function verifyHandshakeUser(
  auth: Record<string, unknown> | undefined
): Promise<HandshakeIdentity> {
  const userId = typeof auth?.userId === "string" ? auth.userId : null;
  const token = typeof auth?.token === "string" ? auth.token : null;
  if (!userId) return { ok: false, error: "Realtime auth: missing userId" };
  if (!token) {
    return { ok: false, error: "Realtime auth: missing session token" };
  }

  let session: Awaited<ReturnType<typeof getKratosSessionByToken>> | null;
  if (isPersonDeviceToken(token)) {
    try {
      session = await resolvePersonDeviceSession(db, token);
    } catch {
      return {
        ok: false,
        error: "Realtime auth: session validation unavailable",
      };
    }
    return matchIdentity(session, userId);
  }
  try {
    // The browser sends the Kratos API SESSION TOKEN (X-Session-Token), so
    // validate it AS A TOKEN first. The old `/presence` code passed it to the
    // COOKIE validator (`getKratosSessionByCookie`), which does
    // `toSession({ cookie: 'ory_kratos_session='+value })` — Kratos rejected the
    // session-token as a malformed cookie → the socket NEVER connected → the AI
    // chat showed a permanent false "Offline" banner while tRPC was perfectly
    // healthy. Fall back to cookie validation for flows that pass a raw
    // ory_kratos_session value as the token (local pod / Eve's
    // raw-token-as-cookie flow).
    session = await getKratosSessionByToken(token);
    if (!session) {
      session = await getKratosSessionByCookie(token);
    }
  } catch {
    return {
      ok: false,
      error: "Realtime auth: session validation unavailable",
    };
  }

  return matchIdentity(session, userId);
}

/** The resolved session's person, who must be the one the handshake named. */
function matchIdentity(
  session: { identity?: { id?: unknown }; active?: boolean } | null,
  userId: string
): HandshakeIdentity {
  const resolvedUserId =
    typeof session?.identity?.id === "string" ? session.identity.id : null;
  if (!resolvedUserId || session?.active === false) {
    return { ok: false, error: "Realtime auth: invalid session" };
  }
  if (resolvedUserId !== userId) {
    return { ok: false, error: "Realtime auth: user mismatch" };
  }
  return { ok: true, userId: resolvedUserId };
}
