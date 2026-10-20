/**
 * Pod-edge rate-limit classification + keying (pure helpers).
 *
 * Kept free of Hono middleware / @synap/api so unit tests and the edge
 * middleware can share the same logic without a heavy import graph.
 */
import { createHash } from "node:crypto";
// Zero-import subpath (never the heavy `@synap/api` root): the ONE public-door
// predicate, shared with hub auth, idempotency and the edge CORS.
import {
  isPublicDoorPath,
  publicDoorTokenSegment,
} from "@synap/api/public-doors";

/**
 * Request classes for the pod-edge rate limiter.
 *
 * - free: health/metrics probes (skipped)
 * - import: bulk import surfaces
 * - ai_agent_turn: Discord/channel agent turns (higher AI budget)
 * - ai_interactive: external/OpenAI-compat chat
 * - calendar_feed: unauth ICS polls (not crud — calendar clients poll)
 * - public_read: credentialless public-door reads (`/api/hub/public/*` GET)
 * - public_submit: credentialless public-door writes (`/api/hub/public/*` POST)
 * - device_auth: the unauthenticated device-flow START (`POST /setup/device`),
 *   IP-keyed — a terminal has no credential yet (MACHINE-IDENTITY-PLAN W2)
 * - key_state: `GET /auth/key-state`, auth-SKIPPED (it answers a key that does
 *   not authenticate), so IP-keyed — a random Bearer per request must not buy
 *   a fresh `crud` budget
 * - oauth_public: the pod authorization server's unauthenticated doors
 *   (`/register`, `/authorize`, `/token`), IP-keyed — open DCR and the CIMD
 *   fetch `/authorize` may trigger are a write and an outbound request any
 *   stranger can cause (spec 17 T11)
 * - crud: everything else
 */
export type RateLimitClass =
  | "free"
  | "import"
  | "ai_agent_turn"
  | "ai_interactive"
  | "calendar_feed"
  | "public_read"
  | "public_submit"
  | "device_auth"
  | "key_state"
  | "oauth_public"
  | "crud";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function formatRetryAfter(windowMs: number): string {
  const seconds = Math.ceil(windowMs / 1000);
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Tunable class budgets (env overrides; call at use-site for fresh reads). */
export function getRateLimitClassConfig(): Record<
  // Public-door classes carry their own nested budgets (getPublicDoorRateConfig).
  Exclude<
    RateLimitClass,
    | "free"
    | "public_read"
    | "public_submit"
    | "device_auth"
    | "key_state"
    | "oauth_public"
  >,
  {
    max: number;
    windowMs: number;
    retryAfter: string;
    sessionMax?: number;
    ipCeiling?: number;
  }
> {
  const crudWindow = parsePositiveInt(
    process.env.RATE_LIMIT_CRUD_WINDOW_MS,
    15 * 60 * 1000
  );
  const importWindow = parsePositiveInt(
    process.env.RATE_LIMIT_IMPORT_WINDOW_MS,
    15 * 60 * 1000
  );
  const aiWindow = parsePositiveInt(
    process.env.RATE_LIMIT_AI_WINDOW_MS,
    5 * 60 * 1000
  );
  const agentWindow = parsePositiveInt(
    process.env.RATE_LIMIT_AGENT_TURN_WINDOW_MS,
    aiWindow
  );
  const calendarFeedWindow = parsePositiveInt(
    process.env.RATE_LIMIT_CALENDAR_FEED_WINDOW_MS,
    5 * 60 * 1000
  );

  // One signed-in person's budget (`crud:session:*`). The console spends ~2
  // gate calls per page and prefetch plus its own queries and polling —
  // roughly 60–150 requests a minute for an active operator — so the anonymous
  // per-IP budget would lock a single person out.
  const crudSessionMax = parsePositiveInt(
    process.env.RATE_LIMIT_CRUD_SESSION_MAX,
    3000
  );

  return {
    import: {
      max: parsePositiveInt(process.env.RATE_LIMIT_IMPORT_MAX, 200),
      windowMs: importWindow,
      retryAfter: formatRetryAfter(importWindow),
    },
    ai_interactive: {
      max: parsePositiveInt(process.env.RATE_LIMIT_AI_MAX, 60),
      windowMs: aiWindow,
      retryAfter: formatRetryAfter(aiWindow),
    },
    ai_agent_turn: {
      max: parsePositiveInt(process.env.RATE_LIMIT_AGENT_TURN_MAX, 120),
      windowMs: agentWindow,
      retryAfter: formatRetryAfter(agentWindow),
    },
    crud: {
      max: parsePositiveInt(process.env.RATE_LIMIT_CRUD_MAX, 500),
      sessionMax: crudSessionMax,
      // Every `crud` request from one client address, whatever bucket it
      // spends from (`crud:ipall:*`, see `buildCrudIpCeilingKey`). Five busy
      // people behind one address fit; a caller inventing a session or Bearer
      // per request does not get past it.
      ipCeiling: parsePositiveInt(
        process.env.RATE_LIMIT_CRUD_IP_CEILING,
        5 * crudSessionMax
      ),
      windowMs: crudWindow,
      retryAfter: formatRetryAfter(crudWindow),
    },
    calendar_feed: {
      max: parsePositiveInt(process.env.RATE_LIMIT_CALENDAR_FEED_MAX, 120),
      windowMs: calendarFeedWindow,
      retryAfter: formatRetryAfter(calendarFeedWindow),
    },
  };
}

/** The unauthenticated OAuth doors budgeted per IP (`oauth_public`). */
export const OAUTH_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/register",
  "/authorize",
  "/token",
]);

