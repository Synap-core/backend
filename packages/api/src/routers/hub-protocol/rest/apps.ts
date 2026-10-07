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
 * WIRE CONTRACT (pinned — the shipped CLI, synap-cli c5d6cfa, calls these):
 *   - `:id` in /apps/:id and its sub-routes is the app's PUBLIC id (`app_<uuid>`),
 *     NOT the uuid primary key.
 *   - The app object is serialized snake_case: the CLI reads `app.public_id`.
 *   - POST /apps/:id/key returns `{ apiKey, keyId }` (plaintext ONCE).
 *
 * Naming (locked): the object is an Application; the authorization is a grant;
 * the bearer is an API key.
 *
 * All rules live in `AppRepository` (the ONE write door) and the canonical
 * primitives: the mint is `ApiKeyRepository.create` + `attachGrantOrRevoke`
 * (GrantRepository); revoke is `revokeApiKeys` + `GrantRepository.revokeForKeys`
 * (a superseded or revoked key's grant is revoked in the same act, so a rotated
 * key never leaves an active grant). The `app/connect` door ALWAYS
 * proposes — it files through `createPendingProposal` (NOT
 * `checkPermissionOrPropose`), because the gate ladder can answer `granted` for
 * an agent and a granted connect would auto-authorize reach with no review.
 *
 * Guardrail: `apps.public_id` is the app's id AND the `client_id` its grant
 * carries — the `/key` mint passes it verbatim as `clientId`.
 */

import { z } from "zod";
import { randomBytes } from "crypto";
import type { Context } from "hono";
import {
  db,
  inArray,
  ApiKeyRepository,
  AppRepository,
  EventRepository,
  GrantRepository,
  sql,
} from "@synap/database";
import { apiKeys, workspaces, KEY_PREFIXES } from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import {
  assertPermissions,
  InvalidPermissionError,
} from "@synap/governance-policy/grants";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  getUserAccessibleWorkspaceIds,
  type HubHono,
  type HubVariables,
} from "./_shared.js";
import { createPendingProposal } from "../../../utils/permission-check.js";
import { openLink } from "../../../utils/deep-links.js";
import { attachGrantOrRevoke } from "../../../services/key-grant.js";

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

/** The wire shape of an app — snake_case, the fields the CLI + UI read. */
function serializeApp(record: {
  id: string;
  publicId: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  mode: string;
  approvedRequests: unknown;
  createdAt: Date;
  revokedAt: Date | null;
}) {
  return {
    id: record.id,
    public_id: record.publicId,
    name: record.name,
    description: record.description,
    logo_url: record.logoUrl,
    mode: record.mode,
    approved_requests: record.approvedRequests ?? null,
    created_at: record.createdAt,
    revoked_at: record.revokedAt,
  };
}

function fail(c: Ctx, err: unknown, what: string) {
  const status = httpStatusForTrpcError(err);
  if (status === 500) logger.error({ err }, `${what} failed`);
  return c.json(
    { error: err instanceof Error ? err.message : `${what} failed` },
    status
  );
}

/** Validate the permission grammar at the door (400), like the grant door. */
function assertRequestPermissions(
  requests: Array<{ permission: string }>
): void {
  try {
    assertPermissions(requests.map((r) => r.permission));
  } catch (err) {
    if (err instanceof InvalidPermissionError) {
      throw Object.assign(new Error(err.message), { code: "BAD_REQUEST" });
    }
    throw err;
  }
}

/**
 * Resolve each request's workspace NAME to an id, from the workspaces the
 * caller can reach. An unknown name fails LOUD (never a silent drop).
 */
async function resolveRequests(
  userId: string,
  requests: Array<{ permission: string; workspace: string }>
): Promise<Array<{ permission: string; workspaceId: string }>> {
  assertRequestPermissions(requests);
  const workspaceIds = await getUserAccessibleWorkspaceIds(userId);
  const rows =
    workspaceIds.length > 0
      ? await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(inArray(workspaces.id, workspaceIds))
      : [];
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  return requests.map((r) => {
    const id = byName.get(r.workspace.toLowerCase());
    if (!id) {
      throw Object.assign(
        new Error(
          `Unknown workspace "${r.workspace}" — no workspace of that name is visible to you.`
        ),
        { code: "BAD_REQUEST" }
      );
    }
    return { permission: r.permission, workspaceId: id };
  });
}

