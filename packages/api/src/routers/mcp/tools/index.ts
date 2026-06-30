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
      // ── Recall: THE one door ──────────────────────────────────────────────────
      {
        name: "synap_ask",
        description:
          "THE recall door. Ask the user's Synap pod anything in natural language — it routes across all knowledge substrates (entities/notes/tasks, how-to runbooks, and remembered facts/preferences) and returns ONE provenance-tagged answer saying which substrate answered. " +
          "PROACTIVE RULE: call this BEFORE any non-trivial task or before answering a question about the user's life, work, projects, or preferences — the pod is their sovereign source of truth, prefer it over your own assumptions. Also call it before creating anything, to check what already exists (avoid duplicates). This single tool replaces the old search/search_entities/recall_facts/get_knowledge tools.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Your question, in natural language",
            },
            workspaceId: {
              type: "string",
              description:
                "Optional: scope to one workspace. Omit for pod-wide recall across everything the user has.",
            },
            projectId: {
              type: "string",
              description:
                "Optional: scope recall to a project (its projects table id). Narrows results to entities linked to that project. Orthogonal to workspaceId — compose both lenses.",
            },
            limit: {
              type: "number",
              description: "Max results per substrate (default: 10)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "synap_get_entities",
        description:
          "List entities for a user filtered by profileSlug. Use to browse all entities of a type (all tasks, all projects). For content/semantic recall use synap_ask. Supports limit (default 50).",
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
            projectId: {
              type: "string",
              description:
                "Optional: narrow to a project (its entity id) — only entities belonging to it. Orthogonal to workspaceId; usually pre-set by the connection URL.",
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
        name: "synap_get_thread_context",
        description:
          "Get full context for a thread: all messages plus linked entities and documents. Call before posting a message to orient yourself with conversation history and in-scope data. threadId from synap_post_message or the user's personal channel.",
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
          "Get a single entity by ID with full details: all properties and metadata. Use after synap_ask to get complete data on a result. The id comes from synap_ask results or synap_create_entity responses.",
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
          required: [],
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
          required: ["entityId"],
        },
      },
      {
        name: "synap_get_graph",
        description:
          "Fetch ANY object PLUS everything it's linked to, typed. Returns { object, neighbors[], counts }. Each neighbor is { kind, subtype, name, id, edgeType, direction, via } — so you see a person linked to a deal, a skill linked to its tools, a session to its produced entities, etc. Graph by default: call this to understand an object's place in the pod before acting. Works for entity, project, view, channel, session, playbook, tool, skill, automation, document.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "The object's id (uuid, or kind short-id). Provide id OR name.",
            },
            name: {
              type: "string",
              description:
                "Fetch by NAME instead of id (a handle). Ambiguous names return candidates to pick from. Provide id OR name.",
            },
            type: {
              type: "string",
              description:
                "Object kind: entity (default), project, view, channel, session, playbook, tool, skill, automation, document.",
            },
            subtype: {
              type: "string",
              description:
                "Narrow a name lookup (entity profileSlug, view type, tool/skill kind). Optional.",
            },
          },
          required: [],
        },
      },

      // (Procedural how-to recall — "how do we deploy", "how does auth work" —
      // is now served by `synap_ask`, which routes to the knowledge_keys
      // substrate. The standalone get_knowledge/list_knowledge tools were folded
      // into it so there is ONE recall door.)

      // ── Writes (governed — may create proposals) ───────────────────────────
      {
        name: "synap_create_entity",
        description:
          "Create a typed entity directly when you already know the exact profileSlug + fields (the precise sibling of synap_capture, which structures free text). Use synap_list_profiles to discover profileSlugs. ALWAYS call synap_ask first to avoid duplicates. Response may be 'approved' (created, id returned) or 'proposed' (awaiting human review, proposalId returned). NEVER treat 'proposed' as an error — store proposalId and tell the user to review it in Synap. PREFER THIS over synap_capture whenever you already know the profileSlug + fields (a task with status/dueDate, a decision with claim/rationale, a person with role/company). It is the structured, deterministic write. Reach for synap_capture only for unstructured blobs you haven't parsed yet.",
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
          required: ["sourceEntityId", "targetEntityId"],
        },
      },

      // ── Session bootstrap & governance ─────────────────────────────────────
      {
        name: "synap_orient",
        description:
          "Returns the user's identity, accessible workspaces, projects, and profiles. Call first in every session.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "synap_list_projects",
        description:
          "List all projects for the user, optionally scoped to a workspace. Returns name, description, status, and workspaceId. Projects are a cross-cutting dimension, orthogonal to workspaces — compose both lenses.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description:
                "Optional: scope to one workspace. Omit for all projects across all workspaces.",
            },
          },
          required: [],
        },
      },
      {
        name: "synap_start_session",
        description:
          "Create a focus session — a goal-bound work session tracked in Synap. Use this to declare 'I'm starting work on X'. A session can be scoped to a project (projectId) OR a workspace (workspaceId) — provide at least one; a project-scoped session needs no workspace membership. The session appears in the browser SessionRoom. After creating, use synap_get_channel to get a personal channel, then synap_post_message with triggerAI=true to dispatch the IS agent for autonomous work. The agent's produced entities are linked to the session via the graph.",
        inputSchema: {
          type: "object",
          properties: {
            goal: {
              type: "string",
              description:
                "ONE short line — a single outcome-oriented sentence (e.g. 'Research best web-scraping approaches for social media'). NOT a paragraph. Put detail, scope, and deliverables in expectedOutputs, never in the goal.",
            },
            workspaceId: {
              type: "string",
              description:
                "Workspace ID the session belongs to. Optional — provide this OR projectId (at least one is required).",
            },
            projectId: {
              type: "string",
              description:
                "Project ID the session belongs to. Optional — provide this OR workspaceId (at least one is required). A project-scoped session needs no workspace membership.",
            },
            subjectEntityId: {
              type: "string",
              description:
                "Optional UUID of the entity this session is ABOUT — the subject-spine anchor (e.g. a person, company, or deal). Ties the session to that entity so it surfaces in the entity's neighborhood.",
            },
            correlationId: {
              type: "string",
              description:
                "Optional idempotency key — same correlationId for same user+workspace returns the existing session.",
            },
            channelId: {
              type: "string",
              description:
                "Optional channel UUID to attach to the session (e.g. the personal channel from synap_get_channel).",
            },
            agentIds: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional array of agent IDs participating in this session.",
            },
            templateId: {
              type: "string",
              description:
                "Optional session template UUID to bootstrap this session from.",
            },
            expectedOutputs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string" },
                  label: { type: "string" },
                  icon: { type: "string" },
                  status: {
                    type: "string",
                    enum: ["pending", "done"],
                    description:
                      "Per-item lifecycle. Defaults to 'pending' when omitted.",
                  },
                },
                required: ["kind", "label"],
              },
              description:
                "Where the detail goes — list each concrete deliverable here so the goal can stay one line. Optional expected deliverables — what the session should produce.",
            },
          },
          required: ["goal"],
        },
      },
      {
        name: "synap_update_session",
        description:
          "Update an in-flight focus session — change its goal, lifecycle status (active|paused), 0-100 progress, or its expected deliverables. Use this WHILE working: bump progress, pause/resume, refine the goal, or mark a deliverable done. Two convenience modes for the per-item deliverable lifecycle: `addOutput` appends a new deliverable (status 'pending'); `completeOutput` marks a deliverable 'done' by exact label match. To CLOSE a session (with a summary, closing any running playbook) use synap_complete_session — update_session intentionally cannot close.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The focus session UUID to update.",
            },
            goal: {
              type: "string",
              description: "New one-line goal (optional).",
            },
            status: {
              type: "string",
              enum: ["active", "paused"],
              description:
                "New lifecycle status (optional). To CLOSE a session use synap_complete_session — update_session cannot close, since a raw close would orphan a running playbook_run.",
            },
            progress: {
              type: "number",
              description: "0-100 integer progress (optional).",
            },
            currentStage: {
              type: "string",
              description:
                "Advance the session to this playbook stage by its stage `key` (optional). Only meaningful for staged playbooks. Changing it emits a stage-transition event automations can react to.",
            },
            expectedOutputs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string" },
                  label: { type: "string" },
                  icon: { type: "string" },
                  status: {
                    type: "string",
                    enum: ["pending", "done"],
                    description:
                      "Per-item lifecycle. Defaults to 'pending' when omitted.",
                  },
                },
                required: ["kind", "label"],
              },
              description:
                "Replace the full deliverable list (optional). For incremental edits prefer addOutput / completeOutput.",
            },
            addOutput: {
              type: "object",
              properties: {
                kind: { type: "string" },
                label: { type: "string" },
                icon: { type: "string" },
              },
              required: ["kind", "label"],
              description:
                "Append ONE new deliverable (stored with status 'pending').",
            },
            completeOutput: {
              type: "string",
              description:
                "Mark the deliverable with this exact label as 'done'. No-op if no deliverable matches the label exactly.",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "synap_complete_session",
        description:
          "Complete a focus session — mark it closed with a summary and optional reports. Closes any running playbook_run and updates the session record. The session becomes visible as a closed session in the browser SessionRoom with deliverables.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The focus session ID to complete.",
            },
            summary: {
              type: "string",
              description:
                "Short human-readable outcome — what was accomplished. Surfaced in session lists (e.g. 'Found 5 viable approaches; top 2: Puppeteer for SPAs, Apify for social media').",
            },
            verificationReport: {
              type: "object",
              description:
                "Optional structured verification report (e.g. what was checked, confidence levels, summary of what was accomplished).",
            },
          },
          required: ["sessionId"],
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
          "THE write door. Hand it any free text — a fact you learned, a decision, a person/company/task mentioned, something worth remembering — and the AI capture pipeline structures it into the right entities and files them in the pod. " +
          "PROACTIVE RULE: call this AFTER you learn something durable about the user, their work, or their preferences, or whenever the user says something worth keeping (\"remember that…\", a new contact, a decision made). Don't wait to be asked — capturing is how the user's second brain grows. It writes directly (no approval wait) and records an auto-approved, revertible proposal; the created entities come back in the result. Hint a profileSlug to guide extraction, or set global:true to store a pod-wide runbook (knowledge_keys) instead of entities. WHEN NOT TO USE: if you already know the exact profileSlug and the field values, call synap_create_entity instead — it is deterministic and writes the typed entity directly. synap_capture routes free text through an AI structuring pipeline that, when it fails or finds nothing, degrades to a single flat note carrying your raw text. Use capture only for genuinely unstructured input (a pasted email, transcript, bio) where you do not yet know the entities.",
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
                "Optional profile hint to guide entity type extraction (work lane)",
            },
            global: {
              type: "boolean",
              description:
                "GLOBAL lane: store as a pod-wide procedural runbook (knowledge_keys) instead of structuring into entities. Use for cross-project how-to / decisions / operational docs ('how we deploy', 'auth works like…'). Mirrors the CLI's `capture --global`.",
            },
            key: {
              type: "string",
              description:
                "Optional stable key (namespace:slug, e.g. 'deploy:backend') for a global runbook — derived from the text if omitted.",
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
          "Post a message to a Synap channel or thread with optional AI triggering. Handles thread creation from a channelId and can trigger an AI response. Pass role (default assistant) and triggerAI to start an agent turn.",
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
      // (synap_write_knowledge folded into synap_capture's `global` lane — a
      // pod-wide runbook is `synap_capture` with global:true. One write door.)

      // ── Capabilities (connected-service verbs: Gmail, Calendar, Drive, …) ────
      {
        name: "synap_list_capabilities",
        description:
          "List the runnable capabilities in a workspace — the verbs unlocked by the user's connected services and applied templates (e.g. gmail_send, gmail_search, calendar_list, calendar_create, drive_search). Each entry has its name (the verbId you pass to synap_run_capability), a label, the backing tool, whether it is ENABLED (approved) or still DRAFT, and its governance. Call this to discover what the user can actually DO with their connections before running anything. A DRAFT capability must be enabled by the user (Settings → Capabilities) before it will run.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string", description: "Workspace UUID" },
          },
          required: ["workspaceId"],
        },
      },
      {
        name: "synap_run_capability",
        description:
          "Run a registered capability verb (from synap_list_capabilities) with dynamic inputs — e.g. send an email, search Gmail, list/create a calendar event, search Drive. Pass verbId (the capability name) + parameters (its args). Responses mirror every governed write: a result on success, or { proposed, proposalId } when the action needs the user's approval (a side-effecting WRITE like sending email) — NEVER treat 'proposed' as an error; tell the user to approve it in Synap. A DRAFT (un-enabled) capability is refused — ask the user to enable it first.",
        inputSchema: {
          type: "object",
          properties: {
            verbId: {
              type: "string",
              description:
                "The capability name from synap_list_capabilities (e.g. 'gmail_send'). Alternatively pass skillId.",
            },
            skillId: {
              type: "string",
              description: "Direct backing-skill UUID (alternative to verbId).",
            },
            parameters: {
              type: "object",
              description:
                "The capability's inputs — e.g. { to, subject, body } for gmail_send, { query } for gmail_search.",
            },
            workspaceId: { type: "string", description: "Workspace UUID" },
          },
          required: ["workspaceId"],
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
    apiKeyScopes: string[],
    sessionUserId?: string,
    agentUserId?: string
  ): Promise<CallToolResult> {
    const { executeMCPToolViaHubProtocol } = await import("../adapter.js");
    return await executeMCPToolViaHubProtocol(
      name,
      args,
      userId,
      apiKeyScopes,
      sessionUserId,
      agentUserId
    );
  },
};
