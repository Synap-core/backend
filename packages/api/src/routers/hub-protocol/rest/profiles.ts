/**
 * Hub Protocol REST — profiles & property defs
 */

import { z } from "@hono/zod-openapi";
import { PROFILE_CONTENT_KINDS } from "@synap-core/types/renderables";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CreateProfileRequestSchema,
  CreatePropertyDefRequestSchema,
  UpdatePropertyDefRequestSchema,
  ListProfilesQuerySchema,
  ListPropertyDefsQuerySchema,
  WireProfileDigestSchema,
  WireProfileSchema,
  WirePropertyDefSchema,
} from "./_codecs/profile.js";
import { getConfinedWorkspace } from "../confine-workspace.js";
import {
  resolveProfileDescription,
  resolveProfileIcon,
} from "../../../utils/profile-presentation.js";

import { registerOpenApi } from "./_codecs/_register.js";
import { defineProfile } from "../define-profile.js";
import {
  getCaller,
  hasScope,
  httpStatusForTrpcError,
  logger,
  resolveActingContext,
  resolveActorId,
  type HubHono,
} from "./_shared.js";
import { jsonGoverned } from "../proposal-response.js";

const ProfileRendererContentKindSchema = z.enum(PROFILE_CONTENT_KINDS);
// Frozen at the three kinds that HAD slots. `entity-card` postdates the slot
// era and is reachable only through `contentKind` — never widen this.
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
    summary: "Define a kind or a role",
    description:
      "Defines an entity kind (`profileKind: 'kind'`, default) or an attachable role (`profileKind: 'role'`), optionally with `fields`. Slug-idempotent. Governed: an agent caller gets `status: 'proposed'` (fields deferred until approval) — that is success, not an error. Same door as MCP synap_define_kind / synap_define_role.",
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
    method: "patch",
    path: "/property-defs/{id}",
    tags: ["Profiles"],
    summary: "Edit an existing property definition",
    description:
      "Changes a stored def's slug / valueType / constraints / uiHints. This is the ONE edit door — `POST /property-defs` is slug-idempotent and never converges, so it reports `status: \"unchanged\"` and points here. Governed: an agent caller gets `status: 'proposed'` (that is success, not an error), because narrowing a def re-interprets every existing row of every profile that links it.",
    request: {
      body: UpdatePropertyDefRequestSchema,
    },
    responses: {
      200: {
        description: "Updated property def",
        schema: WirePropertyDefSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Property def not found", schema: ErrorSchema },
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
          uiHints?: unknown;
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
        description: resolveProfileDescription(p),
        icon: resolveProfileIcon(p),
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
    const parsed = CreateProfileRequestSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) {
      return c.json(
        {
          error: parsed.error.issues
            .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
            .join("; "),
        },
        400
      );
    }
    const body = parsed.data;
    try {
      // SECURITY — acting identity MUST come from the verified auth context,
      // never `body.userId` directly (that was a governed-agent-write →
      // ungoverned-operator-write IDOR: any caller could attribute a profile
      // create to an arbitrary userId). Mirrors POST /views / PATCH /views.
      //
      // SERVICE-KEY CONFINEMENT (Item 3): the inner `profiles.createProfile` is a
      // scopedProcedure that reads `input.workspaceId` (NOT ctx) — the getCaller
      // ctx-clamp does not reach it. Positive-pin the value BEFORE it reaches
      // resolveActingContext (and thus the re-supplied createProfile input).
      const clampedWorkspaceId = getConfinedWorkspace(c, body.workspaceId);
      const acting = await resolveActingContext(c, {
        userId: body.userId,
        ...(clampedWorkspaceId ? { workspaceId: clampedWorkspaceId } : {}),
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      if (!acting.workspaceId) {
        return c.json({ error: "workspaceId is required" }, 400);
      }
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      const actorResolution = await resolveActorId(
        resolvedAgentUserId,
        acting.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const actorId = actorResolution.actorId;
      const workspaceId = acting.workspaceId;
      const caller = await getCaller(c, {
        userId: actorId,
        workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      // The ONE define door MCP `synap_define_kind` / `synap_define_role` also
      // call — role, entity scope and field defs are expressible here too.
      // Governance (agent structure write → proposal) is decided inside
      // `profiles.createProfile`, never here.
      const outcome = await defineProfile(
        caller,
        {
          userId: acting.userId,
          workspaceId,
          slug: body.slug,
          displayName: body.displayName,
          ...(body.profileKind ? { profileKind: body.profileKind } : {}),
          ...(body.applicableKinds
            ? { applicableKinds: body.applicableKinds }
            : {}),
          ...(body.roleCategory !== undefined
            ? { roleCategory: body.roleCategory }
            : {}),
          ...(body.entityScope ? { entityScope: body.entityScope } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          ...(body.icon !== undefined ? { icon: body.icon } : {}),
          ...(body.uiHints ? { uiHints: body.uiHints } : {}),
          ...(body.defaultValues ? { defaultValues: body.defaultValues } : {}),
          ...(body.parentProfileId
            ? { parentProfileId: body.parentProfileId }
            : {}),
          ...(body.fields !== undefined ? { fields: body.fields } : {}),
          ...(body.reasoning ? { reasoning: body.reasoning } : {}),
          ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        },
        { door: "POST /profiles", fieldsParam: "fields" }
      );
      if (!outcome.ok) return c.json({ error: outcome.error }, 400);
      return jsonGoverned(c, outcome.result);
    } catch (err) {
      // SERVICE-KEY CONFINEMENT: a bound service key targeting another workspace
      // throws FORBIDDEN → 403; a slug the hub door's zod refuses → 400. Never a
      // blanket 500. Duck-typed on `.code` (bundled-build TRPCError identity
      // defeats instanceof).
      const status = httpStatusForTrpcError(err);
      if (status === 500) logger.error({ err }, "createProfile failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        status
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
      // SERVICE-KEY CONFINEMENT (Item 3): inner `profiles.setRenderer` is a
      // scopedProcedure reading `input.workspaceId` (NOT ctx) — positive-pin the
      // value fed to BOTH the caller ctx and the input (mismatching body → 403).
      const workspaceId =
        getConfinedWorkspace(c, body.workspaceId) ?? undefined;
      const caller = await getCaller(c, {
        userId: actorId,
        workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.profiles.setRenderer({
        userId,
        workspaceId,
        profileSlug: body.profileSlug,
        slot: body.slot,
        cellKey: body.cellKey,
        props: body.props,
        scope: body.scope,
        reasoning: body.reasoning,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
      });
      return jsonGoverned(c, result);
    } catch (err) {
      // SERVICE-KEY CONFINEMENT: FORBIDDEN → 403, not a blanket 500. Duck-typed
      // on `.code` (bundled-build TRPCError identity defeats instanceof).
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      // BAD_REQUEST → 400 (e.g. the `subjectId` write-door refusal — renderer
      // bindings are whole-kind only, see `set-profile-renderer.ts`).
      if ((err as { code?: unknown })?.code === "BAD_REQUEST")
        return c.json(
          { error: err instanceof Error ? err.message : "Bad request" },
          400
        );
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
      // SECURITY — acting identity MUST come from the verified auth context,
      // never `body.userId` directly (governed-agent-write → ungoverned-
      // operator-write IDOR). Mirrors POST /views / PATCH /views / POST /profiles.
      //
      // SERVICE-KEY CONFINEMENT (Item 3): inner `profiles.createPropertyDef` is a
      // scopedProcedure reading `input.workspaceId` (NOT ctx) — positive-pin the
      // value BEFORE it reaches resolveActingContext (and thus the re-supplied
      // createPropertyDef input).
      const clampedWorkspaceId = getConfinedWorkspace(c, body.workspaceId);
      const acting = await resolveActingContext(c, {
        userId: body.userId,
        ...(clampedWorkspaceId ? { workspaceId: clampedWorkspaceId } : {}),
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      if (!acting.workspaceId) {
        return c.json({ error: "workspaceId is required" }, 400);
      }
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      const actorResolution = await resolveActorId(
        resolvedAgentUserId,
        acting.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const actorId = actorResolution.actorId;
      const workspaceId = acting.workspaceId;
      const caller = await getCaller(c, {
        userId: actorId,
        workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.profiles.createPropertyDef({
        userId: acting.userId,
        workspaceId,
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
      return jsonGoverned(c, result);
    } catch (err) {
      // SERVICE-KEY CONFINEMENT: FORBIDDEN → 403, not a blanket 500. Duck-typed
      // on `.code` (bundled-build TRPCError identity defeats instanceof).
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      logger.error({ err }, "createPropertyDef failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * PATCH /property-defs/:id — the EDIT door.
   *
   * Same acting-identity + service-key confinement rules as POST
   * /property-defs; the governance decision and the apply both live in the hub
   * procedure, which is the ONE governed door (this is only its HTTP edge).
   */
  app.patch("/property-defs/:id", async (c) => {
    const propertyDefId = c.req.param("id");
    const body = (await c.req.json()) as {
      userId: string;
      workspaceId: string;
      slug?: string;
      valueType?: string;
      constraints?: Record<string, unknown>;
      uiHints?: Record<string, unknown>;
      agentUserId?: string;
      sourceMessageId?: string;
      reasoning?: string;
    };
    try {
      const clampedWorkspaceId = getConfinedWorkspace(c, body.workspaceId);
      const acting = await resolveActingContext(c, {
        userId: body.userId,
        ...(clampedWorkspaceId ? { workspaceId: clampedWorkspaceId } : {}),
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      if (!acting.workspaceId) {
        return c.json({ error: "workspaceId is required" }, 400);
      }
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      const actorResolution = await resolveActorId(
        resolvedAgentUserId,
        acting.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const workspaceId = acting.workspaceId;
      const caller = await getCaller(c, {
        userId: actorResolution.actorId,
        workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.profiles.updatePropertyDef({
        userId: acting.userId,
        workspaceId,
        propertyDefId,
        slug: body.slug,
        valueType: body.valueType,
        constraints: body.constraints,
        uiHints: body.uiHints,
        reasoning: body.reasoning,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
      });
      return jsonGoverned(c, result);
    } catch (err) {
      // SERVICE-KEY CONFINEMENT: FORBIDDEN → 403, not a blanket 500. Duck-typed
      // on `.code` (bundled-build TRPCError identity defeats instanceof).
      const code = (err as { code?: unknown })?.code;
      if (code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      if (code === "NOT_FOUND")
        return c.json(
          { error: err instanceof Error ? err.message : "Not found" },
          404
        );
      if (code === "BAD_REQUEST" || code === "CONFLICT")
        return c.json(
          { error: err instanceof Error ? err.message : "Bad request" },
          400
        );
      logger.error({ err }, "updatePropertyDef failed");
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
          userChoice: z
            .enum(["source", "synap"])
            .nullable()
            .describe(
              "The caller's explicit choice for entity-detail: 'source' (open in the source app), 'synap' (render in Synap, including after unbinding), null (never chose)."
            ),
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
    // One object's id — enables the `·object` rungs of `renderer_bindings`.
    // Absent = per-KIND resolution, unchanged.
    const subjectId = c.req.query("subjectId") || undefined;
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
        subjectId,
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
