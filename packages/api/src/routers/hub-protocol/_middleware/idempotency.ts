/**
 * Hub Protocol Idempotency Middleware
 *
 * Adds opt-in HTTP `Idempotency-Key` semantics to all `/api/hub/*` write
 * operations (POST/PUT/PATCH/DELETE).
 *
 * Contract:
 *   - The header is opt-in. Requests without `Idempotency-Key` pass through
 *     unchanged. Read-only methods (GET/HEAD/OPTIONS) are always passed through.
 *   - Cache key is `(userId, idempotencyKey, sha256(body))`. Bodies that differ
 *     under the same key produce different cache entries, so a buggy retry with
 *     a mutated body is NOT served a stale 200.
 *   - TTL is 24h. Only 2xx responses are cached. 4xx/5xx are intentionally
 *     never cached (so a client can recover after a server-side fix or a
 *     transient 5xx).
 *   - Replays return the cached response with `X-Idempotent-Replay: true`.
 *   - The middleware fails OPEN: if the cache backend errors, the request is
 *     processed normally. Idempotency is a safety net, never a hard dependency.
 *
 * Secret-leak hardening (E1.1):
 *   - `skipPaths` lets the mount point exclude endpoints that either issue
 *     secrets (e.g. `/setup/agent` returns a one-shot `hubApiKey`) or are
 *     authed out-of-band so `c.userId` would otherwise fall back to
 *     "anonymous" — which would let two operators sharing an Idempotency-Key
 *     value receive each other's response. These endpoints MUST be skipped.
 *   - As belt-and-suspenders, the response body is matched against
 *     `secretBodyPattern` before caching. If common secret field names appear
 *     in the body text, the response is sent to the original caller but never
 *     stored in the cache.
 *
 * Storage backend:
 *   The Synap backend currently has no shared Redis client (rate limiters use
 *   in-memory Maps with periodic GC; see `hub-protocol-rate-limit.ts`). Until a
 *   shared Redis dep is introduced, this middleware uses the same in-memory
 *   pattern. This is per-instance only — a multi-pod deployment will fall back
 *   to local idempotency, which is fine for the single-pod case (the dominant
 *   topology) and degrades gracefully for the rest.
 *
 *   When a Redis client lands, swap the `cacheGet` / `cacheSet` calls below for
 *   `redis.get` / `redis.setex` and delete the in-memory store + GC interval.
 */

import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const IDEMPOTENT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Default regex for response bodies that should never be cached. Matches the
 * common secret field names emitted by the hub protocol surface — kept in
 * sync with the auth/setup/vault routes. Add new field names here if a new
 * endpoint starts returning a one-shot secret.
 */
const DEFAULT_SECRET_BODY_PATTERN =
  /\b(hubApiKey|subToken|apiKey|provisioningToken|sessionToken|secret|privateKey|kratosSecret)\b/i;

export interface IdempotencyOptions {
  /**
   * Paths that should never be subject to idempotency caching.
   * Match is suffix-based (same shape as the auth middleware's
   * skipAuthPaths) so we work with the mount path being `/api/hub`.
   * Endpoints that issue secrets (`/setup/agent`) or are authed
   * out-of-band (`/entity-share/deliver`) MUST be in this list.
   */
  skipPaths?: string[];
  /**
   * Regex tested against response body text. Matches → never cached.
   * Default: a regex covering common secret field names.
   */
  secretBodyPattern?: RegExp;
}

interface CachedResponse {
  status: number;
  bodyText: string;
  contentType: string;
}

interface CacheEntry {
  value: CachedResponse;
  expiresAt: number;
}

// ── In-memory store (degraded mode — see file header) ─────────────────────
const store = new Map<string, CacheEntry>();

// Periodic GC of expired entries (cheap; runs every 5 min)
const gcInterval = setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt < now) store.delete(key);
    }
  },
  5 * 60 * 1000
);
// Don't keep the Node event loop alive just for GC.
if (typeof gcInterval.unref === "function") gcInterval.unref();

// One-shot startup warning so operators know this is in-memory.
let warned = false;
function warnIfFirst() {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[hub-idempotency] Using in-memory idempotency cache (per-instance). " +
      "Replace with Redis for multi-instance deployments."
  );
}

