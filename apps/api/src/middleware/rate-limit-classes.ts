/**
 * Pod-edge rate-limit classification + keying (pure helpers).
 *
 * Kept free of Hono middleware / @synap/api so unit tests and the edge
 * middleware can share the same logic without a heavy import graph.
 */
import { createHash } from "node:crypto";

/**
 * Request classes for the pod-edge rate limiter.
 *
 * - free: health/metrics probes (skipped)
 * - import: bulk import surfaces
 * - ai_agent_turn: Discord/channel agent turns (higher AI budget)
 * - ai_interactive: external/OpenAI-compat chat
 * - crud: everything else
 */
export type RateLimitClass =
  "free" | "import" | "ai_agent_turn" | "ai_interactive" | "crud";

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
  Exclude<RateLimitClass, "free">,
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
  };
}

/**
 * Classify a request path into a rate-limit class.
 * Pure function — unit-tested; no env/side effects.
 */
export function classifyRateLimitPath(path: string): RateLimitClass {
  // Hono's c.req.path is pathname-only; still strip query/hash defensively.
  const p = path.split(/[?#]/, 1)[0] || "/";

  // free — probes that must never burn budget
  if (
    p === "/health" ||
    p === "/metrics" ||
    p === "/api/hub/health" ||
    p === "/api/hub-protocol/health"
  ) {
    return "free";
  }

  // import — Hub REST bulk import
  if (
    p === "/api/hub/import" ||
    p.startsWith("/api/hub/import/") ||
    p === "/api/hub-protocol/import" ||
    p.startsWith("/api/hub-protocol/import/")
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

  return "crud";
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
export function buildRateLimitKey(
  className: RateLimitClass | string,
  authHeader: string | undefined,
  ip: string
): string {
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
