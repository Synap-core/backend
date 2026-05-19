/**
 * MCP Tools — Synap Hub Protocol
 *
 * Exposes Synap data operations as MCP tools.
 * All writes go through checkPermissionOrPropose() governance.
 *
 * Tool naming convention: synap_{operation}
 * Scopes: mcp.read (reads), mcp.write (writes)
 */

import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const tools = {
  /**
   * List all available tools
   */
  async list(): Promise<Tool[]> {
    return [
      // ── Read / Search ───────────────────────────────────────────────────────
      {
        name: "synap_search",
        description:
          "Unified full-text search across entities, documents, and views. Use for open-ended queries when you don't know the content type. Filter by collections: ['entities','documents','views']. ALWAYS call this or synap_search_entities before creating anything — check for duplicates first.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            workspaceId: {
              type: "string",
              description: "Workspace ID to scope the search",
            },
            collections: {
              type: "array",
              items: {
                type: "string",
                enum: ["entities", "documents", "views", "projects", "agents"],
              },
              description: "Limit to specific collections (optional)",
            },
            limit: {
              type: "number",
              description: "Max results (default: 20)",
              default: 20,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "synap_search_entities",
        description:
          "Search entities by keywords or natural language, filtered by profileSlug (entity type). Use when you want entities specifically. ALWAYS call before synap_create_entity to avoid duplicates. If a result matches with high confidence, link to it instead of creating new. Returns id, title, profileSlug, status, priority, properties.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            profileSlug: {
              type: "string",
              description:
                "Profile slug to filter by (e.g. note, task, bookmark, or a custom profile). Prefer this over `type`.",
            },
            type: {
              type: "string",
              description: "Deprecated alias for profileSlug — same meaning.",
            },
            workspaceId: {
              type: "string",
              description: "Workspace ID (optional)",
            },
            limit: { type: "number", default: 20 },
          },
          required: ["query"],
        },
      },
      {
        name: "synap_get_entities",
        description:
          "List entities for a user filtered by profileSlug. Use to browse all entities of a type (all tasks, all projects). For content search use synap_search_entities. Supports limit (default 50).",
        inputSchema: {
          type: "object",
          properties: {
            profileSlug: {
              type: "string",
              description:
                "Profile slug filter (e.g. note, task, bookmark). Prefer this over `type`.",
            },
            type: {
              type: "string",
              description: "Deprecated alias for profileSlug.",
            },
            workspaceId: {
              type: "string",
              description: "Workspace ID (optional)",
            },
            limit: { type: "number", default: 50 },
          },
          required: [],
        },
      },
      {
        name: "synap_get_document",
        description:
          "Get a document by ID, returning full markdown content. Documents are long-form content (meeting notes, research, writeups) attached to entities. Get documentId from entity.documentId or search results.",
        inputSchema: {
          type: "object",
          properties: {
            documentId: { type: "string", description: "Document UUID" },
          },
          required: ["documentId"],
        },
      },
      {
        name: "synap_recall_facts",
        description:
          "Search memory facts by keyword. Memory stores loose atomic knowledge: preferences, context, facts that don't fit structured entities. Use for 'user prefers X', 'standup is 10am'. For meaning-based search call POST /api/hub/memory/search. Complement with synap_search_entities for structured data. userId is auto-injected from the API key if not provided.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to recall" },
            userId: {
              type: "string",
              description:
                "User ID to recall for (optional, auto-injected from API key if not provided)",
            },
            workspaceId: { type: "string" },
            limit: { type: "number", default: 10 },
          },
          required: ["query"],
        },
      },
      {
        name: "synap_get_thread_context",
        description:
          "Get full context for a thread: all messages plus linked entities and documents. Call before sending a message to orient yourself with conversation history and in-scope data. threadId from synap_send_message or the user's personal channel.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string", description: "Channel/thread UUID" },
          },
          required: ["threadId"],
        },
      },
      {
        name: "synap_list_proposals",
        description:
          "List proposals — pending AI writes awaiting human review. AI writes return status 'proposed' when they require human approval — this is NOT an error. Filter by status: 'pending' (needs review), 'approved', 'rejected'. Use to show the user their pending changes. userId is auto-injected from the API key if not provided.",
        inputSchema: {
          type: "object",
          properties: {
            userId: {
              type: "string",
              description:
                "User ID (optional, auto-injected from API key if not provided)",
            },
            workspaceId: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "approved", "rejected"],
              default: "pending",
            },
            limit: { type: "number", default: 20 },
          },
          required: [],
        },
      },
      {
        name: "synap_get_entity",
        description:
          "Get a single entity by ID with full details: all properties and metadata. Use after synap_search_entities to get complete data on a result. The id comes from search results or synap_create_entity responses.",
        inputSchema: {
          type: "object",
          properties: {
            entityId: { type: "string", description: "Entity UUID" },
            workspaceId: {
              type: "string",
              description: "Workspace ID (optional)",
            },
          },
          required: ["entityId"],
        },
      },
      {
        name: "synap_list_profiles",
        description:
          "List all available entity types in the workspace — system profiles (always present) plus custom types. ALWAYS call at session start before creating entities. Never assume 'deal' or custom types exist — workspaces differ. Returns slug, displayName, entityScope (pod-wide vs workspace-scoped), and property definitions.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Workspace ID (optional)",
            },
          },
          required: ["workspaceId"],
        },
      },
      {
        name: "synap_get_relations",
        description:
          "Get all relations for an entity — inbound and outbound. Returns typed edges with sourceEntityId, targetEntityId, and relation type. Check before synap_link_entities to avoid duplicates. Use to understand an entity's connections.",
        inputSchema: {
          type: "object",
          properties: {
            entityId: {
              type: "string",
              description: "Entity UUID to get relations for",
            },
            workspaceId: {
              type: "string",
              description: "Workspace ID (optional)",
            },
          },
          required: ["entityId", "workspaceId"],
        },
      },
      {
        name: "synap_get_knowledge",
        description:
          "Get a single knowledge key by its namespace:slug identifier (e.g. 'deploy:backend'). Knowledge keys are pod-wide procedural docs — deploy guides, build instructions, operational runbooks, architecture decisions. Use when the user asks 'how do we deploy', 'how does auth work', 'what's our backup strategy', 'how to fix X'. Always search first with synap_list_knowledge to discover available keys.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description:
                "Knowledge key in namespace:slug format (e.g., 'deploy:backend')",
            },
            workspaceId: {
              type: "string",
              description:
                "Workspace ID (optional, defaults to auth user's workspace)",
            },
          },
          required: ["key"],
        },
      },
      {
        name: "synap_list_knowledge",
        description:
          "List all available knowledge keys, optionally filtered by namespace. Returns namespace, slug, key, title, and last updated date. Use before synap_get_knowledge to discover what procedural docs are available. Example namespaces: deploy, build, ops, architecture, security, runbooks.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: {
              type: "string",
              description:
                "Filter by namespace (e.g., 'deploy', 'build', 'ops')",
            },
            workspaceId: {
              type: "string",
              description:
                "Workspace ID (optional, defaults to auth user's workspace)",
            },
            status: {
              type: "string",
              description: "Filter by status: 'active' (default) or all",
              enum: ["active", "all"],
              default: "active",
            },
          },
          required: [],
        },
      },

      // ── Writes (governed — may create proposals) ───────────────────────────
      {
        name: "synap_create_entity",
        description:
          "Create a new entity. Use synap_list_profiles to discover available profileSlugs first. ALWAYS call synap_search_entities before creating to avoid duplicates. Response may be 'approved' (entity created, id returned) or 'proposed' (awaiting human review, proposalId returned). NEVER treat 'proposed' as an error — store proposalId and tell the user to review it in Synap.",
        inputSchema: {
          type: "object",
          properties: {
            profileSlug: {
              type: "string",
              description:
                "Entity profile slug (e.g., note, task, project, event, person, contact, company, deal, bookmark, article). Use synap_list_profiles to discover available types.",
            },
            title: { type: "string" },
            description: { type: "string" },
            properties: {
              type: "object",
              description:
                "Typed entity properties (profileSlug-specific fields)",
            },
          },
          required: ["profileSlug", "title"],
        },
      },
      {
        name: "synap_update_entity",
        description:
          "Update an entity's title, description, or properties (JSONB). Requires entityId from search or synap_get_entity. May return 'proposed' if the write requires review. Use for status changes (task todo→done), property updates, corrections.",
        inputSchema: {
          type: "object",
          properties: {
            entityId: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            properties: {
              type: "object",
              description:
                "Partial properties to merge into entity.properties JSONB",
            },
            metadata: { type: "object" },
          },
          required: ["entityId"],
        },
      },
      {
        name: "synap_create_document",
        description:
          "Create a long-form markdown document, optionally attached to an entity. Use for meeting notes, research, plans — content that doesn't fit entity properties. Content is full markdown. May return 'proposed'.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: {
              type: "string",
              description: "Document content (markdown or plain text)",
            },
            workspaceId: { type: "string" },
          },
          required: ["title", "workspaceId"],
        },
      },
      {
        name: "synap_remember_fact",
        description:
          "Store a loose fact or knowledge fragment in persistent memory. Use for preferences, context, and facts recalled by keyword. Always auto-approved (never proposed). For structured objects use synap_create_entity.",
        inputSchema: {
          type: "object",
          properties: {
            userId: {
              type: "string",
              description:
                "User ID (auto-injected from API key if not provided)",
            },
            fact: { type: "string", description: "The fact to remember" },
            workspaceId: { type: "string" },
          },
          required: ["fact"],
        },
      },
      {
        name: "synap_send_message",
        description:
          "Send a message to a Synap channel/thread. Omit channelId to post to the user's personal AI thread. Set autoRespond: true to trigger AI response. Use for summaries, channel discussions, and content the user wants to find in Synap chat. Pass the real user's ID — not the API key owner's.",
        inputSchema: {
          type: "object",
          properties: {
            channelId: {
              type: "string",
              description: "Channel/thread UUID to send to",
            },
            content: { type: "string", description: "Message content" },
            workspaceId: { type: "string" },
          },
          required: ["channelId", "content"],
        },
      },
      {
        name: "synap_link_entities",
        description:
          "Create a typed relation between two entities. Type is a free string — use conventions: 'related_to', 'parent_of', 'child_of', 'belongs_to', 'authored_by', 'depends_on', 'references', 'mentions'. Check synap_get_relations first to avoid duplicates. May return 'proposed'. Builds the knowledge graph.",
        inputSchema: {
          type: "object",
          properties: {
            sourceEntityId: {
              type: "string",
              description: "Source entity UUID",
            },
            targetEntityId: {
              type: "string",
              description: "Target entity UUID",
            },
            type: {
              type: "string",
              description:
                "Relation type (e.g., 'related', 'parent', 'child', 'belongs-to')",
              default: "related",
            },
            workspaceId: {
              type: "string",
              description: "Workspace ID (optional)",
            },
          },
          required: ["sourceEntityId", "targetEntityId", "workspaceId"],
        },
      },

      // ── Session bootstrap & governance ─────────────────────────────────────
      {
        name: "synap_orient",
        description:
          "Bootstrap context for a new session. Returns the user's identity scopes, accessible workspaces, and available profiles. Call this first in every new session before any other tool.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "synap_governance",
        description:
          "Read workspace governance policy and count of pending proposals. Use before writes to understand auto-approve rules and whether proposals will be created.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string", description: "Workspace UUID" },
          },
          required: ["workspaceId"],
        },
      },

      // ── Capture ─────────────────────────────────────────────────────────────
      {
        name: "synap_capture",
        description:
          "Parse unstructured text into structured entity proposals via the AI capture pipeline. Returns proposed entities ready to inspect or materialize. Optionally hint a profileSlug to guide extraction.",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Free-form text to parse (max 8000 chars)",
            },
            profileSlug: {
              type: "string",
              description:
                "Optional profile hint to guide entity type extraction",
            },
            workspaceId: { type: "string" },
          },
          required: ["text"],
        },
      },

      // ── Workspace & view creation ───────────────────────────────────────────
      {
        name: "synap_create_workspace",
        description:
          "Create a workspace from a definition (name + optional WorkspaceProposal definition object). Pass a stable proposalId for idempotency — same id + user returns the existing workspace.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Workspace display name" },
            definition: {
              type: "object",
              description: "Optional WorkspaceProposal definition fields",
            },
            proposalId: {
              type: "string",
              description: "Idempotency key (optional)",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "synap_create_view",
        description:
          "Create a view in a workspace. Type controls layout: table, kanban, list, gallery, calendar, bento, masonry, flow. profileId scopes the view to one entity type.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: {
              type: "string",
              enum: [
                "table",
                "kanban",
                "list",
                "gallery",
                "calendar",
                "bento",
                "masonry",
                "flow",
              ],
            },
            workspaceId: { type: "string" },
            profileId: {
              type: "string",
              description: "Profile UUID to scope the view (optional)",
            },
            config: {
              type: "object",
              description:
                "View configuration (groupBy, sortBy, filters, etc.)",
            },
          },
          required: ["name", "type", "workspaceId"],
        },
      },

      // ── Channel & messaging ─────────────────────────────────────────────────
      {
        name: "synap_get_channel",
        description:
          "Get or create a channel. Use mode 'personal' to get the user's personal AI thread for a workspace. Use mode 'by-context' to get/create a thread scoped to an entity or document.",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["personal", "by-context"],
            },
            workspaceId: { type: "string" },
            contextObjectType: {
              type: "string",
              enum: ["entity", "document"],
              description: "Required for mode 'by-context'",
            },
            contextObjectId: {
              type: "string",
              description: "Required for mode 'by-context'",
            },
          },
          required: ["mode", "workspaceId"],
        },
      },
      {
        name: "synap_post_message",
        description:
          "Post a message to a Synap channel or thread with optional AI triggering. Unlike synap_send_message, this handles thread creation from a channelId and can trigger an AI response.",
        inputSchema: {
          type: "object",
          properties: {
            channelId: {
              type: "string",
              description: "Channel UUID to post into",
            },
            content: { type: "string" },
            role: {
              type: "string",
              enum: ["user", "assistant", "system"],
              default: "assistant",
            },
            triggerAI: {
              type: "boolean",
              description: "Set true to trigger an AI response after posting",
              default: false,
            },
          },
          required: ["channelId", "content"],
        },
      },

      // ── Proposals & knowledge ───────────────────────────────────────────────
      {
        name: "synap_revise_proposal",
        description:
          "Update the summary or reasoning of a pending proposal (e.g. after user feedback). Does not re-run the event pipeline.",
        inputSchema: {
          type: "object",
          properties: {
            proposalId: { type: "string", description: "Proposal UUID" },
            summary: { type: "string" },
            reasoning: { type: "string" },
          },
          required: ["proposalId"],
        },
      },
      {
        name: "synap_write_knowledge",
        description:
          "Create or update a knowledge document by key (namespace:slug format, e.g. 'deploy:backend'). Upserts the entry — safe to call repeatedly to keep docs current.",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "Knowledge key in namespace:slug format",
            },
            content: {
              type: "string",
              description: "Document content (markdown)",
            },
            namespace: { type: "string" },
            workspaceId: { type: "string" },
          },
          required: ["key", "content"],
        },
      },
    ];
  },

  /**
   * Execute a tool
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    userId: string,
    apiKeyScopes: string[]
  ): Promise<CallToolResult> {
    const { executeMCPToolViaHubProtocol } = await import("../adapter.js");
    return await executeMCPToolViaHubProtocol(name, args, userId, apiKeyScopes);
  },
};