async function cacheGet(key: string): Promise<CachedResponse | null> {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

async function cacheSet(key: string, value: CachedResponse): Promise<void> {
  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

/**
 * Test-only escape hatch. Resets the in-memory store + warning flag so
 * `idempotency.test.ts` can isolate cases. Not exported from the package
 * barrel — internal use only.
 *
 * @internal
 */
export function __resetIdempotencyStoreForTests(): void {
  store.clear();
  warned = false;
}

/**
 * Re-attach a consumed body to the Hono request so downstream handlers can
 * still call `c.req.text()` / `c.req.json()` / etc.
 *
 * `c.req.text()` consumes the underlying ReadableStream — the standard fix is
 * to swap `c.req.raw` for a fresh Request built from the buffered text AND
 * pre-populate `c.req.bodyCache.text` so Hono's HonoRequest helpers serve
 * the cached value instead of trying to re-read the stream.
 */
function reattachBody(
  c: { req: { raw: Request; bodyCache: { text?: string; json?: unknown } } },
  bodyText: string
): void {
  const original = c.req.raw;
  const reconstructed = new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body: bodyText.length > 0 ? bodyText : undefined,
    // Required when the body is non-null on POST/PUT/etc. in undici.
    duplex: bodyText.length > 0 ? "half" : undefined,
    // Preserve other knobs callers may rely on.
    redirect: original.redirect,
    referrer: original.referrer,
    referrerPolicy: original.referrerPolicy,
    integrity: original.integrity,
    signal: original.signal,
  } as RequestInit & { duplex?: "half" });
  c.req.raw = reconstructed;
  // Prime Hono's body cache so .text() / .json() don't re-read the stream.
  c.req.bodyCache.text = bodyText;
  // .json() reads from bodyCache.text if present, so no need to set .json.
}

/**
 * Hub Protocol idempotency middleware. Mount once on the hub app, AFTER the
 * auth middleware (we need `userId` from context) and BEFORE the route slices.
 */
export function idempotencyMiddleware(
  opts: IdempotencyOptions = {}
): MiddlewareHandler {
  const skipPaths = opts.skipPaths ?? [];
  const secretPattern = opts.secretBodyPattern ?? DEFAULT_SECRET_BODY_PATTERN;

  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const key =
      c.req.header("idempotency-key") ?? c.req.header("Idempotency-Key");

    // Pass-through for read-only methods OR when the header is absent.
    if (!IDEMPOTENT_METHODS.has(method) || !key) {
      return next();
    }

    // Skip-path bypass — endpoints that issue secrets or are authed
    // out-of-band MUST be excluded so two callers sharing a key never
    // see each other's response. Suffix match mirrors the auth middleware
    // (we don't know the mount-path prefix at module load).
    const reqPath = c.req.path;
    if (skipPaths.some((p) => reqPath === p || reqPath.endsWith(p))) {
      return next();
    }

    // Reject obvious garbage early. UUIDs (36) + ULIDs (26) + short opaque
    // tokens fit in [8, 256].
    if (key.length < 8 || key.length > 256) {
      return c.json({ error: "Idempotency-Key must be 8-256 chars" }, 400);
    }

    warnIfFirst();

    // Buffer the request body so we can hash it AND replay it to the handler.
    let bodyText = "";
    try {
      bodyText = await c.req.text();
    } catch {
      bodyText = "";
    }
    const bodyHash = createHash("sha256").update(bodyText).digest("hex");

    const userId = (c.get("userId") as string | undefined) ?? "anonymous";
    const cacheKey = `idem:${userId}:${key}:${bodyHash}`;

    // Cache lookup — fail OPEN on any error.
    let cached: CachedResponse | null = null;
    try {
      cached = await cacheGet(cacheKey);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[hub-idempotency] cache get failed", err);
    }

    if (cached) {
      return new Response(cached.bodyText, {
        status: cached.status,
        headers: {
          "Content-Type": cached.contentType,
          "X-Idempotent-Replay": "true",
        },
      });
    }

    // Re-attach the body before invoking downstream handlers.
    reattachBody(c, bodyText);

    await next();

    // Only cache 2xx. Caching 4xx prevents recovery after a fix; caching 5xx
    // turns a transient blip into a permanent failure.
    const status = c.res.status;
    if (status >= 200 && status < 300) {
      try {
        const clone = c.res.clone();
        const text = await clone.text();
        const contentType =
          clone.headers.get("content-type") ?? "application/json";

        // Belt-and-suspenders: never cache a response whose body looks like
        // it carries a secret. Even if a path slips past skipPaths, the
        // pattern check stops the secret from being served on replay. The
        // response itself still flows back to the original caller.
        if (secretPattern.test(text)) {
          // eslint-disable-next-line no-console
          console.warn(
            `[hub-idempotency] response body matched secretBodyPattern at ${reqPath} — skipping cache`
          );
          return;
        }

        await cacheSet(cacheKey, {
          status,
          bodyText: text,
          contentType,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[hub-idempotency] cache set failed", err);
      }
    }
  };
}
