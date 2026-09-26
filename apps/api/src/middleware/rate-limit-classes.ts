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
  Exclude<RateLimitClass, "free" | "public_read" | "public_submit">,
  { max: number; windowMs: number; retryAfter: string }
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
 * Stable SHA-256 prefix of a bearer token. Never log the raw token.
 */
export function hashBearerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/**
 * Key by API-key material when Authorization: Bearer is present (hashed),
 * else by client IP. Class-prefixed so budgets are independent.
 */
/** Path token from `/calendar/feed/{token}.ics` — hashed, never logged raw. */
export function calendarFeedTokenFromPath(path: string): string | null {
  const p = path.split(/[?#]/, 1)[0] || "/";
  const m = /\/calendar\/feed\/([^/]+)\.ics$/.exec(p);
  return m?.[1] ?? null;
}

export function buildRateLimitKey(
  className: RateLimitClass | string,
  authHeader: string | undefined,
  ip: string,
  path?: string
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
  return `${className}:ip:${ip}`;
}
