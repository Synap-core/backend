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
import { db, knowledgeRepository, messages } from "@synap/database";
import {
  proposals,
  ProposalStatus,
  MessageRole,
  eq,
  and,
  desc,
} from "@synap/database";
import { randomUUID, createHash } from "crypto";
import type { Context } from "../../types/context.js";

// ── tRPC caller factory ───────────────────────────────────────────────────────

async function createHubProtocolCaller(userId: string, scopes: string[]) {
  await getDb();

  const ctx: Context & {
    scopes?: string[];
    apiKeyId?: string;
    apiKeyName?: string;
  } = {
    db,
    authenticated: true,
    userId,
    scopes,
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

export async function executeMCPToolViaHubProtocol(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
  apiKeyScopes: string[]
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
        type: args.type as string,
        title: args.title as string,
        description: args.description as string | undefined,
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
        metadata: args.metadata as Record<string, unknown> | undefined,
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
      if (!wsId) {
        return ok({
          error: "workspaceId is required for listing profiles",
        });
      }
      const result = await caller.profiles.listProfiles({
        userId,
        workspaceId: wsId,
      });
      return ok(result);
    }

    case "synap_get_relations": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const relWsId = args.workspaceId as string | undefined;
      if (!relWsId) {
        return ok({
          error: "workspaceId is required for listing relations",
        });
      }
      const result = await caller.relations.listRelations({
        userId,
        workspaceId: relWsId,
        entityId: args.entityId as string,
      });
      return ok(result);
    }

    case "synap_link_entities": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const linkWsId = args.workspaceId as string | undefined;
      if (!linkWsId) {
        return ok({
          error: "workspaceId is required for creating relations",
        });
      }
      const result = await caller.relations.createRelation({
        userId,
        workspaceId: linkWsId,
        sourceEntityId: args.sourceEntityId as string,
        targetEntityId: args.targetEntityId as string,
        type: (args.type as string) || "related",
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
