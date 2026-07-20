/**
 * MCP to Hub Protocol Adapter
 *
 * This adapter allows MCP to use the existing Hub Protocol API,
 * ensuring all operations go through the same event sourcing,
 * validation, security, and worker infrastructure.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { hubProtocolRouter } from "../hub-protocol/index.js";
import { entitiesRouter as regularEntitiesRouter } from "../entities.js";
import { skillsRouter as regularSkillsRouter } from "../skills.js";
import { projectsRouter } from "../projects.js";
import { playbooksRouter } from "../playbooks.js";
import { createHubProtocolCallerContext } from "../hub-protocol/utils.js";
import { validateCreateVerbInput } from "./validate-create-verb.js";
import {
  getObjectGraph,
  resolveByName,
  resolveProfileByName,
  type GraphNeighbor,
  type GraphEnvelope,
} from "../../services/object-graph/graph-service.js";
import { entityDataNeighbors } from "../../services/object-graph/entity-data-graph.js";
import type { LinkEndpointType } from "@synap/playbooks";
import { ask } from "../../services/knowledge/ask.js";
import { synthesizeAnswer } from "../../services/knowledge/synthesize.js";
import {
  type ProfileCatalogEntry,
  toProfileCatalogEntry,
} from "../../services/retrieval/index.js";
import { getDb } from "@synap/database";
import {
  db,
  knowledgeKeysRepository,
  entities,
  tools as toolsTable,
  eq,
  and,
  or,
  isNull,
  resolveIdentity,
  extractIdentitySignals,
  signalsFromExplicit,
  type IdentitySignal,
  type ProviderVerbSpec,
} from "@synap/database";
import { getUserWorkspaceIds } from "../hub-protocol/rest/_shared.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { buildIdentityResolveResponse } from "../../utils/identity-resolve-response.js";
import { openLink } from "../../utils/deep-links.js";
import type { Context } from "../../types/context.js";

// ── tRPC caller factory ───────────────────────────────────────────────────────

async function createHubProtocolCaller(
  userId: string,
  scopes: string[],
  agentUserId?: string,
  sessionId?: string | null
) {
  await getDb();

  // MCP keys use mcp.read / mcp.write scopes. Hub Protocol procedures require
  // hub-protocol.read / hub-protocol.write. Translate at the boundary so callers
  // only need to mint mcp.* keys — no hub-protocol.* knowledge required.
  const hubScopes = Array.from(
    new Set([
      ...scopes,
      ...(scopes.includes("mcp.read") ? ["hub-protocol.read"] : []),
      ...(scopes.includes("mcp.write")
        ? ["hub-protocol.read", "hub-protocol.write"]
        : []),
    ])
  );

  const ctx: Context & {
    scopes?: string[];
    apiKeyId?: string;
    apiKeyName?: string;
  } = {
    db,
    authenticated: true,
    userId,
    // When set (agent-key remap), `userId` is the operator and `agentUserId` is
    // the acting agent — write procs gate on agentUserId so they propose.
    agentUserId: agentUserId ?? null,
    // Link every write in this MCP call to the agent's active focus session so
    // its proposals/entities group under the run. The hub routers propagate
    // ctx.sessionId downward (see hub-protocol/entities.ts createEntity).
    sessionId: sessionId ?? null,
    scopes: hubScopes,
    apiKeyId: "mcp",
    apiKeyName: "MCP Server",
    req: undefined,
    user: null,
    session: null,
  };

  return hubProtocolRouter.createCaller(ctx);
}

// ── Tool result helpers ───────────────────────────────────────────────────────

/**
 * Extract the primary object id from a tool result, in field-priority order:
 *   proposalId → id → entityId → documentId → viewId → channelId →
 *   sessionId → knowledgeKey.id → nested data.id → wrapped channel.id /
 *   document.id
 * First string hit wins; returns undefined when none is present.
 *
 * `messageId` is intentionally excluded — messages aren't openable, and
 * post_message already resolves via `channelId` (which precedes it here).
 */
function primaryObjectId(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data))
    return undefined;
  const d = data as Record<string, unknown>;
  const keys = [
    "proposalId",
    "id",
    "entityId",
    "documentId",
    "viewId",
    "channelId",
    "sessionId",
  ] as const;
  for (const key of keys) {
    const v = d[key];
    if (typeof v === "string" && v) return v;
  }
  const kk = d.knowledgeKey as Record<string, unknown> | undefined;
  if (kk && typeof kk.id === "string" && kk.id) return kk.id;
  const nested = d.data as Record<string, unknown> | undefined;
  if (
    nested &&
    typeof nested === "object" &&
    typeof nested.id === "string" &&
    nested.id
  ) {
    return nested.id;
  }
  // Wrapped detail shapes: get_channel → { channel: { id } }, get_document →
  // { document: { id } }. Both wrappers are openable, so their nested id yields a
  // valid link. Only these known wrappers — never a generic deep scan.
  for (const wrapper of ["channel", "document"] as const) {
    const w = d[wrapper] as Record<string, unknown> | undefined;
    if (w && typeof w === "object" && typeof w.id === "string" && w.id) {
      return w.id;
    }
  }
  return undefined;
}

/**
 * AI Teaching Substrate: the one reinforcement line every 'proposed' write
 * result carries — added HERE (the one response shaper every handler already
 * flows through), never per-case, so it can't be forgotten on a new door.
 */
const PROPOSAL_REINFORCEMENT_HINT =
  "Tell the user why you proposed this and give them this link.";

/**
 * The hint a DEDUPED write carries: an identical proposal was already pending, so
 * the door returned it instead of creating a second. Tells the agent to stop
 * re-proposing and point the user at the existing review instead.
 */
const PROPOSAL_DUPLICATE_HINT =
  "An identical proposal is already pending review — this did NOT create a new one. Do not re-propose; give the user this link to the existing proposal.";

