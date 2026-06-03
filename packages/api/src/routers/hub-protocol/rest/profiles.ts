/**
 * Hub Protocol REST — profiles & property defs
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CreateProfileRequestSchema,
  CreatePropertyDefRequestSchema,
  ListProfilesQuerySchema,
  ListPropertyDefsQuerySchema,
  WireProfileSchema,
  WirePropertyDefSchema,
} from "./_codecs/profile.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  getCaller,
  hasScope,
  logger,
  resolveActorId,
  type HubHono,
} from "./_shared.js";

export function registerProfilesRoutes(app: HubHono): void {
  // ── OpenAPI metadata for /profiles + /property-defs routes ───────────────
  registerOpenApi(app, {
    method: "get",
    path: "/profiles",
    tags: ["Profiles"],
    summary: "List entity profiles",
    description:
      "Returns profiles visible to the user in the given workspace (system + workspace-scoped + extended).",
    request: {
      query: ListProfilesQuerySchema,
    },
    responses: {
      200: {
        description: "Array of profiles",
        schema: z.array(WireProfileSchema),
      },
      400: { description: "Missing required query param", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/profiles",
    tags: ["Profiles"],
    summary: "Create a custom profile",
    description:
      "Creates a workspace-scoped profile. AI-authored creations should pass `agentUserId` so a proposal is opened when governance requires.",
    request: {
      body: CreateProfileRequestSchema,
    },
    responses: {
      200: { description: "Created profile", schema: WireProfileSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/property-defs",
    tags: ["Profiles"],
    summary: "List property definitions",
    description:
      "Returns property defs visible to the workspace (global + profile-base + this workspace's overlays).",
    request: {
      query: ListPropertyDefsQuerySchema,
    },
    responses: {
      200: {
        description: "Array of property definitions",
        schema: z.array(WirePropertyDefSchema),
      },
      400: { description: "Missing required query param", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/property-defs",
    tags: ["Profiles"],
    summary: "Create a property definition",
    description:
      "Adds a property def. Set `overlay: true` to create a workspace-scoped overlay invisible to other workspaces using the same profile.",
    request: {
      body: CreatePropertyDefRequestSchema,
    },
    responses: {
      200: {
        description: "Created property def",
        schema: WirePropertyDefSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /profiles?userId=...&workspaceId=...
   */
  app.get("/profiles", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.req.query("userId");
    const workspaceId = c.req.query("workspaceId");
    if (!userId || !workspaceId) {
      return c.json({ error: "userId and workspaceId are required" }, 400);
    }
    try {
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.profiles.listProfiles({
        userId,
        workspaceId,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "listProfiles failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /profiles
   */
  app.post("/profiles", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json()) as {
      userId: string;
      workspaceId: string;
      slug: string;
      displayName: string;
      description?: string;
      defaultValues?: Record<string, unknown>;
      parentProfileId?: string;
      uiHints?: Record<string, unknown>;
      reasoning?: string;
      agentUserId?: string;
      sourceMessageId?: string;
    };
    try {
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      const actorResolution = await resolveActorId(
        resolvedAgentUserId,
        body.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const actorId = actorResolution.actorId;
      const caller = await getCaller(c, {
        userId: actorId,
        workspaceId: body.workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.profiles.createProfile({
        userId: body.userId,
        workspaceId: body.workspaceId,
        slug: body.slug,
        displayName: body.displayName,
        description: body.description,
        defaultValues: body.defaultValues,
        parentProfileId: body.parentProfileId,
        uiHints: body.uiHints,
        reasoning: body.reasoning,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "createProfile failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /property-defs?userId=...&workspaceId=...&profileId=...
   */
  app.get("/property-defs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.req.query("userId");
    const workspaceId = c.req.query("workspaceId");
    if (!userId || !workspaceId) {
      return c.json({ error: "userId and workspaceId are required" }, 400);
    }
    try {
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.profiles.listPropertyDefs({
        userId,
        workspaceId,
        profileId: c.req.query("profileId"),
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "listPropertyDefs failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /property-defs
   */
  app.post("/property-defs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json()) as {
      userId: string;
      workspaceId: string;
      profileId?: string;
      slug: string;
      valueType: string;
      constraints?: Record<string, unknown>;
      uiHints?: Record<string, unknown>;
      agentUserId?: string;
      sourceMessageId?: string;
      /**
       * When true, create a workspace-scoped overlay def (invisible to other
       * workspaces using the same profile). Default false = base def.
       */
      overlay?: boolean;
    };
    try {
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      const actorResolution = await resolveActorId(
        resolvedAgentUserId,
        body.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const actorId = actorResolution.actorId;
      const caller = await getCaller(c, {
        userId: actorId,
        workspaceId: body.workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.profiles.createPropertyDef({
        userId: body.userId,
        profileId: body.profileId,
        slug: body.slug,
        valueType: body.valueType,
        constraints: body.constraints,
        uiHints: body.uiHints,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        ...(body.overlay
          ? { overlay: true, workspaceId: body.workspaceId }
          : {}),
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "createPropertyDef failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── /profiles/:slug/renderers — Profile Renderer North Star ────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/profiles/{slug}/renderers",
    tags: ["Profiles"],
    summary: "Get the effective renderer(s) for a profile",
    description:
      "Returns the RendererTarget resolved for the given profile in the given workspace. Resolution order: workspace overlay → profile system default → hardcoded fallback. Omit `slot` to receive both list and detail in one round trip. Spec: synap-team-docs/content/team/platform/profile-renderer.mdx",
    request: {
      query: z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        slot: z.enum(["list", "detail"]).optional(),
      }),
    },
    responses: {
      200: {
        description:
          "Object with `list` and/or `detail` fields. Each is a RendererTarget (or null when a single slot was requested).",
        schema: z.object({
          list: z.record(z.string(), z.unknown()).nullable(),
          detail: z.record(z.string(), z.unknown()).nullable(),
        }),
      },
      400: { description: "Missing required query param", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /profiles/:slug/renderers?userId=...&workspaceId=...&slot=...
   */
  app.get("/profiles/:slug/renderers", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.req.query("userId");
    const workspaceId = c.req.query("workspaceId");
    const slotRaw = c.req.query("slot");
    const profileSlug = c.req.param("slug");

    if (!userId || !workspaceId) {
      return c.json({ error: "userId and workspaceId are required" }, 400);
    }
    if (!profileSlug) {
      return c.json({ error: "profile slug is required" }, 400);
    }
    if (slotRaw && slotRaw !== "list" && slotRaw !== "detail") {
      return c.json({ error: "slot must be 'list' or 'detail'" }, 400);
    }
    const slot = slotRaw as "list" | "detail" | undefined;

    try {
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.profiles.getEffectiveRenderers({
        userId,
        workspaceId,
        profileSlug,
        slot,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "getEffectiveRenderers failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