/**
 * Classify a request path into a rate-limit class.
 * Pure function — unit-tested; no env/side effects.
 *
 * `method` only matters for the public-door namespace (a read and a submit are
 * budgeted apart); every other class is path-only, as before.
 */
export function classifyRateLimitPath(
  path: string,
  method: string = "GET"
): RateLimitClass {
  // Hono's c.req.path is pathname-only; still strip query/hash defensively.
  const p = path.split(/[?#]/, 1)[0] || "/";

  // Credentialless public doors — the ONE predicate (public-doors.ts). Checked
  // first so no later rule can pull a public path into a Bearer-keyed class.
  if (isPublicDoorPath(p)) {
    const m = method.toUpperCase();
    return m === "GET" || m === "HEAD" || m === "OPTIONS"
      ? "public_read"
      : "public_submit";
  }

  // Device door START — unauthenticated, so its budget is per IP (RFC 8628
  // §5.1). Only creation: polling `/setup/device/token` is paced by the
  // protocol (`interval`/`slow_down`) and gated by the device code.
  if (p === "/api/hub/setup/device" || p === "/api/hub-protocol/setup/device") {
    return "device_auth";
  }

  // The holder's key-state door skips auth (its key may not work — that is
  // the question), so its budget is per IP, never per presented Bearer.
  if (
    p === "/api/hub/auth/key-state" ||
    p === "/api/hub-protocol/auth/key-state"
  ) {
    return "key_state";
  }

  // The pod AS's public doors, mounted at the ROOT (RFC 8414 puts the issuer
  // there). `/revoke` stays in `crud`: it changes nothing a stranger can
  // reach (possession of the token is the authority) and starts no fetch.
  if (OAUTH_PUBLIC_PATHS.has(p)) {
    return "oauth_public";
  }

  // free — probes that must never burn budget
  if (
    p === "/health" ||
    p === "/metrics" ||
    p === "/api/hub/health" ||
    p === "/api/hub-protocol/health"
  ) {
    return "free";
  }

  // import — Hub REST bulk import, and the observations ingest door.
  //
  // `observations.append` takes a BATCH per call, so the default `crud` budget
  // (500 calls / 15 min) multiplies by the batch size into a very large number
  // of appended rows on an append-only hypertable. It is a bulk-ingest door in
  // everything but name, so it belongs in the bulk-ingest budget rather than
  // alongside single-row CRUD.
  if (
    p === "/api/hub/import" ||
    p.startsWith("/api/hub/import/") ||
    p === "/api/hub-protocol/import" ||
    p.startsWith("/api/hub-protocol/import/") ||
    p.startsWith("/api/hub/trpc/observations")
  ) {
    return "import";
  }

  // agent-turn — higher AI budget (120/5m default)
  if (
    p === "/api/hub/discord/agent-turn" ||
    p === "/api/hub-protocol/discord/agent-turn"
  ) {
    return "ai_agent_turn";
  }

  // ai interactive — external chat + OpenAI-compat
  if (
    p === "/api/external/chat" ||
    p.startsWith("/api/external/chat/") ||
    p === "/v1/chat" ||
    p.startsWith("/v1/chat/")
  ) {
    return "ai_interactive";
  }

  // calendar ICS polls — token in path, no Bearer. Not crud.
  if (/\/api\/hub(?:-protocol)?\/calendar\/feed\/[^/]+\.ics$/.test(p)) {
    return "calendar_feed";
  }

  return "crud";
}

/**
 * The IP ceiling that sits IN FRONT of the per-token calendar bucket.
 *
 * Why a second limiter rather than one key: the token bucket is keyed on a
 * path segment the CALLER chooses, and the pod cannot know whether that token
 * exists until it has hashed it and hit the database. Keyed on the token
 * alone, a fresh random token per request buys a fresh budget every request —
 * unlimited unauthenticated work, and unbounded key growth in the limiter's
 * in-process store. Keyed on IP alone, a household behind one NAT shares one
 * budget, which is the thing the per-token key exists to avoid.
 *
 * So: both. The IP ceiling is deliberately generous — several devices in one
 * home, each polling every 5 minutes, must never see a 429 — while still
 * bounding an anonymous caller to a fixed cost per window.
 */
export function getCalendarFeedIpCeiling(): {
  max: number;
  windowMs: number;
  retryAfter: string;
} {
  const windowMs = parsePositiveInt(
    process.env.RATE_LIMIT_CALENDAR_FEED_WINDOW_MS,
    5 * 60 * 1000
  );
  return {
    max: parsePositiveInt(process.env.RATE_LIMIT_CALENDAR_FEED_IP_MAX, 600),
    windowMs,
    retryAfter: formatRetryAfter(windowMs),
  };
}

/**
 * Public-door budgets (Sites W3). Every public bucket is keyed WITHOUT the
 * Authorization header — a caller-chosen random Bearer must never buy a fresh
 * budget (the defect the calendar feed already paid for).
 *
 * - read, per IP: 300 / 5 min. There is deliberately NO per-share read cap: a
 *   page that goes viral must not 429 every reader.
 * - submit, per IP: 10 / 10 min, checked FIRST (bounds a caller who varies the
 *   token), then per share: 200 / hour (bounds what one form can absorb).
 *
 * KNOWN LIMITATION: behind a Cloudflare tunnel every request arrives from the
 * `cloudflared` peer, so "per IP" is one shared bucket for the whole pod.
 * `CF-Connecting-IP` is deliberately NOT trusted here (anyone reaching the
 * public :80 could forge it); fixing it needs Caddy `trusted_proxies` on the
 * pod, which a Caddyfile edit does not reach on existing pods.
 */
export function getPublicDoorRateConfig(): {
  readIp: { max: number; windowMs: number; retryAfter: string };
  submitIp: { max: number; windowMs: number; retryAfter: string };
  submitShare: { max: number; windowMs: number; retryAfter: string };
} {
  const readWindow = parsePositiveInt(
    process.env.RATE_LIMIT_PUBLIC_READ_WINDOW_MS,
    5 * 60 * 1000
  );
  const submitIpWindow = parsePositiveInt(
    process.env.RATE_LIMIT_PUBLIC_SUBMIT_IP_WINDOW_MS,
    10 * 60 * 1000
  );
  const submitShareWindow = parsePositiveInt(
    process.env.RATE_LIMIT_PUBLIC_SUBMIT_SHARE_WINDOW_MS,
    60 * 60 * 1000
  );
  return {
    readIp: {
      max: parsePositiveInt(process.env.RATE_LIMIT_PUBLIC_READ_IP_MAX, 300),
      windowMs: readWindow,
      retryAfter: formatRetryAfter(readWindow),
    },
    submitIp: {
      max: parsePositiveInt(process.env.RATE_LIMIT_PUBLIC_SUBMIT_IP_MAX, 10),
      windowMs: submitIpWindow,
      retryAfter: formatRetryAfter(submitIpWindow),
    },
    submitShare: {
      max: parsePositiveInt(
        process.env.RATE_LIMIT_PUBLIC_SUBMIT_SHARE_MAX,
        200
      ),
      windowMs: submitShareWindow,
      retryAfter: formatRetryAfter(submitShareWindow),
    },
  };
}

/**
 * Device-flow START budget, per IP: 10 requests / 10 min. Keyed WITHOUT the
 * Authorization header (a random Bearer must not buy a fresh budget).
 */
export function getDeviceAuthRateConfig(): {
  max: number;
  windowMs: number;
  retryAfter: string;
} {
  const windowMs = parsePositiveInt(
    process.env.RATE_LIMIT_DEVICE_AUTH_WINDOW_MS,
    10 * 60 * 1000
  );
  return {
    max: parsePositiveInt(process.env.RATE_LIMIT_DEVICE_AUTH_MAX, 10),
    windowMs,
    retryAfter: formatRetryAfter(windowMs),
  };
}

/**
 * `/auth/key-state` budget, per IP: 30 requests / 10 min. A CLI asks once
 * when its key fails; a burst beyond this is enumeration or load, not a
 * person. Keyed WITHOUT the Authorization header.
 */
export function getKeyStateRateConfig(): {
  max: number;
  windowMs: number;
  retryAfter: string;
} {
  const windowMs = parsePositiveInt(
    process.env.RATE_LIMIT_KEY_STATE_WINDOW_MS,
    10 * 60 * 1000
  );
  return {
    max: parsePositiveInt(process.env.RATE_LIMIT_KEY_STATE_MAX, 30),
    windowMs,
    retryAfter: formatRetryAfter(windowMs),
  };
}

/**
 * `oauth_public` budget, per IP: 60 requests / 10 min. A connection costs at
 * most three calls (register, authorize, token) and a pod app refreshes about
 * once an hour, so this leaves room for many people behind one address while
 * bounding what a stranger can make the pod register or fetch. Keyed WITHOUT
 * the Authorization header (a random Bearer must not buy a fresh budget).
 */
export function getOAuthPublicRateConfig(): {
  max: number;
  windowMs: number;
  retryAfter: string;
} {
  const windowMs = parsePositiveInt(
    process.env.RATE_LIMIT_OAUTH_PUBLIC_WINDOW_MS,
    10 * 60 * 1000
  );
  return {
    max: parsePositiveInt(process.env.RATE_LIMIT_OAUTH_PUBLIC_MAX, 60),
    windowMs,
    retryAfter: formatRetryAfter(windowMs),
  };
}

/**
 * Public-door bucket keys. IP-only for the ceilings; the per-share key hashes
 * the path's token segment. NEVER reads Authorization — there is no parameter
 * for it on purpose.
 */
export function buildPublicDoorKey(
  bucket: "read_ip" | "submit_ip" | "submit_share",
  ip: string,
  path: string
): string {
  if (bucket === "submit_share") {
    const token = publicDoorTokenSegment(path);
    // No token segment ⇒ fall back to the IP bucket's scope, never a shared "".
    return token
      ? `public_submit:share:${hashBearerToken(token)}`
      : `public_submit:share-ip:${ip}`;
  }
  return `public_${bucket}:ip:${ip}`;
}

/**
 * The client IP every pod-edge limiter keys on. Caddy and Traefik (without
 * trusted upstreams) replace an incoming X-Forwarded-For with the peer they
 * saw, so its first entry is the connecting client — or the CDN edge when one
 * fronts the pod.
 *
 * TRUST: the header is believed as-is, which is only sound because the
 * backend publishes no port (deploy/docker-compose.yml) — every caller is
 * Caddy or a service on the compose network. Pod-admin is one such service:
 * it relays the X-Forwarded-For Caddy set on the browser's request
 * (apps/pod-admin/lib/pod-caller-headers.ts), so its server-side calls are
 * keyed by the real client rather than "unknown".
 */
export function clientIp(c: {
  req: { header(name: string): string | undefined };
}): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

/**
 * A call this pod may leave unthrottled: it reached the API process straight
 * over loopback (the socket peer is 127.0.0.0/8 or ::1) and carries no
 * forwarding header, so no proxy relayed it — an in-container caller.
 *
 * Decided on the SOCKET, never on X-Forwarded-For / X-Real-IP: a header saying
 * "127.0.0.1" is something any caller on the compose network can send. And a
 * request that went through a proxy on the same host (a bare-metal install
 * with Caddy on loopback) still carries the proxy's X-Forwarded-For, so it is
 * keyed like any other client rather than waved through. `c.env.incoming` is
 * the Node request `@hono/node-server` binds; without one (tests via
 * `app.request`) nothing is local.
 */
export function isDirectLoopbackCall(c: {
  env?: unknown;
  req: { header(name: string): string | undefined };
}): boolean {
  if (c.req.header("x-forwarded-for") || c.req.header("x-real-ip")) {
    return false;
  }
  const env = c.env as
    { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const peer = env?.incoming?.socket?.remoteAddress;
  if (!peer) return false;
  return (
    peer === "::1" || peer.startsWith("127.") || peer.startsWith("::ffff:127.")
  );
}

/**
 * True when the pod says every visitor arrives from one client address (a
 * Cloudflare tunnel's cloudflared peer). Same env and truthy spellings as
 * `sharedClientIpFromEnv` in `@synap/api` `services/sharing/public-doors-
 * switch.ts`, which this file cannot import (it pulls in the database).
 */
export function sharedClientIp(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.SYNAP_SHARED_CLIENT_IP;
  return (
    typeof raw === "string" &&
    ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
  );
}

/**
 * The address-wide `crud` bucket every request from one client spends,
 * whichever key (`:key:`, `:session:`, `:ip:`) it also spends from. The
 * per-key and per-session buckets are keyed on values the limiter cannot
 * validate (it runs before auth), so without a ceiling a caller inventing one
 * per request is never limited at all.
 *
 * null — no ceiling — when the address does not tell callers apart: "unknown"
 * (no forwarding header: a service on the compose network, which publishes no
 * port; every call through Caddy carries one), or a pod whose visitors all
 * share the tunnel's address, where one ceiling would be the whole internet's.
 */
export function buildCrudIpCeilingKey(
  ip: string,
  env: Record<string, string | undefined> = process.env
): string | null {
  if (ip === "unknown" || sharedClientIp(env)) return null;
  return `crud:ipall:${ip}`;
}

/**
 * Stable SHA-256 prefix of a bearer token. Never log the raw token.
 */
export function hashBearerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/**
 * The Kratos browser-session cookie. Kratos's default name: the pod's
 * kratos.yml (install.sh) sets only `session.cookie.domain`/`same_site`, and
 * every auth path in the pod reads this same literal.
 */
export const KRATOS_SESSION_COOKIE = "ory_kratos_session";

/**
 * The shortest cookie value that earns a per-session bucket. A real Kratos
 * session cookie is a signed, encrypted securecookie of a few hundred
 * characters; anything shorter is invented and stays in the IP bucket.
 */
export const KRATOS_SESSION_MIN_LENGTH = 64;

/**
 * The `ory_kratos_session` value from a raw Cookie header, or null. Lenient on
 * purpose — a malformed header (no `=`, stray `;`, empty value) just yields no
 * session and the request falls back to the IP key; it never throws on the
 * limiter's hot path. The value is only ever hashed, never logged.
 */
export function kratosSessionFromCookieHeader(
  cookieHeader: string | undefined
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== KRATOS_SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/** Path token from `/calendar/feed/{token}.ics` — hashed, never logged raw. */
export function calendarFeedTokenFromPath(path: string): string | null {
  const p = path.split(/[?#]/, 1)[0] || "/";
  const m = /\/calendar\/feed\/([^/]+)\.ics$/.exec(p);
  return m?.[1] ?? null;
}

/**
 * The bucket a request spends from. Class-prefixed so budgets are independent.
 * First match wins:
 *
 *   1. calendar feed — the hashed path token;
 *   2. `Authorization: Bearer` with real key material — the hashed key;
 *   3. a Kratos session cookie — the hashed session, so each signed-in person
 *      has their own budget whatever address they arrive from. Pod-admin's
 *      gate checks and API routes reach `backend:4000` server-side; keyed by
 *      IP alone they all shared ONE `<class>:ip:unknown` budget, and one busy
 *      console drained everyone's;
 *   4. the client IP (anonymous callers).
 *
 * Like the Bearer key, the cookie is not validated here (the limiter runs
 * before auth), so a caller inventing values buys a bucket per value — the
 * exposure an invented Bearer already has. `KRATOS_SESSION_MIN_LENGTH` keeps
 * short values in the IP bucket, and the address-wide ceiling
 * (`buildCrudIpCeilingKey`) bounds what invented values can buy.
 */
export function buildRateLimitKey(
  className: RateLimitClass | string,
  authHeader: string | undefined,
  ip: string,
  path?: string,
  cookieHeader?: string
): string {
  if (className === "calendar_feed" && path) {
    const token = calendarFeedTokenFromPath(path);
    if (token) return `calendar_feed:token:${hashBearerToken(token)}`;
  }
  const auth = authHeader || "";
  // Product lock: only key on Bearer material when header is long enough to be
  // a real key (avoids "Bearer " / "Bearer x" burning a shared empty-hash bucket).
  if (auth.startsWith("Bearer ") && auth.length > 20) {
    const token = auth.slice("Bearer ".length).trim();
    if (token.length > 0) {
      return `${className}:key:${hashBearerToken(token)}`;
    }
  }
  const session = kratosSessionFromCookieHeader(cookieHeader);
  if (session && session.length >= KRATOS_SESSION_MIN_LENGTH) {
    return `${className}:session:${hashBearerToken(session)}`;
  }
  return `${className}:ip:${ip}`;
}