function ok(data: unknown): CallToolResult {
  // Best-effort: inject the canonical clickable `link` (`${PUBLIC_URL}/open/<id>`)
  // ONLY when the result carries an id that resolves to an openable object
  // (proposal / entity / view / document / channel — see primaryObjectId). Every
  // handler flows through this one shaper, so no per-handler edits are needed;
  // arrays, id-less objects, and non-openable ids simply get no link.
  const id = primaryObjectId(data);
  let payload =
    id && data && typeof data === "object" && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), link: openLink(id) }
      : data;
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    // Two proposed shapes flow through here: governed writes ({status:
    // "proposed"}) and executeCapability outcomes ({kind: "proposed"}).
    ((payload as Record<string, unknown>).status === "proposed" ||
      (payload as Record<string, unknown>).kind === "proposed")
  ) {
    // DUPLICATE surfacing (one place, every governed-write door): when the write
    // was deduped at the DB door (`deduped: true` rode up on the result), rewrite
    // the outcome to `status: "duplicate"` + a stop-re-proposing hint so the agent
    // learns an identical proposal is already pending. Otherwise keep the normal
    // "proposed" reinforcement hint (respecting a hint a handler already set).
    const p = payload as Record<string, unknown>;
    const deduped = p.deduped === true;
    payload = {
      ...p,
      ...(deduped ? { status: "duplicate" } : {}),
      hint: deduped
        ? PROPOSAL_DUPLICATE_HINT
        : "hint" in p
          ? p.hint
          : PROPOSAL_REINFORCEMENT_HINT,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function requireScope(scopes: string[], scope: string, toolName: string): void {
  if (!scopes.includes(scope)) {
    // Reachable over HTTP only since the door started honouring the key's own
    // scopes (http-handler.ts deriveMcpScopes); it previously received a
    // hardcoded read+write and could never fail. Name the recovery, not just
    // the denial — this surfaces to the model as recoverable text.
    throw new Error(
      `Tool '${toolName}' requires the '${scope}' scope, which your API key does not grant (it has: ${scopes.length ? scopes.join(", ") : "none"}). ` +
        `Mint a key with the '${scope}' scope in Synap settings → Intelligence → API Keys, or use a read-only tool instead.`
    );
  }
}

// ── Tool execution ────────────────────────────────────────────────────────────

/**
 * Build the uniform graph envelope for any object — the shared core behind both
 * `synap_get_graph` and the `neighbors` embedded in detail fetches (get_entity).
 * Folds in the entity-data graph (relations + property + channel) for
 * entity-backed kinds via the shared `entityDataNeighbors`. `cap` truncates the
 * neighbour list for embedding (counts stay full — honest "showing N of M").
 */
async function buildGraphEnvelope(
  userId: string,
  scopes: string[],
  kind: string,
  id: string,
  cap?: number
): Promise<GraphEnvelope> {
  const extra: GraphNeighbor[] =
    kind === "entity" || kind === "project"
      ? await entityDataNeighbors(userId, scopes, id)
      : [];
  const envelope = await getObjectGraph(
    userId,
    kind as LinkEndpointType,
    id,
    extra
  );
  if (cap && envelope.neighbors.length > cap) {
    return { ...envelope, neighbors: envelope.neighbors.slice(0, cap) };
  }
  return envelope;
}

export async function executeMCPToolViaHubProtocol(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
  apiKeyScopes: string[],
  _sessionUserId?: string,
  agentUserId?: string
): Promise<CallToolResult> {
  // Normalize once: sessionId flows to a `uuid` DB column, so a non-string arg
  // is dropped here rather than `as`-cast blindly. (Malformed UUID *strings* are
  // still rejected downstream by the mutation inputs' zod `.uuid()` schemas.)
  // Reused by every write case below.
  const sessionId =
    typeof args.sessionId === "string" ? args.sessionId : undefined;

  const caller = await createHubProtocolCaller(
    userId,
    apiKeyScopes,
    agentUserId,
    sessionId
  );

  switch (toolName) {
    // ── Recall: THE one door ──────────────────────────────────────────────────
    // `synap_ask` is the unified recall verb — it replaces the old fragmented
    // search / search_entities / recall_facts / get_knowledge / list_knowledge
    // tools. It routes by query intent across all three substrates (semantic
    // entities, procedural knowledge_keys, episodic facts) and returns ONE
    // provenance-tagged answer. Fewer tools = better selection = the AI actually
    // reaches for recall before acting.
    case "synap_ask": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      if (typeof args.query !== "string" || args.query.trim() === "") {
        return ok({ error: "query is required" });
      }
      const workspaceId = args.workspaceId as string | undefined;
      // The semantic engine's catalog (type inference) needs a concrete
      // workspace; resolve the user's first accessible one when no lens is
      // pinned. Recall itself keeps the caller's lens (undefined = pod-wide).
      let catalogWs = workspaceId;
      if (!catalogWs) {
        const wsIds = await getUserWorkspaceIds(userId);
        catalogWs = wsIds[0];
      }
      let catalog: ProfileCatalogEntry[] = [];
      if (catalogWs) {
        const { profiles: profileRows } = await caller.profiles.listProfiles({
          userId,
          workspaceId: catalogWs,
        });
        catalog = profileRows.flatMap((p) => {
          const entry = toProfileCatalogEntry(p);
          return entry ? [entry] : [];
        });
      }
      const compare = args.compare === true;
      // Retrieve across all substrates (same call as /knowledge/search).
      const retrieved = await ask({
        query: args.query as string,
        userId,
        workspaceId: workspaceId ?? null,
        projectId: (args.projectId as string | undefined) ?? null,
        limit: (args.limit as number) || undefined,
        catalog,
        compare: compare || undefined,
      });

      // A/B DIAGNOSTIC — when `compare` is set, return the ranker comparison
      // (baseline vs Horizon on the same pool) directly, skipping IS synthesis.
      // Read-only: this is a ranking diff, not an answer.
      if (compare) {
        return ok({
          mode: "compare",
          query: args.query,
          understanding: retrieved.understanding,
          comparison: retrieved.comparison ?? null,
        });
      }

      // Build context + sources, then synthesize via IS.
      const synthesis = await synthesizeAnswer(
        retrieved.answers,
        args.query as string,
        retrieved.routedTo,
        workspaceId ?? null
      );
      // Surface synthesis outages loudly instead of returning a null answer that
      // looks like "no results". Retrieval/sources still stand.
      if ((synthesis as { error?: string }).error === "synthesis_unavailable") {
        return ok({
          ...synthesis,
          message:
            "⚠️ AI synthesis is temporarily unavailable. The matched sources below are real; tell the user the AI answer layer is degraded (not that nothing was found).",
        });
      }
      return ok(synthesis);
    }

    case "synap_get_entities": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const profileSlug =
        (args.profileSlug as string | undefined) ||
        (args.type as string | undefined);
      const result = await caller.entities.getEntities({
        userId,
        profileSlug: profileSlug || undefined,
        ...(args.workspaceId
          ? { workspaceId: args.workspaceId as string }
          : {}),
        // Project-pinned MCP URL (?projectId=) auto-injects args.projectId, so a
        // focused agent's entity reads narrow to its project — same lens as ask.
        ...(args.projectId ? { projectId: args.projectId as string } : {}),
        // Kind + Facets: narrow to entities carrying a live facet of this role.
        ...(args.facetSlug ? { facetSlug: args.facetSlug as string } : {}),
        limit: (args.limit as number) || 50,
      });
      return ok(result);
    }

    case "synap_get_document": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const result = await caller.documents.getDocument({
        userId,
        documentId: args.documentId as string,
      });
      return ok(result);
    }

    case "synap_get_thread_context": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const result = await caller.context.getThreadContext({
        threadId: args.threadId as string,
      });
      return ok(result);
    }

    case "synap_list_proposals": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const { listCreatedProposals } =
        await import("../../services/proposals/proposals-service.js");
      const result = await listCreatedProposals({
        createdBy: (args.userId as string) || userId,
        workspaceId: args.workspaceId as string | undefined,
        status: args.status as string | undefined,
        limit: (args.limit as number) || undefined,
      });
      return ok(result);
    }

    case "synap_diagnose": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const { listRuns, getRun } = await import("../../services/runs/index.js");
      const flowType = args.flowType as
        "automation" | "playbook" | "capture" | "session" | undefined;
      // With a runId → that run's activity timeline (a capture's decision + trace
      // events: what happened and WHY, each with a fixHint). Without → the feed.
      if (args.runId) {
        if (!flowType) {
          return ok({ error: "flowType is required when runId is given" });
        }
        const detail = await getRun({
          userId,
          flowType,
          id: args.runId as string,
        });
        return ok(detail ?? { error: "Run not found" });
      }
      const runs = await listRuns({
        userId,
        flowType,
        flowId: args.flowId as string | undefined,
        limit: (args.limit as number) || undefined,
      });
      return ok({ runs });
    }

    // ── Write tools ─────────────────────────────────────────────────────────
    case "synap_create_entity": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const result = await caller.entities.createEntity({
        userId,
        profileSlug:
          (args.profileSlug as string | undefined) ||
          (args.type as string | undefined),
        title: args.title as string,
        description: args.description as string | undefined,
        properties: args.properties as Record<string, unknown> | undefined,
        // A project-pinned MCP URL (?projectId=) auto-injects args.projectId, so
        // entities the agent creates are filed into its project focus.
        ...(args.projectId ? { projectId: args.projectId as string } : {}),
        // Kind + Facets: attach role-profiles in the same create call (governed
        // via entities.attachFacet on the created entity).
        ...(Array.isArray(args.facets)
          ? {
              facets: args.facets as Array<{
                slug: string;
                properties?: Record<string, unknown>;
              }>,
            }
          : {}),
        // agent-key remap: the write is OWNED by the operator (userId) but
        // AUTHORED by the agent — pass agentUserId so governance proposes.
        ...(agentUserId ? { agentUserId } : {}),
        aiMetadata: { model: "mcp", reasoning: `MCP tool: ${toolName}` },
      });
      return ok(result);
    }

    case "synap_update_entity": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const result = await caller.entities.updateEntity({
        entityId: args.entityId as string,
        userId,
        title: args.title as string | undefined,
        preview: args.description as string | undefined,
        // properties merges into the JSONB column; metadata is a legacy alias
        metadata: (args.properties ?? args.metadata) as
          Record<string, unknown> | undefined,
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    case "synap_create_document": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const result = await caller.documents.createDocument({
        userId,
        workspaceId: args.workspaceId as string,
        title: args.title as string,
        content: (args.content as string) || "",
        reasoning: "Created via MCP",
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    case "synap_remember_fact": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const { rememberFact } =
        await import("../../services/knowledge/remember-fact.js");
      await rememberFact({
        userId: (args.userId as string) || userId,
        fact: args.fact as string,
      });
      return ok({ success: true, message: "Fact stored successfully" });
    }

    case "synap_get_entity": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      // Hub protocol doesn't expose a single-entity get; use regular entities router
      const entityCallerCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        (args.workspaceId as string) || undefined,
        undefined,
        undefined,
        agentUserId
      );
      const entityCaller = regularEntitiesRouter.createCaller(entityCallerCtx);
      const entityResult = await entityCaller.get({
        id: args.entityId as string,
        includeProfile: true,
      });
      // Graph by default: embed a capped typed-neighbour summary so the agent
      // sees the entity's place in the pod without a second call. Additive +
      // best-effort — never let the graph half break the entity read.
      let graph: GraphEnvelope | undefined;
      try {
        graph = await buildGraphEnvelope(
          userId,
          apiKeyScopes,
          "entity",
          args.entityId as string,
          20
        );
      } catch {
        graph = undefined;
      }
      return ok(
        graph
          ? { ...(entityResult as Record<string, unknown>), graph }
          : entityResult
      );
    }

    case "synap_list_profiles": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const wsId = args.workspaceId as string | undefined;
      const wantFull = (args.detail as string | undefined) === "full";

      /** Map a raw profile row to the lightweight digest shape. */
      const toDigest = (
        p: Record<string, unknown>,
        workspaceId?: string
      ): Record<string, unknown> => {
        const base: Record<string, unknown> = {
          id: p.id,
          slug: p.slug,
          displayName: p.displayName,
          entityScope: p.entityScope,
          // Visibility axis (who can use this profile type) — distinct from
          // entityScope (placement: where its entities live).
          scope: p.scope ?? null,
          description: p.description ?? null,
          icon: p.icon ?? null,
          // Kind + Facets discriminator — lets an agent tell a primary type
          // (kind) from an attachable facet (role) before creating entities.
          profileKind: p.profileKind ?? "kind",
          applicableKinds: p.applicableKinds ?? null,
        };
        if (workspaceId !== undefined) base.workspaceId = workspaceId;
        return base;
      };

      if (wsId) {
        const result = await caller.profiles.listProfiles({
          userId,
          workspaceId: wsId,
        });
        if (wantFull) return ok(result);
        const profiles = Array.isArray(result)
          ? result
          : ((result as unknown as { profiles: unknown[] }).profiles ?? []);
        return ok(
          (profiles as Array<Record<string, unknown>>).map((p) => toDigest(p))
        );
      }
      const wsIds = await getUserWorkspaceIds(userId);
      if (wsIds.length === 0) return ok([]);
      const perWs = await Promise.all(
        wsIds.map((id) =>
          caller.profiles
            .listProfiles({ userId, workspaceId: id })
            .then((res) =>
              res.profiles.map(
                (p) =>
                  ({
                    ...(p as Record<string, unknown>),
                    workspaceId: id,
                  }) as Record<string, unknown>
              )
            )
            .catch(() => [] as Array<Record<string, unknown>>)
        )
      );
      const seen = new Set<string>();
      const merged: Array<Record<string, unknown>> = [];
      for (const profiles of perWs) {
        for (const p of profiles) {
          const slug = p.slug as string;
          if (!seen.has(slug)) {
            seen.add(slug);
            merged.push(wantFull ? p : toDigest(p, p.workspaceId as string));
          }
        }
      }
      return ok(merged);
    }

    case "synap_get_relations": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      let relWsId = args.workspaceId as string | undefined;
      if (!relWsId) {
        const ids = await getUserWorkspaceIds(userId);
        relWsId = ids[0];
      }
      if (!relWsId) return ok({ error: "No accessible workspace found" });
      const result = await caller.relations.listRelations({
        userId,
        workspaceId: relWsId,
        entityId: args.entityId as string,
      });
      return ok(result);
    }

    case "synap_resolve_identity": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      // Read-only identity pre-check via the ONE matcher. Same call the REST
      // /identity/resolve route makes — resolved here directly (no HTTP hop),
      // mirroring how synap_get_entity uses the entities router in-process.
      // Explicit atoms via the ONE shared mapper (same as the REST route), plus
      // any mined from the draft property bag (richest lookup).
      const signals: IdentitySignal[] = [
        ...signalsFromExplicit(
          args.signals as Parameters<typeof signalsFromExplicit>[0]
        ),
        ...extractIdentitySignals(
          args.properties as Record<string, unknown> | undefined
        ),
      ];

      const resolution = await resolveIdentity(db, {
        userId,
        kindSlug: args.kindSlug as string | undefined,
        name: args.title as string | undefined,
        signals,
        // Identity is global (a subject exists once pod-wide) → scope the weak
        // path to the user's visible rows, not a single workspace.
        userScope: userVisibleWhere(entities.workspaceId, userId),
        limit: 10,
      });

      // Cross-user content scoping lives in the shared response builder (the
      // one door for both this tool and the Hub REST /identity/resolve route).
      return ok(await buildIdentityResolveResponse(resolution, userId));
    }

    case "synap_get_graph": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const gKind = (args.type as string | undefined) ?? "entity";
      let gId = args.id as string | undefined;
      // Name-addressing: fetch the graph by NAME instead of id. Resolve the name
      // to an object first; ambiguous names return the candidates to pick from.
      if (!gId && args.name) {
        const matches = await resolveByName(
          userId,
          gKind,
          args.name as string,
          args.subtype as string | undefined
        );
        if (matches.length === 0) {
          // The name matched no entity of this kind — but it may be a
          // profile/role type name. Probe profiles and route the caller to the
          // right tool instead of dead-ending.
          const profileHits = await resolveProfileByName(
            userId,
            args.name as string
          );
          if (profileHits.length > 0) {
            return ok({
              error: `'${args.name}' is a profile/role, not a ${gKind}. get_graph resolves entities, not types.`,
              candidates: profileHits,
              hint: profileHits.some((p) => p.profileKind === "role")
                ? "This is a role (facet). Use synap_list_profiles to inspect it, synap_attach_facet to attach it to an entity, or synap_define_role to edit it."
                : "This is a kind. Use synap_list_profiles to inspect its schema, or synap_get_entities to list entities of this type.",
            });
          }
          return ok({ error: `No ${gKind} named '${args.name}'` });
        }
        if (matches.length > 1)
          return ok({
            ambiguous: true,
            message: `Multiple ${gKind}s named '${args.name}' — pass id`,
            matches,
          });
        gId = matches[0].id;
      }
      if (!gId) return ok({ error: "id or name is required" });
      const envelope = await buildGraphEnvelope(
        userId,
        apiKeyScopes,
        gKind,
        gId
      );
      return ok(envelope);
    }

    case "synap_link_entities": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      let linkWsId = args.workspaceId as string | undefined;
      if (!linkWsId) {
        const ids = await getUserWorkspaceIds(userId);
        linkWsId = ids[0];
      }
      if (!linkWsId) return ok({ error: "No accessible workspace found" });
      const result = await caller.relations.createRelation({
        userId,
        workspaceId: linkWsId,
        sourceEntityId: args.sourceEntityId as string,
        targetEntityId: args.targetEntityId as string,
        type: (args.type as string) || "related",
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    // ── Kind + Facets: attach/detach a role-profile ─────────────────────────
    // Both go through the SAME governed door as the tRPC/Hub REST facet routes
    // (hub-protocol entities.attachFacet/detachFacet → regular entities.*Facet,
    // which run checkPermissionOrPropose). The agent-key remap (agentUserId)
    // makes governance propose for agent callers, exactly like create_entity.
    case "synap_attach_facet": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const result = await caller.entities.attachFacet({
        userId,
        entityId: args.entityId as string,
        profileSlug: args.facetSlug as string,
        ...(args.properties
          ? { properties: args.properties as Record<string, unknown> }
          : {}),
        ...(args.workspaceId
          ? { workspaceId: args.workspaceId as string }
          : {}),
        ...(args.contextEntityId
          ? { contextEntityId: args.contextEntityId as string }
          : {}),
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    case "synap_detach_facet": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // The one-door detach is keyed by facetId. Accept a facetId directly (the
      // handle attach returns), or resolve entityId + facetSlug → facetId via the
      // entity's live facets (the ergonomic form an agent knows), then detach
      // through the SAME governed door — a lookup before the door, not a bypass.
      let facetId = args.facetId as string | undefined;
      if (!facetId) {
        const entityId = args.entityId as string | undefined;
        const facetSlug = args.facetSlug as string | undefined;
        if (!entityId || !facetSlug) {
          return ok({
            error:
              "Provide facetId, or entityId + facetSlug, to detach a facet",
          });
        }
        const entityCallerCtx = await createHubProtocolCallerContext(
          userId,
          apiKeyScopes,
          (args.workspaceId as string) || undefined,
          undefined,
          undefined,
          agentUserId
        );
        const entityCaller =
          regularEntitiesRouter.createCaller(entityCallerCtx);
        const entityResult = await entityCaller.get({
          id: entityId,
          includeProfile: true,
          ...(args.workspaceId
            ? { workspaceId: args.workspaceId as string }
            : {}),
        });
        const facets =
          (
            entityResult as {
              facets?: Array<{
                facet: { id: string; workspaceId: string | null };
                profile: { slug?: string };
              }>;
            }
          ).facets ?? [];
        const matches = facets.filter((f) => f.profile?.slug === facetSlug);
        if (matches.length === 0) {
          return ok({
            error: `No live '${facetSlug}' facet on entity ${entityId}`,
          });
        }
        if (matches.length > 1) {
          // Same role attached in more than one workspace lens — picking the
          // first would detach a nondeterministic one, and the proposal card
          // keys on the opaque facetId so a reviewer wouldn't catch it. Make
          // the caller choose: pass workspaceId to narrow the lens, or the
          // exact facetId.
          return ok({
            error: `Entity ${entityId} carries ${matches.length} live '${facetSlug}' facets — pass workspaceId or an explicit facetId`,
            candidates: matches.map((f) => ({
              facetId: f.facet.id,
              workspaceId: f.facet.workspaceId,
            })),
          });
        }
        facetId = matches[0].facet.id;
      }
      const result = await caller.entities.detachFacet({
        userId,
        facetId,
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    // Mint a NEW role type (Kind + Facets). Goes through the SAME governed door
    // as tRPC/Hub profile creation (hub-protocol profiles.createProfile →
    // regular profiles.create → checkPermissionOrPropose). profileKind:'role'
    // + a non-empty applicableKinds is what makes it an attachable facet type
    // rather than a primary entity kind.
    case "synap_define_role": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const applicableKinds =
        Array.isArray(args.applicableKinds) && args.applicableKinds.length > 0
          ? (args.applicableKinds as string[])
          : ["company", "person"];
      const uiHints: Record<string, unknown> = {};
      if (typeof args.icon === "string") uiHints.icon = args.icon;
      if (typeof args.description === "string")
        uiHints.description = args.description;
      const result = await caller.profiles.createProfile({
        userId,
        workspaceId: args.workspaceId as string,
        slug: args.slug as string,
        displayName: args.displayName as string,
        profileKind: "role",
        applicableKinds,
        ...(Object.keys(uiHints).length > 0 ? { uiHints } : {}),
        ...(args.properties
          ? { defaultValues: args.properties as Record<string, unknown> }
          : {}),
        reasoning: "Role type defined via MCP synap_define_role",
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    // (synap_send_message removed — synap_post_message supersedes it: it handles
    // thread creation from a channelId and can trigger an AI response. One
    // messaging tool, not two.)

    // ── Session bootstrap & governance ──────────────────────────────────────
    // Canonical lens map — delegates to the shared `discover()` service (the ONE
    // place that shapes orient output; the REST /orient route + CLI `orient` go
    // through the same function). ZERO bespoke data fetching here. `scope`
    // subsumes the former synap_list_projects tool (scope:['projects']).
    case "synap_orient": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const { discover } = await import("../../services/discover/discover.js");
      const result = await discover({
        caller,
        userId,
        authScopes: apiKeyScopes,
        detail: (args.detail as "light" | "full" | undefined) ?? "light",
        scope: args.scope as
          Array<"workspaces" | "projects" | "profiles"> | undefined,
        workspaceId: args.workspaceId as string | undefined,
        projectId: args.projectId as string | undefined,
      });
      return ok(result);
    }

    // ── Focus sessions (work tracking) ──────────────────────────────────────
    case "synap_start_session": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const { createFocusSession } =
        await import("../../services/focus-sessions/create-session.js");
      const result = await createFocusSession({
        userId,
        workspaceId: args.workspaceId as string | undefined,
        projectId: args.projectId as string | undefined,
        subjectEntityId: args.subjectEntityId as string | undefined,
        goal: args.goal as string,
        agentUserId,
        correlationId: args.correlationId as string | undefined,
        channelId: args.channelId as string | undefined,
        agentIds: args.agentIds as string[] | undefined,
        templateId: args.templateId as string | undefined,
        expectedOutputs: args.expectedOutputs as
          | Array<{
              kind: string;
              label: string;
              icon?: string;
              status?: "pending" | "done";
            }>
          | undefined,
      });
      return ok(result);
    }

    case "synap_complete_session": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const { completeFocusSession } =
        await import("../../services/focus-sessions/complete-session.js");
      const session = await completeFocusSession({
        sessionId: args.sessionId as string,
        userId,
        agentUserId,
        summary: args.summary as string | undefined,
        verificationReport: args.verificationReport as
          Record<string, unknown> | undefined,
      });
      if (!session) {
        return ok({ error: `Focus session ${args.sessionId} not found` });
      }
      return ok({ status: "closed", session });
    }

    case "synap_update_session": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const { updateFocusSession } =
        await import("../../services/focus-sessions/update-session.js");
      const result = await updateFocusSession({
        sessionId: args.sessionId as string,
        userId,
        agentUserId,
        goal: args.goal as string | undefined,
        status: args.status as "active" | "paused" | undefined,
        progress: args.progress as number | undefined,
        currentStage: args.currentStage as string | undefined,
        addOutput: args.addOutput as
          { kind: string; label: string; icon?: string } | undefined,
        completeOutput: args.completeOutput as string | undefined,
        expectedOutputs: args.expectedOutputs as
          | Array<{
              kind: string;
              label: string;
              icon?: string;
              status?: "pending" | "done";
            }>
          | undefined,
      });
      switch (result.status) {
        case "not_found":
          return ok({
            error: `Focus session ${args.sessionId as string} not found`,
          });
        case "denied":
          return ok({ error: result.reason });
        case "proposed":
          return ok({
            status: "proposed",
            message: "Focus session update proposed for review",
            proposalId: result.proposalId,
            summary: result.summary,
            reviewPath: result.reviewPath,
            reviewUrl: result.reviewUrl,
            session: null,
          });
        case "updated":
          return ok({ status: "updated", session: result.session });
      }
      // Defensive: an unhandled decision must NOT fall through into the next
      // switch case (synap_create_cell) — break out of the outer switch.
      break;
    }

    // ── Cell authoring & renderer binding (external-agent surface) ──────────
    case "synap_create_cell": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // Validate the shape before trusting the cast args (defineCell handles the
      // npm-dep allowlist itself — this only guards the required primitives).
      const parsed = z
        .object({
          name: z.string().min(1),
          rendererSource: z.string().min(1),
          workspaceId: z.string().optional(),
          description: z.string().optional(),
        })
        .safeParse(args);
      if (!parsed.success) {
        throw new Error(
          `Invalid synap_create_cell args: ${parsed.error.issues
            .map((i) => i.message)
            .join(", ")}`
        );
      }
      const cellWorkspaceId = parsed.data.workspaceId ?? null;
      // Gate the workspace-scoped write exactly as the REST door does
      // (rest/cells.ts) — defineCell trusts its caller, so the door must verify
      // the acting user is a member of the target workspace.
      if (cellWorkspaceId) {
        const { verifyWorkspaceAccess } =
          await import("../hub-protocol/rest/_shared.js");
        if (!(await verifyWorkspaceAccess(userId, cellWorkspaceId))) {
          throw new Error(
            `Forbidden: no access to workspace ${cellWorkspaceId}`
          );
        }
      }
      const { defineCell } =
        await import("../../services/cells/define-cell.js");
      const result = await defineCell({
        name: parsed.data.name,
        rendererSource: parsed.data.rendererSource,
        workspaceId: cellWorkspaceId,
        description: parsed.data.description,
        userId,
      });
      return ok({ status: result.changeType, ...result });
    }

    case "synap_promote_cell_to_renderer": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // Governed: for an AI agent this returns `status: 'proposed'` (binding an
      // AI-generated cell as a durable renderer is consequential); an operator
      // auto-applies.
      const result = await caller.profiles.setRenderer({
        userId,
        workspaceId: args.workspaceId as string | undefined,
        profileSlug: args.profileSlug as string,
        slot: args.slot as "list" | "detail" | "dashboard",
        cellKey: args.cellKey as string,
        props: args.props as Record<string, unknown> | undefined,
        scope: args.scope as "workspace" | "pod" | undefined,
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    case "synap_promote_session_to_playbook": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // Governed via the regular `playbooks.promote` — agent → proposed,
      // operator → promoted.
      const result = await caller.playbooks.promote({
        userId,
        sessionId: args.sessionId as string,
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    // ── Playbooks (reusable session templates) ──────────────────────────────
    case "synap_list_playbooks": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      let playbookWsId = args.workspaceId as string | undefined;
      if (!playbookWsId) {
        const wsIds = await getUserWorkspaceIds(userId);
        playbookWsId = wsIds[0];
      }
      if (!playbookWsId) return ok({ error: "No accessible workspace found" });
      const playbookCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        playbookWsId,
        undefined,
        undefined,
        agentUserId
      );
      const playbookCaller = playbooksRouter.createCaller(playbookCtx);
      const result = await playbookCaller.list({
        status: args.status as
          "draft" | "active" | "paused" | "archived" | undefined,
      });
      return ok(result);
    }

    case "synap_match_playbooks": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      let matchWsId = args.workspaceId as string | undefined;
      if (!matchWsId) {
        const wsIds = await getUserWorkspaceIds(userId);
        matchWsId = wsIds[0];
      }
      if (!matchWsId) return ok({ error: "No accessible workspace found" });
      const matchCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        matchWsId,
        undefined,
        undefined,
        agentUserId
      );
      const matchCaller = playbooksRouter.createCaller(matchCtx);
      const result = await matchCaller.matchForEntity({
        profileSlug: args.profileSlug as string,
        entityId: args.entityId as string | undefined,
        workspaceId: matchWsId,
      });
      return ok(result);
    }

    case "synap_governance": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const wsId = args.workspaceId as string;
      const { getEffectiveGovernance } =
        await import("../../utils/permission-check.js");
      const { countPendingProposals } =
        await import("../../services/proposals/proposals-service.js");
      const policy = await getEffectiveGovernance(wsId);
      const pendingCount = await countPendingProposals(wsId);
      return ok({ ...policy, pendingProposals: pendingCount });
    }

    // ── Capture ──────────────────────────────────────────────────────────────
    case "synap_capture": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const { captureRouter } = await import("../capture.js");
      // Resolve workspace: use provided or fall back to user's first workspace
      let captureWsId = args.workspaceId as string | undefined;
      if (!captureWsId) {
        const wsIds = await getUserWorkspaceIds(userId);
        captureWsId = wsIds[0];
      }
      if (!captureWsId) {
        return ok({ error: "No accessible workspace found for this user" });
      }
      // GLOBAL lane — mirror the CLI's `capture --global`: a pod-wide procedural
      // runbook goes to knowledge_keys (a keyed doc upsert), NOT the entity
      // structuring pipeline. This folds the former synap_write_knowledge tool
      // into capture so there is ONE write door; the lane is the routing signal.
      if (args.global === true) {
        const text = args.text as string;
        const key =
          (args.key as string | undefined) ||
          `note:${text
            .slice(0, 48)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")}`;
        const record = await knowledgeKeysRepository.upsert(key, {
          key,
          value: text,
          status: "active",
          workspaceId: captureWsId,
          author: userId,
        });
        return ok({ lane: "global", knowledgeKey: record });
      }
      const captureCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        captureWsId,
        undefined,
        sessionId,
        agentUserId
      );
      const captureCaller = captureRouter.createCaller(
        captureCtx as Parameters<typeof captureRouter.createCaller>[0]
      );
      // Step 1 — structure the free text into entity proposals.
      const structured = await captureCaller.structure({
        text: args.text as string,
        context: args.profileSlug
          ? `Hint: profile is ${args.profileSlug}`
          : undefined,
        dedupMode: args.dedupMode as "title" | "semantic" | "both" | undefined,
      });
      // Step 2 — ACTUALLY WRITE. structure() only previews; without execute()
      // the capture tool returns proposals that are never materialized — the
      // "write door" wrote nothing. Mirror the CLI's smart-capture (structure →
      // execute). First-party capture writes DIRECTLY and records an
      // auto-approved, revertible proposal — it does NOT return 'proposed' /
      // wait for review. The materialized entities come back in the result.
      const captureProposals =
        (structured as { proposals?: unknown[] }).proposals ?? [];
      // DEGRADED GUARD: when the IS structurer is down, structure() returns a
      // single raw-note fallback with `degraded: true`. Do NOT silently execute
      // that note — it looks like a normal capture but is an outage artifact the
      // user doesn't want. Surface the degradation loudly and create nothing;
      // the caller tells the user the AI service is temporarily unavailable.
      if ((structured as { degraded?: boolean }).degraded === true) {
        const reason = (structured as { degradedReason?: string })
          .degradedReason;
        return ok({
          degraded: true,
          degradedReason: reason,
          executed: false,
          message:
            "⚠️ AI structuring is temporarily unavailable, so nothing was created. " +
            "Tell the user their capture was NOT structured (the AI service is degraded) and to try again shortly — do not present this as a normal capture or save a raw note.",
        });
      }
      if (captureProposals.length === 0) {
        return ok({
          ...structured,
          executed: false,
          note: "Nothing to capture.",
        });
      }
      // Dedup → merge: when structure found a high-confidence SAME-PROFILE
      // duplicate, point the proposal at the existing entity so execute MERGES
      // into it (via existingEntityId) instead of creating a near-duplicate.
      // The same-profileSlug guard is load-bearing — the dedup search is
      // cross-profile (semantic), so without it a `person` could merge into a
      // `note`. ≥0.95 auto-merges; anything lower is left to create (the
      // candidates are still surfaced to the caller in `structured`).
      const dedup =
        (
          structured as {
            dedupCandidates?: Record<
              string,
              Array<{ entityId: string; profileSlug: string; score: number }>
            >;
          }
        ).dedupCandidates ?? {};
      const mergedProposals = (
        captureProposals as Array<{
          tempId: string;
          profileSlug: string;
          existingEntityId?: string;
        }>
      ).map((p) => {
        const top = dedup[p.tempId]?.[0];
        if (
          top &&
          top.score >= 0.95 &&
          top.profileSlug === p.profileSlug &&
          !p.existingEntityId
        ) {
          return { ...p, existingEntityId: top.entityId };
        }
        return p;
      });
      // Workspace routing is centralized in captureCaller.execute (see
      // resolveCaptureRouting): the adapter just forwards the AI's structure
      // hints + the caller's mode, so MCP routes identically to every other door.
      const executed = await captureCaller.execute({
        entities: mergedProposals as Parameters<
          typeof captureCaller.execute
        >[0]["entities"],
        relations:
          ((structured as { relations?: unknown[] }).relations as Parameters<
            typeof captureCaller.execute
          >[0]["relations"]) ?? [],
        workspaceRouting: args.workspaceRouting as
          "auto" | "ask" | "locked" | undefined,
        aiWorkspaceId: (structured as { targetWorkspaceId?: string | null })
          .targetWorkspaceId,
        aiWorkspaceConfidence: (
          structured as { targetWorkspaceConfidence?: number | null }
        ).targetWorkspaceConfidence,
        aiWorkspaceReason: (
          structured as { targetWorkspaceReason?: string | null }
        ).targetWorkspaceReason,
        // Explicit caller-provided projectId is a deliberate pin (rung 1) and
        // still auto-links. The AI's structure-RESOLVED target, however, must NOT
        // silently become an auto-link: `belongs_to_project` WIDENS cross-workspace
        // access, so the AI's guess rides the SAME propose/advisory lane as every
        // other surface — execute records it as a suggestion (chip), never links
        // it, unless a DETERMINISTIC rung (explicit / session / relational)
        // independently resolves the same project.
        ...(args.projectId ? { projectId: args.projectId as string } : {}),
        aiProjectId: (structured as { targetProjectId?: string | null })
          .targetProjectId,
        aiProjectConfidence: (
          structured as { targetProjectConfidence?: number | null }
        ).targetProjectConfidence,
        aiProjectReason: (structured as { targetProjectReason?: string | null })
          .targetProjectReason,
      });
      // execute() returns movedToWorkspace / pendingWorkspaceSwitch when routing
      // engaged — surface them at the top level for the caller.
      const ex = executed as {
        movedToWorkspace?: string;
        pendingWorkspaceSwitch?: unknown;
        project?: {
          projectId: string;
          rung: number | null;
          status: "linked" | "proposed";
        };
      };
      return ok({
        structured,
        executed,
        ...(ex.movedToWorkspace
          ? { movedToWorkspace: ex.movedToWorkspace }
          : {}),
        ...(ex.pendingWorkspaceSwitch
          ? { pendingWorkspaceSwitch: ex.pendingWorkspaceSwitch }
          : {}),
        // State what happened on the project axis: linked-by-context (which rung)
        // vs proposed (AI suggestion awaiting confirmation) vs nothing (omitted).
        ...(ex.project
          ? {
              project: ex.project,
              projectDisposition:
                ex.project.status === "linked"
                  ? `linked by context (rung ${ex.project.rung})`
                  : "proposed (AI suggestion — confirm to file)",
            }
          : {}),
      });
    }

    // ── Workspace & view creation ─────────────────────────────────────────────
    // GOVERNED: workspace invent is a durable surface — agents always propose
    // (workspace.create ∉ DEFAULT_AUTO_APPROVE). Operators (no agentUserId) are
    // the authority and grant inline. On propose, the full definition rides in
    // gate `data` so the workspace/create executor can materialize on approval.
    case "synap_create_workspace": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const name = args.name as string | undefined;
      if (typeof name !== "string" || name.trim() === "") {
        return ok({ error: "name is required" });
      }
      const definition = (args.definition ?? {}) as object;
      const idempotencyKey = args.proposalId as string | undefined;
      const { checkPermissionOrPropose } =
        await import("../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: agentUserId ?? undefined,
        subjectType: "workspace",
        action: "create",
        source: "api",
        data: {
          name,
          definition,
          workspaceName: name,
          proposalId: idempotencyKey,
          createdBy: "provisioning",
          source: "mcp.synap_create_workspace",
        },
      });
      if ("denied" in perm && perm.denied) {
        return ok({ error: perm.reason, denied: true });
      }
      if (
        "proposalId" in perm &&
        perm.proposalId &&
        !("granted" in perm && perm.granted)
      ) {
        return ok({
          status: "proposed",
          message:
            "Workspace creation proposed for review (workspace invent is governed) — it materializes on approval.",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          ...(perm.deduped ? { deduped: true } : {}),
        });
      }
      // Granted (operator authority) → same materialize door as approve
      // (deps/compose aware). Do NOT use createWorkspaceFromDefinitionIdempotent
      // alone — it diverges from packages.apply / workspace/create approve.
      const { materializeWorkspaceCore } =
        await import("../../services/workspace-materialization-service.js");
      const core = await materializeWorkspaceCore({
        definition: definition as Parameters<
          typeof materializeWorkspaceCore
        >[0]["definition"],
        userId,
        agentUserId: agentUserId ?? undefined,
        proposalId: idempotencyKey,
        workspaceName: name,
        createdBy: "provisioning",
      });
      if (core.status === "resolved") {
        return ok({
          error:
            "Workspace materialize returned resolved-without-create (unexpected)",
        });
      }
      return ok({
        status: "created",
        workspaceId: core.workspaceId,
        materializeStatus: core.status,
        created: core.status === "created",
      });
    }

    // Agnostic edge-declaration door (Enterprise-OS Wave 0). Set/merge the two
    // workspace-EDGE fields — `sourceRoles` (domain → provider|consumer|
    // provider-consumer) + `defaultSources` (domain → source workspace) — on an
    // EXISTING workspace, so an agent can DECLARE an edge (e.g. "Marketing
    // consumes Comms") without touching template authoring or the tRPC UI door.
    // Tightly scoped: ONLY these two edge fields are agent-writable here — no
    // other settings key (aiGovernance/visibility/…) is reachable. MERGES
    // per-domain via the canonical mergeSettings path — never clobbers.
    case "synap_declare_workspace_source": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const workspaceId = args.workspaceId as string | undefined;
      if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
        return ok({ error: "workspaceId is required" });
      }
      const { WorkspaceSourceEdgeInputSchema, mergeWorkspaceSourceEdges } =
        await import("../../services/workspace-edge-service.js");
      const parsed = WorkspaceSourceEdgeInputSchema.safeParse({
        sourceRoles: args.sourceRoles,
        defaultSources: args.defaultSources,
      });
      if (!parsed.success) {
        return ok({
          error: "Invalid edge fields",
          details: parsed.error.issues,
        });
      }
      if (!parsed.data.sourceRoles && !parsed.data.defaultSources) {
        return ok({
          error: "Provide at least one of: sourceRoles, defaultSources",
        });
      }
      // GOVERNED write (Enterprise-OS Wave 0): declaring a data edge rewires
      // pod-wide cross-workspace read routing, so it goes through the review
      // membrane, not immediate apply. `checkPermissionOrPropose` runs the
      // canonical RBAC floor (action `declare_source` → "write" permission =
      // the same editor+ floor `assertWorkspaceWrite` enforced) and then the
      // agent-governance ladder: an agent-remapped key routes to a PROPOSAL
      // (declare_source is not auto-approved), while a plain operator (no
      // agentUserId, source "api") is the authority and is GRANTED. On grant we
      // apply immediately via `mergeWorkspaceSourceEdges` (byte-identical to the
      // pre-governance path); the proposed branch returns the proposal and does
      // NOT apply — the `workspace/declare_source` executor materializes it on
      // approval.
      const { checkPermissionOrPropose } =
        await import("../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: agentUserId ?? undefined,
        workspaceId,
        subjectType: "workspace",
        action: "declare_source",
        source: "api",
        data: {
          sourceRoles: parsed.data.sourceRoles,
          defaultSources: parsed.data.defaultSources,
        },
      });
      if ("denied" in perm && perm.denied) {
        return ok({ error: perm.reason });
      }
      if ("proposalId" in perm) {
        return ok({
          status: "proposed",
          message:
            "Workspace edge declaration proposed for review (rewiring cross-workspace reads is governed) — it applies on approval.",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          workspaceId,
          ...(perm.deduped ? { deduped: true } : {}),
        });
      }
      // Granted (operator authority) → apply immediately. Attribute on the same
      // acting identity (agent when remapped, else operator).
      const actingUserId = agentUserId ?? userId;
      const result = await mergeWorkspaceSourceEdges(
        workspaceId,
        parsed.data,
        actingUserId
      );
      return ok({ status: "updated", workspaceId, ...result });
    }

    case "synap_create_project": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      if (typeof args.name !== "string" || args.name.trim() === "") {
        return ok({ error: "name is required" });
      }
      // Resolve the HOME workspace: use provided or fall back to the user's
      // first workspace (same fallback synap_capture uses).
      let projectWsId = args.workspaceId as string | undefined;
      if (!projectWsId) {
        const wsIds = await getUserWorkspaceIds(userId);
        projectWsId = wsIds[0];
      }
      if (!projectWsId) {
        return ok({ error: "No accessible workspace found for this user" });
      }
      const projectCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        projectWsId,
        undefined,
        sessionId,
        agentUserId
      );
      const projectCaller = projectsRouter.createCaller(projectCtx);
      const result = await projectCaller.create({
        name: args.name as string,
        description: args.description as string | undefined,
        // Provenance: this create came through the MCP door.
        door: "mcp",
        // Gravity evidence — the tRPC create enforces ≥5 caller-visible ids for
        // agent callers (projectCtx carries the agent identity).
        evidenceEntityIds: Array.isArray(args.evidenceEntityIds)
          ? (args.evidenceEntityIds as string[])
          : undefined,
      });
      return ok(result);
    }

    case "synap_create_playbook": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      if (typeof args.name !== "string" || args.name.trim() === "") {
        return ok({ error: "name is required" });
      }
      if (
        typeof args.goalTemplate !== "string" ||
        args.goalTemplate.trim() === ""
      ) {
        return ok({ error: "goalTemplate is required" });
      }
      let pbWsId = args.workspaceId as string | undefined;
      if (!pbWsId) {
        const wsIds = await getUserWorkspaceIds(userId);
        pbWsId = wsIds[0];
      }
      if (!pbWsId) {
        return ok({ error: "No accessible workspace found for this user" });
      }
      const pbCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        pbWsId,
        undefined,
        sessionId,
        agentUserId
      );
      const pbCaller = playbooksRouter.createCaller(pbCtx);
      const result = await pbCaller.create({
        name: args.name as string,
        goalTemplate: args.goalTemplate as string,
        description: args.description as string | undefined,
        stages: args.stages as Record<string, unknown>[] | undefined,
        // Default to `active` so a created template is immediately runnable via
        // synap_start_session(templateId) — a draft would be invisible to run.
        status:
          (args.status as
            "draft" | "active" | "paused" | "archived" | undefined) ?? "active",
        agentUserId,
      });
      return ok(result);
    }

    case "synap_create_view": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const result = await caller.views.createView({
        userId,
        workspaceId: args.workspaceId as string,
        name: args.name as string,
        type: args.type as string,
        profileId: args.profileId as string | undefined,
        config: args.config as Record<string, unknown> | undefined,
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    // ── Channel & messaging ───────────────────────────────────────────────────
    case "synap_get_channel": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const mode = args.mode as string;
      const wsId = args.workspaceId as string;
      if (mode === "personal") {
        const result = await caller.channels.ensurePersonal({
          userId,
          workspaceId: wsId,
        });
        return ok(result);
      }
      if (!args.contextObjectType || !args.contextObjectId) {
        return ok({
          error:
            "contextObjectType and contextObjectId are required for mode 'by-context'",
        });
      }
      const result = await caller.channels.resolveOrCreateChannel({
        userId,
        workspaceId: wsId,
        channelType: "thread" as const,
        contextObjectType: args.contextObjectType as "entity" | "document",
        contextObjectId: args.contextObjectId as string,
      });
      return ok(result);
    }

    case "synap_post_message": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const { postChannelMessage } =
        await import("../../services/messaging/post-message.js");
      const result = await postChannelMessage({
        channelId: args.channelId as string,
        content: args.content as string,
        role: args.role as string | undefined,
        triggerAI: Boolean(args.triggerAI),
        userId,
      });
      return ok(result);
    }

    // ── Proposals & knowledge ─────────────────────────────────────────────────
    case "synap_revise_proposal": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const proposalId = args.proposalId as string;
      if (args.summary === undefined && args.reasoning === undefined) {
        return ok({ error: "Provide at least one of: summary, reasoning" });
      }
      const { reviseProposal } =
        await import("../../services/proposals/proposals-service.js");
      await reviseProposal({
        proposalId,
        summary: args.summary as string | undefined,
        reasoning: args.reasoning as string | undefined,
        actorId: userId,
      });
      return ok({ success: true, proposalId });
    }

    // (synap_write_knowledge folded into synap_capture's `global` lane — one
    // write door. A pod-wide runbook is `capture` with global:true.)

    // ── Capabilities (connected-service verbs) ─────────────────────────────────
    case "synap_list_capabilities": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const wsId = args.workspaceId as string;
      const query =
        typeof args.query === "string" && args.query.trim().length > 0
          ? args.query
          : undefined;
      const kind = typeof args.kind === "string" ? args.kind : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const { listCapabilities } =
        await import("../../services/capabilities/capability-registry.js");
      const { projectRunnableActions } =
        await import("../../services/capabilities/action-projection.js");
      const capabilities = await listCapabilities(
        { workspaceId: wsId, userId },
        query || kind || limit !== undefined
          ? {
              query,
              kind: kind as never,
              limit,
            }
          : undefined
      );

      // MCP and Hub REST intentionally share this projection: never expose a
      // catalog-only, draft, or disconnected action as executable on one
      // surface while hiding it on the other.
      const runnable = projectRunnableActions(capabilities);

      // Response size discipline: with a query, drop the full verb catalog dump
      // (grant/govDefault noise) — the compact projection carries name/kind/
      // description/governance + a slim verb list, `runnable` above already
      // carries the paramsSchema for anything actually callable.
      const responseCapabilities = query
        ? capabilities.map((cap) => ({
            kind: cap.kind,
            id: cap.id,
            name: cap.name,
            governance: cap.governance,
            ...(cap.connection ? { connection: cap.connection } : {}),
            verbs: cap.verbs?.map((v) => ({ id: v.id, label: v.label })),
          }))
        : capabilities;

      return ok({ capabilities: responseCapabilities, runnable });
    }

    case "synap_run_capability": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const wsId = args.workspaceId as string;
      const { executeCapability } =
        await import("../../services/capabilities/execute-capability.js");
      const outcome = await executeCapability({
        verbId: args.verbId as string | undefined,
        skillId: args.skillId as string | undefined,
        parameters: args.parameters as Record<string, unknown> | undefined,
        workspaceId: wsId,
        userId,
        // Thread the acting agent (set on agent-key remap) so an agent WRITE verb
        // is governed by grant/propose — consistent with every other write proc
        // in this adapter. Omitting it laundered agent writes into operator runs.
        agentUserId: agentUserId ?? null,
      });
      // Surface the same discriminated outcome the hub door returns, in a shape
      // the agent reads naturally (proposed is NOT an error).
      return ok(outcome);
    }

    case "synap_create_verb": {
      requireScope(apiKeyScopes, "mcp.write", toolName);

      // Hard constraints 1 (declarative-only) + 2's field shape are enforced
      // in a pure, unit-tested helper — see validate-create-verb.test.ts.
      const validated = validateCreateVerbInput(args);
      if (!validated.ok) {
        return ok({ error: validated.error });
      }
      const input = validated.data;

      // Hard constraint 2: toolName must ALREADY be installed/credentialed for
      // the caller (pod-wide, or the given workspace) — this door only ADDS a
      // verb to an existing tool. It never creates a tool/connection as a
      // side effect.
      const wsLens = input.workspaceId
        ? or(
            isNull(toolsTable.workspaceId),
            eq(toolsTable.workspaceId, input.workspaceId)
          )
        : isNull(toolsTable.workspaceId);
      const [existingTool] = await db
        .select({ id: toolsTable.id, name: toolsTable.name })
        .from(toolsTable)
        .where(
          and(
            eq(toolsTable.name, input.toolName),
            wsLens,
            userVisibleWhere(toolsTable.workspaceId, userId)
          )
        )
        .limit(1);
      if (!existingTool) {
        return ok({
          error:
            `Tool '${input.toolName}' is not installed` +
            `${input.workspaceId ? ` for workspace ${input.workspaceId}` : ""}. ` +
            `synap_create_verb only adds a verb to an ALREADY-installed, credentialed tool — ` +
            `install/connect '${input.toolName}' first, or check the exact name via synap_list_capabilities.`,
        });
      }

      // Hard constraint 4: reuse the canonical ProviderVerbSpec shape
      // verbatim (@synap/database schema/skills.ts) — no invented field names.
      const providerSpec: ProviderVerbSpec = {
        tool: input.toolName,
        method: input.method,
        pathTemplate: input.pathTemplate,
        ...(input.query ? { query: input.query } : {}),
        ...(input.body ? { body: input.body } : {}),
        ...(input.responseShape ? { responseShape: input.responseShape } : {}),
      };

      // Hard constraint 3: reuse the SAME governed door POST /skills uses
      // (skillsRouter.create) — checkPermissionOrPropose runs INSIDE it. No
      // bypass flag, no direct db.insert here.
      const skillsCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        input.workspaceId ?? null,
        undefined,
        sessionId,
        agentUserId ?? null
      );
      const skillsCaller = regularSkillsRouter.createCaller(skillsCtx as never);
      const result = await skillsCaller.create({
        workspaceId: input.workspaceId,
        kind: "declarative",
        scope: input.workspaceId ? "workspace" : "pod",
        name: input.verbName,
        description: input.description,
        providerSpec: providerSpec as unknown as Record<string, unknown>,
        parameters: input.parameters,
        // Fixed alongside this tool: skills.create's own checkPermissionOrPropose
        // call was missing agentUserId entirely (no input field for it existed),
        // so an agent-initiated create was evaluated as if the human owner did
        // it directly. Now threaded through, mirroring entities.ts's pattern.
        agentUserId: agentUserId ?? undefined,
      });

      return ok(result);
    }

    default:
      throw new Error(
        `Unknown MCP tool: ${toolName}. Call synap_load_skill("catalog") for skills or synap_list_capabilities({query}) to find capabilities.`
      );
  }
}

