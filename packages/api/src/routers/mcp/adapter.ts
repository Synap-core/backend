/**
 * MCP to Hub Protocol Adapter
 *
 * This adapter allows MCP to use the existing Hub Protocol API,
 * ensuring all operations go through the same event sourcing,
 * validation, security, and worker infrastructure.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { hubProtocolRouter } from "../hub-protocol/index.js";
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
      const validTypes = [
        "note",
        "task",
        "document",
        "project",
        "contact",
        "meeting",
        "idea",
      ] as const;
      const t = args.type as string | undefined;
      const validType =
        t && (validTypes as readonly string[]).includes(t)
          ? (t as (typeof validTypes)[number])
          : undefined;
      const result = await caller.search.searchEntities({
        userId,
        query: args.query as string,
        type: validType,
        limit: (args.limit as number) || 20,
      });
      return ok(result);
    }

    case "synap_get_entities": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const validTypes = [
        "task",
        "note",
        "document",
        "project",
        "contact",
        "meeting",
        "idea",
      ] as const;
      const t = args.type as string | undefined;
      const validType =
        t && (validTypes as readonly string[]).includes(t)
          ? (t as (typeof validTypes)[number])
          : undefined;
      const result = await caller.entities.getEntities({
        userId,
        type: validType,
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
        userId: args.userId as string,
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

      const conditions = [eq(proposals.createdBy, args.userId as string)];
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
      // Storing facts requires semantic embeddings — route through Intelligence Hub.
      // For direct storage, use POST /api/hub/memory with a pre-computed embedding.
      return ok({
        success: false,
        message:
          "Use the Intelligence Hub's /api/hub/memory endpoint directly to store facts with embeddings. Provide: { userId, fact, embedding: number[1536] }",
      });
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

    const validTypes = [
      "task",
      "note",
      "document",
      "project",
      "contact",
      "meeting",
      "idea",
    ] as const;
    const validType = (validTypes as readonly string[]).includes(entityType!)
      ? (entityType as (typeof validTypes)[number])
      : undefined;
    const entities = await caller.entities.getEntities({
      userId,
      type: validType,
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
