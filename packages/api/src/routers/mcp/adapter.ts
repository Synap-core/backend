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
import { getDb } from "@synap/database";
import {
  db,
  knowledgeKeysRepository,
  knowledgeRepository,
  messages,
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

async function createHubProtocolCaller(userId: string, scopes: string[]) {
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

export async function executeMCPToolViaHubProtocol(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
  apiKeyScopes: string[],
  _sessionUserId?: string
): Promise<CallToolResult> {
  const caller = await createHubProtocolCaller(userId, apiKeyScopes);

  switch (toolName) {
    // ── Read tools ──────────────────────────────────────────────────────────
    case "synap_search": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const result = await caller.search.search({
        userId,
        query: args.query as string,
        workspaceId: args.workspaceId as string | undefined,
        limit: (args.limit as number) || 20,
      });
      return ok(result);
    }

    case "synap_search_entities": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const slug =
        (args.profileSlug as string | undefined) ||
        (args.type as string | undefined);
      const result = await caller.search.searchEntities({
        userId,
        query: args.query as string,
        ...(slug ? { profileSlug: slug } : {}),
        ...(args.workspaceId
          ? { workspaceId: args.workspaceId as string }
          : {}),
        limit: (args.limit as number) || 20,
      });
      return ok(result);
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

    case "synap_recall_facts": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      // Keyword-based fact search (no embedding needed)
      const facts = await knowledgeRepository.searchFacts({
        userId: (args.userId as string) || userId,
        query: args.query as string,
        limit: (args.limit as number) || 10,
      });
      return ok(facts);
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
      });
      return ok(result);
    }

    case "synap_remember_fact": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const fact = args.fact as string;
      const factUserId = (args.userId as string) || userId;

      // Store fact with a zero embedding (keyword search still works;
      // semantic search will rank it low, which is acceptable for MCP-sourced facts).
      const zeroEmbedding = new Array(1536).fill(0);
      await knowledgeRepository.saveFact({
        userId: factUserId,
        fact,
        confidence: 0.8,
        embedding: zeroEmbedding,
      });
      return ok({ success: true, message: "Fact stored successfully" });
    }

    case "synap_get_entity": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      // Hub protocol doesn't expose a single-entity get; use regular entities router
      const entityCallerCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        (args.workspaceId as string) || undefined
      );
      const entityCaller = regularEntitiesRouter.createCaller(entityCallerCtx);
      const entityResult = await entityCaller.get({
        id: args.entityId as string,
        includeProfile: true,
      });
      return ok(entityResult);
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
      });
      return ok(result);
    }

    case "synap_get_knowledge": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const wsId = args.workspaceId as string | undefined;
      // Knowledge keys live in Hub Protocol REST (not tRPC). Call the
      // repository directly — same data path as POST/GET /api/hub/knowledge.
      const result = await knowledgeKeysRepository.getByKey(
        args.key as string,
        wsId
      );
      return ok(result);
    }

    case "synap_list_knowledge": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const wsId = args.workspaceId as string | undefined;
      const statusFilter =
        (args.status as string | undefined) === "active" ? "active" : undefined;
      // Knowledge keys live in Hub Protocol REST (not tRPC). Call the
      // repository directly — same data path as GET /api/hub/knowledge.
      const result = await knowledgeKeysRepository.list({
        namespace: args.namespace as string | undefined,
        workspaceId: wsId,
        status: statusFilter,
      });
      return ok(result);
    }

    case "synap_send_message": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const content = args.content as string;
      const channelId = args.channelId as string;
      const hash = createHash("sha256")
        .update(JSON.stringify({ channelId, content, role: "assistant" }))
        .digest("hex");
      await db.insert(messages).values({
        id: randomUUID(),
        channelId,
        role: MessageRole.ASSISTANT,
        content,
        userId,
        hash,
        previousHash: "",
      });
      return ok({ success: true, channelId });
    }

    // ── Session bootstrap & governance ──────────────────────────────────────
    case "synap_orient": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      await getDb();
      // Fetch workspaces the user belongs to
      const memberRows = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId));
      const wsIds = memberRows.map((r) => r.workspaceId);
      const wsList =
        wsIds.length > 0
          ? await db
              .select({ id: workspaces.id, name: workspaces.name })
              .from(workspaces)
              .where(inArray(workspaces.id, wsIds))
          : [];
      // Fetch profiles for first workspace as a representative sample
      const firstWsId = wsIds[0];
      const profiles = firstWsId
        ? await caller.profiles.listProfiles({ userId, workspaceId: firstWsId })
        : [];
      return ok({
        me: { userId, scopes: apiKeyScopes },
        workspaces: wsList,
        workspaceCount: wsList.length,
        profiles,
        note:
          wsList.length > 1
            ? `You have ${wsList.length} workspaces. MCP tools auto-scope to all when no workspaceId is given. Pass workspaceId to narrow to one workspace.`
            : `Single workspace: ${wsList[0]?.name ?? "none"}. All tools default to this workspace.`,
      });
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
      const captureCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        captureWsId
      );
      const captureCaller = captureRouter.createCaller(
        captureCtx as Parameters<typeof captureRouter.createCaller>[0]
      );
      const result = await captureCaller.structure({
        text: args.text as string,
        context: args.profileSlug
          ? `Hint: profile is ${args.profileSlug}`
          : undefined,
      });
      return ok(result);
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

    case "synap_write_knowledge": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const key = args.key as string;
      const content = args.content as string;
      const wsId = (args.workspaceId as string | undefined) || userId;
      const record = await knowledgeKeysRepository.upsert(key, {
        key,
        value: content,
        status: "active",
        workspaceId: wsId,
        author: userId,
      });
      return ok(record);
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
