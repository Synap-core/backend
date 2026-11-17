/**
 * Hub Protocol REST — agents.
 *
 *   POST /agents/sync                 an intelligence service's agent registry
 *
 * An agent asks its person for ONE MORE thing, with its OWN key
 * (`services/agent-access-ask.ts`):
 *   POST /agents/access-requests      { requests: [{ permission, workspaceId }],
 *                                     reason? } → the ask (or what each pair
 *                                     already is: given, open, quiet)
 *   GET  /agents/access-requests/:id  pending / allowed / declined / expired
 */

import { z } from "zod";
import {
  db,
  agents,
  intelligenceServices,
  drizzleSql,
  eq,
  and,
  or,
  notInArray,
} from "@synap/database";

import type { Context } from "hono";
import {
  hasScope,
  logger,
  requireUuidParam,
  type HubHono,
  type HubVariables,
  httpStatusForTrpcError,
  refuseStaleDeviceSession,
} from "./_shared.js";
import { refusalBody } from "./_presence.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  AccessAskParamsSchema,
  AccessAskReceiptSchema,
  AccessAskViewSchema,
} from "./_codecs/app-access-ask.js";
import { AgentAccessAskBodySchema } from "./_codecs/agent-access-ask.js";
import {
  fileAgentAccessAsk,
  readAgentAccessAsk,
} from "../../../services/agent-access-ask.js";
import {
  findOrCreateServiceAgentUser,
  linkAgentToUser,
} from "../../../services/agent-identity-service.js";
import { resolvePodOwnerUserId } from "../../../services/capabilities/pod-owner.js";

/**
 * Zod payload for POST /agents/sync.
 */
const SyncAgentsPayload = z.object({
  serviceId: z.string(),
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      description: z.string().nullish().optional(),
      icon: z.string().nullish().optional(),
      capabilities: z.array(z.string()),
      metadata: z.record(z.string(), z.unknown()).nullish().optional(),
    })
  ),
});

type Ctx = Context<{ Variables: HubVariables }>;

/**
 * An agent's key asks with either Hub scope: a read-only key must be able to
 * ask for its first write. The ask grants nothing until its person allows it.
 */
function canAsk(c: Ctx): boolean {
  const scopes = c.get("scopes");
  return (
    hasScope(scopes, "hub-protocol.read") ||
    hasScope(scopes, "hub-protocol.write")
  );
}

function askFailed(c: Ctx, err: unknown, what: string) {
  const status = httpStatusForTrpcError(err);
  if (status === 500) logger.error({ err }, `${what} failed`);
  return c.json(refusalBody(err, `${what} failed`), status);
}

