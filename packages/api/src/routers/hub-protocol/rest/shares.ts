/**
 * Hub REST — Shares: the owner's share doors for agents and
 * other Hub callers.
 *
 *   GET  /shares?resourceType=…&resourceId=…   who a record is shared with
 *   GET  /shares?anchorProjectId=…             what a project shares
 *   GET  /shares/policy?workspaceId=…          effective exposure policy (owner)
 *   POST /shares                               share { resourceType, resourceId,
 *                                              anchorProjectId?, audience,
 *                                              expiresAt?, reasoning? }
 *   POST /shares/unshare                       { resourceType, resourceId,
 *                                              anchorProjectId? } — direct
 *   POST /shares/links/:id/revoke              revoke one link — direct;
 *                                              { removeGuests?: boolean }
 *                                              also removes the guests it
 *                                              admitted (default true; pass
 *                                              false to keep them)
 *   POST /shares/publish                       { resourceType, resourceId,
 *                                              reasoning? } — put a record on
 *                                              the public web; an agent
 *                                              key gets 202 proposed
 *   POST /shares/unpublish                     { resourceType, resourceId } —
 *                                              back to draft, direct
 *   POST /shares/publication/revoke            { resourceType, resourceId } —
 *                                              kill the public url for good
 *                                              direct
 *   GET  /shares/sites?projectId=…             a project's live site status
 *                                              (null when it has none)
 *   GET  /shares/sites/:id                     one site's status
 *   POST /shares/sites                         { projectId, homeWorkspaceId?,
 *                                              config, reasoning? } — create or
 *                                              configure a project's site; an
 *                                              agent key gets 202 proposed
 *   POST /shares/sites/:id/publish             { entityIds (≤ 200), reasoning? } —
 *                                              publish records INTO the site;
 *                                              an agent key gets ONE 202
 *                                              proposal for the batch
 *   POST /shares/sites/:id/unpublish           { entityIds? } — those records
 *                                              off this site, or (no body) the
 *                                              site back to draft — direct
 *   POST /shares/sites/:id/revoke              the site (and every member row)
 *                                              revoked for good — direct
 *
 * Every rule lives in `services/sharing/share-service.ts` (the same core the
 * tRPC `shares` router calls). An agent key's share is ALWAYS `status:
 * "proposed"` (HTTP 202 via `jsonGoverned`) — `share.create` is ADMIN-floored;
 * an approved agent link carries no token.
 *
 * DELIBERATELY ABSENT here: minting a link secret (`rotateLink`), redeeming one
 * (`redeemLink`), setting the policy (`setPolicy`), and putting a site live or
 * rotating its token (`publishSite`, `rotateSiteToken`). All of them are a
 * signed-in person's act (the core refuses agents and API keys), so a Hub route
 * for them would be a door nobody it serves may walk through.
 */

import { z } from "zod";
import type { Context } from "hono";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  type HubHono,
  type HubVariables,
} from "./_shared.js";
import { jsonGoverned } from "../proposal-response.js";
import {
  getExposurePolicy,
  listShares,
  revokeLink,
  shareResource,
  unshareResource,
  SHARE_AUDIENCES,
  type ShareActor,
} from "../../../services/sharing/share-service.js";
import { SHARE_KINDS } from "../../../services/sharing/exposure-policy.js";
import { registerShareExecutors } from "../../../services/sharing/share-executors.js";
import {
  configureSite,
  publishToSite,
  revokeSite,
  siteStatus,
  SITE_PUBLISH_MAX_RECORDS,
  unpublishFromSite,
} from "../../../services/sharing/site-service.js";
import {
  publishResource,
  revokePublication,
  unpublishResource,
} from "../../../services/sharing/publish-service.js";

registerShareExecutors();

const Uuid = z.string().uuid();
const Kind = z.enum(SHARE_KINDS);
const ShareSchema = z.object({
  resourceType: Kind,
  resourceId: Uuid,
  anchorProjectId: Uuid.optional(),
  audience: z.enum(SHARE_AUDIENCES),
  expiresAt: z.coerce.date().optional(),
  reasoning: z.string().max(2000).optional(),
});
const UnshareSchema = z.object({
  resourceType: Kind,
  resourceId: Uuid,
  anchorProjectId: Uuid.optional(),
});

const PublishSchema = z.object({
  resourceType: Kind,
  resourceId: Uuid,
  reasoning: z.string().max(2000).optional(),
});
const UnpublishSchema = z.object({ resourceType: Kind, resourceId: Uuid });
const RevokeLinkSchema = z.object({ removeGuests: z.boolean().optional() });
// The config is validated (strictly) by the site service, which owns its schema.
const ConfigureSiteSchema = z.object({
  projectId: Uuid,
  homeWorkspaceId: Uuid.optional(),
  config: z.unknown(),
  reasoning: z.string().max(2000).optional(),
});

const SiteRecordIds = z.array(Uuid).min(1).max(SITE_PUBLISH_MAX_RECORDS);
const PublishToSiteSchema = z.object({
  entityIds: SiteRecordIds,
  reasoning: z.string().max(2000).optional(),
});
const UnpublishFromSiteSchema = z.object({
  entityIds: SiteRecordIds.optional(),
});

type Ctx = Context<{ Variables: HubVariables }, any, any>;

