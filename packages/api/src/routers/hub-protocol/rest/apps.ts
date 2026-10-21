/**
 * Hub REST — Apps (App Connect v1, 2026-10-06).
 *
 *   POST   /apps               register/upsert an app for the caller's user → { app }
 *   GET    /apps               the caller's apps WITH their grants (what each may touch)
 *   GET    /apps/:id           one app + its grants (owner-floored)
 *   POST   /apps/:id/connect   { requests } → ONE proposal → { proposalId, reviewUrl }
 *   POST   /apps/:id/key       AFTER approval: mint a fresh key + grant, plaintext ONCE
 *   DELETE /apps/:id           revoke the app (revokes its keys → its grants)
 *
 * Pod apps (spec 17 PB4) — the connections manager the browser/settings call:
 *   GET    /pod-apps             the caller's pod app connections: each app row
 *                                plus `pod_app` (domain, tier, approval per
 *                                space, connected / last used, write mode)
 *   POST   /apps/:id/narrow      { approved } = the pairs it KEEPS → { app }
 *   PUT    /apps/:id/write-mode  { applyAutomatically } → the write mode
 *   (revoke = DELETE /apps/:id: keys, refresh families, codes, webhooks)
 * Narrow and write mode are the owner's own acts: an agent's credential or a
 * scoped key is refused (`assertOwnerCredential`).
 *
 * WIRE CONTRACT (pinned — the shipped CLI, synap-cli c5d6cfa, calls these):
 *   - `:id` in /apps/:id and its sub-routes is the app's PUBLIC id (`app_<uuid>`),
 *     NOT the uuid primary key.
 *   - The app object is serialized snake_case: the CLI reads `app.public_id`.
 *   - POST /apps/:id/key returns `{ apiKey, keyId }` (plaintext ONCE).
 *
 * Naming (locked): the object is an Application; the authorization is a grant;
 * the bearer is an API key.
 *
 * Every rule lives in ONE service, `services/app-connect.ts` (shared with the
 * tRPC `apps.*` door): request access, issue key, revoke. This file only
 * authenticates, parses and maps errors to HTTP statuses.
 */

import { z } from "zod";
import type { Context } from "hono";
import { db, AppRepository } from "@synap/database";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  type HubHono,
  type HubVariables,
} from "./_shared.js";
import {
  issueKey,
  loadOwnedApp,
  narrowApp,
  podAppViews,
  registerApp,
  requestAccess,
  revokeApp,
  serializeApp,
  setAppWriteMode,
} from "../../../services/app-connect.js";

type Ctx = Context<{ Variables: HubVariables }, any, any>;

/** A request as the CLI sends it: a permission + a workspace NAME. */
const RequestSchema = z.object({
  permission: z.string().min(1).max(120),
  workspace: z.string().min(1).max(200),
});

const RegisterBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  logoUrl: z.string().max(2048).optional().nullable(),
  // One mode is implemented (`AppMode = "specific"`); a bounded free string
  // stored whatever a caller sent into a column nothing renders.
  mode: z.literal("specific").optional().nullable(),
});

const ConnectBody = z.object({
  requests: z.array(RequestSchema).min(1).max(64),
});

/** POST /apps/:id/narrow — the (permission, space) pairs the app KEEPS. */
const NarrowBody = z.object({
  approved: z
    .array(
      z.object({
        permission: z.string().min(1).max(120),
        workspaceId: z.string().uuid(),
      })
    )
    .min(1)
    .max(64),
});

const WriteModeBody = z.object({ applyAutomatically: z.boolean() });

function fail(c: Ctx, err: unknown, what: string) {
  const status = httpStatusForTrpcError(err);
  if (status === 500) logger.error({ err }, `${what} failed`);
  return c.json(
    { error: err instanceof Error ? err.message : `${what} failed` },
    status
  );
}

