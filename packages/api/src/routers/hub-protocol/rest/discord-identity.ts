/**
 * Hub Protocol REST — Discord ↔ Synap identity linking (V0 BYOA, Option B)
 *
 * Three endpoints that let a Discord user act AS their own Synap user inside the
 * agent-turn — instead of every Discord caller collapsing into the operator.
 *
 *   GET  /discord/identity?discordUserId=...     → is this Discord user linked?
 *   GET  /discord/identity/members?workspaceId=  → who can we link them to?
 *   POST /discord/identity/link                  → create the link (admin-gated)
 *
 * Identity model
 * --------------
 * The bridge authenticates with the OPERATOR's API key. That key's id
 * (`c.get("apiKeyId")`) is the `parentApiKeyId` of the Discord→Synap mapping
 * rows in `api_key_external_users` — the SAME table the OpenWebUI sub-token path
 * uses. `discordUserId` is the opaque `externalUserId`. So a "link" is just one
 * mapping row keyed on (operator-key, discord-user-id).
 *
 * SECURITY — why linking is admin-only
 * ------------------------------------
 * Linking establishes WHO a Discord user becomes inside Synap:
 *   - mode "existing" → the Discord user is mapped onto an EXISTING member. This
 *     is an impersonation primitive: whoever holds that Discord id then reads and
 *     writes that member's data. It MUST be authorized by a workspace admin.
 *   - mode "new" → provisions a fresh Synap account + grants team membership.
 *     Account creation is also admin-only.
 * The gate reads the LOADED acting context's workspace role (owner/admin) via
 * `resolveActingContext` — it does NOT trust any caller-supplied "isAdmin" flag.
 * The bridge calls with the operator key (= workspace owner), so it passes; a
 * lesser caller (editor/viewer) is rejected 403.
 */

import { z } from "@hono/zod-openapi";
import { db, users, workspaceMembers, eq, and, inArray } from "@synap/database";
import { getConfinedWorkspace } from "../confine-workspace.js";

import {
  resolveExistingExternalUser,
  linkExternalUserToExisting,
  resolveExternalUserMapping,
  getWorkspaceStrategy,
} from "../../../services/external-user-mapping.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

// ── Schemas ──────────────────────────────────────────────────────────────────

const IdentityQuerySchema = z
  .object({ discordUserId: z.string().min(1) })
  .openapi("DiscordIdentityQuery");

const IdentityResponseSchema = z
  .object({
    linked: z.boolean(),
    synapUserId: z.string().optional(),
    displayName: z.string().optional(),
  })
  .openapi("DiscordIdentityResponse");

const MembersQuerySchema = z
  .object({ workspaceId: z.string().uuid().optional() })
  .openapi("DiscordIdentityMembersQuery");

const MembersResponseSchema = z
  .object({
    members: z.array(z.object({ userId: z.string(), name: z.string() })),
  })
  .openapi("DiscordIdentityMembersResponse");

const LinkRequestSchema = z
  .object({
    discordUserId: z.string().min(1),
    mode: z.enum(["existing", "new"]),
    /** Required when mode = "existing": the member to map this Discord id onto. */
    targetUserId: z.string().uuid().optional(),
    /** Optional human-friendly label stored on the mapping / new user. */
    displayName: z.string().min(1).max(200).optional(),
    /** Optional workspace to bind the acting context + membership grant to. */
    workspaceId: z.string().uuid().optional(),
  })
  .openapi("DiscordIdentityLinkRequest");

