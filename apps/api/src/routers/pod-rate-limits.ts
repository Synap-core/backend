/**
 * Pod rate limits — `/api/pod-rate-limits/*`. The owner sets the pod's request
 * budgets from the pod's own settings instead of deployment variables
 * (founder, 2026-10-27: "the limit should not be hardcoded logic but
 * parameters"). Storage and the session are wired in
 * `pod-rate-limits-deps.ts`, so the tests drive the real routes with fake
 * dependencies (the `pod-updates` shape).
 *
 *   GET /   session            → { budgets, canEdit }
 *   PUT /   session, pod admin → { values: { RATE_LIMIT_…: n | null } } → same
 *
 * A value set here wins over the env (`RATE_LIMIT_*`), which stays the
 * deployment's default; `null` clears it. The edge applies a change at once
 * (`setRateLimitOverrides`), without a redeploy, and every bucket starts
 * afresh. Only a signed-in person reaches this door: an agent's key cannot
 * raise its own budget.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  describeRateLimitBudgets,
  parseRateLimitOverrides,
  RATE_LIMIT_BUDGET_KEYS,
  RATE_LIMIT_SETTING_MAX,
  setRateLimitOverrides,
  type RateLimitOverrides,
} from "../middleware/rate-limit-classes.js";

export interface PodRateLimitsDeps {
  authenticate: MiddlewareHandler[];
  /** `users.id` for the session's identity, or null. */
  resolveUserId(identityId: string): Promise<string | null>;
  isPodAdmin(userId: string): Promise<boolean>;
  /** Raw `pod_settings.settings.rateLimits.values`. Throws on a failed read. */
  readValuesRaw(): Promise<unknown>;
  /** Persists the FULL set of values (never a partial). */
  writeValues(next: RateLimitOverrides, changedBy: string): Promise<void>;
  audit(entry: {
    userId: string;
    change: string;
    data?: Record<string, unknown>;
  }): Promise<void>;
}

const KEYS: ReadonlySet<string> = new Set(RATE_LIMIT_BUDGET_KEYS);

/**
 * `{ values: { KEY: n | null } }` with known keys and a positive integer up to
 * `RATE_LIMIT_SETTING_MAX` or `null`; anything else refuses the whole patch.
 */
export function parseRateLimitsPatch(
  body: unknown
): Record<string, number | null> | null {
  const values = (body as { values?: unknown } | null)?.values;
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    return null;
  }
  const entries = Object.entries(values);
  if (entries.length === 0) return null;
  for (const [key, value] of entries) {
    if (!KEYS.has(key)) return null;
    if (value === null) continue;
    if (
      !Number.isInteger(value) ||
      (value as number) <= 0 ||
      (value as number) > RATE_LIMIT_SETTING_MAX
    ) {
      return null;
    }
  }
  return Object.fromEntries(entries) as Record<string, number | null>;
}

export function createPodRateLimitsRouter(deps: PodRateLimitsDeps) {
  const router = new Hono();
  router.use("*", ...deps.authenticate);

  async function caller(c: Context) {
    const identityId = c.get("userId" as never) as string | undefined;
    if (!identityId) return null;
    return deps.resolveUserId(identityId);
  }

  async function view(userId: string) {
    return {
      budgets: describeRateLimitBudgets(),
      canEdit: await deps.isPodAdmin(userId),
    };
  }

  router.get("/", async (c) => {
    const userId = await caller(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    return c.json(await view(userId));
  });

  router.put("/", async (c) => {
    const patch = parseRateLimitsPatch(await c.req.json().catch(() => null));
    if (!patch) return c.json({ error: "invalid_request" }, 400);
    const userId = await caller(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    if (!(await deps.isPodAdmin(userId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    let previous: RateLimitOverrides;
    try {
      previous = parseRateLimitOverrides(await deps.readValuesRaw());
    } catch {
      return c.json({ error: "settings_unavailable" }, 503);
    }
    const next: Record<string, number> = { ...previous };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    const clean = parseRateLimitOverrides(next);
    await deps.writeValues(clean, userId);
    setRateLimitOverrides(clean);
    await deps.audit({
      userId,
      change: "pod_rate_limits.changed",
      data: { from: previous, to: clean },
    });
    return c.json(await view(userId));
  });

  return router;
}