export function registerAgentsRoutes(app: HubHono): void {
  // ── An agent's ask for one more thing (static paths) ─────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/agents/access-requests",
    tags: ["Agents"],
    summary: "An agent asks its person for one more thing",
    description:
      "With the agent's own key. Each pair is a permission inside the agent's limits, in one space the person can give it. " +
      "Files ONE ask the person answers from a card; allowing it ADDS the pairs to the key that asked (no other key of the agent), within what its computer holds. " +
      "A pair the key already holds, already asked for, or that the person declined less than 30 days ago is not asked again. An ask waits 7 days.",
    request: { body: AgentAccessAskBodySchema },
    responses: {
      201: { description: "The ask, filed", schema: AccessAskReceiptSchema },
      200: {
        description: "Nothing new to ask: each pair's state",
        schema: AccessAskReceiptSchema,
      },
      400: {
        description:
          "Invalid body, or a pair that names no space (ASK_NEEDS_SPACE)",
        schema: ErrorSchema,
      },
      403: {
        description:
          "Not an agent's own key acting for its person (NOT_AN_AGENT_KEY), a permission outside the agent's limits (ASK_BEYOND_AGENT_LIMIT), or a pair the person cannot give (ASK_NOT_ON_OFFER)",
        schema: ErrorSchema,
      },
    },
  });
  app.post("/agents/access-requests", async (c) => {
    if (!canAsk(c)) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const body = AgentAccessAskBodySchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const receipt = await fileAgentAccessAsk({
        apiKeyId: c.get("apiKeyId"),
        callerUserId: userId,
        pairs: body.data.requests,
        reason: body.data.reason ?? null,
      });
      return c.json(receipt, receipt.id ? 201 : 200);
    } catch (err) {
      return askFailed(c, err, "POST /agents/access-requests");
    }
  });

  registerOpenApi(app, {
    method: "get",
    path: "/agents/access-requests/{id}",
    tags: ["Agents"],
    summary: "What became of an agent's ask",
    description:
      "With the agent's own key: pending, allowed, declined (Not now) or expired. An agent reads only its own asks.",
    request: { params: AccessAskParamsSchema },
    responses: {
      200: { description: "The ask", schema: AccessAskViewSchema },
      400: { description: "Invalid id", schema: ErrorSchema },
      403: { description: "Not an agent's own key", schema: ErrorSchema },
      404: { description: "No such ask of this agent", schema: ErrorSchema },
    },
  });
  app.get("/agents/access-requests/:id", async (c) => {
    if (!canAsk(c)) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const askId = requireUuidParam(c, "id");
    if (askId instanceof Response) return askId;
    try {
      return c.json(
        await readAgentAccessAsk({
          apiKeyId: c.get("apiKeyId"),
          callerUserId: userId,
          askId,
        })
      );
    } catch (err) {
      return askFailed(c, err, "GET /agents/access-requests/:id");
    }
  });

  /**
   * POST /agents/sync — synchronise an intelligence service's agent registry.
   *
   * Receives a list of agent definitions from the IS / orchestrator and persists
   * them as the canonical source of truth for that service's agents.
   *
   * Logic:
   *   - Upserts each supplied agent (by service + slug uniqueness)
   *   - Resolves-or-creates the agent-USER for each synced agent and backfills
   *     `agents.userId` when it is still NULL (see §1b)
   *   - Deactivates any agent previously known for this service that is
   *     absent from the incoming payload (active = false, no delete)
   */
  app.post("/agents/sync", async (c) => {
    const stale = refuseStaleDeviceSession(c);
    if (stale) return stale;
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const body = SyncAgentsPayload.safeParse(await c.req.json());
    if (!body.success) {
      return c.json(
        {
          error: "Validation failed",
          details: body.error.flatten().fieldErrors,
        },
        400
      );
    }

    const { serviceId, agents: agentsPayload } = body.data;

    let resolvedServiceId: string | null = null;

    // Resolve the service by EITHER its primary id OR its stable serviceId text
    // key. The IS sends its serviceId (e.g. "synap-hub"), not the pod-assigned
    // row id — matching only on id is why agent sync silently 404'd.
    try {
      const service = await db
        .select({ id: intelligenceServices.id })
        .from(intelligenceServices)
        .where(
          or(
            eq(intelligenceServices.id, serviceId),
            eq(intelligenceServices.serviceId, serviceId)
          )
        )
        .limit(1);
      resolvedServiceId = service[0]?.id ?? null;
    } catch (err) {
      // A DB error here is infrastructure, not a lookup miss — surface it as 500
      // rather than masquerading as "service not found".
      logger.error(
        { err, serviceId },
        "Failed to resolve intelligence service"
      );
      return c.json(
        { error: "Failed to resolve intelligence service" },
        httpStatusForTrpcError(err)
      );
    }

    if (!resolvedServiceId) {
      return c.json(
        { error: `Intelligence service not found: ${serviceId}` },
        404
      );
    }

    try {
      // ── 1. Upsert each agent ──────────────────────────────────────────────────
      //
      // §1b IDENTITY: `agents.userId` is the agent-USER (the principal channels
      // address and writes are attributed to), NOT the human owner. The
      // local-adjunct path sets it; this door never did, so an IS-synced agent
      // had NO channel-postable identity at all. Resolved-or-created below via
      // the ONE agent-user door (`findOrCreateServiceAgentUser`) and linked with
      // the existing `linkAgentToUser`.
      //
      // The creator is the POD OWNER, not `c.get("userId")`: the request identity
      // for an IS service key can be the "system" sentinel (no `users` row — see
      // hub-protocol-rest.ts §is_internal), which would violate the
      // `users.created_by_user_id` FK, and keying on "whichever key ran the sync"
      // would make a pod-wide agent's identity depend on who synced it. The pod
      // owner is deterministic and pod-level, matching `ownerType:"synap"`.
      // Null on a pre-bootstrap pod (no pod-admin workspace) ⇒ identity linking
      // is skipped and the roster sync still succeeds.
      const creatorId = await resolvePodOwnerUserId();
      if (!creatorId) {
        logger.warn(
          { serviceId },
          "POST /agents/sync: no pod owner resolved — synced agents will have no agent-user identity (agents.userId stays NULL)"
        );
      }

      let syncedCount = 0;
      let linkedCount = 0;
      for (const agent of agentsPayload) {
        const upserted = await db
          .insert(agents)
          .values({
            id: agent.id,
            name: agent.name,
            slug: agent.slug,
            description: agent.description ?? null,
            icon: agent.icon ?? null,
            capabilities: agent.capabilities,
            metadata: agent.metadata,
            active: true,
            ownerType: "synap",
            intelligenceServiceId: resolvedServiceId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [agents.intelligenceServiceId, agents.slug],
            set: {
              // NOT id — the conflict target identifies the row; rewriting the
              // PK to the incoming id can collide with another row's id.
              name: agent.name,
              description:
                agent.description ?? drizzleSql`${agents.description}`,
              icon: agent.icon ?? drizzleSql`${agents.icon}`,
              capabilities: agent.capabilities,
              metadata: agent.metadata,
              active: true,
              ownerType: "synap",
              intelligenceServiceId: resolvedServiceId,
              updatedAt: new Date(),
            },
          })
          .returning({ insertedId: agents.id, userId: agents.userId });

        if (upserted.length > 0) {
          syncedCount++;
        }

        // §1b — backfill the agent-user link. ONLY when still NULL: an existing
        // link (e.g. one a local-adjunct flow or an earlier sync established) is
        // authoritative and must never be repointed by a roster refresh.
        const row = upserted[0];
        if (creatorId && row && !row.userId) {
          try {
            const { agentUserId } = await findOrCreateServiceAgentUser({
              creatorId,
              // The agent's slug IS the `agentType` the IS is addressed by (the
              // same string chat-stream.ts hands the IS), so the agent-user
              // singleton key (creator × agentType) is one principal per synced
              // agent — never one shared principal for the whole service.
              agentType: agent.slug,
              label: agent.name,
              metadata: {
                description: agent.description ?? undefined,
                capabilities: agent.capabilities,
              },
              createdVia: "intelligence-service",
              logger,
            });
            await linkAgentToUser(row.insertedId, agentUserId);
            linkedCount++;
          } catch (err) {
            // Non-fatal PER AGENT: the roster sync is what keeps agent routing
            // alive, so one un-mintable identity must not take the whole roster
            // down. Loud + counted (`linked` in the response) so this is never a
            // silent partial success.
            logger.error(
              { err, serviceId, agentSlug: agent.slug },
              "POST /agents/sync: could not resolve agent-user identity for synced agent (agents.userId left NULL)"
            );
          }
        }
      }

      // ── 2. Deactivate agents that were not in the payload ─────────────────────
      // An empty payload means "deactivate everything for this service".
      // For a non-empty payload, deactivate only the agents whose slug is NOT in
      // the payload. Earlier this used a hand-built `NOT EXISTS (VALUES ...)`
      // subquery, but interpolating `agentsPayload.map(a => sql`${a.slug}`)`
      // into a single `VALUES` clause produced malformed SQL (the chunks were
      // concatenated without row separators), so it spuriously deactivated
      // agents that WERE in the payload — collapsing the roster to a single
      // agent on every sync. `notInArray` is the correct, safe primitive.
      const payloadSlugs = agentsPayload.map((a) => a.slug);
      const deactivatedResult =
        agentsPayload.length === 0
          ? await db
              .update(agents)
              .set({ active: false, updatedAt: new Date() })
              .where(
                and(
                  eq(agents.intelligenceServiceId, resolvedServiceId),
                  eq(agents.active, true)
                )
              )
              .returning({ id: agents.id })
          : await db
              .update(agents)
              .set({ active: false, updatedAt: new Date() })
              .where(
                and(
                  eq(agents.intelligenceServiceId, resolvedServiceId),
                  eq(agents.active, true),
                  notInArray(agents.slug, payloadSlugs)
                )
              )
              .returning({ id: agents.id });

      const deactivatedCount = deactivatedResult.length;

      return c.json({
        status: "success",
        synced: syncedCount,
        /** Agents whose NULL `agents.userId` this sync backfilled (§1b). */
        linked: linkedCount,
        deactivated: deactivatedCount,
      });
    } catch (err) {
      logger.error({ err, serviceId }, "POST /agents/sync failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
