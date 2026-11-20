/**
 * The proxy's two questions to the pod ("who is this?", "may they admin?"),
 * asked together and answered from memory for 30 s.
 *
 * Every page request ran Kratos whoami, THEN the role probe, with nothing
 * kept: two sequential round trips before any byte of the page, on every
 * click. Now both start at once, and a POSITIVE answer (an active session, an
 * admin or member role) is reused for `GATE_ANSWER_TTL_MS` for the same
 * Kratos session cookie.
 *
 * Trade-off, founder accepted 2026-11-20: a revoked session or a removed role
 * can keep opening console pages for up to 30 s. The data behind those pages
 * stays gated by the pod on every read; this only shapes the page shell.
 *
 * Never kept: `none` (no session), `unavailable` (the pod did not answer),
 * any error, a role asked without an active session, and a request with no
 * Kratos session cookie (nothing to key it by).
 *
 * The memory is one module-level Map: the proxy runs in the Node.js runtime
 * (Next 16 proxy docs, "Runtime") and `next-server` `require()`s the compiled
 * proxy once per process (`loadNodeMiddleware`), so it lives as long as the
 * server process. Bounded to `GATE_CACHE_MAX_ENTRIES`, oldest first out.
 */

import { createHash } from "node:crypto";
import {
  checkSession,
  podAdminRole,
  type KratosIdentity,
  type SessionCheck,
} from "./kratos";

export const GATE_ANSWER_TTL_MS = 30_000;
export const GATE_CACHE_MAX_ENTRIES = 1_000;

/**
 * Kratos's default cookie name, the same literal every auth path in the pod
 * reads (`apps/api` `rate-limit-classes.ts` `KRATOS_SESSION_COOKIE`). The
 * whoami answer depends on it alone; the other cookies on the request vary
 * (theme, nav state) and must not split the key.
 */
const KRATOS_SESSION_COOKIE = "ory_kratos_session";

type Role = "admin" | "member";

interface Remembered {
  identity: KratosIdentity;
  identityUntil: number;
  role?: Role;
  roleUntil?: number;
}

const remembered = new Map<string, Remembered>();

/**
 * SHA-256 of every Kratos session cookie value on the request (a browser may
 * send two with the same name), or null when there is none. The raw value is
 * a bearer secret: only its hash is held.
 */
export function sessionCacheKey(incoming: Headers): string | null {
  const values: string[] = [];
  for (const part of (incoming.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== KRATOS_SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (value) values.push(value);
  }
  if (values.length === 0) return null;
  return createHash("sha256").update(values.join("\n")).digest("hex");
}

export interface GateAnswers {
  session: SessionCheck;
  /** null when the path did not ask for the role. */
  role: Role | "unavailable" | null;
}

/**
 * Both answers for this request. The decisions (login, 503, /forbidden) stay
 * in `proxy.ts`; this only changes how the answers are fetched.
 */
export async function gateAnswers(
  incoming: Headers,
  needRole: boolean
): Promise<GateAnswers> {
  const key = sessionCacheKey(incoming);
  const now = Date.now();
  let known = key ? remembered.get(key) : undefined;
  if (known && known.identityUntil <= now) {
    remembered.delete(key!);
    known = undefined;
  }
  const knownRole =
    known?.role && (known.roleUntil ?? 0) > now ? known.role : undefined;

  const [session, role] = await Promise.all([
    known
      ? ({ state: "active", identity: known.identity } as const)
      : checkSession(incoming),
    needRole ? (knownRole ?? podAdminRole(incoming)) : null,
  ]);

  if (key && session.state === "active") {
    const stamp = Date.now() + GATE_ANSWER_TTL_MS;
    const entry: Remembered = known ?? {
      identity: session.identity,
      identityUntil: stamp,
    };
    if (!knownRole && (role === "admin" || role === "member")) {
      entry.role = role;
      entry.roleUntil = stamp;
    }
    if (!known) remember(key, entry);
  }

  return { session, role };
}

function remember(key: string, entry: Remembered): void {
  remembered.delete(key);
  remembered.set(key, entry);
  // A Map iterates in insertion order: the first key is the oldest entry.
  while (remembered.size > GATE_CACHE_MAX_ENTRIES) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
}
