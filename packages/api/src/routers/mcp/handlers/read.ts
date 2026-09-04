/**
 * MCP tool handlers — read domain.
 *
 * Split out of `adapter.ts`'s single switch (router-decomposition Wave 7).
 * Each export is a `Partial<Record<toolName, handler>>` merged into the
 * combined dispatch map in `adapter.ts`. Behavior is byte-identical to the
 * original `case` blocks — only the wrapping (switch case → object entry,
 * captured locals → `ctx` fields) changed.
 */

import { ask } from "../../../services/knowledge/ask.js";
import { synthesizeAnswer } from "../../../services/knowledge/synthesize.js";
import { describeAiFailure } from "../../../utils/ai-failure.js";
import {
  toProfileCatalogEntry,
  type ProfileCatalogEntry,
} from "../../../services/retrieval/index.js";
import {
  getUserMemberWorkspaceIds,
  getUserAccessibleWorkspaceIds,
} from "../../hub-protocol/rest/_shared.js";
import { entitiesRouter as regularEntitiesRouter } from "../../entities.js";
import { createHubProtocolCallerContext } from "../../hub-protocol/utils.js";
import {
  resolveByName,
  resolveProfileByName,
  type GraphEnvelope,
} from "../../../services/object-graph/graph-service.js";
import {
  ok,
  requireScope,
  buildGraphEnvelope,
  resolveEntityWorkspaceId,
  McpToolContext,
  CallToolResult,
  McpHandlerMap,
} from "./shared.js";

