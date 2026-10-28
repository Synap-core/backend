/**
 * Origin policy of the Socket.IO server — mirrors apps/api/src/cors-origin.ts.
 * This is a separate process/package so the check is duplicated by design. The
 * Socket.IO handshake is credentialed, so reflecting every origin is a CSWSH
 * surface; trust only first-party origins (env/base-domain) and APPROVED
 * cross-origin applications.
 *
 * Async because the approved-application check hits the DB — the same
 * `federated_application_connections` table the HTTP door consults. Omitting
 * that path was the bug: an approved app (e.g. crm.synap.live) was authorized
 * for HTTP/tRPC but its Socket.IO handshake was rejected with no
 * Access-Control-Allow-Origin, so realtime was silently down for every approved
 * cross-origin app.
 */
import {
  db,
  and,
  eq,
  arrayContains,
  federatedApplicationConnections,
} from "@synap/database";
import { realtimeFirstPartyBase } from "./first-party-base.js";

/**
 * deploy/docker-compose.yml passes `FRONTEND_URL: ${FRONTEND_URL:-<this>}`, so
 * a production pod nobody configured still has it SET to this value.
 */
const DEFAULT_FRONTEND_URL = "http://localhost:3000";

export async function isAllowedRealtimeOrigin(
  origin?: string
): Promise<boolean> {
  // No Origin: a native client. Origin `null`: an opaque origin — the Desktop
  // app's production renderer is loaded from file:// and connects with
  // `Origin: null` (polling first, withCredentials). Accepting it is not a
  // CSWSH hole here: no realtime door reads an ambient cookie — every
  // handshake proves itself with the token in its `auth` payload
  // (session-auth.ts, api-key-auth.ts), which a foreign page cannot supply.
  if (!origin || origin === "null") return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false; // malformed origin
  }
  const production = process.env.NODE_ENV === "production";
  const host = u.hostname.toLowerCase();
  const base = realtimeFirstPartyBase(process.env.SYNAP_BASE_DOMAIN);
  // Derived subdomain trust requires https + the default port (dev allows http) —
  // matches apps/api/src/cors-origin.ts.
  const schemeOk = u.protocol === "https:" || !production;
  if (
    base &&
    schemeOk &&
    u.port === "" &&
    (host === base || host.endsWith(`.${base}`))
  ) {
    return true;
  }
  // Explicit allowlist. FRONTEND_URL counts only when it is really configured:
  // the compose default (localhost:3000) is trusted outside production only,
  // so a pod nobody configured never trusts a localhost page.
  const frontendUrl = process.env.FRONTEND_URL;
  const trustFrontendUrl =
    !!frontendUrl && !(production && frontendUrl === DEFAULT_FRONTEND_URL);
  const explicit = [
    ...(process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()),
    process.env.PUBLIC_URL ?? "",
    process.env.POD_ADMIN_URL ?? "",
    ...(trustFrontendUrl ? [frontendUrl] : []),
  ].filter(Boolean);
  if (
    explicit.some((o) => {
      try {
        return new URL(o).origin === u.origin;
      } catch {
        return false;
      }
    })
  ) {
    return true;
  }
  // Approved cross-origin applications — trusted exactly as the HTTP CORS door
  // trusts them (`isApprovedApplicationOrigin`): an APPROVED row whose
  // `allowed_origins` contains this exact origin. A DB outage fails CLOSED —
  // never reflect an unknown Origin onto a credentialed WebSocket.
  try {
    const connection = await db.query.federatedApplicationConnections.findFirst(
      {
        where: and(
          eq(federatedApplicationConnections.status, "approved"),
          arrayContains(federatedApplicationConnections.allowedOrigins, [
            u.origin,
          ])
        ),
        columns: { id: true },
      }
    );
    return Boolean(connection);
  } catch {
    return false;
  }
}
