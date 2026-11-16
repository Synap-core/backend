/**
 * Hub REST — Apps (App Connect v1, 2026-10-06).
 *
 *   POST   /apps               register/upsert an app for the caller's user → { app }
 *   GET    /apps               the caller's apps WITH their grants (what each may touch)
 *   GET    /apps/:id           one app + its grants (owner-floored)
 *   POST   /apps/:id/connect   { requests } → ONE proposal → { proposalId, reviewUrl }
 *   POST   /apps/:id/key       AFTER approval: mint a fresh key + grant, plaintext ONCE
 *   PUT    /apps/:id/redirect-uris  { redirectUris } — where a person's "Sign in
 *                              with Synap" code may go (owner only) → { app }
 *   DELETE /apps/:id           revoke the app (revokes its keys → its grants)
 *
 * A pod app asks its person for ONE MORE thing (plan 647ebfd4 option C), with
 * its OWN token (the grant names the app); `services/app-access-ask.ts`:
 *   POST   /apps/access-requests      { requests, reason? } → the ask (or what
 *                                     each pair already is: given, open, quiet)
 *   GET    /apps/access-requests/:id  pending / allowed / declined / expired
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
import { db, AppRepository, getRequestGrant } from "@synap/database";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  requireAppPublicIdParam,
  requireUuidParam,
  type HubHono,
  type HubVariables,
  refuseStaleDeviceSession,
} from "./_shared.js";
import { gateHubTwin, refusalBody } from "./_presence.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  AccessAskBodySchema,
  AccessAskParamsSchema,
  AccessAskReceiptSchema,
  AccessAskViewSchema,
} from "./_codecs/app-access-ask.js";
import {
  fileAppAccessAsk,
  readAppAccessAsk,
} from "../../../services/app-access-ask.js";
import {
  issueKey,
  loadOwnedApp,
  narrowApp,
  podAppViews,
  registerApp,
  requestAccess,
  revokeApp,
  serializeApp,
  setAppRedirectUris,
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

/**
 * POST /apps/:id/narrow — the (permission, space) pairs the app KEEPS; a null
 * space is a pod-wide read it was approved (decision e1b59d38 "B").
 */
const NarrowBody = z.object({
  approved: z
    .array(
      z.object({
        permission: z.string().min(1).max(120),
        workspaceId: z.string().uuid().nullable(),
      })
    )
    .min(1)
    .max(64),
});

const WriteModeBody = z.object({ applyAutomatically: z.boolean() });

const RedirectUrisBody = z.object({
  redirectUris: z.array(z.string().min(1).max(2048)).max(8),
});