function generatePlainKey(): string {
  return `${KEY_PREFIXES.USER}${randomBytes(32).toString("hex")}`;
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
      // Unset fields stay `undefined` so `register` leaves them alone — an agent
      // re-registering a name it already uses must not blank the description.
      const record = await new AppRepository(db).register({
        ownerUserId: userId,
        name: body.data.name,
        description: body.data.description ?? undefined,
        logoUrl: body.data.logoUrl ?? undefined,
        mode: body.data.mode ?? undefined,
      });
      return c.json({ app: serializeApp(record) }, 201);
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
      return c.json({
        apps: rows.map((r) => ({
          ...serializeApp(r.app),
          last_used_at: r.lastUsedAt,
          grants: r.grants,
        })),
      });
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
    const publicId = c.req.param("id");
    try {
      const repo = new AppRepository(db);
      const found = await repo.getByPublicId(publicId);
      if (!found || found.app.ownerUserId !== userId) {
        return c.json({ error: "App not found" }, 404);
      }
      return c.json({
        ...serializeApp(found.app),
        last_used_at: found.lastUsedAt,
        grants: found.grants,
      });
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
    const publicId = c.req.param("id");
    const body = ConnectBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const repo = new AppRepository(db);
      const found = await repo.getByPublicId(publicId);
      if (!found || found.app.ownerUserId !== userId) {
        return c.json({ error: "App not found" }, 404);
      }
      const appRow = found.app;
      // Revoked is terminal: a revoked app is gone from every surface, so it
      // must not file a new request. Re-register (which clears revoked_at) to
      // bring it back.
      if (appRow.revokedAt) {
        return c.json(
          { error: "This app was revoked — register it again to reconnect." },
          409
        );
      }
      const requests = await resolveRequests(userId, body.data.requests);
      const proposal = await createPendingProposal({
        userId,
        workspaceId: null,
        targetType: "app",
        targetId: appRow.id,
        proposalType: "connect",
        data: {
          appId: appRow.id,
          publicId: appRow.publicId,
          name: appRow.name,
          requests,
        },
        createdBy: userId,
        proposedByUserId: userId,
        notificationDescription: `${appRow.name} is asking for access`,
      });
      return c.json(
        { proposalId: proposal.id, reviewUrl: openLink(proposal.id) },
        201
      );
    } catch (err) {
      return fail(c, err, "POST /apps/:id/connect");
    }
  });

  // ── POST /apps/:id/key — mint AFTER approval (human only) ─────────────────
  app.post("/apps/:id/key", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    // A key mint is a credential act of a signed-in human, never an agent.
    if (c.get("agentUserId")) {
      return c.json(
        {
          error:
            "An agent credential cannot mint an app key — sign in as the app's owner.",
        },
        403
      );
    }
    const publicId = c.req.param("id");
    try {
      const repo = new AppRepository(db);
      const found = await repo.getByPublicId(publicId);
      if (!found || found.app.ownerUserId !== userId) {
        return c.json({ error: "App not found" }, 404);
      }
      const appRow = found.app;
      // Revoked is terminal — never mint a live key for an app the UI hides.
      if (appRow.revokedAt) {
        return c.json(
          { error: "This app was revoked — register it again to reconnect." },
          409
        );
      }
      const approved = appRow.approvedRequests ?? [];
      if (approved.length === 0) {
        return c.json(
          {
            error:
              "This app has no approved requests yet — connect it and approve the request first.",
          },
          409
        );
      }

      // Rotate: revoke every key already bound to this app (its grants stop
      // resolving the moment the key is inactive) AND revoke those keys' grants
      // at the ONE grant write door, so a superseded key never leaves an active
      // grant behind (the app "Can:" line counts reach only from an active key,
      // which is exactly what hid the stale grant).
      const existingKeyIds = await repo.keyIdsFor(appRow.publicId);
      if (existingKeyIds.length > 0) {
        await new GrantRepository(db).revokeForKeys(existingKeyIds, userId);
        await revokeApiKeys(db, {
          where: inArray(apiKeys.id, existingKeyIds),
          revokedBy: userId,
          reason: `Rotated by a new app key for ${appRow.name}`,
        });
      }

      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(db, eventRepo);
      const plaintext = generatePlainKey();
      const keyRow = await apiKeyRepo.create(
        {
          keyName: `${appRow.name} (app)`,
          keyPrefix: KEY_PREFIXES.USER,
          key: plaintext,
          scope: ["hub-protocol.read", "hub-protocol.write"],
          // Apps are long-lived; the grant is the bound, not the clock.
          userId,
          keyType: "user_pat",
          description: `App key for ${appRow.name} (${appRow.publicId})`,
        },
        userId
      );

      await attachGrantOrRevoke({
        apiKeyId: keyRow.id,
        principalUserId: userId,
        onBehalfOf: userId,
        grant: {
          permissions: approved.map((r) => r.permission),
          workspaceIds: approved.map((r) => r.workspaceId),
        },
        expiresAt: null,
        createdBy: userId,
        clientId: appRow.publicId,
      });

      return c.json({ apiKey: plaintext, keyId: keyRow.id });
    } catch (err) {
      return fail(c, err, "POST /apps/:id/key");
    }
  });

  // ── DELETE /apps/:id — revoke the app (and its keys) ──────────────────────
  app.delete("/apps/:id", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const publicId = c.req.param("id");
    try {
      const repo = new AppRepository(db);
      const found = await repo.getByPublicId(publicId);
      if (!found || found.app.ownerUserId !== userId) {
        return c.json({ error: "App not found" }, 404);
      }
      const keyIds = await repo.keyIdsFor(found.app.publicId);
      if (keyIds.length > 0) {
        // Revoke the keys' grants too (the ONE grant write door), so revoking
        // the app cannot leave an active grant behind.
        await new GrantRepository(db).revokeForKeys(keyIds, userId);
        await revokeApiKeys(db, {
          where: inArray(apiKeys.id, keyIds),
          revokedBy: userId,
          reason: `App revoked: ${found.app.name}`,
        });
      }
      await repo.revoke(found.app.id);
      return c.json({ revoked: true, public_id: found.app.publicId });
    } catch (err) {
      return fail(c, err, "DELETE /apps/:id");
    }
  });
}