/**
 * Read MCP resource by calling Hub Protocol API
 */
export async function readMCPResourceViaHubProtocol(
  uri: string,
  userId: string,
  apiKeyScopes: string[]
): Promise<{
  contents: Array<{ uri: string; mimeType: string; text?: string }>;
}> {
  if (!apiKeyScopes.includes("mcp.read")) {
    throw new Error("Insufficient permissions: mcp.read required");
  }

  const caller = await createHubProtocolCaller(userId, apiKeyScopes);

  const match = uri.match(/^synap:\/\/(\w+)(?:\/(.+))?$/);
  if (!match) throw new Error(`Invalid resource URI: ${uri}`);

  const [, resourceType, resourcePath] = match;

  if (resourceType === "entities") {
    const parts = resourcePath?.split("/") || [];
    const entityType = parts[0]?.replace(/s$/, "");
    const entityId = parts[1];

    if (entityId) {
      const all = await caller.entities.getEntities({ userId, limit: 1 });
      const entity = all.find((e: { id: string }) => e.id === entityId);
      if (!entity) throw new Error(`Entity not found: ${uri}`);
      return {
        contents: [
          { uri, mimeType: "application/json", text: JSON.stringify(entity) },
        ],
      };
    }

    const entities = await caller.entities.getEntities({
      userId,
      profileSlug: entityType || undefined,
      limit: 100,
    });
    return {
      contents: [
        { uri, mimeType: "application/json", text: JSON.stringify(entities) },
      ],
    };
  }

  if (resourceType === "threads") {
    const parts = resourcePath?.split("/") || [];
    const threadId = parts[0];
    if (!threadId)
      throw new Error("Thread ID required: synap://threads/{id}/context");
    const context = await caller.context.getThreadContext({ threadId });
    return {
      contents: [
        { uri, mimeType: "application/json", text: JSON.stringify(context) },
      ],
    };
  }

  throw new Error(`Unknown resource type: ${resourceType}`);
}
