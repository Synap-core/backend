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
  WireProfileDigestSchema,
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

const ProfileRendererContentKindSchema = z.enum([
  "entity-detail",
  "entity-profile",
  "collection",
]);
const LegacyRendererSlotSchema = z.enum(["list", "detail", "dashboard"]);
const legacySlotToContentKind = {
  list: "collection",
  detail: "entity-detail",
  dashboard: "entity-profile",
} as const;

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
        description:
          "Array of profiles. Default: lightweight digest (id, slug, displayName, entityScope, scope, description, icon, profileKind, applicableKinds). `scope` = visibility (who can use the type); `entityScope` = placement (where its entities live). Pass ?detail=full for the complete row.",
        schema: z.union([
          z.array(WireProfileDigestSchema),
          z.array(WireProfileSchema),
        ]),
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
   * GET /profiles?userId=...&workspaceId=...&detail=full
   *
   * Default (no `detail` param): lightweight digest per profile —
   *   { id, slug, displayName, entityScope, scope, description, icon,
   *     profileKind, applicableKinds }
   * Pass `?detail=full` to receive the complete profile row.
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
    const detail = c.req.query("detail");
    try {
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.profiles.listProfiles({
        userId,
        workspaceId,
      });
      if (detail === "full") {
        return c.json(result);
      }
      // Default: lightweight digest — strip heavy JSONB renderer/hint columns
      const profiles = Array.isArray(result)
        ? result
        : ((result as unknown as { profiles: unknown[] }).profiles ?? []);
      const digests = (
        profiles as Array<{
          id: string;
          slug: string;
          displayName: string;
          entityScope?: string;
          scope?: "system" | "shared" | "workspace" | "user" | null;
          description?: string | null;
          icon?: string | null;
          profileKind?: "kind" | "role";
          applicableKinds?: string[] | null;
        }>
      ).map((p) => ({
        id: p.id,
        slug: p.slug,
        displayName: p.displayName,
        entityScope: p.entityScope,
        // Visibility axis (who can use this profile type) — distinct from
        // entityScope (placement: where its entities live).
        scope: p.scope ?? null,
        description: p.description ?? null,
        icon: p.icon ?? null,
        // An omitted discriminator is a legacy primary kind, never a role.
        profileKind: p.profileKind ?? "kind",
        applicableKinds: p.applicableKinds ?? null,
      }));
      return c.json(digests);
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
   * POST /profiles/renderer
   * Bind a cell as a profile's renderer. GOVERNED: agent callers get a proposal
   * (`status: 'proposed'`), operators auto-apply (`status: 'applied'`).
   * Body: { userId, profileSlug, slot, cellKey, props?, scope?, workspaceId? }
   */
  app.post("/profiles/renderer", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as {
      userId?: string;
      workspaceId?: string;
      profileSlug?: string;
      slot?: "list" | "detail" | "dashboard";
      cellKey?: string;
      props?: Record<string, unknown>;
      scope?: "workspace" | "pod";
      reasoning?: string;
      agentUserId?: string;
      sourceMessageId?: string;
    } | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    if (!body.profileSlug || !body.slot || !body.cellKey) {
      return c.json(
        { error: "profileSlug, slot and cellKey are required" },
        400
      );
    }
    try {
      // The acting identity is the authenticated owner resolved by the auth
      // middleware (the IS acts as the operator via its is_internal key remap) —
      // NOT the request body. Mirrors /cells/define; a body userId is ignored.
      const userId = c.get("userId") as string;
      if (!userId) return c.json({ error: "Unauthenticated" }, 403);
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      const actorResolution = await resolveActorId(resolvedAgentUserId, userId);
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const actorId = actorResolution.actorId;
      const caller = await getCaller(c, {
        userId: actorId,
        workspaceId: body.workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.profiles.setRenderer({
        userId,
        workspaceId: body.workspaceId,
        profileSlug: body.profileSlug,
        slot: body.slot,
        cellKey: body.cellKey,
        props: body.props,
        scope: body.scope,
        reasoning: body.reasoning,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "profiles.setRenderer failed");
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
      reasoning?: string;
      /**
       * When true, create a workspace-scoped overlay def (invisible to other
       * workspaces using the same profile). Default false = base def.
       */
      overlay?: boolean;
      required?: boolean;
      defaultValue?: unknown;
      displayOrder?: number;
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
        workspaceId: body.workspaceId,
        profileId: body.profileId,
        slug: body.slug,
        valueType: body.valueType,
        constraints: body.constraints,
        uiHints: body.uiHints,
        reasoning: body.reasoning,
        overlay: body.overlay === true,
        required: body.required,
        defaultValue: body.defaultValue,
        displayOrder: body.displayOrder,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
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
      "Returns the RendererTarget resolved for the given profile in the given workspace. Resolution order: workspace overlay → profile system default → hardcoded fallback. Omit `contentKind` to receive all profile renderer kinds in one round trip. Spec: synap-team-docs/content/team/platform/profile-renderer.mdx",
    request: {
      query: z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        contentKind: ProfileRendererContentKindSchema.optional(),
        slot: LegacyRendererSlotSchema.optional().describe(
          "Deprecated alias: list → entity-profile, detail → entity-detail, dashboard → collection."
        ),
      }),
    },
    responses: {
      200: {
        description:
          "ContentKind-keyed renderer map. Unrequested kinds are null when `contentKind` is supplied.",
        schema: z.object({
          "entity-detail": z.record(z.string(), z.unknown()).nullable(),
          "entity-profile": z.record(z.string(), z.unknown()).nullable(),
          collection: z.record(z.string(), z.unknown()).nullable(),
        }),
      },
      400: { description: "Missing required query param", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /profiles/:slug/renderers?userId=...&workspaceId=...&contentKind=...
   * `slot` remains an additive legacy alias while callers migrate.
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
    const contentKindRaw = c.req.query("contentKind");
    const slotRaw = c.req.query("slot");
    const profileSlug = c.req.param("slug");

    if (!userId || !workspaceId) {
      return c.json({ error: "userId and workspaceId are required" }, 400);
    }
    if (!profileSlug) {
      return c.json({ error: "profile slug is required" }, 400);
    }
    const parsedContentKind =
      ProfileRendererContentKindSchema.optional().safeParse(contentKindRaw);
    if (!parsedContentKind.success) {
      return c.json(
        {
          error:
            "contentKind must be 'entity-detail', 'entity-profile', or 'collection'",
        },
        400
      );
    }
    const parsedSlot = LegacyRendererSlotSchema.optional().safeParse(slotRaw);
    if (!parsedSlot.success) {
      return c.json(
        { error: "slot must be 'list', 'detail', or 'dashboard'" },
        400
      );
    }
    const slotKind = parsedSlot.data
      ? legacySlotToContentKind[parsedSlot.data]
      : undefined;
    if (
      parsedContentKind.data &&
      slotKind &&
      parsedContentKind.data !== slotKind
    ) {
      return c.json(
        { error: "contentKind and slot refer to different renderer kinds" },
        400
      );
    }
    const contentKind = parsedContentKind.data ?? slotKind;

    try {
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.profiles.getEffectiveRenderers({
        userId,
        workspaceId,
        profileSlug,
        contentKind,
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
