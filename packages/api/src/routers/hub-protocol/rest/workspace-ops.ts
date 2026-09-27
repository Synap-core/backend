/**
 * Hub Protocol REST — governed workspace operations (R8a).
 *
 *   POST  /workspaces/:workspaceId/archive   { restore?, reasoning? }
 *   POST  /workspaces/:workspaceId/restore   { reasoning? }
 *   PATCH /workspaces/:workspaceId           { name?, description? }
 *   POST  /entities/move                     { entityIds[], workspaceId, reason? }
 *   POST  /profiles/grant-access             { profileId, targetWorkspaceId, workspaceId?, reasoning? }
 *
 * Thin: each route validates the wire shape, resolves the acting user, and
 * forwards to `services/workspace-ops-doors.ts` — which forwards to the
 * governed tRPC procedure. An agent key gets `202 { status: "proposed" }`
 * (`jsonGoverned`); a human owner gets the applied result.
 */

import { z } from "zod";
import type { Context } from "hono";
import {
  archiveWorkspaceDoor,
  grantProfileAccessDoor,
  moveEntitiesDoor,
  renameWorkspaceDoor,
  type WorkspaceOpsActor,
} from "../../../services/workspace-ops-doors.js";
import { jsonGoverned } from "../proposal-response.js";
import {
  hasScope,
  httpStatusForTrpcError,
  isUuid,
  logger,
  resolveActingContext,
  type HubHono,
  type HubVariables,
} from "./_shared.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = Context<{ Variables: HubVariables }, any>;

const reasoning = z.string().max(2000).optional();

async function readJson(c: Ctx): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** Scope + acting user, or the error response to return. */
async function actorFor(
  c: Ctx
): Promise<
  { ok: true; actor: WorkspaceOpsActor } | { ok: false; res: Response }
> {
  const scopes = (c.get("scopes") as string[] | undefined) ?? [];
  if (!hasScope(scopes, "hub-protocol.write")) {
    return {
      ok: false,
      res: c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      ),
    };
  }
  const acting = await resolveActingContext(c, {});
  if (!acting.ok) {
    return { ok: false, res: c.json({ error: acting.error }, acting.status) };
  }
  return {
    ok: true,
    actor: {
      userId: acting.userId,
      scopes,
      agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
      sessionId: (c.get("sessionId") as string | undefined) ?? null,
      keyType: (c.get("keyType") as string | undefined) ?? null,
      keyWorkspaceId: (c.get("keyWorkspaceId") as string | undefined) ?? null,
    },
  };
}

function failure(c: Ctx, err: unknown, what: string) {
  logger.warn({ err }, `${what} failed`);
  return c.json(
    { error: err instanceof Error ? err.message : "Unknown error" },
    httpStatusForTrpcError(err)
  );
}

export function registerWorkspaceOpsRoutes(app: HubHono): void {
  const archiveOrRestore = (forceRestore: boolean) => async (c: Ctx) => {
    const a = await actorFor(c);
    if (!a.ok) return a.res;
    const workspaceId = c.req.param("workspaceId") ?? "";
    if (!isUuid(workspaceId)) {
      return c.json({ error: "workspaceId must be a UUID" }, 400);
    }
    const parsed = z
      .object({ restore: z.boolean().optional(), reasoning })
      .safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }
    try {
      const result = await archiveWorkspaceDoor(a.actor, {
        workspaceId,
        restore: forceRestore || parsed.data.restore === true,
        reasoning: parsed.data.reasoning,
      });
      return jsonGoverned(c, result);
    } catch (err) {
      return failure(c, err, "workspace archive");
    }
  };

  app.post("/workspaces/:workspaceId/archive", archiveOrRestore(false));
  app.post("/workspaces/:workspaceId/restore", archiveOrRestore(true));

  app.patch("/workspaces/:workspaceId", async (c) => {
    const a = await actorFor(c);
    if (!a.ok) return a.res;
    const workspaceId = c.req.param("workspaceId") ?? "";
    if (!isUuid(workspaceId)) {
      return c.json({ error: "workspaceId must be a UUID" }, 400);
    }
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().max(2000).optional(),
      })
      .safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }
    try {
      const result = await renameWorkspaceDoor(a.actor, {
        workspaceId,
        ...parsed.data,
      });
      return jsonGoverned(c, result);
    } catch (err) {
      return failure(c, err, "workspace rename");
    }
  });

  app.post("/entities/move", async (c) => {
    const a = await actorFor(c);
    if (!a.ok) return a.res;
    const parsed = z
      .object({
        entityIds: z.array(z.string().uuid()).min(1).max(500),
        workspaceId: z.string().uuid(),
        reason: z.string().max(2000).optional(),
      })
      .safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }
    try {
      const result = await moveEntitiesDoor(a.actor, parsed.data);
      return c.json(result, 200);
    } catch (err) {
      return failure(c, err, "entity move");
    }
  });

  app.post("/profiles/grant-access", async (c) => {
    const a = await actorFor(c);
    if (!a.ok) return a.res;
    const parsed = z
      .object({
        profileId: z.string().uuid(),
        targetWorkspaceId: z.string().uuid(),
        workspaceId: z.string().uuid().optional(),
        reasoning,
      })
      .safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }
    try {
      const result = await grantProfileAccessDoor(a.actor, parsed.data);
      return jsonGoverned(c, result);
    } catch (err) {
      return failure(c, err, "profile grant-access");
    }
  });
}
