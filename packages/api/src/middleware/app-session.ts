/**
 * The session gate of the APP API — `/trpc` and the routes the Synap apps
 * call beside it (`/api/chat`, `/api/files`, `/api/capture`,
 * `/api/media/transcribe`, `/api/ws-ticket`).
 *
 * Two credentials reach the person here, and only two:
 *   1. a Kratos session — the cookie or `X-Session-Token`, judged by the
 *      Kratos middleware (`authMiddleware`, @synap/auth) exactly as before;
 *   2. a Synap app's DEVICE token, sent as
 *      `Authorization: Bearer synap_pd_…`, minted only by
 *      `services/person-device-token.ts` and resolved only by
 *      `resolvePersonDeviceSession` into the SAME `{ identity: { id, traits } }`
 *      shape a Kratos session has, so every procedure behind this gate sees
 *      the person exactly as it does for a browser session.
 *
 * Any OTHER bearer — a PAT, an agent or machine key, an app's person token, a
 * Kratos token sent as a bearer — is IGNORED here: the request falls to the
 * Kratos check, which reads `Authorization` only in local mode, and there
 * only to compare it with the desktop's own `LOCAL_AUTH_TOKEN`; it never
 * resolves a key into a person. That is the boundary: a key
 * minted for an agent must never become a human session on `/trpc`, where
 * nothing routes its writes through governance. Keys keep their own doors
 * (`/mcp`, `/api/hub/*`), which in turn never resolve a device token (it is no
 * `api_keys` row). Tests: `app-session.test.ts` (tripwire
 * `app-session-bearer`).
 *
 * A device token that does not resolve answers 401 `invalid_token` — never
 * a fall-through to an ambient cookie, which may be someone else's — so the
 * app refreshes. A failed lookup answers 503: never "signed out".
 */

import type { MiddlewareHandler } from "hono";
import { authMiddleware } from "@synap/auth";
import { db } from "@synap/database";
import {
  isPersonDeviceToken,
  resolvePersonDeviceSession,
} from "@synap/database/person-devices";
import { runAsDeviceSession } from "../utils/device-session.js";

/** The bearer credential of `Authorization`, or null. Scheme is case-insensitive. */
export function bearerCredential(header: string | undefined): string | null {
  const match = header?.match(/^\s*bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

/**
 * `kratos` is the Kratos session middleware; a test passes a stand-in. The
 * bearer half has no seam: it is the one lookup, on the pod's own database.
 */
export function appSessionMiddleware(
  kratos: MiddlewareHandler = authMiddleware
): MiddlewareHandler {
  return async (c, next) => {
    const bearer = bearerCredential(c.req.header("authorization"));
    if (!isPersonDeviceToken(bearer)) return kratos(c, next);

    let session;
    try {
      session = await resolvePersonDeviceSession(db, bearer);
    } catch {
      return c.json(
        {
          error: "auth_service_unavailable",
          message: "Sign-in could not be checked. Please retry.",
        },
        503
      );
    }
    if (!session) {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return c.json({ error: "invalid_token" }, 401);
    }
    c.set(
      "user" as never,
      {
        id: session.identity.id,
        email: session.identity.traits.email,
        name: session.identity.traits.name,
      } as never
    );
    c.set("userId" as never, session.identity.id as never);
    c.set("session" as never, session as never);
    // The ONE place a session is marked a device session (createContext
    // copies it to `ctx.sessionKind`; credential doors refuse it).
    c.set("sessionKind" as never, "person_device" as never);
    c.set("authenticated" as never, true as never);
    // The request's async scope knows it too, so a credential write deep in
    // a service (no ctx at hand) can ask for fresh authentication.
    return runAsDeviceSession(
      { id: session.device.id, authTime: session.device.authTime },
      () => next()
    );
  };
}
