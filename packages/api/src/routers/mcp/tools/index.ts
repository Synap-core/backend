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
import {
  composeCapabilityBrief,
  MAIN_CAPABILITY_TOOLS,
  type CapabilityBriefDoor,
} from "../../../services/capability-briefs/compose-capability-brief.js";

/** Context available when `list()` is called from a live MCP session (createMCPServer) — absent for the legacy static capabilities manifest (http-handler.ts GET /). */
export interface ToolsListContext {
  workspaceId?: string;
  agentUserId?: string;
  door?: CapabilityBriefDoor;
}

export const tools = {
  /**
   * List all available tools. When `ctx` is supplied (a live MCP session), the
   * main-capability tools (AI Teaching Substrate Wave 2b) get a composed
   * teaching brief appended to their description — teaching core + live
   * governance verdict + posture emphases. Never fetched for the legacy
   * unauthenticated manifest (no ctx there).
   */
  async list(ctx?: ToolsListContext): Promise<Tool[]> {
    const toolDefs: Tool[] = [
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
            compare: {
              type: "boolean",
              description:
                "A/B DIAGNOSTIC: run BOTH the baseline and Horizon rankers on the same candidate pool and return { baseline, horizon, diff:{ overlapAtN, moved } } instead of a synthesized answer. Read-only — does NOT change normal recall. For evaluating ranking changes.",
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
            facetSlug: {
              type: "string",
              description:
                "Kind + Facets filter — only return entities carrying a live facet of this role-profile slug (e.g. 'client', 'investor'). Use synap_list_profiles to find role slugs (profileKind='role').",
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
          "List all available entity types (profiles) — system profiles plus custom types. ALWAYS call at session start before creating entities. Never assume 'deal' or custom types exist — workspaces differ. Returns a lightweight digest per profile: id, slug, displayName, entityScope (pod-wide vs workspace-scoped), description, icon. For full property schemas use synap_orient or GET /discover.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description:
                "Workspace ID (optional — omit to list across all workspaces)",
            },
            detail: {
              type: "string",
              enum: ["full"],
              description:
                "Pass 'full' to receive the complete profile row including renderer and uiHints columns. Omit for the lightweight digest (default).",
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
        name: "synap_resolve_identity",
        description:
          "Read-only identity PRE-CHECK — call BEFORE creating an entity to decide create-vs-enrich-vs-attach_facet. Pass the strong signals you have (email/phone/url/twitter/github/externalId) and/or a title + kindSlug. Returns match:'strong' (a globally-unique signal already resolves to an entity → do NOT create; enrich it or synap_attach_facet a new role onto entityId instead), match:'weak' (same-name candidates — advisory, inspect `candidates` before deciding), or match:'none' (safe to create). This is the dedup door: an entity exists ONCE (a person, a company); roles are facets, never second entities. Never writes.",
        inputSchema: {
          type: "object",
          properties: {
            kindSlug: {
              type: "string",
              description:
                "The kind (profile slug) you intend to create, e.g. person, company. A same-name match must be this kind to count as a 'weak' match; cross-kind rows still appear in `candidates`.",
            },
            title: {
              type: "string",
              description:
                "The name/title to check. Omit to do a strong-signal-only lookup.",
            },
            signals: {
              type: "object",
              description:
                "Strong identity atoms you already know. Any one match auto-resolves.",
              properties: {
                email: { type: "string" },
                phone: { type: "string" },
                url: {
                  type: "string",
                  description: "A LinkedIn or website URL.",
                },
                twitter: { type: "string" },
                github: { type: "string" },
                externalId: {
                  type: "string",
                  description: "Provider-qualified id, e.g. 'github:12345'.",
                },
              },
            },
            properties: {
              type: "object",
              description:
                "Draft property bag — strong signals are also extracted from it (merged with `signals`).",
            },
            workspaceId: {
              type: "string",
              description: "Workspace ID (optional).",
            },
          },
          required: [],
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
            projectId: {
              type: "string",
              description:
                "Optional project id to file the created entity into — stamps belongs_to_project membership.",
            },
            facets: {
              type: "array",
              description:
                "Kind + Facets: attach one or more role-profiles to the new entity in the SAME call (e.g. a person who is a client + investor). A role is a facet, NOT a separate entity — resolve identity first, then attach roles here. Each item: { slug, properties? }. Only applied when the entity is created (not when the create is proposal-gated).",
              items: {
                type: "object",
                properties: {
                  slug: {
                    type: "string",
                    description:
                      "Role-profile slug (profileKind='role' from synap_list_profiles).",
                  },
                  properties: {
                    type: "object",
                    description: "Optional facet-specific properties.",
                  },
                },
                required: ["slug"],
              },
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

      // ── Kind + Facets (roles) ──────────────────────────────────────────────
      {
        name: "synap_attach_facet",
        description:
          "Attach a ROLE to an existing entity (Kind + Facets). A role — client, partner, prospect, investor, sponsor — is a FACET, never its own entity: an entity IS one kind (person, company) and HAS many roles. Resolve identity FIRST (synap_ask / synap_get_entities on strong signals like email/phone/url) so you attach the role to the REAL entity instead of creating a duplicate. Governed like any write: may return 'proposed' (a proposalId to review) — NEVER treat that as an error. Use synap_list_profiles to find role slugs (profileKind='role') and which kinds they apply to (applicableKinds).",
        inputSchema: {
          type: "object",
          properties: {
            entityId: {
              type: "string",
              description: "UUID of the entity to attach the role to.",
            },
            facetSlug: {
              type: "string",
              description:
                "Role-profile slug to attach (profileKind='role', e.g. 'client').",
            },
            properties: {
              type: "object",
              description: "Optional facet-specific properties.",
            },
            workspaceId: {
              type: "string",
              description:
                "Optional facet visibility lens. Omit to inherit the parent entity's workspace.",
            },
            contextEntityId: {
              type: "string",
              description:
                "Optional disambiguator when the same role attaches in multiple contexts (e.g. a client OF a specific company).",
            },
          },
          required: ["entityId", "facetSlug"],
        },
      },
      {
        name: "synap_detach_facet",
        description:
          "Detach (soft-delete) a role from an entity (Kind + Facets). Provide the entityId + facetSlug of the role to remove (or a facetId directly). Governed like any write: may return 'proposed' — NEVER treat that as an error. Removing a role never deletes the entity; only the role-facet is retired.",
        inputSchema: {
          type: "object",
          properties: {
            entityId: {
              type: "string",
              description:
                "UUID of the entity carrying the role (with facetSlug).",
            },
            facetSlug: {
              type: "string",
              description:
                "Role-profile slug to detach from the entity (paired with entityId).",
            },
            facetId: {
              type: "string",
              description:
                "Alternative to entityId+facetSlug: the facet's own UUID (the handle synap_attach_facet returns).",
            },
            workspaceId: {
              type: "string",
              description:
                "Optional workspace lens used to resolve the facet when detaching by entityId + facetSlug.",
            },
          },
          required: [],
        },
      },

      // ── Session bootstrap & governance ─────────────────────────────────────
      {
        name: "synap_orient",
        description:
          "Returns a lightweight LENS MAP — your identity, projects (companies/initiatives), workspaces (operational domains), and a profile sample. Call first in every session. This also lists your projects (it supersedes the old synap_list_projects tool) — pass scope:['projects'] and/or workspaceId to narrow. Pass detail:'full' for workspace descriptions, full onboarding specs, and per-workspace profiles. Drill into a workspace's full property schemas via synap_list_profiles.",
        inputSchema: {
          type: "object",
          properties: {
            detail: {
              type: "string",
              enum: ["light", "full"],
              description:
                "light (default) = names/ids/domain/counts + onboarding goal; full = descriptions, full onboarding spec, and per-workspace profiles.",
            },
            scope: {
              type: "array",
              items: {
                type: "string",
                enum: ["workspaces", "projects", "profiles"],
              },
              description:
                "Optional: restrict the map to these sections. Omit for all three.",
            },
            workspaceId: {
              type: "string",
              description:
                "Optional: pin the map (and the profile sample) to one workspace.",
            },
            projectId: {
              type: "string",
              description: "Optional: pin the projects section to one project.",
            },
          },
          required: [],
        },
      },
      {
        name: "synap_start_session",
        description:
          "Create a focus session — a goal-bound work session tracked in Synap. Use this to declare 'I'm starting work on X'. A session can be scoped to a project (projectId) OR a workspace (workspaceId) — provide at least one; a project-scoped session needs no workspace membership. The session appears in the browser SessionRoom.",
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
      // ── Cell authoring & renderer binding ───────────────────────────────────
      {
        name: "synap_create_cell",
        description:
          "Define (create or update) a ViewFrame cell from raw renderer source — the way an external agent ships an AI-generated cell. Idempotent upsert keyed on the cell's typeKey (derived from `name`) + workspace: pass a workspaceId to scope the cell to one workspace, or omit it to make the cell pod-global (visible in every workspace). Returns the resolved `typeKey`. This creates the cell definition ONLY; to surface it as a profile's renderer, follow up with synap_promote_cell_to_renderer.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Human-readable cell name; also the basis for the generated typeKey (`generated:<slug>`).",
            },
            rendererSource: {
              type: "string",
              description: "The cell's renderer source (HTML/JS frame source).",
            },
            workspaceId: {
              type: "string",
              description:
                "Optional workspace UUID. Omit for a pod-global cell (visible in all workspaces).",
            },
            description: {
              type: "string",
              description: "Optional short description of the cell.",
            },
          },
          required: ["name", "rendererSource"],
        },
      },
      {
        name: "synap_promote_cell_to_renderer",
        description:
          "Bind a cell as a profile's renderer for a slot (list | detail | dashboard) — durable, consequential, so it's governed like any write. scope 'workspace' (default) sets a per-workspace overlay; scope 'pod' sets the profile's system default across all workspaces.",
        inputSchema: {
          type: "object",
          properties: {
            profileSlug: {
              type: "string",
              description: "Slug of the profile to bind the renderer on.",
            },
            slot: {
              type: "string",
              enum: ["list", "detail", "dashboard"],
              description: "Which renderer slot to set.",
            },
            cellKey: {
              type: "string",
              description:
                "The cell typeKey to bind (e.g. from synap_create_cell).",
            },
            props: {
              type: "object",
              description: "Optional props passed to the cell renderer.",
            },
            scope: {
              type: "string",
              enum: ["workspace", "pod"],
              description:
                "'workspace' (default) = per-workspace overlay; 'pod' = profile system default. Workspace scope requires workspaceId.",
            },
            workspaceId: {
              type: "string",
              description: "Workspace UUID (required for scope 'workspace').",
            },
          },
          required: ["profileSlug", "slot", "cellKey"],
        },
      },
      {
        name: "synap_promote_session_to_playbook",
        description:
          "Promote a validated focus session into a reusable Playbook (runtime → config): re-grants the capabilities the session used and records lineage. GOVERNED — an AI agent caller gets `status: 'proposed'` (awaiting review); an operator gets `status: 'promoted'`.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The focus session ID to promote into a playbook.",
            },
          },
          required: ["sessionId"],
        },
      },
      // ── Playbooks (reusable session templates) ──────────────────────────────
      {
        name: "synap_list_playbooks",
        description:
          "List existing playbooks (reusable process/session templates) visible in a workspace. Call this to discover what already exists BEFORE improvising a new process. A playbook can then be started as a runtime session via synap_start_session, passing its id as templateId.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description:
                "Workspace ID (optional — falls back to the user's first workspace if omitted).",
            },
            status: {
              type: "string",
              enum: ["draft", "active", "paused", "archived"],
              description: "Optional status filter.",
            },
          },
          required: [],
        },
      },
      {
        name: "synap_create_playbook",
        description:
          "Create a reusable playbook (a staged process/session template) so a repeatable workflow — e.g. competitor analysis, market research, onboarding — can be discovered (synap_list_playbooks) and run (synap_start_session with templateId) later. Provide a name, a goalTemplate (the session goal, may contain {{param}} placeholders), and optional ordered stages. Created active by default. Governed — may return a proposal.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Playbook display name." },
            goalTemplate: {
              type: "string",
              description:
                "The session goal this playbook instantiates (e.g. 'Analyze competitors for {{market}}'). May contain {{param}} placeholders.",
            },
            description: {
              type: "string",
              description: "What this playbook is for.",
            },
            stages: {
              type: "array",
              description:
                "Ordered stages. Each: { key, name, description?, goal?, suggestedTasks? }.",
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  name: { type: "string" },
                  description: { type: "string" },
                  goal: { type: "string" },
                  suggestedTasks: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["key", "name"],
              },
            },
            status: {
              type: "string",
              enum: ["draft", "active", "paused", "archived"],
              description: "Defaults to 'active' (immediately runnable).",
            },
            workspaceId: {
              type: "string",
              description:
                "Home workspace (optional — falls back to the user's first workspace).",
            },
          },
          required: ["name", "goalTemplate"],
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
          'PROACTIVE RULE: call this AFTER you learn something durable about the user, their work, or their preferences, or whenever the user says something worth keeping ("remember that…", a new contact, a decision made). Don\'t wait to be asked. Hint a profileSlug to guide extraction, or set global:true to store a pod-wide runbook (knowledge_keys) instead of entities. If you already know the exact profileSlug and field values, use synap_create_entity instead.',
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
            projectId: {
              type: "string",
              description:
                "Optional project id to file the created entities into — stamps belongs_to_project membership.",
            },
            dedupMode: {
              type: "string",
              enum: ["title", "semantic", "both"],
              description:
                "Dedup strategy for surfaced candidates: 'title' = string-similarity search only, 'semantic' = pgvector cosine search over entity embeddings (catches paraphrases with no shared words), 'both' (default) = run both and keep the strongest match per entity.",
            },
            workspaceRouting: {
              type: "string",
              enum: ["auto", "ask", "locked"],
              description:
                "How to place the capture across workspaces. 'auto' (default) = the AI files it into the workspace it infers is the right domain (returned as movedToWorkspace) — this WINS over the session/ambient workspace so the user needn't think about workspaces (only applied on sufficient confidence + membership). 'ask' = don't move; return pendingWorkspaceSwitch so you can confirm with the user first (safe mode). 'locked' = never move; keep the caller's/session workspace. Use 'locked' (not a bare workspaceId) when you need to force a specific workspace.",
            },
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
        name: "synap_create_project",
        description:
          "Create a project — a cross-cutting lens for an initiative or venture (e.g. a company, a client, a cross-workspace effort), as opposed to a workspace, which is a domain lens (e.g. Builder, Marketing). Use this when the user describes a new initiative/venture that should organize entities across one or more workspaces. Pass workspaceId as the project's HOME workspace (omit to use the user's first workspace). Response may be 'created' (projectId returned) or 'proposed' (awaiting human review, proposalId returned) — NEVER treat 'proposed' as an error.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Project display name" },
            description: { type: "string" },
            workspaceId: {
              type: "string",
              description:
                "The project's HOME workspace (optional — falls back to the user's first workspace if omitted).",
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
      {
        name: "synap_load_skill",
        description:
          "Load the full body of a seeded teaching skill (the L2 tier behind the one-line summaries you see on other tools' descriptions and in the catalog). Pass a `system/<package>/<stem>` slug, a bare stem (e.g. 'document-embeds'), or 'catalog' to list every available skill grouped by topic.",
        inputSchema: {
          type: "object",
          properties: {
            ref: {
              type: "string",
              description:
                "A skill slug/stem (e.g. 'document-embeds', 'system/synap/document-embeds') or 'catalog'.",
            },
          },
          required: ["ref"],
        },
      },
    ];

    if (!ctx) return toolDefs;

    // Live session — append a composed teaching brief to each main-capability
    // tool's description. Failure-safe per-tool (composeCapabilityBrief never
    // throws); a tool with no brief content is left as-is.
    await Promise.all(
      toolDefs.map(async (tool) => {
        if (!MAIN_CAPABILITY_TOOLS.includes(tool.name)) return;
        const brief = await composeCapabilityBrief(tool.name, {
          agentUserId: ctx.agentUserId,
          workspaceId: ctx.workspaceId ?? null,
          door: ctx.door ?? "chat",
        });
        if (brief) tool.description = `${tool.description}\n\n---\n${brief}`;
      })
    );

    return toolDefs;
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
    if (name === "synap_load_skill") {
      const { resolveSkillContent } =
        await import("../../../services/capability-briefs/load-skill.js");
      const ref = args.ref as string;
      const content = await resolveSkillContent(ref, sessionUserId ?? userId);
      return {
        content: [{ type: "text", text: content }],
      };
    }
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