const LinkResponseSchema = z
  .object({
    linked: z.literal(true),
    synapUserId: z.string(),
    created: z.boolean(),
  })
  .openapi("DiscordIdentityLinkResponse");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The parent key id for Discord→Synap mappings = the api_keys.id of the bearer
 * that authenticated this request (the operator's key). Only set for API-key
 * callers; absent for Kratos-session callers (who shouldn't be hitting this).
 */
function parentKeyId(c: { get: (k: string) => unknown }): string | undefined {
  return c.get("apiKeyId") as string | undefined;
}

export function registerDiscordIdentityRoutes(app: HubHono): void {
  // ── GET /discord/identity ────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/discord/identity",
    tags: ["Discord", "Identity"],
    summary: "Resolve an existing Discord→Synap identity link (read-only)",
    description:
      "Returns whether the given Discord user is linked to a Synap user under " +
      "the calling operator key. NEVER auto-creates a link.",
    request: { query: IdentityQuerySchema },
    responses: {
      200: { description: "Link status", schema: IdentityResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/discord/identity", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const keyId = parentKeyId(c);
    if (!keyId) {
      return c.json(
        { error: "Discord identity lookup requires an API-key bearer" },
        403
      );
    }
    const discordUserId = c.req.query("discordUserId");
    if (!discordUserId) {
      return c.json({ error: "discordUserId query param is required" }, 400);
    }
    try {
      const resolved = await resolveExistingExternalUser(keyId, discordUserId);
      return c.json(resolved, 200);
    } catch (err) {
      logger.error({ err, discordUserId }, "GET /discord/identity failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /discord/identity/members ────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/discord/identity/members",
    tags: ["Discord", "Identity"],
    summary: "List linkable members of the acting workspace",
    description:
      "Returns the human members of the acting (operator) workspace that a " +
      "Discord user can be linked to via the onboarding picker.",
    request: { query: MembersQuerySchema },
    responses: {
      200: { description: "Linkable members", schema: MembersResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/discord/identity/members", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const rawWorkspaceId = c.req.query("workspaceId");
    // Bind to the acting identity + workspace (membership-checked for the caller).
    const acting = await resolveActingContext(c, {
      workspaceId: rawWorkspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    // Listing linkable members is workspace-scoped — a workspace is required.
    if (!acting.workspaceId) {
      return c.json({ error: "workspaceId is required" }, 400);
    }

    try {
      const memberRows = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, acting.workspaceId));
      const ids = memberRows.map((m) => m.userId);
      if (ids.length === 0) return c.json({ members: [] }, 200);

      // Only humans are linkable targets — never agent users.
      const userRows = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(inArray(users.id, ids), eq(users.userType, "human")));

      return c.json(
        {
          members: userRows.map((u) => ({
            userId: u.id,
            name: u.name ?? "Unnamed member",
          })),
        },
        200
      );
    } catch (err) {
      logger.error(
        { err, workspaceId: acting.workspaceId },
        "GET /discord/identity/members failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /discord/identity/link ──────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/discord/identity/link",
    tags: ["Discord", "Identity"],
    summary: "Link a Discord user to a Synap identity (admin-gated)",
    description:
      "Creates the Discord→Synap mapping. mode='existing' maps onto an existing " +
      "workspace member (impersonation — admin-only). mode='new' provisions a " +
      "fresh Synap user + team membership (account creation — admin-only). " +
      "Authorized by the acting context's workspace role (owner/admin), never a " +
      "caller-supplied flag.",
    request: { body: LinkRequestSchema },
    responses: {
      200: { description: "Linked", schema: LinkResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/discord/identity/link", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const keyId = parentKeyId(c);
    if (!keyId) {
      return c.json(
        { error: "Discord identity linking requires an API-key bearer" },
        403
      );
    }

    let body: z.infer<typeof LinkRequestSchema>;
    try {
      body = LinkRequestSchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid request body" },
        400
      );
    }

    // ── SECURITY GATE ────────────────────────────────────────────────────────
    // Bind the acting identity + workspace, then require an OWNER/ADMIN role on
    // that workspace. resolveActingContext returns the membership role for the
    // resolved (authenticated) user — we trust THAT, not the request body.
    // Item 3 Part 3: confine a bound service key to its workspace before resolving.
    // (A service key would additionally need an owner/admin role — gated below.)
    const confinedWorkspaceId =
      getConfinedWorkspace(c, body.workspaceId) ?? undefined;
    const acting = await resolveActingContext(c, {
      workspaceId: confinedWorkspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    // Linking a Discord identity is a workspace owner/admin action. A workspace
    // is required — and the guard MUST precede the role check below, since the
    // no-workspace (pod-personal) default returns role "owner" and would
    // otherwise spuriously satisfy the owner/admin gate.
    if (!acting.workspaceId) {
      return c.json(
        { error: "workspaceId is required to link a Discord identity" },
        400
      );
    }
    if (acting.role !== "owner" && acting.role !== "admin") {
      logger.warn(
        {
          userId: acting.userId,
          workspaceId: acting.workspaceId,
          role: acting.role,
          mode: body.mode,
        },
        "discord/identity/link rejected: caller is not workspace owner/admin"
      );
      return c.json(
        {
          error: "Only a workspace owner or admin can link Discord identities",
        },
        403
      );
    }

    try {
      if (body.mode === "existing") {
        if (!body.targetUserId) {
          return c.json(
            { error: "targetUserId is required when mode='existing'" },
            400
          );
        }
        // The target MUST be a member of the acting workspace — prevents linking
        // a Discord id onto an arbitrary pod user the admin can't actually see.
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, acting.workspaceId),
            eq(workspaceMembers.userId, body.targetUserId)
          ),
          columns: { id: true },
        });
        if (!membership) {
          return c.json(
            { error: "targetUserId is not a member of this workspace" },
            400
          );
        }
        // The target MUST be a human — never link a Discord id onto an agent user.
        const target = await db.query.users.findFirst({
          where: and(
            eq(users.id, body.targetUserId),
            eq(users.userType, "human")
          ),
          columns: { id: true },
        });
        if (!target) {
          return c.json({ error: "targetUserId must be a human user" }, 400);
        }

        const result = await linkExternalUserToExisting(
          keyId,
          body.discordUserId,
          body.targetUserId,
          { source: "discord", displayName: body.displayName }
        );
        if (!result) {
          return c.json({ error: "Failed to create identity link" }, 500);
        }
        return c.json(
          {
            linked: true as const,
            synapUserId: result.synapUserId,
            created: false,
          },
          200
        );
      }

      // mode === "new": provision a fresh Synap user + team membership. Reuse the
      // canonical auto-provision path; parentOwnerUserId = the acting admin so
      // getWorkspaceStrategy mirrors THEIR memberships into the new account.
      const result = await resolveExternalUserMapping(
        keyId,
        body.discordUserId,
        {
          parentOwnerUserId: acting.userId,
          source: "discord",
          displayName: body.displayName,
        }
      );
      if (!result) {
        return c.json({ error: "Failed to provision Synap user" }, 500);
      }
      logger.info(
        {
          discordUserId: body.discordUserId,
          synapUserId: result.synapUserId,
          created: result.created,
          strategy: getWorkspaceStrategy(),
        },
        "discord/identity/link: provisioned new Synap identity"
      );
      return c.json(
        {
          linked: true as const,
          synapUserId: result.synapUserId,
          created: result.created,
        },
        200
      );
    } catch (err) {
      logger.error(
        { err, discordUserId: body.discordUserId, mode: body.mode },
        "POST /discord/identity/link failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
