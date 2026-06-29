/**
 * MCP to Hub Protocol Adapter
 *
 * This adapter allows MCP to use the existing Hub Protocol API,
 * ensuring all operations go through the same event sourcing,
 * validation, security, and worker infrastructure.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { hubProtocolRouter } from "../hub-protocol/index.js";
import { entitiesRouter as regularEntitiesRouter } from "../entities.js";
import { createHubProtocolCallerContext } from "../hub-protocol/utils.js";
import {
  getObjectGraph,
  resolveByName,
  type GraphNeighbor,
  type GraphEnvelope,
} from "../../services/object-graph/graph-service.js";
import { entityDataNeighbors } from "../../services/object-graph/entity-data-graph.js";
import type { LinkEndpointType } from "@synap/playbooks";
import { ask } from "../../services/knowledge/ask.js";
import { synthesizeAnswer } from "../../services/knowledge/synthesize.js";
import { type ProfileCatalogEntry } from "../../services/retrieval/index.js";
import { getDb } from "@synap/database";
import {
  db,
  focusSessions,
  knowledgeKeysRepository,
  knowledgeRepository,
  messages,
  projects,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import {
  proposals,
  ProposalStatus,
  MessageRole,
  eq,
  and,
  desc,
  inArray,
} from "@synap/database";
import { randomUUID, createHash } from "crypto";
import type { Context } from "../../types/context.js";

// ── tRPC caller factory ───────────────────────────────────────────────────────

async function createHubProtocolCaller(
  userId: string,
  scopes: string[],
  agentUserId?: string
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

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function requireScope(scopes: string[], scope: string, toolName: string): void {
  if (!scopes.includes(scope)) {
    throw new Error(`Tool '${toolName}' requires scope '${scope}'`);
  }
}

// ── Tool execution ────────────────────────────────────────────────────────────

async function getUserWorkspaceIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  return rows.map((r) => r.workspaceId);
}

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
  const caller = await createHubProtocolCaller(
    userId,
    apiKeyScopes,
    agentUserId
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
        catalog = profileRows.flatMap((p) =>
          p.slug ? [{ slug: p.slug, displayName: p.displayName ?? p.slug }] : []
        );
      }
      // Retrieve across all substrates (same call as /knowledge/search).
      const retrieved = await ask({
        query: args.query as string,
        userId,
        workspaceId: workspaceId ?? null,
        projectId: (args.projectId as string | undefined) ?? null,
        limit: (args.limit as number) || undefined,
        catalog,
      });

      // Build context + sources, then synthesize via IS.
      const synthesis = await synthesizeAnswer(
        retrieved.answers,
        args.query as string,
        retrieved.routedTo,
        workspaceId ?? null
      );
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
      const statusArg = (args.status as string) || "pending";
      const statusMap: Record<string, ProposalStatus> = {
        pending: ProposalStatus.PENDING,
        approved: ProposalStatus.APPROVED,
        rejected: ProposalStatus.REJECTED,
      };
      const status = statusMap[statusArg] ?? ProposalStatus.PENDING;

      const proposalUserId = (args.userId as string) || userId;
      const conditions = [eq(proposals.createdBy, proposalUserId)];
      if (args.workspaceId)
        conditions.push(eq(proposals.workspaceId, args.workspaceId as string));
      if (statusArg !== "all") conditions.push(eq(proposals.status, status));

      const result = await db
        .select()
        .from(proposals)
        .where(and(...conditions))
        .orderBy(desc(proposals.createdAt))
        .limit((args.limit as number) || 20);

      return ok(result);
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
          | Record<string, unknown>
          | undefined,
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
      const fact = args.fact as string;
      const factUserId = (args.userId as string) || userId;

      // Embed the fact through the SAME path entity/recall writes use
      // (`@synap/ai-embeddings`), so semantic search can actually rank it.
      // Best-effort: if embedding is unavailable, fall back to a zero vector
      // (keyword search still works) rather than failing the write.
      let embedding: number[];
      try {
        const { generateEmbedding } = await import("@synap/ai-embeddings");
        embedding = await generateEmbedding(fact);
      } catch {
        embedding = new Array(1536).fill(0);
      }
      await knowledgeRepository.saveFact({
        userId: factUserId,
        fact,
        confidence: 0.8,
        embedding,
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
      if (wsId) {
        const result = await caller.profiles.listProfiles({
          userId,
          workspaceId: wsId,
        });
        return ok(result);
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
            merged.push(p);
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
        if (matches.length === 0)
          return ok({ error: `No ${gKind} named '${args.name}'` });
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

    // (synap_send_message removed — synap_post_message supersedes it: it handles
    // thread creation from a channelId and can trigger an AI response. One
    // messaging tool, not two.)

    // ── Session bootstrap & governance ──────────────────────────────────────
    case "synap_orient": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      // Fetch workspaces the user belongs to
      const memberRows = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId));
      const wsIds = memberRows.map((r) => r.workspaceId);
      const wsRaw =
        wsIds.length > 0
          ? await db
              .select({
                id: workspaces.id,
                name: workspaces.name,
                description: workspaces.description,
                domain: workspaces.domain,
                settings: workspaces.settings,
              })
              .from(workspaces)
              .where(inArray(workspaces.id, wsIds))
          : [];
      // Surface the FULL onboarding spec: a workspace declares an onboarding
      // spec (settings.onboarding) the shared `onboard` skill can run. Return
      // the whole interview spec (goal / framing / collect / openingQuestions /
      // doneWhen), not just `goal`, so an agent gets the complete framing. The
      // skill itself checks sparseness before interviewing.
      const wsList = wsRaw.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        domain: w.domain,
        onboarding:
          (w.settings as { onboarding?: Record<string, unknown> } | null)
            ?.onboarding ?? undefined,
      }));
      // Fetch profiles for first workspace as a representative sample
      const firstWsId = wsIds[0];
      const profiles = firstWsId
        ? await caller.profiles.listProfiles({ userId, workspaceId: firstWsId })
        : [];
      // Fetch projects for the user
      const projectRows = await db
        .select({
          id: projects.id,
          name: projects.name,
          description: projects.description,
          workspaceId: projects.workspaceId,
          status: projects.status,
        })
        .from(projects)
        .where(eq(projects.userId, userId));
      return ok({
        me: { userId, scopes: apiKeyScopes },
        workspaces: wsList,
        workspaceCount: wsList.length,
        projects: projectRows,
        projectCount: projectRows.length,
        profiles,
        note:
          wsList.length > 1
            ? `You have ${wsList.length} workspaces and ${projectRows.length} projects. Most read tools auto-scope to all your workspaces when no workspaceId is given. Pass workspaceId to narrow to one workspace; pass projectId to narrow entity reads and recall to a project.`
            : `Single workspace: ${wsList[0]?.name ?? "none"}. ${projectRows.length > 0 ? `${projectRows.length} project(s). ` : ""}Tools default to this workspace. Pass projectId on entity reads/recall to narrow to a project.`,
      });
    }

    case "synap_list_projects": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const conditions = [eq(projects.userId, userId)];
      if (args.workspaceId)
        conditions.push(eq(projects.workspaceId, args.workspaceId as string));
      const projectRows = await db
        .select({
          id: projects.id,
          name: projects.name,
          description: projects.description,
          status: projects.status,
          workspaceId: projects.workspaceId,
        })
        .from(projects)
        .where(and(...conditions));
      return ok(projectRows);
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
          | Record<string, unknown>
          | undefined,
      });
      if (!session) {
        return ok({ error: `Focus session ${args.sessionId} not found` });
      }
      return ok({ status: "closed", session });
    }

    case "synap_update_session": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const sessionId = args.sessionId as string;

      // Load scoped by the operator userId — the floor that stops an agent key
      // from touching another user's session (mirrors completeFocusSession).
      const existing = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, sessionId),
          eq(focusSessions.userId, userId)
        ),
      });
      if (!existing) {
        return ok({ error: `Focus session ${sessionId} not found` });
      }

      // Governance membrane — AI callers route through proposals (same gate the
      // Hub PATCH /focus-sessions/:id and synap_complete_session use).
      const { checkPermissionOrPropose } =
        await import("../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId,
        workspaceId: existing.workspaceId ?? undefined,
        subjectType: "focus_session",
        action: "update",
        source: "intelligence",
        data: {
          id: sessionId,
          status: args.status as string | undefined,
          progress: args.progress as number | undefined,
        },
      });
      if ("denied" in perm && perm.denied) {
        return ok({ error: perm.reason });
      }
      if ("proposalId" in perm) {
        return ok({
          status: "proposed",
          message: "Focus session update proposed for review",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          session: null,
        });
      }

      // Build the field set. status is constrained to active|paused — closing a
      // session is synap_complete_session's job (it also closes the running
      // playbook_run); a raw status='closed' here would orphan that run.
      const set: Partial<typeof focusSessions.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (args.goal !== undefined) set.goal = args.goal as string;
      if (args.status !== undefined)
        set.status = args.status as "active" | "paused";
      if (args.progress !== undefined) set.progress = args.progress as number;

      // addOutput / completeOutput / a full expectedOutputs replace mutate the
      // JSONB deliverables array. Do the read-modify-write inside a transaction
      // with a row lock (`FOR UPDATE`) so two concurrent edits can't both read
      // the same base array and lose one's item (TOCTOU).
      type OutputItem = {
        kind: string;
        label: string;
        icon?: string;
        status?: "pending" | "done";
      };
      const mutatesOutputs =
        args.addOutput !== undefined ||
        typeof args.completeOutput === "string" ||
        args.expectedOutputs !== undefined;

      const [updated] = await db.transaction(async (tx) => {
        if (mutatesOutputs) {
          const [locked] = await tx
            .select({ expectedOutputs: focusSessions.expectedOutputs })
            .from(focusSessions)
            .where(eq(focusSessions.id, sessionId))
            .for("update");
          const current: OutputItem[] = Array.isArray(locked?.expectedOutputs)
            ? (locked.expectedOutputs as OutputItem[])
            : [];
          let next: OutputItem[] =
            (args.expectedOutputs as OutputItem[] | undefined) ?? current;
          if (args.addOutput) {
            const add = args.addOutput as OutputItem;
            next = [
              ...next,
              {
                kind: add.kind,
                label: add.label,
                icon: add.icon,
                status: "pending",
              },
            ];
          }
          if (typeof args.completeOutput === "string") {
            const label = args.completeOutput;
            next = next.map((o) =>
              o.label === label ? { ...o, status: "done" as const } : o
            );
          }
          set.expectedOutputs = next;
        }
        return tx
          .update(focusSessions)
          .set(set)
          .where(eq(focusSessions.id, sessionId))
          .returning();
      });
      return ok({ status: "updated", session: updated });
    }

    case "synap_governance": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const wsId = args.workspaceId as string;
      const { getEffectiveGovernance } =
        await import("../../utils/permission-check.js");
      const policy = await getEffectiveGovernance(wsId);
      const pendingCount = await db
        .select({ count: proposals.id })
        .from(proposals)
        .where(
          and(
            eq(proposals.workspaceId, wsId),
            eq(proposals.status, ProposalStatus.PENDING)
          )
        )
        .then((rows) => rows.length);
      return ok({ ...policy, pendingProposals: pendingCount });
    }

    // ── Capture ──────────────────────────────────────────────────────────────
    case "synap_capture": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const { captureRouter } = await import("../capture.js");
      // Resolve workspace: use provided or fall back to user's first workspace
      let captureWsId = args.workspaceId as string | undefined;
      if (!captureWsId) {
        const row = await db
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, userId))
          .limit(1)
          .then((r) => r[0]);
        captureWsId = row?.workspaceId;
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
        undefined,
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
      });
      // Step 2 — ACTUALLY WRITE. structure() only previews; without execute()
      // the capture tool returns proposals that are never materialized — the
      // "write door" wrote nothing. Mirror the CLI's smart-capture (structure →
      // execute). First-party capture writes DIRECTLY and records an
      // auto-approved, revertible proposal — it does NOT return 'proposed' /
      // wait for review. The materialized entities come back in the result.
      const captureProposals =
        (structured as { proposals?: unknown[] }).proposals ?? [];
      if (captureProposals.length === 0) {
        return ok({
          ...structured,
          executed: false,
          note: "Nothing to capture.",
        });
      }
      const executed = await captureCaller.execute({
        entities: captureProposals as Parameters<
          typeof captureCaller.execute
        >[0]["entities"],
        relations:
          ((structured as { relations?: unknown[] }).relations as Parameters<
            typeof captureCaller.execute
          >[0]["relations"]) ?? [],
      });
      return ok({ structured, executed });
    }

    // ── Workspace & view creation ─────────────────────────────────────────────
    case "synap_create_workspace": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const { createWorkspaceFromDefinitionIdempotent } =
        await import("../../services/workspace-creation-service.js");
      const { workspaceId: newWsId, created } =
        await createWorkspaceFromDefinitionIdempotent({
          definition: (args.definition ?? {}) as Parameters<
            typeof createWorkspaceFromDefinitionIdempotent
          >[0]["definition"],
          userId,
          proposalId: args.proposalId as string | undefined,
          workspaceName: args.name as string,
          createdBy: "provisioning",
        });
      return ok({ workspaceId: newWsId, created });
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
      const channelId = args.channelId as string;
      const content = args.content as string;
      const role = (args.role as string) || "assistant";
      const triggerAI = Boolean(args.triggerAI);
      const msgId = randomUUID();
      const hash = createHash("sha256")
        .update(`${msgId}${content}`)
        .digest("hex");
      const roleEnum =
        role === "user"
          ? MessageRole.USER
          : role === "system"
            ? MessageRole.SYSTEM
            : MessageRole.ASSISTANT;
      await db.insert(messages).values({
        id: msgId,
        channelId,
        role: roleEnum,
        content,
        userId,
        hash,
        previousHash: "",
      });
      if (triggerAI) {
        const { emitChatEvent } =
          await import("../../utils/chat-realtime-broadcast.js");
        const { EventNames } = await import("@synap-core/types/events");
        emitChatEvent({
          event: EventNames.CHAT_MESSAGE,
          data: {
            threadId: channelId,
            message: {
              id: msgId,
              threadId: channelId,
              role: roleEnum,
              content,
              userId,
              timestamp: new Date(),
              previousHash: "",
              hash,
            },
            userId,
            triggerAI: true,
          },
          workspaceId: null,
          userId,
        });
      }
      return ok({ success: true, messageId: msgId, channelId });
    }

    // ── Proposals & knowledge ─────────────────────────────────────────────────
    case "synap_revise_proposal": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const proposalId = args.proposalId as string;
      const updateData: Record<string, unknown> = {};
      if (args.summary !== undefined) updateData.summary = args.summary;
      if (args.reasoning !== undefined) updateData.reasoning = args.reasoning;
      if (Object.keys(updateData).length === 0) {
        return ok({ error: "Provide at least one of: summary, reasoning" });
      }
      await db
        .update(proposals)
        .set({
          ...(updateData as { summary?: string; reasoning?: string }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proposals.id, proposalId),
            eq(proposals.status, ProposalStatus.PENDING)
          )
        );
      return ok({ success: true, proposalId });
    }

    // (synap_write_knowledge folded into synap_capture's `global` lane — one
    // write door. A pod-wide runbook is `capture` with global:true.)

    // ── Capabilities (connected-service verbs) ─────────────────────────────────
    case "synap_list_capabilities": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const wsId = args.workspaceId as string;
      const { listCapabilities } =
        await import("../../services/capabilities/capability-registry.js");
      const capabilities = await listCapabilities({
        workspaceId: wsId,
        userId,
      });
      // Flatten to a verb-first list the agent can act on directly: each runnable
      // verb + whether its owning capability is enabled (approved) or DRAFT.
      const runnable = (
        capabilities as Array<{
          name?: string;
          kind?: string;
          approved?: boolean;
          governance?: unknown;
          verbs?: Array<{
            id?: string;
            label?: string;
            kind?: string;
            effectiveExecMode?: string;
          }>;
        }>
      ).flatMap((cap) =>
        (cap.verbs ?? []).map((v) => ({
          verbId: v.id,
          label: v.label ?? v.id,
          tool: cap.name,
          enabled: cap.approved === true,
          execMode: v.effectiveExecMode,
        }))
      );
      return ok({ capabilities, runnable });
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
      });
      // Surface the same discriminated outcome the hub door returns, in a shape
      // the agent reads naturally (proposed is NOT an error).
      return ok(outcome);
    }

    default:
      throw new Error(`Unknown MCP tool: ${toolName}`);
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
