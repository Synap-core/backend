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
import { z } from "zod";
import {
  composeCapabilityBrief,
  MAIN_CAPABILITY_TOOLS,
  type CapabilityBriefDoor,
} from "../../../services/capability-briefs/compose-capability-brief.js";
import { toSafeToolError, validateUuidArgs } from "../tool-errors.js";
import { USER_OBSERVATION_CATEGORIES } from "../../../services/knowledge/remember-fact.js";
import { PROPOSAL_REJECTION_REASONS } from "@synap-core/types/proposals";
import { automationDataContractSchema } from "../../automations.js";

/**
 * JSON Schema for `synap_create_automation`'s `dataContract` input, DERIVED from
 * `automationDataContractSchema` — the very schema `automations.create` runs to
 * reject an AI-authored automation that lacks a contract. Deriving (rather than
 * hand-copying a second shape here) is the point: the published tool surface and
 * the gate that rejects it cannot drift apart.
 *
 * Prose descriptions are layered on top — they carry meaning the Zod shape can't,
 * and prose is not what drifts. `$schema` is stripped: MCP `inputSchema` property
 * entries are plain sub-schemas, and gen-manifest.ts needs a deterministic
 * committed diff.
 */
function buildAutomationDataContractJsonSchema(): Record<string, unknown> {
  const derived = z.toJSONSchema(automationDataContractSchema, {
    io: "input",
  }) as Record<string, unknown>;
  delete derived.$schema;

  const properties = derived.properties as Record<
    string,
    Record<string, unknown>
  >;
  const describeItems = (section: string, description: string): void => {
    const items = (properties[section] as { items?: Record<string, unknown> })
      .items;
    const nodeIds = (
      items?.properties as Record<string, Record<string, unknown>> | undefined
    )?.nodeIds;
    if (nodeIds) {
      nodeIds.description =
        "Ids of the nodes in THIS submission's flowDefinition that implement this line. Every id MUST match a node you are sending in flowDefinition.nodes — an unknown id is rejected. Reference the trigger node by its own id.";
    }
    properties[section].description = description;
  };

  derived.description =
    "REQUIRED for every agent-authored automation (this tool always is): the explicit user-facing promise behind the flow. The create door validates it and REJECTS the automation without it. Declare what enters the process (gets), what is written into Synap (stores), and what reacts or sends afterward (reacts) — and wire each line to the flow nodes that implement it.";
  (properties.mode as Record<string, unknown>).description =
    "Must match which sections are populated: 'ingest' → stores non-empty and reacts EMPTY; 'react' → reacts non-empty and stores EMPTY; 'ingest_and_react' → BOTH non-empty.";
  (properties.version as Record<string, unknown>).description =
    "Contract format version. Always 1.";
  describeItems(
    "gets",
    "Gets data — what ENTERS the process. At least one entry. `origin` says where it comes from ('external' = a connected third party, 'synap' = a pod event, 'schedule' = a cron tick, 'manual' = an on-demand trigger); `event` names it (e.g. 'entity.create.completed', 'gmail.message.received'); `provider` names the third party when origin is 'external'. Never claim external intake unless that inbound connection actually exists."
  );
  describeItems(
    "stores",
    "Stores in Synap — what this automation WRITES into the pod. `resource` names what is stored (e.g. 'entity:contact', 'knowledge'). Empty array when the automation stores nothing."
  );
  describeItems(
    "reacts",
    "Reacts & sends — what happens AFTER, beyond storing. `kind` is 'synap_write' | 'external_write' | 'notification' | 'agent' | 'process'; `destination` names the target (channel, provider, agent). Empty array when the automation only ingests."
  );
  return derived;
}