export const readHandlers: McpHandlerMap = {
  synap_ask: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    if (typeof args.query !== "string" || args.query.trim() === "") {
      return ok({ error: "query is required" });
    }
    let workspaceId = args.workspaceId as string | undefined;
    // ACCESS PARITY (security, not just honesty): the `mcp.read` scope proves
    // "may call recall", NEVER "may see THIS workspace". `ask()` forwards this
    // value as the PROCEDURAL namespace, and `knowledge_keys` has no user
    // column (`services/knowledge/ask.ts:227` — its own comment warns that an
    // unfiltered value "would read UNFILTERED across every user/workspace on
    // the pod"). So an unchecked, caller-supplied workspaceId lets an
    // authenticated agent read a workspace's runbooks without being a member —
    // and workspace UUIDs are freely disclosed elsewhere (the get_relations
    // honesty note prints one), so the id is not a secret.
    //
    // Degrade a non-accessible id to pod-wide rather than honouring it, exactly
    // as the hub `/knowledge/answer` door already does
    // (`hub-protocol/rest/knowledge.ts:987-990`, "rather than leaking a foreign
    // workspace's knowledge"). This door never received that check.
    if (workspaceId) {
      const accessible = await getUserAccessibleWorkspaceIds(userId);
      if (!accessible.includes(workspaceId)) workspaceId = undefined;
    }
    // DOOR PARITY: the catalog lens must track the QUERY lens, exactly as the
    // hub `/knowledge/answer` door does — both read the same `workspaceId`,
    // no separate resolution. This USED to fall back to the caller's first
    // membership workspace (`wsIds[0]`, an unordered SELECT) whenever no
    // workspaceId was passed, so the same `ask` call could type-infer against
    // a DIFFERENT workspace than the one it retrieved from, depending on
    // which door answered it. Unscoped now means pod-wide for both, honestly:
    // no catalog (empty), same as the hub door's `workspaceId: null` case.
    let catalog: ProfileCatalogEntry[] = [];
    if (workspaceId) {
      const { profiles: profileRows } = await caller.profiles.listProfiles({
        userId,
        workspaceId,
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

    // The PENDING block (`ask`'s Wave-3 lane): the caller's own pending
    // proposals whose content matches this query — surfaced SEPARATELY from the
    // synthesized answer so recall never presents unvalidated work as fact.
    // `ask.ts` computes it; the MCP door must forward it, or the whole anti-
    // amnesia fix silently never reaches the agents that call this tool (it was
    // dropped here — a live `ask("Talentir")` returned no pending block despite
    // two matching pending proposals). Additive; omitted when nothing pends.
    const pendingBlock = retrieved.pending
      ? { pending: retrieved.pending }
      : {};

    // Build context + sources, then synthesize via IS. Pass the pending count
    // so the composed NL answer can acknowledge matching pending proposals
    // instead of contradicting the pendingBlock surfaced right below it.
    const synthesis = await synthesizeAnswer(
      retrieved.answers,
      args.query as string,
      retrieved.routedTo,
      workspaceId ?? null,
      retrieved.pending?.matches?.length ?? 0,
      // The degradation signal must reach the SENTENCE, not just the envelope.
      // `degraded` was already returned alongside this answer and correct; the
      // synthesis simply never saw it, so a half-dead retrieval layer produced
      // a confident answer with no caveat in the prose an agent reads.
      retrieved.degraded ?? []
    );

    // Surface synthesis outages loudly instead of returning a null answer that
    // looks like "no results". Retrieval/sources still stand.
    if ((synthesis as { error?: string }).error === "synthesis_unavailable") {
      // The WHY comes from the one failure door, classified from the real
      // error — never a stock "temporarily unavailable" that could be telling
      // the agent to retry a failure no retry can fix.
      const failure = describeAiFailure(synthesis.failureClass ?? "unknown");
      return ok({
        ...synthesis,
        ...pendingBlock,
        degraded: retrieved.degraded,
        message:
          `⚠️ AI synthesis did not run. ${failure.message} ` +
          (failure.retryable
            ? "Retrying may work. "
            : "Do not retry — say so instead. ") +
          "The matched sources below are real; tell the user the AI answer layer is degraded (not that nothing was found).",
      });
    }
    // DOOR PARITY: `degraded` is the retrieval-health signal `ask()` already
    // computes (a substrate outage, a keyword-only fallback after the vector
    // index went down). The hub `/answer` door has forwarded it since the
    // keyword-fallback incident; this door never did, so an MCP caller — the
    // primary agent surface — could not tell a healthy empty result from a
    // degraded one. `truncated` rides along inside `...synthesis`.
    return ok({ ...synthesis, ...pendingBlock, degraded: retrieved.degraded });
  },
  synap_get_entities: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const profileSlug =
      (args.profileSlug as string | undefined) ||
      (args.type as string | undefined);
    const result = await caller.entities.getEntities({
      userId,
      profileSlug: profileSlug || undefined,
      ...(args.workspaceId ? { workspaceId: args.workspaceId as string } : {}),
      // Project-pinned MCP URL (?projectId=) auto-injects args.projectId, so a
      // focused agent's entity reads narrow to its project — same lens as ask.
      ...(args.projectId ? { projectId: args.projectId as string } : {}),
      // Kind + Facets: narrow to entities carrying a live facet of this role.
      ...(args.facetSlug ? { facetSlug: args.facetSlug as string } : {}),
      limit: (args.limit as number) || 50,
    });
    // HONEST EMPTY: a bare [] reads as "none exist" — but this call is LENSED
    // (profileSlug/workspace/project/facet). An agent that concludes "the user
    // has no X" from a scoped-empty is the ExaSearch "not accessible" mistake
    // one layer down. When empty AND a lens was applied, echo the lens and say
    // the emptiness is scoped, not absolute. (Shape normalized to an object,
    // matching get_graph/list_capabilities; ok() forwards it verbatim.)
    const lens = [
      profileSlug ? `profileSlug=${profileSlug}` : null,
      args.workspaceId ? `workspaceId=${String(args.workspaceId)}` : null,
      args.projectId ? `projectId=${String(args.projectId)}` : null,
      args.facetSlug ? `facetSlug=${String(args.facetSlug)}` : null,
    ].filter(Boolean);
    const note =
      result.length === 0 && lens.length > 0
        ? `No entities matched under this lens (${lens.join(", ")}). This is a SCOPED empty, not proof the user has none — broaden the scope (drop a filter, omit workspaceId for pod-wide) or call synap_ask before concluding anything is absent.`
        : undefined;
    return ok({
      entities: result,
      count: result.length,
      ...(note ? { note } : {}),
    });
  },
  synap_get_document: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const result = await caller.documents.getDocument({
      userId,
      documentId: args.documentId as string,
    });
    return ok(result);
  },
  synap_get_thread_context: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, apiKeyScopes, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const result = await caller.context.getThreadContext({
      threadId: args.threadId as string,
    });
    return ok(result);
  },
  synap_list_proposals: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const { listCreatedProposals } =
      await import("../../../services/proposals/proposals-service.js");
    const result = await listCreatedProposals({
      // `createdBy` is the ONLY user floor this service applies — a
      // model-supplied `args.userId` would list a foreign user's proposals.
      createdBy: userId,
      workspaceId: args.workspaceId as string | undefined,
      // Gate 2: session proposal pack filter
      sessionId:
        typeof args.sessionId === "string" && args.sessionId.trim() !== ""
          ? args.sessionId
          : undefined,
      status: args.status as string | undefined,
      limit: (args.limit as number) || undefined,
    });
    // A LIST must be readable. Unprojected, this returned every row's full
    // `data` payload: 33 pending proposals measured at 283,737 characters
    // (~6k chars/row, largest single row 36k) — past the tool-result ceiling,
    // so the caller got an error instead of a list and could not enumerate
    // its own proposals at all. `detail: "full"` still returns everything,
    // so no capability is removed — only the default changes.
    if ((args.detail as string) === "full") return ok(result);
    const rows = Array.isArray(result)
      ? result
      : ((result as { proposals?: unknown[] })?.proposals ?? []);
    // ONE definition of BASIC. This projection is shared verbatim with the
    // Hub REST `GET /proposals?view=basic` door — a second hand-rolled
    // summarizer here is how the two drifted in the first place.
    const { toProposalBasic } =
      await import("../../hub-protocol/rest/_codecs/proposal.js");
    const summarized = (rows as Record<string, unknown>[]).map(toProposalBasic);
    return ok({
      proposals: summarized,
      detail: "summary",
      note: "Compact rows. Call again with detail:'full' (and a small limit) to inspect a proposal's full payload.",
    });
  },
  synap_template_health: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const { listWorkspaceTemplateHealth } =
      await import("../../../services/template-health.js");
    // Access-scope FIRST (same predicate the Hub `/workspaces` projection
    // uses), then let the service report health only for what it's handed —
    // it never widens the lens, so a foreign workspace can't leak.
    const wsIds = await getUserAccessibleWorkspaceIds(userId);
    const all = await listWorkspaceTemplateHealth(wsIds);
    const rows = args.driftedOnly ? all.filter((w) => w.drifted) : all;
    return ok({
      workspaces: rows,
      driftedCount: all.filter((w) => w.drifted).length,
      total: all.length,
    });
  },
  synap_diagnose: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    // The THIRD door: mode derived from payload shape (like capture), not a
    // caller-chosen tool. {} → whole-pod health · {type} → a class surface ·
    // {id} → auto-detect the object · {agentId} → agent scorecard. Today's
    // run-feed grammar ({runId,flowType} / {flowType,flowId}) is preserved as
    // a back-compat special case inside the router.
    const { diagnoseRouter } =
      await import("../../../services/diagnose/index.js");
    const result = await diagnoseRouter({
      userId,
      agentId: args.agentId as string | undefined,
      id: args.id as string | undefined,
      type: args.type as
        | "proposal"
        | "session"
        | "capability"
        | "agent"
        | "entity"
        | "run"
        | undefined,
      workspaceId: (args.workspaceId as string | undefined) ?? undefined,
      stuckThresholdHours: args.stuckThresholdHours as number | undefined,
      flowType: args.flowType as
        | "automation"
        | "playbook"
        | "capture"
        | "capability"
        | "session"
        | undefined,
      flowId: args.flowId as string | undefined,
      runId: args.runId as string | undefined,
      limit: (args.limit as number) || undefined,
    });
    return ok(result);
  },
  synap_get_entity: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
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
    // `detail: "full"` returns TODAY'S payload, byte-identical — this is the
    // pre-existing expression, untouched.
    if ((args.detail as string | undefined) === "full") {
      return ok(
        graph
          ? { ...(entityResult as Record<string, unknown>), graph }
          : entityResult
      );
    }

    /**
     * LEAN (the default) — same convention as `synap_list_profiles`' `toDigest`
     * below, and `synap_list_proposals` / `synap_orient`: the small shape is
     * what a caller gets by default, `detail: "full"` returns the whole row.
     *
     * WHY. `entities.get` resolves the kind's property schema once per
     * accessible workspace into `effectivePropertiesByWorkspace` (16 workspaces
     * for a real user). Measured on the live pod, that fan-out is 83-93% of
     * every entity read: `note` 34,593 chars, `decision` 120,769, `person`
     * 205,118. Claude Code TRUNCATES MCP tool output at 25,000 tokens, and for
     * `person` the fan-out spans chars 12,233-204,239 — so the cut lands INSIDE
     * it, severing the JSON mid-structure (unparseable) and taking every key
     * that follows it (`facets`, `externalLinks`, `graph`) with it.
     *
     * What is KEPT is the half an agent writes against: `effectiveProperties`
     * is resolved from the entity's OWN workspace, so it IS the schema a write
     * to THIS entity is validated against. The other entries describe how a
     * DIFFERENT entity of the same kind would resolve under another lens.
     *
     * Fields are named ONE BY ONE rather than rest-spread, deliberately: a
     * hand-written projection is only safe while something forces it to track
     * its source, so the `entity-get` spec in
     * `__tripwires__/cross-door-field-parity.test.ts` audits this door against
     * `entities.get`'s own zod output schema. Add a field there and this door
     * reds until it answers for it.
     */
    const row = (
      graph
        ? { ...(entityResult as Record<string, unknown>), graph }
        : (entityResult as Record<string, unknown>)
    ) as Record<string, unknown>;
    const byWorkspace = (row.effectivePropertiesByWorkspace ?? {}) as Record<
      string,
      unknown
    >;
    const workspaceIds = Object.keys(byWorkspace);
    // COMPARED, never assumed — measured, the arrays are identical for 6 of 9
    // types but `person` has 5 distinct variants. An overlay list built from
    // "all of them" would be a signpost that names nothing.
    const base = JSON.stringify(row.effectiveProperties ?? null);
    const workspacesWithOverlay = workspaceIds.filter(
      (id) => JSON.stringify(byWorkspace[id]) !== base
    );
    return ok({
      entity: row.entity,
      profile: row.profile,
      effectiveProperties: row.effectiveProperties,
      facets: row.facets,
      externalLinks: row.externalLinks,
      graph: row.graph,
      // The SIGNPOST. This is what makes the omission honest rather than
      // silent: it names what was withheld, which lenses actually differ, and
      // how to get it back.
      propertyOverlays: {
        workspacesWithOverlay,
        hint:
          `${workspacesWithOverlay.length} of ${workspaceIds.length} accessible ` +
          `workspaces override this kind's property schema. Omitted here: ` +
          `\`effectivePropertiesByWorkspace\` — pass detail:'full' for the ` +
          `per-workspace map. \`effectiveProperties\` above is this entity's ` +
          `own workspace schema, the one a write to it is validated against.`,
      },
    });
  },
  synap_list_profiles: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
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
    const wsIds = await getUserMemberWorkspaceIds(userId);
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
  },
  synap_get_relations: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    let relWsId = args.workspaceId as string | undefined;
    // HONEST FALLBACK: relations are workspace-scoped. When the caller gives
    // no workspaceId, the entity's OWN workspace is the right lens — not an
    // arbitrary member workspace — so a "no relations" answer reflects the
    // entity's real home instead of whichever workspace happened to sort
    // first. Only fall back to the old ids[0] pick (and say so) when the
    // entity's workspace can't be resolved (deleted, pod-global/no
    // workspaceId, or not visible to this caller). Shared with
    // synap_match_playbooks via resolveEntityWorkspaceId (shared.ts).
    let autoPicked = false;
    let memberCount = 0;
    if (!relWsId) {
      const resolved = await resolveEntityWorkspaceId(
        userId,
        args.entityId as string | undefined
      );
      relWsId = resolved.workspaceId;
      autoPicked = resolved.autoPicked;
      memberCount = resolved.memberCount;
    }
    if (!relWsId) return ok({ error: "No accessible workspace found" });
    const result = await caller.relations.listRelations({
      userId,
      workspaceId: relWsId,
      entityId: args.entityId as string,
    });
    // Only reshape in the AMBIGUOUS case (we auto-picked among several
    // workspaces); the explicit-workspaceId common case stays byte-identical,
    // so no consumer that expects the raw shape can break. `getRelated` may
    // return an array or an object, so attach the honesty note without
    // clobbering either shape.
    if (autoPicked && memberCount > 1) {
      // Labeled deliberately: this is the MEMBER-only count
      // (getUserMemberWorkspaceIds), not the wider "accessible" count synap_orient
      // reports (member ∪ pod-visible) — the two are correct, separate lenses, and
      // an unlabeled bare number is exactly what reads as a bug when they disagree.
      const note = `The entity's own workspace could not be resolved, so relations were read from ONE workspace (${relWsId}) of your ${memberCount} member workspaces. If this looks empty or incomplete, the entity's relations may live in another workspace — pass an explicit workspaceId to scope deliberately.`;
      return ok(
        Array.isArray(result)
          ? { relations: result, scopedWorkspaceId: relWsId, note }
          : {
              ...(result as Record<string, unknown>),
              scopedWorkspaceId: relWsId,
              note,
            }
      );
    }
    return ok(result);
  },
  synap_get_graph: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
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
    const envelope = await buildGraphEnvelope(userId, apiKeyScopes, gKind, gId);
    // A table-backed id that hydrated to nothing with no visible edges — the id
    // genuinely doesn't exist / isn't visible. Return not-found, never a shell
    // node named by its own UUID (mirrors the name-not-found branch above).
    if (!envelope.found) {
      return ok({ error: `No ${gKind} with id '${gId}'` });
    }
    return ok(envelope);
  },
  synap_get_channel: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, caller } = ctx;
    // GET-OR-CREATE, so this declares the WRITE scope despite the name.
    //
    // Both modes mint rows: `ensurePersonal` creates the personal channel, and
    // `by-context` resolve-or-creates one bound to an object.
    //
    // This is NOT closing an open hole — it makes an existing one honest. The
    // inner procedure is already `scopedProcedure(["hub-protocol.write"])`
    // (hub-protocol/channels.ts), and a read-only key derives only
    // `hub-protocol.read`, so the create was already rejected one layer down.
    // Declaring `mcp.read` here just meant the rejection arrived deep, as a
    // confusing inner 403, instead of at the door with a scope message. It also
    // contradicted `skills/synap/writes.md`, which documents this operation as
    // needing write scope.
    //
    // Practically non-breaking: a read-only key could never complete this call.
    //
    // Kept as ONE tool rather than split into get + create: the create IS the
    // point (a caller asking for a context channel wants one to exist), and a
    // near-identical sibling tool is exactly the overlap that degrades tool
    // selection.
    requireScope(apiKeyScopes, "mcp.write", toolName);
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
  },
};