export function registerAppsRoutes(app: HubHono): void {
  // ── POST /apps — register/upsert (idempotent by owner+name) ───────────────
  app.post("/apps", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const body = RegisterBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      // Unset fields stay `undefined` so `register` leaves them alone — a
      // re-register of a name already in use must not blank the description.
      // Answers through the ONE projection, the same shape as every read.
      const found = await registerApp({
        ownerUserId: userId,
        name: body.data.name,
        description: body.data.description ?? undefined,
        logoUrl: body.data.logoUrl ?? undefined,
        mode: body.data.mode ?? undefined,
        actorAgentUserId: c.get("agentUserId") as string | undefined,
        actorKeyType: c.get("keyType") as string | undefined,
      });
      return c.json({ app: serializeApp(found) }, 201);
    } catch (err) {
      return fail(c, err, "POST /apps");
    }
  });

  // ── GET /apps — the caller's apps + their grants ──────────────────────────
  app.get("/apps", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    try {
      const rows = await new AppRepository(db).listForOwner(userId);
      return c.json({ apps: rows.map(serializeApp) });
    } catch (err) {
      return fail(c, err, "GET /apps");
    }
  });

  // ── GET /apps/:id — one app + its grants (owner-floored) ──────────────────
  app.get("/apps/:id", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    try {
      return c.json(
        serializeApp(await loadOwnedApp(c.req.param("id"), userId))
      );
    } catch (err) {
      return fail(c, err, "GET /apps/:id");
    }
  });

  // ── POST /apps/:id/connect — file ONE proposal (always) ───────────────────
  app.post("/apps/:id/connect", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const body = ConnectBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const result = await requestAccess({
        publicId: c.req.param("id"),
        ownerUserId: userId,
        requests: body.data.requests,
        actorAgentUserId: c.get("agentUserId") as string | undefined,
      });
      return c.json(result, 201);
    } catch (err) {
      return fail(c, err, "POST /apps/:id/connect");
    }
  });

  // ── POST /apps/:id/key — mint AFTER approval (the owner, never an agent) ──
  app.post("/apps/:id/key", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    try {
      return c.json(
        await issueKey({
          publicId: c.req.param("id"),
          ownerUserId: userId,
          actorAgentUserId: c.get("agentUserId") as string | undefined,
          actorKeyType: c.get("keyType") as string | undefined,
          via: "cli",
        })
      );
    } catch (err) {
      return fail(c, err, "POST /apps/:id/key");
    }
  });

  // ── DELETE /apps/:id — revoke the app (the owner, never an agent) ─────────
  app.delete("/apps/:id", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    try {
      const { publicId } = await revokeApp({
        publicId: c.req.param("id"),
        ownerUserId: userId,
        actorAgentUserId: c.get("agentUserId") as string | undefined,
        actorKeyType: c.get("keyType") as string | undefined,
      });
      return c.json({ revoked: true, public_id: publicId });
    } catch (err) {
      return fail(c, err, "DELETE /apps/:id");
    }
  });

  // ── GET /pod-apps — the caller's pod app connections (PB4) ────────────────
  app.get("/pod-apps", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    try {
      const repo = new AppRepository(db);
      const rows = (
        await repo.listForOwner(userId, { includeRevoked: true })
      ).filter((r) => r.app.mode === "oauth");
      const keys = await repo.keysByApp(rows.map((r) => r.app.publicId));
      const pod = await podAppViews(rows, keys);
      return c.json({
        apps: rows.map((row) => ({
          ...serializeApp(row),
          pod_app: pod.get(row.app.publicId) ?? null,
        })),
      });
    } catch (err) {
      return fail(c, err, "GET /pod-apps");
    }
  });

  // ── POST /apps/:id/narrow — keep only some of the approval (the owner) ────
  app.post("/apps/:id/narrow", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const body = NarrowBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const found = await narrowApp({
        publicId: c.req.param("id"),
        ownerUserId: userId,
        approved: body.data.approved,
        actorAgentUserId: c.get("agentUserId") as string | undefined,
        actorKeyType: c.get("keyType") as string | undefined,
      });
      return c.json({ app: serializeApp(found) });
    } catch (err) {
      return fail(c, err, "POST /apps/:id/narrow");
    }
  });

  // ── PUT /apps/:id/write-mode — "apply automatically" (the owner, F6) ─────
  app.put("/apps/:id/write-mode", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const body = WriteModeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      return c.json(
        await setAppWriteMode({
          publicId: c.req.param("id"),
          ownerUserId: userId,
          applyAutomatically: body.data.applyAutomatically,
          actorAgentUserId: c.get("agentUserId") as string | undefined,
          actorKeyType: c.get("keyType") as string | undefined,
        })
      );
    } catch (err) {
      return fail(c, err, "PUT /apps/:id/write-mode");
    }
  });
}