const AUTOMATION_DATA_CONTRACT_JSON_SCHEMA =
  buildAutomationDataContractJsonSchema();

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
        annotations: {
          title: "Ask the pod",
          readOnlyHint: true,
          openWorldHint: false,
        },
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
        annotations: {
          title: "List entities",
          readOnlyHint: true,
          openWorldHint: false,
        },
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
        annotations: {
          title: "Get document",
          readOnlyHint: true,
          openWorldHint: false,
        },
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
        annotations: {
          title: "Get thread context",
          readOnlyHint: true,
          openWorldHint: false,
        },
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
        annotations: {
          title: "List proposals",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "List proposals — the audit trail of AI writes. AI writes return status 'proposed' when they require human approval — this is NOT an error. Filter by status: 'pending' (needs review), 'approved', 'rejected', 'auto_approved' (the write EXECUTED immediately under governance and filed this row as its receipt — use this to show the user what you did without asking), 'reverted', 'approval_failed', 'withdrawn'. Pass sessionId to load the **session review pack** (proposals for one focus session). userId is auto-injected from the API key if not provided.",
        inputSchema: {
          type: "object",
          properties: {
            userId: {
              type: "string",
              description:
                "User ID (optional, auto-injected from API key if not provided)",
            },
            workspaceId: { type: "string" },
            sessionId: {
              type: "string",
              description:
                "Focus session UUID — list only proposals attributed to this session (the review pack).",
            },
            status: {
              type: "string",
              enum: [
                "pending",
                "approved",
                "rejected",
                "auto_approved",
                "reverted",
                "approval_failed",
                "withdrawn",
                "all",
              ],
              default: "pending",
            },
            limit: { type: "number", default: 20 },
            detail: {
              type: "string",
              enum: ["summary", "full"],
              default: "summary",
              description:
                "'summary' (default) returns one compact row per proposal — id, type, target, provenance, and a one-line summary — which is what a LIST is for. 'full' includes the entire `data` payload of every row: only ask for it when you need to inspect a specific proposal's contents, and pair it with a small `limit`.",
            },
          },
          required: [],
        },
      },
      {
        name: "synap_template_health",
        annotations: {
          title: "Template health",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "See which workspaces are behind their template — the pod's template-update radar. Returns, per workspace: `attached` (installed from a template), `stamped` (has a recorded version), `installedVersion`, `latestVersion` (freshest in the catalog), and `drifted` (an update is available). Use it to answer \"do any of my workspaces have template updates?\" then apply one with the `market.install`/update door for that slug. Read-only; scoped to the caller's own workspaces.",
        inputSchema: {
          type: "object",
          properties: {
            driftedOnly: {
              type: "boolean",
              description:
                "When true, return only workspaces with an available update (drifted). Default false = every workspace with its health.",
              default: false,
            },
          },
          required: [],
        },
      },
      {
        name: "synap_diagnose",
        annotations: {
          title: "Diagnose",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          'Understand what\'s happening / what\'s wrong — the pod\'s health door (the third door, alongside ask + capture). The MODE is derived from what you pass (never a tool name you choose): NO ARGS → whole-pod health (stuck runs, failed flows, review backlog + age, duplicate-proposal clusters, capability posture, agents hitting the daily cap) with a plain-language summary; `type` → a class as a surface (type:"proposal" = the review queue: pending count, oldest, duplicate clusters; type:"session" = stuck sessions; type:"agent" = agent roster + quality; type:"capability" = approved vs awaiting; type:"run" = per-flow failure counts); `id` → auto-detects what the id is (proposal / session / capability / automation-run / playbook-run / agent / entity) and explains its state + WHY; `agentId` → an agent\'s behavioural scorecard (approve/reject/revise rates, top rejection reasons, duplicate rate, daily-cap posture). Backward-compatible: `runId`+`flowType` → that run\'s activity timeline (a capture\'s decision + trace events, each with a machine-readable reason + fixHint); `flowType`/`flowId` → the run feed. USER-scoped automatically.',
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "proposal",
                "session",
                "capability",
                "agent",
                "entity",
                "run",
              ],
              description:
                "Diagnose a whole CLASS as a surface (the review queue, stuck sessions, the agent roster, capability health, per-flow run failures).",
            },
            id: {
              type: "string",
              description:
                "Any object id — the door auto-detects whether it is a proposal / session / capability / run / agent / entity and explains its state + why.",
            },
            agentId: {
              type: "string",
              description:
                "An agent-user id → its behavioural quality scorecard (approve/reject/revise rates, rejection reasons, duplicate rate, daily-cap posture).",
            },
            workspaceId: {
              type: "string",
              description:
                "Narrow whole-pod health or a class surface to ONE workspace lens (default: all workspaces you can see).",
            },
            stuckThresholdHours: {
              type: "number",
              description:
                "Override the 'stuck run' age boundary for whole-pod health (default 24h).",
            },
            flowType: {
              type: "string",
              enum: [
                "automation",
                "playbook",
                "capture",
                "session",
                "capability",
              ],
              description:
                "Back-compat run-feed grammar: restrict to one ledger. REQUIRED when runId is given (the id space differs per flow).",
            },
            flowId: {
              type: "string",
              description:
                "Back-compat: restrict the feed to one flow's runs (automationId / playbookId).",
            },
            runId: {
              type: "string",
              description:
                "Back-compat: a specific run id (or a capture's correlationId) → that run's activity timeline instead of the feed.",
            },
            limit: { type: "number", default: 25 },
          },
          required: [],
        },
      },
      {
        name: "synap_get_entity",
        annotations: {
          title: "Get entity",
          readOnlyHint: true,
          openWorldHint: false,
        },
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
        annotations: {
          title: "List profiles",
          readOnlyHint: true,
          openWorldHint: false,
        },
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
        annotations: {
          title: "Get relations",
          readOnlyHint: true,
          openWorldHint: false,
        },
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
        annotations: {
          title: "Resolve identity",
          readOnlyHint: true,
          openWorldHint: false,
        },
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
        annotations: {
          title: "Get graph",
          readOnlyHint: true,
          openWorldHint: false,
        },
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
        annotations: {
          title: "Create entity",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Create a typed entity when you already know the exact profileSlug + fields — the structured, deterministic sibling of synap_capture (which parses free text). Discover slugs with synap_list_profiles; synap_ask first to avoid duplicates. Same-profile same-name creates are REJECTED with candidates (reuse the existing id, enrich, or attach a facet) unless forceCreate=true. Placeholder person/company titles (e.g. 'Not publicly disclosed', 'unknown') are rejected.",
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
            content: {
              type: "string",
              description:
                "LONG-FORM markdown body (the write-up itself, not a summary). Materialized into a versioned document linked to the entity — so a note/article/research entity and its body land in ONE call. Use `description` for a short preview and `content` for anything multi-paragraph; do NOT stuff long text into `properties`.",
            },
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
            forceCreate: {
              type: "boolean",
              description:
                "Bypass the weak same-name gate when a same-profile entity with this title already exists. Prefer reusing the existing id. Does NOT bypass strong-signal auto-merge (email/phone/url). Default false.",
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
        annotations: {
          title: "Update entity",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
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
        annotations: {
          title: "Create document",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Create a standalone document. TWO modes: (1) authored text — pass `content` (markdown) for meeting notes, research, plans that don't fit entity properties. (2) external reference — pass `url` (no `content`) to reference a file/page you have a LINK to but no bytes to upload (e.g. a Google Doc, a PDF URL); this is the agent-appropriate way to add a 'file' since an agent has no filesystem. Pass `entityId` to ATTACH the document to an existing entity. If you're also creating the entity, prefer synap_create_entity with `content` (entity + body in ONE call). To store a real binary from disk, that's the CLI `synap upload` / the multipart upload door — an agent can't do it here. Attachment only happens when the document auto-approved; a proposal-gated one has no row to link yet, and the response says so.",
        inputSchema: {
          type: "object",
          properties: {
            idempotencyKey: {
              type: "string",
              description:
                "Optional: a stable key so a retry returns the PRIOR write, not a duplicate. Omit and identical content is deduped automatically; pass one to make a retry idempotent even if its content changed trivially.",
            },
            title: { type: "string" },
            content: {
              type: "string",
              description:
                "Authored document body (markdown or plain text). Mutually exclusive with `url`.",
            },
            url: {
              type: "string",
              description:
                "External reference: an https URL to a file/page you have a link to (no bytes stored). Use INSTEAD of `content` when referencing an existing file/link rather than authoring a body.",
            },
            entityId: {
              type: "string",
              description:
                "Optional UUID of an EXISTING entity to attach this document to. The attach is a separate governed entity update — its own outcome comes back under `attached`.",
            },
            workspaceId: { type: "string" },
          },
          required: ["title"],
        },
      },
      {
        name: "synap_store_file",
        annotations: {
          title: "Store file",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Store file CONTENT you already have (text via `content`, or binary via `contentBase64`) as a `file` — ANY type, stored **as-is and NEVER read/analyzed**. Use for a report/CSV/image/PDF/etc. you generated or hold. Pass `attachToEntityId` to attach it to an existing entity instead of creating a new file. For a large file sitting on a local disk, that's the CLI `synap upload` (an agent can't stream bytes it doesn't hold). For a link you have (no bytes), use `synap_create_document` with `url`. Max 10MB via this inline path.",
        inputSchema: {
          type: "object",
          properties: {
            filename: {
              type: "string",
              description: "The file name (e.g. 'report.csv', 'diagram.png').",
            },
            mimeType: {
              type: "string",
              description:
                "The content type (e.g. 'text/csv', 'image/png', 'application/pdf'). Must be an allowed type.",
            },
            content: {
              type: "string",
              description:
                "UTF-8 TEXT content to store as-is. Mutually exclusive with `contentBase64`.",
            },
            contentBase64: {
              type: "string",
              description:
                "Base64-encoded BINARY content. Mutually exclusive with `content`.",
            },
            title: {
              type: "string",
              description:
                "Optional human-facing title (defaults to filename).",
            },
            workspaceId: { type: "string" },
            attachToEntityId: {
              type: "string",
              description:
                "Optional UUID of an EXISTING entity — attach the stored blob to it as provenance instead of creating a new `file` entity.",
            },
          },
          required: ["filename", "mimeType"],
        },
      },
      {
        name: "synap_remember_fact",
        annotations: {
          title: "Remember fact",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          'Store a durable fact about the user (preference, habit, working style, technical context) as a governed `user_observation`. Returns status:"proposed" with a `reviewUrl` when the fact is your own inference — that is normal, not an error — or status:"created" when you pass userStated:true because the user told you directly. Returns the record\'s id so you can link or revert it.',
        inputSchema: {
          type: "object",
          properties: {
            idempotencyKey: {
              type: "string",
              description:
                "Optional: a stable key so a retry returns the PRIOR write, not a duplicate. Omit and identical content is deduped automatically; pass one to make a retry idempotent even if its content changed trivially.",
            },
            userId: {
              type: "string",
              description:
                "User ID (auto-injected from API key if not provided)",
            },
            fact: { type: "string", description: "The fact to remember" },
            confidence: {
              type: "number",
              description:
                "How sure you are, 0–1 (default 0.8). Stored on the observation; it does NOT change the governance outcome.",
            },
            category: {
              type: "string",
              // SSOT: the `uo_category` enum lives in remember-fact.ts (seeded
              // in ensure-system-profiles.ts) — never re-list it here.
              enum: [...USER_OBSERVATION_CATEGORIES],
              description:
                "Which bucket the observation belongs to (default 'preferences').",
            },
            userStated: {
              type: "boolean",
              description:
                "true ONLY if the user directly stated this; do not infer. This is the single signal that makes the write auto-approve instead of proposing.",
            },
          },
          required: ["fact"],
        },
      },
      {
        name: "synap_link_entities",
        annotations: {
          title: "Link entities",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
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
        annotations: {
          title: "Attach facet",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Attach a ROLE to an existing entity (Kind + Facets). A role — client, partner, prospect, investor, sponsor — is a FACET, never its own entity: an entity IS one kind (person, company) and HAS many roles. Resolve identity FIRST (synap_ask / synap_get_entities on strong signals like email / phone / website) so you attach the role to the REAL entity instead of creating a duplicate. Governed like any write: may return 'proposed' (a proposalId to review) — NEVER treat that as an error. Use synap_list_profiles to find role slugs (profileKind='role') and which kinds they apply to (applicableKinds).",
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
        annotations: {
          title: "Detach facet",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
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
      {
        name: "synap_define_role",
        annotations: {
          title: "Define role type",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Define a NEW role type (Kind + Facets) that can then be attached to entities via synap_attach_facet. A role — e.g. 'market-maker', 'sponsor', 'mentor' — is an attachable FACET, never its own entity. Escalation L3: call ONLY after synap_list_profiles shows no existing role slug that fits; prefer attaching an existing role over minting a near-duplicate. applicableKinds declares which base kinds (e.g. 'company', 'person') the role can attach to and is REQUIRED (non-empty). Governed: may return 'proposed' — NEVER treat that as an error.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description:
                "URL-safe role slug (lowercase, digits, hyphens), e.g. 'market-maker'.",
            },
            displayName: {
              type: "string",
              description: "Human-readable role name, e.g. 'Market Maker'.",
            },
            applicableKinds: {
              type: "array",
              items: { type: "string" },
              description:
                "Base-kind slugs this role can attach to. REQUIRED, non-empty. Defaults to ['company','person'].",
            },
            description: {
              type: "string",
              description: "Optional description of what the role represents.",
            },
            icon: {
              type: "string",
              description: "Optional icon hint for the role.",
            },
            roleCategory: {
              type: "string",
              description:
                "Optional grouping key so an automation can select entities wearing ANY role in this category via entity.query { roleCategory } — e.g. tag every supply role 'provider'. Future roles tagged the same category qualify with no query change.",
            },
            properties: {
              type: "object",
              description:
                "Optional default property values for facets of this role.",
            },
            workspaceId: {
              type: "string",
              description: "Workspace to define the role in.",
            },
          },
          required: ["slug", "displayName", "workspaceId"],
        },
      },
      {
        name: "synap_define_kind",
        annotations: {
          title: "Define entity kind",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Define a NEW entity KIND (a primary type: 'podcast', 'workout', 'invoice') and, optionally, its fields — the data model an app is built on. A kind is a thing that HAS identity; a hat that thing WEARS (client, sponsor, mentor) is a ROLE — use synap_define_role for those, never a kind. Escalation L3: call ONLY after synap_list_profiles shows no existing kind that fits; extending an existing kind with new fields is almost always better than minting a near-duplicate. Kinds are POD-WIDE by default (their entities are visible in every workspace) — pass entityScope:'workspace' only for a kind that is genuinely app-specific. Slug-idempotent: re-calling with an existing slug returns that profile and adds any new fields, so it is also the door for growing a kind's schema. Governed: may return 'proposed' — NEVER treat that as an error (when the kind itself is proposed, its fields are deferred until approval).",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description:
                "URL-safe kind slug (lowercase, digits, hyphens), e.g. 'podcast-episode'.",
            },
            displayName: {
              type: "string",
              description: "Human-readable type name, e.g. 'Podcast Episode'.",
            },
            description: {
              type: "string",
              description: "Optional description of what this kind represents.",
            },
            icon: {
              type: "string",
              description: "Optional icon hint for the kind.",
            },
            entityScope: {
              type: "string",
              enum: ["pod", "workspace"],
              description:
                "Where entities of this kind live. OMIT for the doctrine default 'pod' (kinds are pod-wide). Pass 'workspace' only for a kind that belongs to one app and should not appear pod-wide.",
            },
            properties: {
              type: "array",
              description:
                "Optional FIELDS of this kind, created and linked after the profile exists. Each entry defines one property def.",
              items: {
                type: "object",
                properties: {
                  slug: {
                    type: "string",
                    description:
                      "URL-safe field slug (lowercase, digits, hyphens), e.g. 'episode-number'.",
                  },
                  valueType: {
                    type: "string",
                    enum: [
                      "string",
                      "number",
                      "boolean",
                      "date",
                      "entity_id",
                      "array",
                      "object",
                      "secret",
                    ],
                    description:
                      "Field value type. 'entity_id' is a structural link to another entity.",
                  },
                  displayName: {
                    type: "string",
                    description: "Optional human-readable field label.",
                  },
                  required: {
                    type: "boolean",
                    description:
                      "Whether the field is required on entities of this kind.",
                  },
                  defaultValue: {
                    description: "Optional default value for the field.",
                  },
                  displayOrder: {
                    type: "number",
                    description: "Optional ordering hint within the form.",
                  },
                  constraints: {
                    type: "object",
                    description:
                      "Optional constraints, e.g. { enum: ['low','high'] } or { min: 0, max: 100 }.",
                  },
                  uiHints: {
                    type: "object",
                    description:
                      "Optional UI hints, e.g. { inputType: 'email' }.",
                  },
                  overlay: {
                    type: "boolean",
                    description:
                      "Create the field as a workspace-scoped overlay (invisible to other workspaces) instead of a base field on the kind.",
                  },
                },
                required: ["slug", "valueType"],
              },
            },
            defaultValues: {
              type: "object",
              description:
                "Optional default property VALUES applied to new entities of this kind (distinct from `properties`, which defines the fields themselves).",
            },
            workspaceId: {
              type: "string",
              description: "Workspace to define the kind in.",
            },
          },
          required: ["slug", "displayName", "workspaceId"],
        },
      },

      // ── Session bootstrap & governance ─────────────────────────────────────
      {
        name: "synap_orient",
        annotations: {
          title: "Orient in pod",
          readOnlyHint: true,
          openWorldHint: false,
        },
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
        annotations: {
          title: "Start focus session",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Create a focus session — a goal-bound work session — to declare 'I'm starting work on X'. Scope it to a project (projectId) OR a workspace (workspaceId), at least one; project-scoped needs no workspace membership.",
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
        annotations: {
          title: "Update focus session",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
        description:
          "Update an in-flight focus session WHILE working: goal, status (active|paused), progress, deliverables (`addOutput` appends, `completeOutput` marks done by label). Cannot close — use synap_complete_session for that.",
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
        annotations: {
          title: "Complete focus session",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
        description:
          "Close a focus session with a summary and optional reports; also closes any running playbook_run. Returns a **review pack**: pendingProposals[], counts, and warnings (e.g. unfinished expectedOutputs — warn only). Use synap_list_proposals({sessionId}) to re-fetch the pack.",
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
        name: "synap_get_session",
        annotations: {
          title: "Get focus session",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "Re-find a focus session — read-only. Pass sessionId for a specific session. Omit sessionId only when you have exactly one open session (ambient). If multiple sessions are open, returns multiSession:true + openSessions[] — pass sessionId explicitly (ambient attach is disabled to prevent mis-attribution). Always yours: sessions are scoped to the calling user.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description:
                "Optional focus session UUID. Omit only when exactly one session is open; if multiple are open you must pass sessionId.",
            },
          },
          required: [],
        },
      },
      {
        name: "synap_list_sessions",
        annotations: {
          title: "List focus sessions",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "List YOUR focus sessions, newest first — read-only. Use it to see what work is open before starting something new (don't start a second session for work that already has one), or to find a session you closed earlier. Filter by status and/or narrow to a workspace or project.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: [
                "active",
                "paused",
                "closed",
                "forming",
                "scheduled",
                "failed",
                "cancelled",
                "stale",
                "open",
                "all",
              ],
              description:
                "'open' (default) = every non-terminal session (active/paused/forming/scheduled). 'all' = no status filter. Or name one exact status — incl. 'stale' (reaper-marked, reopenable).",
            },
            workspaceId: {
              type: "string",
              description: "Optional: only sessions in this workspace.",
            },
            projectId: {
              type: "string",
              description: "Optional: only sessions scoped to this project.",
            },
            subjectEntityId: {
              type: "string",
              description:
                "Optional: only sessions ABOUT this entity (the subject-spine anchor).",
            },
            limit: { type: "number", default: 20 },
          },
          required: [],
        },
      },
      // ── Cell authoring & renderer binding ───────────────────────────────────
      {
        name: "synap_create_cell",
        annotations: {
          title: "Define cell",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
        description:
          "Define (create or update) a ViewFrame cell from raw renderer source — idempotent upsert on typeKey (from `name`) + workspace (omit workspaceId for pod-global). Creates the definition ONLY; surface it with synap_promote_cell_to_renderer.",
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
            viewTypes: {
              type: "array",
              items: { type: "string" },
              description:
                'Optional view types this cell can RENDER (e.g. ["list","table"]). Required for the cell to be selectable as a view renderer — a cell that declares none stays a plain widget and views fall back to the built-in adapter.',
            },
          },
          required: ["name", "rendererSource"],
        },
      },
      {
        name: "synap_promote_cell_to_renderer",
        annotations: {
          title: "Promote cell to renderer",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
        description:
          "Escalation L4 — crystallize AFTER a cell has succeeded once as a good recurring presentation. Bind that cell as a profile's renderer for a slot (list | detail | dashboard). Durable/consequential → governed like any write (may propose). scope 'workspace' (default) = per-workspace overlay; scope 'pod' = profile system default. Never promote a speculative or unproven one-off.",
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
        annotations: {
          title: "Promote session to playbook",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Escalation L4 — crystallize AFTER a session succeeded and the process is clearly repeatable (not a one-off). Promotes a validated focus session into a reusable Playbook (runtime → config): re-grants capabilities used and records lineage. May propose; never promote failed or speculative sessions.",
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
        annotations: {
          title: "List playbooks",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "List playbooks (reusable process/session templates) visible to you across the pod — every member workspace plus pod-wide templates. Call this to discover what already exists BEFORE improvising a new process. Optional workspaceId only narrows (still includes pod-wide). A playbook can be launched via synap_run_playbook (executor) or started as a working session via synap_start_session(templateId).",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description:
                "Optional workspace narrow — only that workspace's playbooks plus pod-wide ones. Omit for the full user-visible catalog.",
            },
            status: {
              type: "string",
              enum: ["draft", "active", "paused", "archived"],
              description: "Optional status filter.",
            },
            limit: {
              type: "number",
              description: "Page size (1–100, default 50).",
            },
          },
          required: [],
        },
      },
      {
        name: "synap_match_playbooks",
        annotations: {
          title: "Match playbooks",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "Given an entity's profile (e.g. 'post', 'deal', 'lead'), find active playbooks whose SUBJECT is that kind of entity — the Capture→Session matcher answering 'is there a playbook FOR this thing?'. Read-only. Returns candidates ({ id, name, goalTemplate, subjectProfileSlug, params, executor }); [] when none. Launch a returned candidate as an entity-bound session with synap_start_session (its id as templateId + the entity as subjectEntityId).",
        inputSchema: {
          type: "object",
          properties: {
            profileSlug: {
              type: "string",
              description:
                "The entity profile slug to match playbooks against (e.g. 'post', 'deal', 'lead', 'competitor').",
            },
            entityId: {
              type: "string",
              description:
                "Optional UUID of the specific entity — round-trip it into synap_start_session as subjectEntityId once a playbook is chosen. Does not narrow the match (matching is by profile).",
            },
            workspaceId: {
              type: "string",
              description:
                "Workspace ID to scope the lookup (optional — falls back to the user's first workspace). Pod-wide playbooks match regardless.",
            },
          },
          required: ["profileSlug"],
        },
      },
      {
        name: "synap_create_playbook",
        annotations: {
          title: "Create playbook",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Create a reusable playbook (staged process/session template) for a repeatable workflow — discoverable via synap_list_playbooks, run via synap_start_session with templateId. goalTemplate may contain {{param}} placeholders.",
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
        annotations: {
          title: "Get governance policy",
          readOnlyHint: true,
          openWorldHint: false,
        },
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
      {
        name: "synap_set_workspace_focus",
        annotations: {
          title: "Set workspace focus",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Pin your runtime workspace focus so every subsequent write (create/update/capture) with no explicit workspaceId lands there — the 'use the CRM workspace until I say otherwise' scenario. ADVISORY: a call that DOES pass an explicit workspaceId still overrides the focus; reads are unaffected. Sticky across calls until cleared. Pass `workspace` as a name (matched against your workspaces) or an id; omit it (or pass 'none'/'clear') to clear the focus.",
        inputSchema: {
          type: "object",
          properties: {
            workspace: {
              type: "string",
              description:
                "Workspace name or id to focus on. Omit, or pass 'none'/'clear', to clear the current focus.",
            },
          },
          required: [],
        },
      },

      // ── Capture ─────────────────────────────────────────────────────────────
      {
        name: "synap_capture",
        annotations: {
          title: "Capture",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "THE write door — everything worth remembering goes through here, in whatever shape you already have it. Never classify your input first: the payload is a GRADIENT, and you send as much structure as you have.\n" +
          "• `text` alone → free text, AI-structured into the right entities (the raw text is kept as provenance).\n" +
          "• `entities[]` → you already know the kind + fields (discover slugs with synap_list_profiles). `ref` is optional for a single entity.\n" +
          "• `entities[]` + `relations[]` → a graph. Refs let you link things that don't exist yet; the whole graph is ONE reviewable proposal, so nothing half-lands. To link something that already exists, give it a `ref` plus `existingEntityId`.\n" +
          "Call it AFTER learning something durable — don't wait to be asked. Placement uses EXISTING lenses only; capture never invents a workspace. `global:true` stores a pod-wide runbook (text only).\n" +
          "DEDUP: the strong identity signals are the property keys `email`, `phone`, `website`, `linkedinUrl`, `twitterHandle`, `githubUsername` — those exact spellings. Sending a URL under any other key (e.g. `url`) is NOT a dedup signal and will duplicate the entity.\n" +
          "\n" +
          'EXAMPLE 1 — raw text:\n{ "text": "Met Ada Lovelace of Acme at the conference — she owns their data platform and wants a demo in March." }\n' +
          "\n" +
          'EXAMPLE 2 — one structured entity, with properties + a long body:\n{ "entities": [ { "profileSlug": "person", "title": "Ada Lovelace", "properties": { "email": "ada@acme.com", "role": "Head of Data" }, "content": "## Notes\\nOwns the data platform. Wants a March demo." } ] }\n' +
          "\n" +
          'EXAMPLE 3 — a small graph (refs link entities that do not exist yet):\n{ "entities": [ { "ref": "p1", "profileSlug": "person", "title": "Ada Lovelace", "properties": { "email": "ada@acme.com" } }, { "ref": "c1", "profileSlug": "company", "title": "Acme Corp", "properties": { "website": "https://acme.com" } } ], "relations": [ { "sourceRef": "p1", "targetRef": "c1", "type": "works_at" } ] }\n' +
          "\n" +
          'ALWAYS returns the same receipt: { status, scope: { workspaceId, projectId, sessionId }, writeReceipt }. `status: "proposed"` is SUCCESS, not an error — writeReceipt.reviewUrl is a real clickable link and you MUST surface it as a markdown link in your reply, e.g. "Queued that for your review: [Review proposal](<reviewUrl>)" — never report a proposed write as simply done, and never withhold the link.\n' +
          'THE DOOR MAY REJECT, and a rejection is a CORRECT outcome — do not retry it: `status: "rejected"` with reason "already-known" (a lone entity carrying nothing but identity signals that already resolve to an existing one — its id is returned; re-send with content / extra properties / relations to ENRICH it instead), "no-durable-content" (nothing storable was sent). When the AI structurer is DOWN the text lane no longer rejects — it saves your text as a plain unstructured note and returns `degraded: true` with a `degradedNotice`: the note LANDED, but it is NOT the person/task/decision it describes, so relay that notice to the user instead of reporting a normal capture.',
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "Free-form text to parse (max 8000 chars). Send this when you have prose. If you ALSO send `entities[]`, the structured payload is used and this text is kept on the proposal as provenance.",
            },
            entities: {
              type: "array",
              description:
                "Structured payload: the things to write. Each needs a `profileSlug`; `ref` is only required when a relation points at it (it is auto-assigned otherwise).",
              items: {
                type: "object",
                properties: {
                  ref: {
                    type: "string",
                    description:
                      "Local id you invent, unique within this call — relations point at it. Optional when you send no relations.",
                  },
                  profileSlug: {
                    type: "string",
                    description:
                      "Entity kind (e.g. person, company, deal, note). REQUIRED.",
                  },
                  title: {
                    type: "string",
                    description: "Display name. Defaults to `ref` if omitted.",
                  },
                  description: {
                    type: "string",
                    description: "Short preview text.",
                  },
                  content: {
                    type: "string",
                    description:
                      "Long-form markdown body — materialized as a linked document on approval.",
                  },
                  properties: {
                    type: "object",
                    description:
                      "Typed fields. Include the STRONG identity signals when known — `email`, `phone`, `website`, `linkedinUrl`, `twitterHandle`, `githubUsername` — spelled exactly like that: they are what drives dedup against existing entities.",
                  },
                  existingEntityId: {
                    type: "string",
                    description:
                      "UUID of an entity that already exists — LINK it instead of creating a duplicate.",
                  },
                  facets: {
                    type: "array",
                    description:
                      "Kind + Facets: role-profiles to attach on approval (a role is a facet, never a second entity).",
                    items: {
                      type: "object",
                      properties: {
                        profileSlug: { type: "string" },
                        status: { type: "string" },
                        properties: { type: "object" },
                        contextRef: {
                          type: "string",
                          description:
                            "Optional ref of another entity in this call that gives the role its context.",
                        },
                      },
                      required: ["profileSlug"],
                    },
                  },
                },
                required: ["profileSlug"],
              },
            },
            relations: {
              type: "array",
              description:
                "The graph's edges (needs `entities[]`). Both refs MUST name entities in this same call.",
              items: {
                type: "object",
                properties: {
                  sourceRef: { type: "string" },
                  targetRef: { type: "string" },
                  type: {
                    type: "string",
                    description:
                      "Relation type — free string, e.g. 'works_at', 'related_to', 'contact_for', 'references'.",
                  },
                },
                required: ["sourceRef", "targetRef", "type"],
              },
            },
            summary: {
              type: "string",
              description:
                "One line the reviewer sees on the proposal card (structured payloads). Auto-generated when omitted — write your own, it is what the user reads.",
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
                "How much latitude the backend resolver has to place the capture. Placement is DERIVED by the backend, not free-picked by you: the resolver files pod-wide kinds pod-wide and computes a workspace lens from the ontology (a role enabled in exactly one of your workspaces) and context (bound channel / focus session). You do NOT choose a workspace and cannot invent one — you are only ever consulted as a TIE-BREAKER among the pre-approved candidates the resolver could not separate, and you may abstain. 'auto' (default) = let the resolver place it (deterministic when possible; tie-break only when >1 candidate survive; returned as movedToWorkspace). 'ask' = never move silently; return pendingWorkspaceSwitch so you can confirm with the user first. 'locked' = keep the caller's/session workspace, no resolution. To force a specific workspace, pass an explicit workspaceId (rung-1 explicit placement) rather than expecting to route there by inference.",
            },
          },
          // No `required`: the payload is a gradient — `text` OR `entities[]`
          // (or both). An empty call is REJECTED at the door with
          // reason "no-durable-content" and a message saying what to send.
        },
      },

      // ── Workspace & view creation ───────────────────────────────────────────
      {
        name: "synap_create_workspace",
        annotations: {
          title: "Create workspace",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Escalation L3 (governed — may propose): create a workspace from a definition. Template-first: market.search(kind:template) + prefer install before freehand create. Only after workspace-design four conditions hold and no template fits. Capture never invents a workspace. Pass stable proposalId for idempotency.",
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
        name: "synap_declare_workspace_source",
        annotations: {
          title: "Declare workspace source edge",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Declare a cross-workspace DATA EDGE on an EXISTING workspace by setting/merging its edge fields. `sourceRoles` = per-domain role this workspace plays (provider | consumer | provider-consumer), e.g. Marketing consumes Comms → { comms: 'consumer' }. `defaultSources` = per-domain the workspace to READ that domain from (the source of truth), e.g. { comms: { workspaceId: '<comms-ws-id>' } }. MERGES per-domain — existing domains and all other settings are preserved, never clobbered. Use this to wire the enterprise graph (provides/consumes) instead of copying data between workspaces. Editor+ membership required.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description:
                "The workspace to declare the edge ON (the subject).",
            },
            sourceRoles: {
              type: "object",
              description:
                "Domain → role map. Values: 'provider' | 'consumer' | 'provider-consumer'. Example: { \"comms\": \"consumer\" }. Merged per-domain into the existing map.",
              additionalProperties: {
                type: "string",
                enum: ["provider", "consumer", "provider-consumer"],
              },
            },
            defaultSources: {
              type: "object",
              description:
                'Domain → default source workspace to read that domain from. Each value: { workspaceId (required), capability?, profileSlug?, label? }. Example: { "comms": { "workspaceId": "<uuid>" } }. Merged per-domain.',
              additionalProperties: {
                type: "object",
                properties: {
                  workspaceId: { type: "string" },
                  capability: { type: "string" },
                  profileSlug: { type: "string" },
                  label: { type: "string" },
                },
                required: ["workspaceId"],
              },
            },
          },
          required: ["workspaceId"],
        },
      },
      {
        name: "synap_create_project",
        annotations: {
          title: "Create project",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Create a project — a cross-cutting lens for an initiative/venture that organizes entities across workspaces (a workspace is a domain lens; a project cuts across them). workspaceId = its HOME workspace (optional). A PROJECT IS A COMMITMENT WITH GRAVITY: never create one per git-repo, per-feature, or per-task — those are entities (task/plan/note). You MUST pass evidenceEntityIds: at least 5 existing entity ids that would belong to this project, or the create is rejected. If a same/similar project already exists it is reused (or surfaced) — reuse it instead of making a near-duplicate.",
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
            evidenceEntityIds: {
              type: "array",
              items: { type: "string" },
              description:
                "REQUIRED for agents: ≥5 existing, visible entity ids that would belong to this project (its gravity). Fewer/invalid ⇒ rejected with guidance to store as an entity or reuse an existing project.",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "synap_create_view",
        annotations: {
          title: "Create view",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Create a view in a workspace (recovery when the right view is missing, or proactive once data warrants it). Call synap_list_views first — don't duplicate. Type: table, kanban, list, gallery, calendar, bento, masonry, flow. profileId scopes to one entity type. Governed: may propose. On success the result includes `link` (`${PUBLIC_URL}/open/<id>`) — surface that URL to the user.",
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
      {
        name: "synap_list_views",
        annotations: {
          title: "List views",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "List views you own, optionally narrowed by workspaceId, type, or profileId. Call this BEFORE synap_create_view so you do not duplicate an existing board. Owner-only (same floor as hub listViews). Omit filters for the full catalog.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description:
                "Optional workspace UUID to narrow to. Omit for every view you own.",
            },
            type: {
              type: "string",
              description:
                "Optional view type filter (table, kanban, list, gallery, calendar, bento, masonry, flow).",
            },
            profileId: {
              type: "string",
              description:
                "Optional profile UUID to filter views scoped to that entity type.",
            },
          },
        },
      },

      // ── Channel & messaging ─────────────────────────────────────────────────
      {
        name: "synap_get_channel",
        annotations: {
          title: "Get or create channel",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
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
        annotations: {
          title: "Post message",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Post a message to a Synap channel or thread with optional AI triggering. Handles thread creation from a channelId and can trigger an AI response. triggerAI only starts an agent turn when role is 'user' — pass role:'user' with triggerAI:true to start one.",
        inputSchema: {
          type: "object",
          properties: {
            idempotencyKey: {
              type: "string",
              description:
                "Optional: a stable key so a retry returns the PRIOR message, not a duplicate. Plain posts also dedup on identical content automatically — EXCEPT a post that triggers the AI (triggerAI:true), which never content-dedups (two identical prompts are two real turns); pass a key there for at-most-once turn semantics.",
            },
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
        annotations: {
          title: "Revise proposal",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
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
        name: "synap_reject_proposal",
        annotations: {
          title: "Reject proposal",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
        description:
          "Reject a pending proposal so the queued change never lands — withdraw a write you now know is wrong (a duplicate, a superseded plan, a mistaken read) instead of leaving it in the user's review queue. Give a `reason`: it is recorded on the proposal and feeds your agent scorecard. " +
          "There is deliberately NO approve tool: approval is the HUMAN step (an agent key that approved its own write would be self-approving) — point the user at the proposal's review link instead. Rejecting is safe by the same logic in reverse: it only PREVENTS a pending change from landing, so it carries no self-approval or undo risk. Only a still-pending proposal can be rejected.",
        inputSchema: {
          type: "object",
          properties: {
            proposalId: {
              type: "string",
              description:
                "Proposal UUID, or the 8-char short id printed by synap_list_proposals / the CLI.",
            },
            reason: {
              type: "string",
              description:
                "Why you are rejecting it (recorded on the proposal). Always give one.",
            },
            reasonCode: {
              type: "string",
              enum: [...PROPOSAL_REJECTION_REASONS],
              description:
                "Optional structured cause, one of the fixed set — recorded alongside `reason` and fed to the calibration/scorecard loop. Use `other` (or omit) when none fits and rely on the free-text `reason`.",
            },
          },
          required: ["proposalId"],
        },
      },
      // (synap_write_knowledge folded into synap_capture's `global` lane — a
      // pod-wide runbook is `synap_capture` with global:true. One write door.)

      // ── Capabilities (connected-service verbs: Gmail, Calendar, Drive, …) ────
      {
        name: "synap_list_capabilities",
        annotations: {
          title: "List capabilities",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          'Discover what the user can actually DO. Returns a SECTIONED view: `integrations` (their connected services + tools, one per name, each with its `verbs` nested — e.g. google → gmail_send, gmail_search, calendar_list; the verb `id` is what you pass to synap_run_capability), `skills` (standalone runnable skills), and `commands`. Each integration shows `connection.connected` (needs connecting if false) and each verb shows `granted`/`effectiveExecMode` (a not-yet-granted verb must be enabled in Settings → Capabilities). Core built-in tools (already available to you directly as MCP tools) and teaching docs are omitted from this actionable view and only COUNTED under `excluded`; pass kind:"builtin-tool" to see the full catalog. Pass `query` to search across integrations/verbs/skills (e.g. query:"send email").',
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: { type: "string", description: "Workspace UUID" },
            query: {
              type: "string",
              description:
                "Search text (e.g. 'send email', 'calendar'). Ranks + narrows the result instead of returning the full unfiltered dump.",
            },
            kind: {
              type: "string",
              description:
                "Optional exact kind filter: tool | skill | command | source-provider | builtin-tool | teaching-doc.",
            },
            limit: {
              type: "number",
              description:
                "Max entries to return (default 20 when `query` is set; unset otherwise).",
            },
          },
          required: ["workspaceId"],
        },
      },
      {
        name: "synap_run_capability",
        annotations: {
          title: "Run capability",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        },
        description:
          'Run a registered capability verb (discover via synap_list_capabilities) with dynamic inputs — e.g. send an email, search Gmail, create a calendar event. Pass verbId + parameters. A DRAFT (un-enabled) capability is refused — ask the user to enable it first. Governed like any write: an ungranted verb comes back as `{ kind: "proposed", proposalId, reviewUrl }` instead of running — that is SUCCESS, not an error. You MUST surface the `reviewUrl` as a clickable link in your reply (never just say \'proposed\' with no link) — e.g. "Queued that email send for your review: [Review proposal](<reviewUrl>)" — and continue the conversation without waiting for approval.',
        inputSchema: {
          type: "object",
          properties: {
            idempotencyKey: {
              type: "string",
              description:
                "Optional: a stable key that correlates retries of THIS run. Note: a direct capability run has NO automatic content dedup — a retried call CAN produce a second external effect (e.g. a second send). Pass a key when the effect must be at-most-once; the key is recorded on the run.",
            },
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
        name: "synap_create_verb",
        annotations: {
          title: "Create verb",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Add a new DECLARATIVE verb (a deterministic provider HTTP call — no code execution) to an ALREADY-INSTALLED, already-credentialed tool — e.g. teach 'apify_api' a new 'apify_search_reddit_actors' verb without a dev-session/redeploy. Creates a kind='declarative' skill only; rejects any request implying code/instruction/builtin execution. `toolName` MUST already exist (installed + visible to the caller) or this is refused — it never creates a new tool/connection as a side effect. Governed the same as every other write: may return status='proposed' for review. Discover installed tools with synap_list_capabilities first.",
        inputSchema: {
          type: "object",
          properties: {
            toolName: {
              type: "string",
              description:
                "The NAME of the already-installed tool this verb calls (e.g. 'apify_api'). Must already exist — this tool never creates a new tool/connection.",
            },
            verbName: {
              type: "string",
              description:
                "Stable name for the new verb/skill (e.g. 'apify_search_reddit_actors').",
            },
            description: {
              type: "string",
              description: "What the verb does and when to use it.",
            },
            method: {
              type: "string",
              enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
              description: "HTTP method the provider call uses.",
            },
            pathTemplate: {
              type: "string",
              description:
                "Request path with {{param}} interpolation, e.g. '/v2/acts/{{actorId}}/runs'.",
            },
            query: {
              type: "object",
              description:
                "Query params; values may be '{{param}}'; arrays become repeated query keys.",
            },
            body: {
              type: "object",
              description: "Request body template; values may be '{{param}}'.",
            },
            responseShape: {
              type: "object",
              description:
                "How to shape the provider's raw response (collectionPath, item, scalar, headers dot-paths).",
            },
            parameters: {
              type: "object",
              description:
                'The verb\'s own runtime parameter schema using the shorthand type system, e.g. { query: "string", limit: "number?" }.',
            },
            workspaceId: {
              type: "string",
              description:
                "Optional workspace UUID to scope the new verb to (default: pod-wide).",
            },
          },
          required: ["toolName", "verbName", "method", "pathTemplate"],
        },
      },
      {
        name: "synap_list_automations",
        annotations: {
          title: "List automations",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "List automations (WHEN-triggered flows) visible in a workspace — the reactive rules a user has set up (e.g. 'on new lead → draft a follow-up', 'every morning → recap yesterday'). Each entry has its id (pass to synap_trigger_automation), name, triggerType (event | cron | webhook | manual), and status (active | draft | paused | error). Read-only. Call this to discover what already reacts BEFORE creating a new automation. Omit workspaceId to list everything accessible.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description:
                "Optional workspace UUID to narrow to (pod-wide automations are always included). Omit for all accessible.",
            },
            status: {
              type: "string",
              enum: ["draft", "active", "paused", "error"],
              description: "Optional status filter.",
            },
            limit: {
              type: "number",
              description: "Max entries to return (default 50).",
            },
          },
        },
      },
      {
        name: "synap_trigger_automation",
        annotations: {
          title: "Trigger automation",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        },
        description:
          "Run an existing automation NOW, on demand (discover ids via synap_list_automations) — e.g. fire a 'daily client recap' immediately instead of waiting for its schedule. Pass the automation id; optionally a payload injected as the run's trigger.payload. This is a RUN, not a proposal: it returns { status: 'triggered', runId } once enqueued (gated by your write access to the automation's workspace). Any entity writes the run then performs are separately reviewed under the automation's own governance. A draft automation is runnable on demand this way; paused/error non-manual ones are refused.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "UUID of the automation to trigger.",
            },
            payload: {
              type: "object",
              description:
                "Optional data injected as trigger.payload in the run context (e.g. { entityId } to bind the run to a subject).",
            },
            workspaceId: {
              type: "string",
              description:
                "Optional workspace lens. When set, only automations in that workspace can be triggered; omit to trigger a pod-wide automation.",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "synap_create_automation",
        annotations: {
          title: "Create automation",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Create an automation — a WHEN→THEN flow that reacts to a trigger (event | cron | webhook | manual) by running a flow of steps. Use for repeatable reactions ('every morning recap each client', 'on new deal notify the channel'). Governed the same as every write: an agent create returns status='proposed' for review; on approval it becomes ACTIVE (live) — not a stuck draft. Provide the trigger, a flowDefinition ({ nodes, edges }), and a dataContract — the contract is REQUIRED for agent-authored automations (which this always is) and the create door rejects the automation without a valid one. For a cron trigger put the schedule in triggerConfig.expression (5-field cron). Discover what already exists with synap_list_automations first.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Automation display name." },
            description: {
              type: "string",
              description: "What this automation does.",
            },
            triggerType: {
              type: "string",
              enum: ["event", "cron", "webhook", "manual"],
              description:
                "WHEN it fires: 'event' (something happened, e.g. entity created), 'cron' (schedule — put the 5-field expression in triggerConfig.expression), 'webhook' (external call), 'manual' (only via synap_trigger_automation).",
            },
            triggerConfig: {
              type: "object",
              description:
                "Trigger settings. cron → { expression: '0 9 * * *' }. event → { eventPattern: 'entity.create.completed', filters: { profileSlug } }.",
            },
            flowDefinition: {
              type: "object",
              description:
                "The THEN flow: { nodes: [...], edges: [...] }. Nodes are the steps; edges wire them in order. A step of type 'capability' MUST name a verb that actually exists — data.verbId is the backing skill's NAME (e.g. 'ai.generate'), not a UUID, and the create is REJECTED if it does not resolve for you (data.capabilityId is optional; omit it and the verb alone resolves). Check with synap_list_capabilities before authoring capability steps.",
              properties: {
                nodes: { type: "array", items: { type: "object" } },
                edges: { type: "array", items: { type: "object" } },
              },
              required: ["nodes", "edges"],
            },
            status: {
              type: "string",
              enum: ["draft", "active", "paused", "error"],
              description: "Defaults to 'active' (live once approved).",
            },
            resultRouting: {
              type: "string",
              enum: ["per_type", "per_entity", "trigger"],
              description:
                "Optional: where run results are posted. 'per_entity' = the subject entity's own channel, 'per_type' = one channel per entity type, 'trigger' = the triggering channel.",
            },
            metadata: {
              type: "object",
              description:
                "Metadata bag. REQUIRED here: `dataContract` — this tool is always agent-authored, and automations.create REJECTS an agent-authored automation whose metadata carries no valid contract. Any other keys you add are kept as-is.",
              properties: {
                dataContract: AUTOMATION_DATA_CONTRACT_JSON_SCHEMA,
              },
              required: ["dataContract"],
            },
            workspaceId: {
              type: "string",
              description: "Optional workspace to scope to (default pod-wide).",
            },
          },
          required: ["name", "triggerType", "flowDefinition", "metadata"],
        },
      },
      {
        name: "synap_run_playbook",
        annotations: {
          title: "Run playbook",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        },
        description:
          "LAUNCH a playbook via its executor (discover via synap_list_playbooks) — instantiates a session + run channel + playbook_run and dispatches to the playbook's executor (is-agent | external-agent | hybrid). Pass playbookId OR an unambiguous playbookName/name (multi-match returns candidates — never a silent pick). Write home: workspaceId if set, else the playbook's workspace, else subject/session; pod-wide playbooks with no home reject (pass workspaceId). Distinct from synap_start_session(templateId). Governed: agent launch returns status='proposed' until approved.",
        inputSchema: {
          type: "object",
          properties: {
            playbookId: {
              type: "string",
              description:
                "UUID of the playbook to run. Provide this OR playbookName/name.",
            },
            playbookName: {
              type: "string",
              description:
                "Public name of the playbook (case-insensitive). Must be unique among playbooks you can see; ambiguous names return candidates with id + workspaceId.",
            },
            name: {
              type: "string",
              description: "Alias for playbookName.",
            },
            params: {
              type: "object",
              description:
                "Values for the playbook's {{param}} placeholders (e.g. { market: 'EU fintech' }).",
            },
            subjectId: {
              type: "string",
              description:
                "Optional entity UUID to bind this run to (the run's subject lens). Also used as write-home fallback for pod-wide playbooks.",
            },
            agentIds: {
              type: "array",
              items: { type: "string" },
              description: "Optional agent ids to staff the run with.",
            },
            reasoning: {
              type: "string",
              description:
                "Why you're launching this — surfaced on the review proposal.",
            },
            workspaceId: {
              type: "string",
              description:
                "Write workspace for the run. Optional when the playbook is already workspace-scoped; required for pod-wide playbooks unless subject/session supplies a home. Never falls back to an arbitrary membership.",
            },
          },
          required: [],
        },
      },
      {
        name: "synap_create_skill",
        annotations: {
          title: "Create code skill",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Author a runnable CODE skill — a sandboxed executable (plus its docs) the agent can later run, e.g. a custom transform/enrichment that no connected-service verb covers. Use this when you need CODE; for a deterministic provider HTTP call on an already-installed tool use synap_create_verb instead. Governed the same as every write: an agent create returns status='proposed'. Once approved, a code skill is born UNAPPROVED — it does NOT load or run as a tool until the owner explicitly approves it (code executes, so it needs a deliberate human OK). `code` is required.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Stable skill name (e.g. 'normalize_phone_numbers').",
            },
            description: {
              type: "string",
              description: "One line: what it does + when to use it.",
            },
            code: {
              type: "string",
              description:
                "The executable source (runs sandboxed). REQUIRED — this is what makes it a code skill.",
            },
            body: {
              type: "string",
              description:
                "Optional Markdown documentation: how the skill works, inputs/outputs, when to use it.",
            },
            parameters: {
              type: "object",
              description:
                "Optional runtime parameter schema (shorthand types, e.g. { input: 'string', count: 'number?' }).",
            },
            workspaceId: {
              type: "string",
              description:
                "Optional workspace to scope the skill to (default: pod-wide).",
            },
          },
          required: ["name", "code"],
        },
      },
      {
        name: "synap_load_skill",
        annotations: {
          title: "Load skill",
          readOnlyHint: true,
          openWorldHint: false,
        },
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
    agentUserId?: string,
    /**
     * AMBIENT focus-session handle — the MCP URL's `?sessionId=`, injected
     * server-side by the transport (routers/mcp/index.ts). It is deliberately
     * NOT part of `scopedArgs` and is NEVER advertised on a tool schema: putting
     * a bookkeeping handle in front of the model on every tool would make the
     * advertised schemas dishonest. An explicit `args.sessionId` (the session
     * tools) always wins; this is only the fallback.
     */
    ambientSessionId?: string,
    /**
     * SERVICE-KEY CONFINEMENT: the authenticating key's `keyType` + workspace
     * binding. Forwarded to the adapter so a bound `service` key is confined to
     * its workspace via `resolveConfinedWorkspace`. Undefined/null → passthrough.
     */
    keyType?: string | null,
    keyWorkspaceId?: string | null
  ): Promise<CallToolResult> {
    // THE error door. Every MCP tool call flows through this one seam, so the
    // boundary lives here and nowhere else: a thrown error becomes an
    // `isError: true` RESULT (recoverable text the model can act on) instead of
    // a JSON-RPC -32603 protocol crash. A governed `{status:"proposed"}` write
    // returns normally and is untouched — proposed is SUCCESS, not an error.
    const badArg = validateUuidArgs(args, name);
    if (badArg) return badArg;

    try {
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
        agentUserId,
        ambientSessionId,
        keyType,
        keyWorkspaceId
      );
    } catch (err) {
      return toSafeToolError(err, name);
    }
  },
};