/** An OPTIONAL JSON body: empty = `{}`; present but not JSON = null. */
async function optionalJson(c: Ctx): Promise<unknown> {
  const raw = await c.req.text().catch(() => "");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function actorOf(c: Ctx, reasoning?: string): ShareActor {
  return {
    userId: c.get("userId"),
    agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
    keyType: (c.get("keyType") as string | undefined) ?? null,
    source: "hub-rest",
    reasoning,
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

export function registerSharesRoutes(app: HubHono): void {
  // Static routes BEFORE any `/:id`.
  app.get("/shares/policy", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const ws = Uuid.safeParse(c.req.query("workspaceId"));
    if (!ws.success) {
      return c.json({ error: "workspaceId (uuid) is required" }, 400);
    }
    try {
      return c.json(await getExposurePolicy(actorOf(c), ws.data));
    } catch (err) {
      return fail(c, err, "GET /shares/policy");
    }
  });

  app.get("/shares/sites", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const project = Uuid.safeParse(c.req.query("projectId"));
    if (!project.success) {
      return c.json({ error: "projectId (uuid) is required" }, 400);
    }
    try {
      return c.json(await siteStatus(actorOf(c), { projectId: project.data }));
    } catch (err) {
      return fail(c, err, "GET /shares/sites");
    }
  });

  app.get("/shares/sites/:id", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid site id" }, 400);
    try {
      return c.json(await siteStatus(actorOf(c), { siteId: id.data }));
    } catch (err) {
      return fail(c, err, "GET /shares/sites/:id");
    }
  });

  app.post("/shares/sites", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = ConfigureSiteSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const { reasoning, homeWorkspaceId, ...rest } = body.data;
      return jsonGoverned(
        c,
        await configureSite(actorOf(c, reasoning), {
          ...rest,
          homeWorkspaceId: homeWorkspaceId ?? null,
        })
      );
    } catch (err) {
      return fail(c, err, "POST /shares/sites");
    }
  });

  app.post("/shares/sites/:id/publish", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid site id" }, 400);
    const body = PublishToSiteSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const { reasoning, entityIds } = body.data;
      return jsonGoverned(
        c,
        await publishToSite(actorOf(c, reasoning), {
          siteId: id.data,
          entityIds,
        })
      );
    } catch (err) {
      return fail(c, err, "POST /shares/sites/:id/publish");
    }
  });

  app.post("/shares/sites/:id/unpublish", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid site id" }, 400);
    const raw = await optionalJson(c);
    if (raw === null) return c.json({ error: "Body must be JSON" }, 400);
    const body = UnpublishFromSiteSchema.safeParse(raw);
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      return c.json(
        await unpublishFromSite(actorOf(c), {
          siteId: id.data,
          entityIds: body.data.entityIds,
        })
      );
    } catch (err) {
      return fail(c, err, "POST /shares/sites/:id/unpublish");
    }
  });

  app.post("/shares/sites/:id/revoke", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid site id" }, 400);
    try {
      return c.json(await revokeSite(actorOf(c), id.data));
    } catch (err) {
      return fail(c, err, "POST /shares/sites/:id/revoke");
    }
  });

  app.get("/shares", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const anchor = Uuid.safeParse(c.req.query("anchorProjectId"));
    const kind = Kind.safeParse(c.req.query("resourceType"));
    const id = Uuid.safeParse(c.req.query("resourceId"));
    try {
      if (anchor.success) {
        return c.json(
          await listShares(actorOf(c), { anchorProjectId: anchor.data })
        );
      }
      if (kind.success && id.success) {
        return c.json(
          await listShares(actorOf(c), {
            resourceType: kind.data,
            resourceId: id.data,
          })
        );
      }
      return c.json(
        {
          error: "Pass anchorProjectId, or resourceType + resourceId (uuid).",
        },
        400
      );
    } catch (err) {
      return fail(c, err, "GET /shares");
    }
  });

  app.post("/shares/unshare", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = UnshareSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      return c.json(await unshareResource(actorOf(c), body.data));
    } catch (err) {
      return fail(c, err, "POST /shares/unshare");
    }
  });

  app.post("/shares/links/:id/revoke", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid share id" }, 400);
    const raw = await c.req.text().catch(() => "");
    let parsedBody: unknown = {};
    if (raw.trim()) {
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        return c.json({ error: "Body must be JSON" }, 400);
      }
    }
    const body = RevokeLinkSchema.safeParse(parsedBody);
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      return c.json(
        await revokeLink(actorOf(c), id.data, {
          // The default lives in the core (`revokeLink`): undefined = remove.
          removeGuests: body.data.removeGuests,
        })
      );
    } catch (err) {
      return fail(c, err, "POST /shares/links/:id/revoke");
    }
  });

  app.post("/shares/publish", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = PublishSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const { reasoning, ...rest } = body.data;
      return jsonGoverned(
        c,
        await publishResource(actorOf(c, reasoning), rest)
      );
    } catch (err) {
      return fail(c, err, "POST /shares/publish");
    }
  });

  app.post("/shares/unpublish", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = UnpublishSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      return c.json(await unpublishResource(actorOf(c), body.data));
    } catch (err) {
      return fail(c, err, "POST /shares/unpublish");
    }
  });

  app.post("/shares/publication/revoke", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = UnpublishSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      return c.json(await revokePublication(actorOf(c), body.data));
    } catch (err) {
      return fail(c, err, "POST /shares/publication/revoke");
    }
  });

  app.post("/shares", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = ShareSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const { reasoning, expiresAt, ...rest } = body.data;
      return jsonGoverned(
        c,
        await shareResource(actorOf(c, reasoning), {
          ...rest,
          expiresAt: expiresAt ?? null,
        })
      );
    } catch (err) {
      return fail(c, err, "POST /shares");
    }
  });
}
