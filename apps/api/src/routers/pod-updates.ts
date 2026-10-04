/**
 * Pod updates — `/api/pod-updates/*`. The owner's auto-update setting (U3)
 * and the last update outcome (U4). Decisions live here; Postgres and the
 * file read are wired in `pod-updates-deps.ts`, so the tests drive the real
 * routes with fake dependencies.
 *
 *   GET /           session            → { settings, lastUpdate, canEdit }
 *   PUT /settings   session, pod admin → { auto?, channel? } → same shape
 *
 * The CP reads the same facts, without a session, from the `updates` section
 * of `GET /api/provision/status` (see `pod-updates/index.ts`).
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  buildPodUpdatesStatus,
  parseUpdateSettingsPatch,
  resolvePodUpdateSettings,
  type LastUpdateRead,
  type PodUpdateSettings,
} from "../pod-updates/index.js";

export interface PodUpdatesDeps {
  authenticate: MiddlewareHandler[];
  /** `users.id` for the session's identity, or null. */
  resolveUserId(identityId: string): Promise<string | null>;
  isPodAdmin(userId: string): Promise<boolean>;
  /** Raw `pod_settings.settings.updates`. Throws on a failed read. */
  readSettingsRaw(): Promise<unknown>;
  /** Persists the FULL effective setting (never a partial). */
  writeSettings(next: PodUpdateSettings): Promise<void>;
  readLastUpdate(): Promise<LastUpdateRead>;
  audit(entry: {
    userId: string;
    change: string;
    data?: Record<string, unknown>;
  }): Promise<void>;
}

export function createPodUpdatesRouter(deps: PodUpdatesDeps) {
  const router = new Hono();
  router.use("*", ...deps.authenticate);

  async function caller(c: Context) {
    const identityId = c.get("userId" as never) as string | undefined;
    if (!identityId) return null;
    return deps.resolveUserId(identityId);
  }

  async function view(userId: string) {
    const [status, canEdit] = await Promise.all([
      buildPodUpdatesStatus(deps),
      deps.isPodAdmin(userId),
    ]);
    return { ...status, canEdit };
  }

  router.get("/", async (c) => {
    const userId = await caller(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const body = await view(userId);
    // A failed settings read is a 503, never the default rendered as truth.
    if (body.settingsRead === "failed") {
      return c.json({ error: "settings_unavailable", ...body }, 503);
    }
    return c.json(body);
  });

  router.put("/settings", async (c) => {
    const patch = parseUpdateSettingsPatch(
      await c.req.json().catch(() => null)
    );
    if (!patch) return c.json({ error: "invalid_request" }, 400);
    const userId = await caller(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    if (!(await deps.isPodAdmin(userId))) {
      return c.json({ error: "forbidden" }, 403);
    }
    let previous;
    try {
      previous = resolvePodUpdateSettings(await deps.readSettingsRaw());
    } catch {
      return c.json({ error: "settings_unavailable" }, 503);
    }
    const next: PodUpdateSettings = {
      auto: patch.auto ?? previous.auto,
      channel: patch.channel ?? previous.channel,
    };
    await deps.writeSettings(next);
    await deps.audit({
      userId,
      change: "pod_updates.settings_changed",
      data: {
        from: { auto: previous.auto, channel: previous.channel },
        to: next,
      },
    });
    return c.json(await view(userId));
  });

  return router;
}
