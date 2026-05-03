/**
 * Hub Protocol REST — entity share delivery (CP → pod)
 *
 * Authenticated via CP-signed JWT (NOT the regular API-key middleware), so the
 * top-level auth middleware skip-lists this path.
 */

import { config } from "@synap-core/core";
import { db, eq } from "@synap/database";

import { hubProtocolRouter } from "../index.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { verifyCpJwt } from "../../../utils/jwks-client.js";

import { logger, type HubHono } from "./_shared.js";

export function registerEntityShareRoutes(app: HubHono): void {
  /**
   * POST /entity-share/deliver
   *
   * Called by the Control Plane (using its ES256 CP JWT) to deliver a shared
   * entity snapshot into the recipient's first active workspace on this pod.
   *
   * Auth: CP JWT (Bearer) — verified via JWKS, NOT the regular API key auth.
   * This is a STATIC route — must stay above any /:id dynamic patterns.
   */
  app.post("/entity-share/deliver", async (c) => {
    // Verify CP JWT — this call originates from the Control Plane, not from IS.
    const authHeader = c.req.header("authorization") ?? null;
    const rawToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!rawToken) {
      return c.json({ error: "Authorization header required" }, 401);
    }

    const cpUrl = config.server.controlPlaneUrl;
    const payload = await verifyCpJwt<{
      sub: string;
      email: string;
      type: string;
      aud: string;
    }>(rawToken, cpUrl);

    if (!payload || payload.type !== "entity-share-deliver") {
      return c.json({ error: "Invalid or expired CP token" }, 401);
    }

    const body = (await c.req.json()) as {
      entitySnapshot: Record<string, unknown>;
      fromPodId: string;
      shareId: string;
    };

    if (!body.entitySnapshot || !body.shareId) {
      return c.json({ error: "entitySnapshot and shareId are required" }, 400);
    }

    const snapshot = body.entitySnapshot;

    // Resolve the recipient user on this pod by email (from CP JWT)
    const { users, workspaceMembers } = await import("@synap/database/schema");
    const podUser = await db.query.users.findFirst({
      where: eq(users.email, payload.email),
      columns: { id: true },
    });

    if (!podUser) {
      logger.warn(
        { email: payload.email, shareId: body.shareId },
        "entity-share/deliver: no pod account found for recipient email"
      );
      return c.json(
        {
          error:
            "No pod account found for this email — please sign in to this pod first",
        },
        422
      );
    }

    // Find the recipient's first active workspace on this pod
    const membership = await db.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.userId, podUser.id),
      with: { workspace: { columns: { id: true } } },
      orderBy: (m, { asc }) => [asc(m.joinedAt)],
    });

    if (!membership?.workspace?.id) {
      logger.warn(
        { userId: podUser.id, shareId: body.shareId },
        "entity-share/deliver: recipient has no workspace on this pod"
      );
      return c.json({ error: "Recipient has no workspace on this pod" }, 422);
    }

    const workspaceId = membership.workspace.id;
    const profileSlug =
      (snapshot.profileSlug as string | undefined) ??
      (snapshot.type as string | undefined) ??
      "note";

    try {
      // Build caller context directly — getCaller reads scopes from the API key
      // middleware context which is bypassed for CP JWT auth on this route.
      const callerCtx = await createHubProtocolCallerContext(
        podUser.id,
        ["hub-protocol.read", "hub-protocol.write"],
        workspaceId
      );
      const caller = hubProtocolRouter.createCaller(callerCtx as any);

      const result = await caller.entities.createEntity({
        userId: podUser.id,
        profileSlug,
        title: (snapshot.title as string | undefined) ?? "Shared Entity",
        description: (snapshot.preview as string | undefined) ?? undefined,
        properties:
          (snapshot.properties as Record<string, unknown> | undefined) ?? {},
      });

      logger.info(
        { shareId: body.shareId, userId: podUser.id, workspaceId, profileSlug },
        "entity-share/deliver: entity created from share"
      );

      return c.json({ status: "ok", entityId: result?.id ?? null });
    } catch (err) {
      logger.error(
        { err, shareId: body.shareId },
        "entity-share/deliver: entity creation failed"
      );
      return c.json(
        {
          error: err instanceof Error ? err.message : "Entity creation failed",
        },
        500
      );
    }
  });
}