/** A JSON body as an object (anything else is no body). */
function asBody(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function fail(c: Ctx, err: unknown, what: string) {
  const status = httpStatusForTrpcError(err);
  if (status === 500) logger.error({ err }, `${what} failed`);
  return c.json(refusalBody(err, `${what} failed`), status);
}

/**
 * An app's own token asks with either Hub scope: a read-only app must be able
 * to ask for its first write. The ask grants nothing until its person allows it.
 */
function canAsk(c: Ctx): boolean {
  const scopes = c.get("scopes");
  return (
    hasScope(scopes, "hub-protocol.read") ||
    hasScope(scopes, "hub-protocol.write")
  );
}

export function registerAppsRoutes(app: HubHono): void {
  // ── An app's ask for one more thing (static, BEFORE /apps/:id) ────────────
  registerOpenApi(app, {
    method: "post",
    path: "/apps/access-requests",
    tags: ["Apps"],
    summary: "A pod app asks its person for one more thing",
    description:
      "With the app's own token. Each pair is a permission the app's client-id document declares, in one space (by id or by the template it was made from) the person may give it. " +
      "Files ONE ask the person answers from a card; allowing it ADDS the pairs to what the app holds. " +
      "A pair the app already holds, already asked for, or that the person declined less than 30 days ago is not asked again. An ask waits 7 days.",
    request: { body: AccessAskBodySchema },
    responses: {
      201: { description: "The ask, filed", schema: AccessAskReceiptSchema },
      200: {
        description: "Nothing new to ask: each pair's state",
        schema: AccessAskReceiptSchema,
      },
      400: { description: "Invalid body", schema: ErrorSchema },
      403: {
        description:
          "Not a pod app's own token (NOT_A_POD_APP), a permission its document does not declare (ASK_NOT_DECLARED), or a space the person cannot give it (ASK_NOT_ON_OFFER)",
        schema: ErrorSchema,
      },
    },
  });
  app.post("/apps/access-requests", async (c) => {
    if (!canAsk(c)) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const body = AccessAskBodySchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const receipt = await fileAppAccessAsk({
        publicId: getRequestGrant()?.clientId,
        callerUserId: userId,
        agentUserId: c.get("agentUserId") as string | undefined,
        pairs: body.data.requests,
        reason: body.data.reason ?? null,
      });
      return c.json(receipt, receipt.id ? 201 : 200);
    } catch (err) {
      return fail(c, err, "POST /apps/access-requests");
    }
  });

  registerOpenApi(app, {
    method: "get",
    path: "/apps/access-requests/{id}",
    tags: ["Apps"],
    summary: "What became of an app's ask",
    description:
      "With the app's own token: pending, allowed, declined (Not now) or expired. An app reads only its own asks.",
    request: { params: AccessAskParamsSchema },
    responses: {
      200: { description: "The ask", schema: AccessAskViewSchema },
      400: { description: "Invalid id", schema: ErrorSchema },
      403: { description: "Not a pod app's own token", schema: ErrorSchema },
      404: { description: "No such ask of this app", schema: ErrorSchema },
    },
  });
  app.get("/apps/access-requests/:id", async (c) => {
    if (!canAsk(c)) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const askId = requireUuidParam(c, "id");
    if (askId instanceof Response) return askId;
    try {
      return c.json(
        await readAppAccessAsk({
          publicId: getRequestGrant()?.clientId,
          callerUserId: userId,
          askId,
        })
      );
    } catch (err) {
      return fail(c, err, "GET /apps/access-requests/:id");
    }
  });

  // ── POST /apps — register/upsert (idempotent by owner+name) ───────────────
  app.post("/apps", async (c) => {
    const stale = refuseStaleDeviceSession(c);
    if (stale) return stale;
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
    const appId = requireAppPublicIdParam(c, "id");
    if (appId instanceof Response) return appId;
    try {
      return c.json(serializeApp(await loadOwnedApp(appId, userId)));
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
    const appId = requireAppPublicIdParam(c, "id");
    if (appId instanceof Response) return appId;
    const body = ConnectBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const result = await requestAccess({
        publicId: appId,
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
    const stale = refuseStaleDeviceSession(c);
    if (stale) return stale;
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const appId = requireAppPublicIdParam(c, "id");
    if (appId instanceof Response) return appId;
    const raw = await c.req.json().catch(() => null);
    const pass = await gateHubTwin(c, {
      action: "apps.issueKey",
      input: { ...asBody(raw), publicId: appId },
      door: "POST /apps/:id/key",
    });
    if (pass instanceof Response) return pass;
    try {
      return c.json(
        await issueKey({
          publicId: appId,
          ownerUserId: userId,
          actorAgentUserId: c.get("agentUserId") as string | undefined,
          actorKeyType: c.get("keyType") as string | undefined,
          via: "cli",
          presence: pass,
        })
      );
    } catch (err) {
      return fail(c, err, "POST /apps/:id/key");
    }
  });

  // ── PUT /apps/:id/redirect-uris — where sign-in codes go (the owner) ──────
  app.put("/apps/:id/redirect-uris", async (c) => {
    const stale = refuseStaleDeviceSession(c);
    if (stale) return stale;
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const appId = requireAppPublicIdParam(c, "id");
    if (appId instanceof Response) return appId;
    const raw = await c.req.json().catch(() => null);
    const body = RedirectUrisBody.safeParse(raw);
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    const pass = await gateHubTwin(c, {
      action: "apps.setRedirectUris",
      input: { ...asBody(raw), publicId: appId },
      door: "PUT /apps/:id/redirect-uris",
    });
    if (pass instanceof Response) return pass;
    try {
      const found = await setAppRedirectUris({
        publicId: appId,
        ownerUserId: userId,
        redirectUris: body.data.redirectUris,
        actorAgentUserId: c.get("agentUserId") as string | undefined,
        actorKeyType: c.get("keyType") as string | undefined,
        presence: pass,
      });
      return c.json({ app: serializeApp(found) });
    } catch (err) {
      return fail(c, err, "PUT /apps/:id/redirect-uris");
    }
  });

  // ── DELETE /apps/:id — revoke the app (the owner, never an agent) ─────────
  app.delete("/apps/:id", async (c) => {
    const stale = refuseStaleDeviceSession(c);
    if (stale) return stale;
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const appId = requireAppPublicIdParam(c, "id");
    if (appId instanceof Response) return appId;
    try {
      const { publicId } = await revokeApp({
        publicId: appId,
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
    const stale = refuseStaleDeviceSession(c);
    if (stale) return stale;
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const appId = requireAppPublicIdParam(c, "id");
    if (appId instanceof Response) return appId;
    const body = NarrowBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const found = await narrowApp({
        publicId: appId,
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
    const stale = refuseStaleDeviceSession(c);
    if (stale) return stale;
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const appId = requireAppPublicIdParam(c, "id");
    if (appId instanceof Response) return appId;
    const raw = await c.req.json().catch(() => null);
    const body = WriteModeBody.safeParse(raw);
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    const pass = await gateHubTwin(c, {
      action: "apps.setWriteMode",
      input: { ...asBody(raw), publicId: appId },
      door: "PUT /apps/:id/write-mode",
    });
    if (pass instanceof Response) return pass;
    try {
      return c.json(
        await setAppWriteMode({
          publicId: appId,
          ownerUserId: userId,
          applyAutomatically: body.data.applyAutomatically,
          actorAgentUserId: c.get("agentUserId") as string | undefined,
          actorKeyType: c.get("keyType") as string | undefined,
          presence: pass,
        })
      );
    } catch (err) {
      return fail(c, err, "PUT /apps/:id/write-mode");
    }
  });
}
