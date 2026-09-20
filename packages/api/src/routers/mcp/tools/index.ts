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
import { SESSION_KINDS } from "../../../services/focus-sessions/session-kind.js";
import { PROPOSAL_REJECTION_REASONS } from "@synap-core/types/proposals";
import { TERMINAL_SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import { ABSTRACT_VERBS } from "@synap/database/schema";
// The catalog names `synap_find` accepts — SPREAD from the service that owns
// them, never re-typed, so a fourth catalog cannot be advertised without
// existing (and vice versa). Same idiom as ABSTRACT_VERBS above.
import { FIND_CATALOGS } from "../../../services/capabilities/find-intent.js";
// The output-slot `ref` kind union, DERIVED into the three JSON-Schema enums
// below rather than retyped beside them. It was hand-written three times in
// this file; @synap/playbooks is dependency-free, so there is no cycle and no
// reason for a copy. Widening the union now widens what MCP advertises, in the
// same commit, and `output-ref-kinds-parity` audits the mirrors this file
// cannot import (the Hub REST client's duplicated literal).
import { OUTPUT_REF_KINDS } from "@synap/playbooks";

import { automationDataContractSchema } from "../../automations.js";
import { ruleSentenceSchema } from "../../../services/rules/sentence-schema.js";
import { PROJECT_SCOPE_EVENT_PREFIXES } from "../../../services/rules/scope.js";
import { buildCapabilityExecuteAgentJsonSchema } from "../../../contracts/capability-execute-schema.js";

/**
 * The ONE advertised shape of a session criterion (start + update doors).
 * Validated server-side with `sessionCriteriaSchema`; this only teaches it.
 */
const SESSION_CRITERIA_PROPERTY = {
  type: "array",
  maxItems: 12,
  description:
    "Optional binary acceptance criteria — your definition of done, each one observable (e.g. 'Typecheck passes with 0 errors'). Closing never blocks on them; unmet ones are flagged.",
  items: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Lowercase slug, unique in the session.",
      },
      statement: { type: "string" },
      required: {
        type: "boolean",
        description: "Default true.",
      },
      check: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["evidence", "capability", "judge", "human"],
          },
          capability: { type: "string" },
          evidenceKey: { type: "string" },
          hint: { type: "string" },
        },
        required: ["kind"],
      },
    },
    required: ["key", "statement", "check"],
  },
};

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

/**
 * JSON Schema for `synap_create_rule`'s `sentence` input, DERIVED from
 * `ruleSentenceSchema` — the very schema the rule door parses the sentence with
 * before compiling it. Same reasoning as the automation data-contract schema
 * above: the published tool surface and the parser that refuses a bad sentence
 * cannot drift apart, and teaching the grammar a new action type widens this
 * tool with no edit here.
 *
 * Prose descriptions are layered on top. `$schema` is stripped (MCP
 * `inputSchema` property entries are plain sub-schemas, and gen-manifest.ts
 * needs a deterministic committed diff).
 */
function buildRuleSentenceJsonSchema(): Record<string, unknown> {
  const derived = z.toJSONSchema(ruleSentenceSchema, {
    io: "input",
  }) as Record<string, unknown>;
  delete derived.$schema;

  const properties = derived.properties as Record<
    string,
    Record<string, unknown>
  >;
  derived.description =
    "The rule's structured WHEN / WHERE / THEN. Send it when the rule should DO something — the door compiles it into a live automation or REFUSES naming the clause that failed. Omit it for a prose-only FACT rule. All three keys are required when you send it (`conditions` and `actions` may be empty arrays, but an empty `actions` is refused as 'no THEN').";
  properties.trigger.description =
    "WHEN — `null` is refused (nothing would ever start the rule). triggerType 'event' → subjectCategory + actionVerb (+ optional profileSlug), e.g. { triggerType: 'event', subjectCategory: 'entity', profileSlug: 'deal', actionVerb: 'created' }. OMIT actionVerb for ANY activity on that subject — it compiles to the `<subject>.*` wildcard, which is the right choice for the non-entity subjects (notification, proposal, focus_session, external_message …) whose real actions are domain verbs, not create/update/delete. Every subjectCategory offered is producer-backed AND workspace-scoped, so none of them is a trigger that can never fire. triggerType 'cron' → cronFrequency (+ cronTime / cronDays / cronDayOfMonth / cronTimezone). The compiled event pattern is checked against the runtime's own event grammar, so a WHEN nothing emits is refused rather than stored.";
  properties.conditions.description =
    "WHERE — narrows the WHEN. Each row needs BOTH `key` and `value`: a half-filled row is refused, not dropped, because dropping it would silently apply the rule more widely than the author wrote. Empty array = no narrowing.";
  properties.actions.description =
    "THEN — what runs. At least one action with a non-null `type`, or the rule is refused. `config` is per-type and is validated against the executor's own node contract. `run_command` is refused: the command step has no receiver and would fail every time — use an AI step instead.";
  return derived;
}

const RULE_SENTENCE_JSON_SCHEMA = buildRuleSentenceJsonSchema();

/**
 * JSON Schema for `synap_run_capability`, DERIVED from the ONE
 * capability-execute input contract (`contracts/capability-execute.ts`) — the
 * same schema the tRPC and Hub REST doors declare.
 *
 * The AGENT subset is narrower than the full contract on purpose:
 * `sessionId`, `sourceMessageId` and `channelId` are AMBIENT on an MCP turn and
 * the handler supplies them from `ctx`, so a model-supplied value would let an
 * agent file its run under someone else's operation. The narrowing lives in the
 * contract (`MCP_AGENT_PARAMS`) rather than here, so this tool cannot quietly
 * fall behind the service's parameter list again.
 */
const RUN_CAPABILITY_JSON_SCHEMA = buildCapabilityExecuteAgentJsonSchema();

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
          "List entities for a user filtered by profileSlug. Use to browse all entities of a type (all tasks, all projects). For content/semantic recall use synap_ask. Supports limit (default 50). Returns lean rows by default; use synap_get_entity or detail:'full' for full values.",
        inputSchema: {
          type: "object",
          properties: {
            detail: {
              type: "string",
              enum: ["lean", "full"],
              description:
                "lean (default) = null columns and systemData omitted, string values over 120 chars truncated with '…[truncated: N chars total]' (every property key kept). full = unprojected rows.",
            },
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
          "List proposals — the audit trail of AI writes. AI writes return status 'proposed' when they require human approval — this is NOT an error. Filter by status: 'pending' (needs review), 'approved', 'rejected', 'auto_approved' (the write EXECUTED immediately under governance and filed this row as its receipt — use this to show the user what you did without asking), 'reverted', 'approval_failed', 'withdrawn', 'expired' (never decided — its session closed or its window lapsed). Pass sessionId to load the **session review pack** (proposals for one focus session). userId is auto-injected from the API key if not provided.",
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
                "expired",
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
          'Understand what\'s happening / what\'s wrong — the pod\'s health door (the third door, alongside ask + capture). The MODE is derived from what you pass (never a tool name you choose): NO ARGS → whole-pod health (stuck runs, failed flows, review backlog + age, duplicate-proposal clusters, capability posture, agents hitting the daily cap) with a plain-language summary; `type` → a class as a surface (type:"proposal" = the review queue: pending count, oldest, duplicate clusters; type:"session" = stuck sessions; type:"agent" = agent roster + quality; type:"capability" = approved vs awaiting; type:"run" = per-flow failure counts; type:"workspace" = the workspace landscape: per-workspace entity counts + which kinds live in each, PAIRWISE profile-slug overlap between workspaces, and flags for empty / duplicate-named / no-authored-identity workspaces — the "do I have too many workspaces?" read); `id` → auto-detects what the id is (proposal / session / capability / automation-run / playbook-run / agent / entity / view / document / workspace) and explains its state + WHY; `agentId` → an agent\'s behavioural scorecard (approve/reject/revise rates, top rejection reasons, duplicate rate, daily-cap posture). Backward-compatible: `runId`+`flowType` → that run\'s activity timeline (a capture\'s decision + trace events, each with a machine-readable reason + fixHint); `flowType`/`flowId` → the run feed. USER-scoped automatically.',
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
                "workspace",
              ],
              description:
                "Diagnose a whole CLASS as a surface (the review queue, stuck sessions, the agent roster, capability health, per-flow run failures, the workspace landscape).",
            },
            id: {
              type: "string",
              description:
                "Any object id — the door auto-detects whether it is a proposal / session / capability / run / agent / entity / view / document / workspace and explains its state + why.",
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
            detail: {
              type: "string",
              enum: ["lean", "full"],
              default: "lean",
              description:
                "'lean' (default) omits `effectivePropertiesByWorkspace` — the kind's property schema re-resolved once per accessible workspace, which is 83-93% of an entity read and long enough on its own to truncate the response. You still get the entity, its profile, its own workspace's `effectiveProperties` (the schema a write to this entity is validated against), facets, externalLinks and graph, plus a `propertyOverlays` signpost naming which workspaces differ. 'full' adds the per-workspace map back — ask for it only when you need to compare lenses.",
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
          "List all available entity types (profiles) AND the relation types you may link them with. ALWAYS call at session start before creating entities or relations. Never assume 'deal', custom types or a relation slug exist — workspaces differ. Returns { profiles, relationTypes }: a lightweight digest per profile (id, slug, displayName, profileKind, entityScope, applicableKinds on roles, description ≤120 chars, workspaceId), and relationTypes as slugs grouped by lens ([{workspaceId:null, slugs}] = valid everywhere, plus per-workspace groups listing only the slugs that workspace adds). detail:'full' returns complete profile rows and full relation-type rows (displayName, description, isDirectional, inverseLabel). A relation `type` on synap_capture / synap_link_entities must be one of those slugs; any other slug is rejected with the valid list. If the relation read failed you get `relationTypesError` instead of `relationTypes`. Without a workspaceId, profiles are merged across your workspaces; a workspace whose profiles could not be read is named in `workspacesFailed` (its kinds are missing from `profiles`), never silently dropped. No property schemas here or in synap_orient. A kind's fields, enums and required keys: call synap_get_entity on any existing entity of that kind (its `effectiveProperties`); over HTTP, GET /api/hub/discover?profileSlugs=<slug>. For a kind with no entities yet, a write that breaks the schema is rejected with the valid fields quoted — fix and resend once.",
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
                "Pass 'full' to receive complete profile rows (including renderer and uiHints columns) and full relation-type rows (displayName, description, isDirectional, inverseLabel). Omit for the lean digest (default): profile digests plus relation-type slugs grouped by lens.",
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
          "Create a SINGLE typed entity — no relations parameter exists here. Use when you already know the exact profileSlug + fields: the structured, deterministic sibling of synap_capture (which parses free text). Discover slugs with synap_list_profiles; synap_ask first to avoid duplicates. Same-profile same-name creates are REJECTED with candidates (reuse the existing id, enrich, or attach a facet) unless forceCreate=true. Placeholder person/company titles (e.g. 'Not publicly disclosed', 'unknown') are rejected. To create an entity TOGETHER WITH its edge to another entity in one reviewable unit, use synap_capture instead, passing both `entities` and `relations` — synap_link_entities cannot target an entity this call just proposed (its id isn't live until approved).",
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
            sessionId: {
              type: "string",
              description:
                "OPTIONAL focus-session override. Leave it out and the write is attributed automatically — you do NOT normally pass this. Send it ONLY to disambiguate: when two or more of your focus sessions are open, automatic attribution deliberately declines rather than guess, and this is the only way to say which session the write belongs to. A session that isn't yours is ignored, not an error.",
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
            expectedLabel: {
              type: "string",
              description:
                "The declared output slot this fulfils, exactly as declared on the session.",
            },
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
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
          "Update an entity's title, description, properties (JSONB), or long-form BODY (`content`). Requires entityId from search or synap_get_entity. May return 'proposed' if the write requires review. Use for status changes (task todo→done), property updates, and correcting the body of a document you captured earlier. `content` REPLACES the body of the entity's linked document (read it first with synap_get_document); it always goes to review. If the entity has no body document yet the call is refused — create and attach one with synap_create_document({ entityId, title, content }).",
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
            content: {
              type: "string",
              description:
                "Full REPLACEMENT body (markdown) for the entity's linked document — not a patch. Read the current body with synap_get_document first. Its outcome comes back under `body` and is always 'proposed'.",
            },
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
            },
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
            sessionId: {
              type: "string",
              description:
                "OPTIONAL focus-session override. Leave it out and the write is attributed automatically — you do NOT normally pass this. Send it ONLY to disambiguate: when two or more of your focus sessions are open, automatic attribution deliberately declines rather than guess, and this is the only way to say which session the write belongs to. A session that isn't yours is ignored, not an error.",
            },
            expectedLabel: {
              type: "string",
              description:
                "The declared output slot this fulfils, exactly as declared on the session.",
            },
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
            },
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
            expectedLabel: {
              type: "string",
              description:
                "The declared output slot this fulfils, exactly as declared on the session.",
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
          "Create a typed relation between two entities. `type` is NOT a free string: it must name an existing relation-def slug — real ones include 'relates_to', 'references', 'mentions', 'parent_of', 'depends_on', 'blocks', 'created_by', 'works_at', 'belongs_to_project'. The default slugs resolve pod-wide, so no `workspaceId` is needed for them; a workspace may add or override slugs. A slug that names no relation def is rejected. If available to you, check this entity's existing relations first to avoid duplicates. Both endpoints must already be LIVE entities — an id from a still-pending synap_create_entity proposal will fail; to create an entity and its edge together, use synap_capture with `entities` + `relations` instead. May return 'proposed'. Builds the knowledge graph.",
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
              // Must name an existing `relation_defs` slug — `relations.create`
              // rejects anything else. The previous examples ('related',
              // 'parent', 'child', 'belongs-to') were ALL invalid slugs, so an
              // agent following this schema got a 400. These are real defaults
              // from `database/src/utils/default-relation-defs.ts`.
              description:
                "Relation type — an existing relation-def slug (e.g. 'relates_to', 'references', 'mentions', 'parent_of', 'belongs_to_project', 'works_at')",
              default: "relates_to",
            },
            workspaceId: {
              type: "string",
              description: "Workspace ID (optional)",
            },
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
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
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
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
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
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
          "Define or WIDEN a role (facet): a hat on ANY entity kind, not only person/company. Example: applicableKinds ['item'] means 'this item is an X'. Call ONLY after synap_list_profiles. If the slug already exists, extra applicableKinds are MERGED (widen only — never a second slug for the same hat). Prefer attach_facet; widen when kind_mismatch. NULL stored allowlist = any kind. Governed: may return 'proposed' — NEVER treat that as an error.",
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
                "Kind slugs this hat can attach to (item, person, company, task, …). Merged on an existing role. Defaults to ['company','person'] only when omitted on CREATE — that default is a convenience, not a model limit.",
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
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
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
          "Define a NEW entity KIND only after list_profiles + extend-first (load_skill system/synap-schema/extend-first). A hat on an existing kind — including item, task, deal — is a ROLE (synap_define_role / attach_facet), never a sibling kind. Prefer parentProfileSlug of the closest parent over a disconnected slug. A relationship-with-its-own-life (buyer×seller×price×stage) is its own kind (deal *precedent*), not a twin of CRM deal. Slug-idempotent for fields. POD-WIDE default. Governed: 'proposed' is success.",
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
            parentProfileSlug: {
              type: "string",
              description:
                "Optional slug of a parent kind to extend (e.g. 'note', 'person') — NOT a UUID. Resolved to the parent profile id server-side; use synap_list_profiles to discover slugs.",
            },
            workspaceId: {
              type: "string",
              description: "Workspace to define the kind in.",
            },
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
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
          "The session BRIEFING — call first in every session. Leads with `startHere`: proposals you or your agents filed that await review (raise these first; the user's queue may hold more from others), open work sessions, the most-used kinds, runnable actions, and the skill to load for concept depth. Then your identity, what is known about the user, projects (companies/initiatives) and the workspaces (operational domains) that hold data. Pass scope:['projects'] and/or workspaceId to narrow. Light omits empty domains and the full type inventory; detail:'full' adds every workspace, descriptions, onboarding specs and per-workspace profiles. Every kind and role: synap_list_profiles.",
        inputSchema: {
          type: "object",
          properties: {
            detail: {
              type: "string",
              enum: ["light", "full"],
              description:
                "light (default) = startHere + names/ids/domain/counts + onboarding goal, empty domains and the entity-type inventory omitted; full = every workspace, descriptions, full onboarding spec, per-workspace profiles, and the lens-model explanation in `note`.",
            },
            explain: {
              type: "boolean",
              description:
                "Include the lens-model explanation (workspaces vs projects, where writes land) in `note` without the rest of detail:'full'. Omit once you know the model.",
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
          "Create a focus session — a goal-bound work session — to declare 'I'm starting work on X'. Scope it to a project (projectId) OR a workspace (workspaceId), at least one; project-scoped needs no workspace membership. Give it a short `title` (the name) and a `goal` (the outcome). To decompose work, start a root session, then start each sub-session with parentSessionId = the root; declare ordering with blockedBySessionIds instead of writing the dependency chain into the goal. The result reports `parentLink` and `blockerLinks` — a failed edge is reported there, never silently dropped. If an open session with the same goal already exists in this scope, the existing one is returned with status 'deduped' — continue it instead of starting another. DEFAULTS: your writes are grouped into a session automatically even if you never call this; calling it when you begin a unit of work names that session (if one was auto-opened for you it is ADOPTED — `adopted: true`, same id, never a duplicate). FETCH THE POD'S PROCESSES FIRST: with no templateId, the result's `playbooks` block hands you the pod's existing playbooks ranked against your title+goal, each with the `reason` it matched — suggestions only, NOTHING is applied. If one fits, start again with that `templateId` (the only way a playbook binds); if none does, carry on ad-hoc deliberately. Pass templateId: null to skip matching entirely. PROPOSE `criteria` — two to five binary, observable statements — and let the person validate or rewrite them; declaring none leaves you nothing to report progress against but your own opinion. Declare `expectedOutputs` for what the session will produce, so 'done' is derivable from unfilled slots rather than announced as a percentage. A detour that has to happen first is a CHILD session: `parentSessionId` plus `suspendedIntent`, one line naming what you were about to do, so popping back restates the goal.",
        inputSchema: {
          type: "object",
          properties: {
            forceCreate: {
              type: "boolean",
              description:
                "Create a new session even if an open one with the same goal already exists in this scope. Default false.",
            },
            title: {
              type: "string",
              maxLength: 200,
              description:
                "Optional short NAME for the session — one line, a few words (e.g. 'Scraping research'). This is what lists show. Omit it and lists show the goal's first line, clipped.",
            },
            goal: {
              type: "string",
              description:
                "The OUTCOME — a single outcome-oriented sentence (e.g. 'Research best web-scraping approaches for social media'). NOT a paragraph. The name goes in title; detail, scope, and deliverables go in expectedOutputs; dependencies go in blockedBySessionIds.",
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
              type: ["string", "null"],
              description:
                "Optional playbook UUID — the ONE way a playbook binds to this session. Omit and the result's `playbooks` block ranks the pod's playbooks against your words so you can name one (nothing is applied for you); pass null to skip matching entirely.",
            },
            params: {
              type: "object",
              additionalProperties: true,
              description:
                "Answers to the template's declared params (only with templateId). Each playbook declares its own: synap_list_playbooks / synap_match_playbooks return the declaration, including which are `required`, their `type` and any `options`. A required one you leave out is NOT an error here — it lands as a deliverable OWED BY THE PERSON on the session, so the question is visible and ages rather than being silently answered with an empty string. A value of the wrong type IS refused.",
            },
            criteria: SESSION_CRITERIA_PROPERTY,
            parentSessionId: {
              type: "string",
              format: "uuid",
              description:
                "Optional UUID of this session's PARENT — this session is a child: a detour (something blocked the parent's work and this clears it) or a planned sub-session of a larger piece of work. Records `session --spawned_from--> session`; the parent stays OPEN and lists its children (closing a child never closes the parent, and the parent never auto-closes). Must be a session you own; if it cannot be linked, the result's `parentLink` says why. The child does NOT inherit the parent's governance settings.",
            },
            blockedBySessionIds: {
              type: "array",
              items: { type: "string", format: "uuid" },
              maxItems: 20,
              description:
                "Optional UUIDs of sessions this one WAITS ON — each becomes a `session --blocked_by--> session` edge (blocked-ness is derived: it clears when the blocker closes). Every id must be a session you own. Reported per id on the result's `blockerLinks` (linked | proposed | failed with a reason).",
            },
            suspendedIntent: {
              type: "string",
              maxLength: 400,
              description:
                "ONE line naming what you were about to do in the PARENT session when you pushed — recorded on the parent so popping back restates the goal instead of relying on memory. Only meaningful with parentSessionId.",
            },
            expectedOutputs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string" },
                  label: { type: "string" },
                  icon: { type: "string" },
                  // `status` and the other receipts (attestedBy, retiredAt,
                  // satisfiedByProposalId, delegatedTo, owedSince…) are NOT
                  // advertised, on purpose: a field a model is told about is a
                  // field it will try to send, and each of these is stamped by
                  // exactly one server door. The wire still ACCEPTS them so a
                  // caller echoing a stored slot back does not lose them at the
                  // parse; CHANGING one is refused (`mergeExpectedOutputs`).
                  owner: {
                    type: "string",
                    enum: ["human", "agent"],
                    description:
                      "WHO this deliverable is waiting on. Omit (= 'agent') for anything you can do yourself. Set 'human' to declare work you CANNOT take — the slot stays pending and the board shows the person what is waiting on them.",
                  },
                  blockedReason: {
                    type: "string",
                    enum: [
                      "credential",
                      "permission",
                      "capability",
                      "policy",
                      "decision",
                      "physical",
                    ],
                    description:
                      "Only with owner='human'. WHY you could not take it, as the class of thing that would unblock you: 'credential' a secret to mint or store; 'permission' a governance rule to write; 'capability' a tool that does not exist; 'policy' a rule to change or accept; 'decision' a choice only a person can make; 'physical' an action in the world. Pick the one that names what someone would BUILD or DO to remove the block.",
                  },
                  why: {
                    type: "string",
                    maxLength: 500,
                    description:
                      "Only with owner='human'. ONE line naming WHICH thing is missing, not its class — 'the Stripe restricted key for the live account', not 'a credential'. This is what the person reads to know what to do.",
                  },
                  ref: {
                    description:
                      'WHERE to go for this deliverable — turns the card\'s title into a door instead of leaving the person to search. ONE of two shapes: {"kind":"entity|document|view|cell|automation|playbook","id":"<uuid>"} for something in the pod, or {"url":"https://..."} for an external page. REFUSED if the object is not one you can already see. Use it above all with owner=\'human\': name the blocker in `why`, then point at it here.',
                    oneOf: [
                      {
                        type: "object",
                        properties: {
                          kind: {
                            type: "string",
                            enum: [...OUTPUT_REF_KINDS],
                          },
                          id: { type: "string" },
                        },
                        required: ["kind", "id"],
                        additionalProperties: false,
                      },
                      {
                        type: "object",
                        properties: {
                          url: { type: "string", format: "uri" },
                        },
                        required: ["url"],
                        additionalProperties: false,
                      },
                    ],
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
          "Update an in-flight focus session WHILE working: title (the name), goal, status (active|paused), progress, subject (`subjectEntityId` re-points what the work is ABOUT, null clears), deliverables (`addOutput` appends, `completeOutput` marks done by label), roster (`addAgentId` appends one agent, idempotently), and the playbook it FOLLOWS (`followPlaybookId` makes this session a run of that playbook and merges in its criteria + deliverables; null releases it). Cannot close — use synap_complete_session for that.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The focus session UUID to update.",
            },
            title: {
              type: ["string", "null"],
              maxLength: 200,
              description:
                "Rename the session — its short one-line NAME (optional). Pass null to clear it (lists then show the goal's first line).",
            },
            goal: {
              type: "string",
              description: "New one-line goal — the outcome (optional).",
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
            criteria: {
              ...SESSION_CRITERIA_PROPERTY,
              description:
                "Replace the session's acceptance criteria wholesale (optional) — the full list, not a delta.",
            },
            currentStage: {
              type: "string",
              description:
                "Advance the session to this playbook stage by its stage `key` (optional). Only meaningful for staged playbooks. Changing it emits a stage-transition event automations can react to.",
            },
            subjectEntityId: {
              type: ["string", "null"],
              description:
                "Re-point WHAT this session is about — the entity UUID of the person/company/deal the work concerns. Pass null to CLEAR it; omit to leave it alone. REFUSED if the entity is not one you can already see (the same floor an output ref goes through).",
            },
            expectedOutputs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string" },
                  label: { type: "string" },
                  icon: { type: "string" },
                  // `status` and the other receipts (attestedBy, retiredAt,
                  // satisfiedByProposalId, delegatedTo, owedSince…) are NOT
                  // advertised, on purpose: a field a model is told about is a
                  // field it will try to send, and each of these is stamped by
                  // exactly one server door. The wire still ACCEPTS them so a
                  // caller echoing a stored slot back does not lose them at the
                  // parse; CHANGING one is refused (`mergeExpectedOutputs`).
                  owner: {
                    type: "string",
                    enum: ["human", "agent"],
                    description:
                      "WHO this deliverable is waiting on. Omit (= 'agent') for anything you can do yourself. Set 'human' to declare work you CANNOT take — the slot stays pending and the board shows the person what is waiting on them.",
                  },
                  blockedReason: {
                    type: "string",
                    enum: [
                      "credential",
                      "permission",
                      "capability",
                      "policy",
                      "decision",
                      "physical",
                    ],
                    description:
                      "Only with owner='human'. WHY you could not take it, as the class of thing that would unblock you: 'credential' a secret to mint or store; 'permission' a governance rule to write; 'capability' a tool that does not exist; 'policy' a rule to change or accept; 'decision' a choice only a person can make; 'physical' an action in the world. Pick the one that names what someone would BUILD or DO to remove the block.",
                  },
                  why: {
                    type: "string",
                    maxLength: 500,
                    description:
                      "Only with owner='human'. ONE line naming WHICH thing is missing, not its class — 'the Stripe restricted key for the live account', not 'a credential'. This is what the person reads to know what to do.",
                  },
                  ref: {
                    description:
                      'WHERE to go for this deliverable — turns the card\'s title into a door instead of leaving the person to search. ONE of two shapes: {"kind":"entity|document|view|cell|automation|playbook","id":"<uuid>"} for something in the pod, or {"url":"https://..."} for an external page. REFUSED if the object is not one you can already see. Use it above all with owner=\'human\': name the blocker in `why`, then point at it here.',
                    oneOf: [
                      {
                        type: "object",
                        properties: {
                          kind: {
                            type: "string",
                            enum: [...OUTPUT_REF_KINDS],
                          },
                          id: { type: "string" },
                        },
                        required: ["kind", "id"],
                        additionalProperties: false,
                      },
                      {
                        type: "object",
                        properties: {
                          url: { type: "string", format: "uri" },
                        },
                        required: ["url"],
                        additionalProperties: false,
                      },
                    ],
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
                owner: {
                  type: "string",
                  enum: ["human", "agent"],
                  description:
                    "WHO this deliverable is waiting on. Omit (= 'agent') for anything you can do yourself. Set 'human' to declare work you CANNOT take.",
                },
                blockedReason: {
                  type: "string",
                  enum: [
                    "credential",
                    "permission",
                    "capability",
                    "policy",
                    "decision",
                    "physical",
                  ],
                  description:
                    "Only with owner='human'. The class of thing that would unblock you: 'credential' a secret to mint or store; 'permission' a governance rule to write; 'capability' a tool that does not exist; 'policy' a rule to change or accept; 'decision' a choice only a person can make; 'physical' an action in the world.",
                },
                why: {
                  type: "string",
                  maxLength: 500,
                  description:
                    "Only with owner='human'. ONE line naming WHICH thing is missing, not its class.",
                },
                ref: {
                  description:
                    'WHERE to go for this deliverable — turns the card\'s title into a door instead of leaving the person to search. ONE of two shapes: {"kind":"entity|document|view|cell|automation|playbook","id":"<uuid>"} for something in the pod, or {"url":"https://..."} for an external page. REFUSED if the object is not one you can already see. Use it above all with owner=\'human\': name the blocker in `why`, then point at it here.',
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        kind: {
                          type: "string",
                          enum: [...OUTPUT_REF_KINDS],
                        },
                        id: { type: "string" },
                      },
                      required: ["kind", "id"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        url: { type: "string", format: "uri" },
                      },
                      required: ["url"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              required: ["kind", "label"],
              description:
                "Append ONE new deliverable (stored with status 'pending'). This is also how you HAND WORK BACK: set owner='human' with a blockedReason and a one-line why to put a named, classified blocker on the board instead of stalling silently.",
            },
            completeOutput: {
              type: "string",
              description:
                "Mark the deliverable with this exact label as 'done'. REFUSED for a slot you declared owner='human' — you cannot close work you handed back. The reply always carries `completeOutput.result`: 'completed' (marked done), 'refused' (human-owned; nothing changed, do NOT report the work as delivered), or 'no_match' (no deliverable has that exact label; nothing changed). A 'refused' or 'no_match' still comes back as a successful update because the rest of the patch landed — read the field, not just the session.",
            },
            addAgentId: {
              type: "string",
              description:
                "APPEND one agent user id to the session roster (optional). Idempotent — re-attaching an agent already on the session writes nothing. Use this to staff a session already in flight; the roster is otherwise only settable when the session is created.",
            },
            followPlaybookId: {
              type: ["string", "null"],
              description:
                "FOLLOW a playbook with this live session (optional) — the session BECOMES A RUN of it: it appears in that playbook's runs and leaves the plain work list. Its acceptance criteria and deliverables MERGE in (nothing you already have is overwritten or deleted); its title, goal and origin are left alone. Pass null to RELEASE the playbook — the merged criteria and deliverables STAY, and a release is refused while a stage gate is waiting. Find a playbook with synap_list_playbooks / synap_match_playbooks. The reply carries `follow` with what happened.",
            },
            params: {
              type: "object",
              additionalProperties: true,
              description:
                "Only with followPlaybookId: answers to the playbook's declared params. They are stored on the session (so a re-run can reuse them) and merged over any it already carries. A required one you leave out lands as a deliverable OWED BY THE PERSON, never a silent blank; a value of the wrong type is refused.",
            },
            followStageKey: {
              type: ["string", "null"],
              description:
                "Only with followPlaybookId: which stage this work is ALREADY in, by the stage `key` (optional). OMIT IT unless you know — the session then sits in no stage, which is honest; it is never guessed and never set to the first stage. A key the playbook does not declare is refused, with the valid keys listed.",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "synap_evaluate_session",
        annotations: {
          title: "Evaluate focus session",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          "Grade a focus session against its acceptance criteria. Post deterministic evidence for evidence-checked criteria as `evidence: { <evidenceKey>: { passed, detail? } }`; capability and judge checks run automatically (the judge is never the model that did the work). Returns each criterion's result, the current evaluations and the session verdict. At most 2 automatic attempts per criterion — after that a failing required criterion is handed to the human. Never blocks closing the session.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The focus session UUID.",
            },
            evidence: {
              type: "object",
              description:
                'Evidence keyed by each criterion\'s evidenceKey (e.g. { typecheck: { passed: true, detail: "0 errors" } }).',
              additionalProperties: {
                type: "object",
                properties: {
                  passed: { type: "boolean" },
                  detail: { type: "string", maxLength: 2000 },
                },
                required: ["passed"],
              },
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
          "End a focus session — the ONE door for every lifecycle exit. `terminalStatus` says HOW it ended: 'closed' (the work finished, default), 'cancelled' (abandoned — you stopped on purpose), 'failed' (you could not complete it). Say which honestly: a cancelled or failed session recorded as 'closed' tells the user work succeeded when it did not. 'cancelled' also STOPS the session's in-flight work where a real stop exists (queued jobs, a running agent reply) and returns `cancel`: { stopped[], notStoppable[] (already running — it will finish), finished[] (proposals that already applied) }. A cancel may come back status 'proposed' — that is NOT an error: it is queued for the user's review and nothing is stopped until they approve. Also closes any running playbook_run. Returns a **review pack**: pendingProposals[], counts, and warnings (e.g. unfinished expectedOutputs — warn only). Use synap_list_proposals({sessionId}) to re-fetch the pack.",
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
            terminalStatus: {
              type: "string",
              enum: [...TERMINAL_SESSION_STATUSES],
              description:
                "How the session ended. 'closed' (default) = the work finished. 'cancelled' = abandoned on purpose. 'failed' = attempted and could not be completed. All three run the SAME close (review pack, playbook_run close, ephemeral expiry, close event) — only the recorded outcome differs.",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "synap_revert_session",
        annotations: {
          title: "Ask the user to revert a session",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "Reverting takes back work that was already approved, so it is a HUMAN decision: this tool NEVER reverts anything. Call it when a session (a run), some of its proposals, or one item of a proposal should be undone. It answers status 'refused' — that is the contract, NOT an error — with the session's revertable proposals and a link to each: hand those to the user. The user reverts from the session room or the proposal — everything, only some proposals, or one item; items edited since are skipped with the reason.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The focus session (run) UUID.",
            },
            proposalIds: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional: only these proposals of the session should be undone.",
            },
            proposalId: {
              type: "string",
              description:
                "Optional: one proposal of the session — with opKey, one item of it.",
            },
            opKey: {
              type: "string",
              description:
                "Optional: one item of proposalId — its key in the proposal's materialized record (an op ref, or `<sourceRef>-><targetRef>:<type>` for a link).",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "synap_rerun_session",
        annotations: {
          title: "Rerun a session",
          readOnlyHint: false,
          // `replace` reverts the previous run's approved work first.
          destructiveHint: true,
          openWorldHint: false,
        },
        description:
          "Re-analyse a finished session (a run) from its STORED sources with the CURRENT guidelines, as a NEW session spawned from it. ALWAYS call with dryRun:true first: it returns the counts (sources, what would be reverted, pending proposals left alone, estimated structure calls) and whether it is within the cap — nothing is written. mode 'add' re-analyses on top of the previous run; mode 'replace' reverts the previous run first and is a HUMAN decision (an agent gets `ok:false, reason:'replace_is_a_human_decision'` — hand the user the session room). Each re-analysed source files its writes through the governed capture/import doors, so an item outcome 'proposed' is normal, NOT an error. A still-open session is refused (cancel it first); refusals come back as { ok:false, reason, message }.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The finished focus session (run) UUID to rerun.",
            },
            mode: {
              type: "string",
              enum: ["add", "replace"],
              description:
                "'add' = re-analyse on top of the previous run. 'replace' = revert the previous run first (human only).",
            },
            dryRun: {
              type: "boolean",
              description:
                "true = counts + cap verdict only, nothing written. Do this first.",
            },
            sourceDocumentIds: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional: rerun only these stored sources of the session (the ids in its run manifest).",
            },
            reasoning: {
              type: "string",
              description:
                "Why you are rerunning (e.g. which guideline changed) — recorded on the new session's run manifest for the reviewer.",
            },
          },
          required: ["sessionId", "mode"],
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
          "Re-find a focus session — read-only. To CONTINUE a session, read `continuation` first: it is the continuation packet (userMustDecide = owed slots + pending proposals, aiCanDo = open agent deliverables, blockers, outputs, run manifest, rerun, lastCompletion, nextMove). A section with status 'unavailable' failed to load — it is NOT empty. Pass sessionId for a specific session. Omit sessionId only when you have exactly one open session (ambient). If multiple sessions are open, returns multiSession:true + openSessions[] — pass sessionId explicitly (ambient attach is disabled to prevent mis-attribution). Always yours: sessions are scoped to the calling user.",
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
            playbookId: {
              type: "string",
              description:
                "Optional: only runs of this playbook DEFINITION. Pair with kind 'run' or 'all' — flow-linked rows are runs, so under the default nothing would match.",
            },
            automationId: {
              type: "string",
              description:
                "Optional: only runs of this automation DEFINITION (not one automationRunId). Same pairing as playbookId.",
            },
            kind: {
              type: "string",
              // DERIVED from the ONE vocabulary, never hand-mirrored: a new
              // population reaches this tool schema instead of being silently
              // unaskable. "all" is a filter sentinel, not a kind.
              enum: [...SESSION_KINDS, "all"],
              description:
                "Which population. 'work' = units of work a person owns. 'run' = a playbook or automation execution. 'receipt' = the container an agent's proposals were filed under. 'all' (default) = no filter. Every row carries its own `kind` either way.",
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
          'Define (create or update) a ViewFrame cell from raw renderer source — idempotent upsert on typeKey (from `name`) + workspace (omit workspaceId for pod-global). An agent call ALWAYS lands as a proposal: status="proposed" is SUCCESS — say it is awaiting review, pass on reviewUrl, do not retry. Creates the definition ONLY: the cell is not surfaced anywhere until it is bound as a renderer for a kind, which is a separate step — ask the user to do it in the Synap app.',
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
            contentKind: {
              type: "string",
              enum: [
                "entity-detail",
                "entity-card",
                "entity-profile",
                "collection",
                "widget",
              ],
              description:
                "Optional renderer SLOT — WHAT this cell renders. 'entity-detail' = one entity's full page, 'entity-card' = one entity's small block, 'entity-profile' = a whole profile's dashboard, 'collection' = a view of many entities, 'widget' (the default) = generic and placeable only. A cell left at 'widget' is never offered when assigning a renderer to a profile, so declare the slot you actually want.",
            },
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
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
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
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
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
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
          "List playbooks (reusable process/session templates) visible to you across the pod — every member workspace plus pod-wide templates. Call this to discover what already exists BEFORE improvising a new process. Optional workspaceId only narrows (still includes pod-wide). Launch one via synap_run_playbook.",
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
          "Suggest playbooks for what the user wants — text-first, suggest-and-confirm, NEVER auto-run the top hit. Pass intentText (what they said — that exact spelling) and/or profileSlug (the kind of thing, e.g. 'post') and/or entityId. At least ONE is required: a call with no signal is REFUSED (without one, every active playbook ties at the same score; to just see what exists, call synap_list_playbooks). Read-only. Returns ranked candidates best first ({ id, name, goalTemplate, subjectProfileSlug, params, executor, score, reason, signals }); [] when none. Show the reason when you suggest; wait for confirmation before launching via synap_run_playbook (or, on doors that expose sessions, by opening the template as a working session with the chosen entity as its subject). When profileSlug is omitted, every active visible playbook is a candidate (ranked by intentText). When present, kind/facet matches AND playbooks with no subject (e.g. Plan Next Content) stay in the pool.",
        inputSchema: {
          type: "object",
          properties: {
            profileSlug: {
              type: "string",
              description:
                "Optional entity profile slug to match against (e.g. 'post', 'deal', 'lead', 'competitor'). Omit to search all active visible playbooks by intentText alone.",
            },
            entityId: {
              type: "string",
              description:
                "Optional UUID of the specific entity — round-trip it as the launch's subject once a playbook is chosen. Widens the match with that entity's live facet-role slugs.",
            },
            workspaceId: {
              type: "string",
              description:
                "Workspace ID to scope the lookup (optional — falls back to the user's first workspace). Pod-wide playbooks match regardless.",
            },
            intentText: {
              type: "string",
              description:
                "What the user said they want. Sufficient on its own — ranks the candidates (never filters) and each result carries `score` and a human-readable `reason`. Show the reason when you suggest a playbook; never run one without the user's confirmation.",
            },
          },
          required: [],
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
          'Create a reusable playbook (staged process/session template) for a repeatable workflow — discoverable via synap_list_playbooks, launched via synap_run_playbook. goalTemplate may contain {{param}} placeholders. An agent call ALWAYS lands as a proposal: status="proposed" is SUCCESS — say it is awaiting review, pass on reviewUrl, do not retry.',
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
                "Ordered stages. Each: { key, name, category, description?, goal?, suggestedTasks?, position?, indefinite? }. `category` is REQUIRED — it is the closed rollup axis a cross-playbook board groups on, since your stage `key`s are this playbook's own vocabulary and no other playbook shares them. Stage keys must be unique within the playbook.",
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  name: { type: "string" },
                  category: {
                    type: "string",
                    enum: [
                      "backlog",
                      "planned",
                      "started",
                      "paused",
                      "completed",
                      "canceled",
                    ],
                    description:
                      "Which rollup bucket this stage belongs to: backlog (not committed) · planned (committed, not begun) · started (work under way) · paused (on hold) · completed (terminal, succeeded) · canceled (terminal, abandoned).",
                  },
                  description: { type: "string" },
                  goal: { type: "string" },
                  suggestedTasks: {
                    type: "array",
                    items: { type: "string" },
                  },
                  position: {
                    type: "number",
                    description:
                      "Order WITHIN this stage's category group — not a global order.",
                  },
                  indefinite: {
                    type: "boolean",
                    description:
                      "True if a subject may sit here indefinitely; otherwise a long dwell is worth surfacing.",
                  },
                },
                required: ["key", "name", "category"],
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
          "Read workspace governance policy and count of pending proposals. Use before writes to understand auto-approve rules and whether proposals will be created. When called with an agent key it also returns `agentBudget`: YOUR pending-proposal cap, how many of it you are using, whether you are BLOCKED (at the cap your writes are refused — nothing is written), and the remedy, including the link to a cap-raise request already waiting for your owner's review. Read-only: it never files anything.",
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

      {
        name: "synap_set_project_focus",
        annotations: {
          title: "Set project focus",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "DECLARE which project you are working on, so writes that don't pin their own project file into it — the 'everything I do now is for the Apollo migration' scenario. Sticky across calls until cleared. A call that passes an explicit projectId still wins. Filing into a project GRANTS ACCESS to it, so this is a DECLARATION only: the project is verified to exist and be visible to you at set time, and nothing infers a project from what you write. Pass `project` as a name (matched against the projects you can see) or an id; omit it (or pass 'none'/'clear') to clear the focus.",
        inputSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description:
                "Project name or id to declare. Omit, or pass 'none'/'clear', to clear the current focus.",
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
          "• + `projects[]` / `sessions[]` / `documents[]` / `links[]` → a CONNECTED PLAN: build a project, its sessions (parent = `parentRef`, dependencies = `blockedByRefs`, or edges in `links[]`), a spec document and the entities they are about — ONE reviewable proposal, refs across all of it, applied ALL-OR-NONE on approval. Reference plan items by REF; ids exist only after approval (the receipt lists each step with `id: null`; once applied, `synap_list_proposals` shows `materializedIds` ref → id). To change the plan, revise it (full updated operations, re-validated by the pod) — never file a second proposal that points at pending items.\n" +
          "COUNT BEFORE YOU FILE: if you are about to make a SECOND `synap_create_*` call for objects that reference each other (a kind and the playbook using it, a project and its sessions, a skill and the automation calling it), they belong in ONE call here. N connected objects as N proposals exhausts your pending-proposal cap, and re-sending a capped write through another door is how the same playbook lands in the pod twice. Give each `sessions[]` step its `expectedOutputs` — the plan's object list IS the definition of done, so the person can see what is still owed instead of being told a percentage.\n" +
          'PLAN EXAMPLE — a project, a root session with two children (one blocked by the other), a spec document:\n{ "entities": [ { "ref": "acme", "profileSlug": "company", "title": "Acme Corp", "properties": { "website": "https://acme.com" } } ], "projects": [ { "ref": "p1", "name": "Acme onboarding", "subjectRef": "acme", "evidenceRefs": ["acme"] } ], "sessions": [ { "ref": "s0", "title": "Onboard Acme", "goal": "Acme is live on the platform", "projectRef": "p1", "subjectRef": "acme" }, { "ref": "s1", "title": "Write the spec", "goal": "Spec signed off by Acme", "parentRef": "s0", "projectRef": "p1" }, { "ref": "s2", "title": "Build the import", "goal": "Acme data imported", "parentRef": "s0", "projectRef": "p1", "blockedByRefs": ["s1"] } ], "documents": [ { "ref": "spec", "title": "Acme onboarding spec", "content": "# Spec\\n…", "sessionRef": "s1" } ] }\n' +
          "Call it AFTER learning something durable — don't wait to be asked. Placement uses EXISTING lenses only; capture never invents a workspace. `global:true` stores a pod-wide runbook (text only).\n" +
          "DEDUP: the strong identity signals are the property keys `email`, `phone`, `website`, `linkedinUrl`, `twitterHandle`, `githubUsername` — those exact spellings. Sending a URL under any other key (e.g. `url`) is NOT a dedup signal and will duplicate the entity.\n" +
          "\n" +
          'EXAMPLE 1 — raw text:\n{ "text": "Met Ada Lovelace of Acme at the conference — she owns their data platform and wants a demo in March." }\n' +
          "\n" +
          'EXAMPLE 2 — one structured entity, with properties + a long body:\n{ "entities": [ { "profileSlug": "person", "title": "Ada Lovelace", "properties": { "email": "ada@acme.com", "role": "Head of Data" }, "content": "## Notes\\nOwns the data platform. Wants a March demo." } ] }\n' +
          "\n" +
          'EXAMPLE 3 — a small graph (refs link entities that do not exist yet):\n{ "entities": [ { "ref": "p1", "profileSlug": "person", "title": "Ada Lovelace", "properties": { "email": "ada@acme.com" } }, { "ref": "c1", "profileSlug": "company", "title": "Acme Corp", "properties": { "website": "https://acme.com" } } ], "relations": [ { "sourceRef": "p1", "targetRef": "c1", "type": "works_at" } ] }\n' +
          "\n" +
          'ALWAYS returns the same receipt: { status, scope: { workspaceId, projectId, sessionId }, writeReceipt }. `status: "proposed"` is SUCCESS, not an error — writeReceipt.reviewUrl is a real clickable link and you MUST surface it as a markdown link in your reply, e.g. "Queued that for your review: [Review proposal](<reviewUrl>)" — never report a proposed write as simply done, and never withhold the link.\n`status: "partial"` means the entities landed but at least one `relations[]` edge did NOT — the failed edges are named in `relationsFailed[]` with a reason. Do not report a partial capture as done: say which edges did not land. The usual cause is a `type` that names no relation def — re-send those edges with a real slug. The default slugs resolve pod-wide: a capture needs no `workspaceId` for its edges to land.\n' +
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
                      "UUID of an entity that already exists. On its own this LINKS — the entity is attached and its fields are left untouched, so the properties you extracted are DISCARDED. Pair it with `updateExisting: true` to write them instead.",
                  },
                  updateExisting: {
                    type: "boolean",
                    description:
                      "NOT SUPPORTED ON THIS LANE — sending it here is REFUSED, by design, rather than accepted and dropped. The structured `entities[]` lane materializes through a composite graph whose operations can only create or LINK, never patch, so honouring this flag is impossible here and silently ignoring it would discard the properties you sent while reporting success. To PATCH an entity you recognise: send the same information as `text` (that lane routes to the update-capable door and will patch a confident identity match that carries new facts), or call `synap_update_entity` with the entityId and the fields to change. Note `existingEntityId` ALONE still links — the target keeps its existing fields and your extracted properties are dropped.",
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
                    // NOT a free string, despite what this description said
                    // until 2026-09-07: every edge is created through
                    // `relations.create`, which rejects any slug that is not a
                    // relation_def of the effective workspace or of the
                    // pod-wide base layer. The old examples
                    // 'related_to' and 'contact_for' are not defs anywhere —
                    // a model that followed this schema got its edges dropped
                    // into `relationsFailed[]`. Only real slugs may be named
                    // here; the tripwire in
                    // `__tripwires__/relation-types-in-tool-schemas.test.ts`
                    // holds every one of them to DEFAULT_RELATION_DEFS.
                    description:
                      "Relation type — an existing relation-def slug, e.g. 'works_at', 'relates_to', 'references', 'mentions', 'parent_of', 'depends_on'. The default slugs resolve pod-wide (no `workspaceId` needed); a workspace may add or override slugs. A type that names no def fails ALONE: that edge comes back in `relationsFailed[]` with the graph's status set to `partial`.",
                  },
                },
                required: ["sourceRef", "targetRef", "type"],
              },
            },
            projects: {
              type: "array",
              description:
                "PLAN: projects to create. `ref` is how sessions/entities point at it (`projectRef`). An agent-proposed project needs ≥5 evidence entities (`evidenceRefs` of entities in this call + `evidenceEntityIds` you can see); below that the step is still filed, MARKED for the reviewer, and never auto-applies.",
              items: {
                type: "object",
                properties: {
                  ref: { type: "string" },
                  name: { type: "string" },
                  description: { type: "string" },
                  subjectRef: {
                    type: "string",
                    description:
                      "Ref of the entity in this call the project is about.",
                  },
                  subjectEntityId: { type: "string" },
                  evidenceRefs: { type: "array", items: { type: "string" } },
                  evidenceEntityIds: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["ref", "name"],
              },
            },
            sessions: {
              type: "array",
              description:
                "PLAN: focus sessions to open. Each `…Ref` names a step in this call; its `…Id` twin names something that already exists (never both). Parent = the spawned_from edge (a parent never auto-closes).",
              items: {
                type: "object",
                properties: {
                  ref: { type: "string" },
                  title: {
                    type: "string",
                    description: "Short one-line name (≤200 chars).",
                  },
                  goal: {
                    type: "string",
                    description: "The outcome (≤2000 chars). REQUIRED.",
                  },
                  parentRef: { type: "string" },
                  parentSessionId: { type: "string" },
                  blockedByRefs: { type: "array", items: { type: "string" } },
                  blockedBySessionIds: {
                    type: "array",
                    items: { type: "string" },
                  },
                  subjectRef: { type: "string" },
                  subjectEntityId: { type: "string" },
                  projectRef: { type: "string" },
                  projectId: { type: "string" },
                  expectedOutputs: {
                    type: "array",
                    description:
                      "What this session will PRODUCE — `{ kind, label }` per deliverable (`owner: 'human'` for one you cannot take). Declare them: the plan's own object list is the definition of done, so progress is derivable from unfilled slots rather than self-graded. Acceptance `criteria` are NOT carried by a plan step — set them on the session afterwards with synap_update_session.",
                    items: { type: "object" },
                  },
                },
                required: ["ref", "goal"],
              },
            },
            documents: {
              type: "array",
              description:
                "PLAN: documents to create (markdown). Attach one as an entity's body (`entityRef`/`entityId`) and/or record it as a session's output (`sessionRef`/`sessionId`).",
              items: {
                type: "object",
                properties: {
                  ref: { type: "string" },
                  title: { type: "string" },
                  content: { type: "string" },
                  entityRef: { type: "string" },
                  entityId: { type: "string" },
                  sessionRef: { type: "string" },
                  sessionId: { type: "string" },
                  expectedLabel: {
                    type: "string",
                    description:
                      "The declared output slot of that session this document fulfils (as synap_create_document).",
                  },
                },
                required: ["ref", "title", "content"],
              },
            },
            links: {
              type: "array",
              description:
                "PLAN: session edges. `blocked_by`: from waits on to. `spawned_from`: to is from's parent (from must be a session in this call). Cycles are refused.",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["blocked_by", "spawned_from"],
                  },
                  fromRef: { type: "string" },
                  fromSessionId: { type: "string" },
                  toRef: { type: "string" },
                  toSessionId: { type: "string" },
                },
                required: ["type"],
              },
            },
            skills: {
              type: "array",
              description:
                "RULE LOOP: instruction skills to create — the FACT half, what an agent should KNOW while reasoning. `ref` is how a `rules[]` step points at it (`factRef`). This is an instruction, NOT a capability/verb: it does not install a tool.",
              items: {
                type: "object",
                properties: {
                  ref: { type: "string" },
                  name: { type: "string" },
                  body: {
                    type: "string",
                    description: "The instruction itself, markdown. REQUIRED.",
                  },
                  scope: {
                    type: "string",
                    enum: ["pod", "user", "workspace"],
                  },
                  agentTypes: {
                    type: "array",
                    items: { type: "string" },
                    description: "Omit or null to apply to every agent type.",
                  },
                },
                required: ["ref", "name", "body", "scope"],
              },
            },
            automations: {
              type: "array",
              description:
                "RULE LOOP: automations to create — the BEHAVIOUR half, what RUNS when the world changes. `ref` is how a `rules[]` step points at it (`behaviourRefs`). ALWAYS materialized DISABLED (draft): approving the proposal creates it, it never arrives already running — switch it on yourself afterwards. A flow node may name a skill THIS SAME call creates: skills are applied before automations, so the reference resolves.",
              items: {
                type: "object",
                properties: {
                  ref: { type: "string" },
                  name: { type: "string" },
                  description: { type: "string" },
                  triggerType: {
                    type: "string",
                    enum: ["event", "cron", "webhook", "manual"],
                  },
                  flowDefinition: {
                    type: "object",
                    description:
                      "`{ nodes: [], edges: [] }` — validated in full (node contracts, unknown verbs, dangling edges, cycles) by the automation door. Put the trigger config on `flowDefinition.triggerConfig`; an event automation without one cannot match.",
                  },
                },
                required: ["ref", "name", "triggerType", "flowDefinition"],
              },
            },
            rules: {
              type: "array",
              description:
                "RULE LOOP: the memory that joins a FACT to a BEHAVIOUR. Needs `factRef` and/or `behaviourRefs` — each names a `skills[]` / `automations[]` step in this call, or a real UUID that already exists. A rule joined to nothing is refused.",
              items: {
                type: "object",
                properties: {
                  ref: { type: "string" },
                  intent: {
                    type: "string",
                    description: "The rule in the user's own words. REQUIRED.",
                  },
                  scope: {
                    type: "object",
                    properties: {
                      kind: {
                        type: "string",
                        enum: ["pod", "workspace", "user"],
                      },
                      workspaceId: { type: "string" },
                    },
                    required: ["kind"],
                  },
                  factRef: { type: "string" },
                  behaviourRefs: { type: "array", items: { type: "string" } },
                },
                required: ["ref", "intent", "scope"],
              },
            },
            summary: {
              type: "string",
              description:
                "One line the reviewer sees on the proposal card (structured payloads). Auto-generated when omitted — write your own, it is what the user reads.",
            },
            validate: {
              type: "boolean",
              description:
                'Dry run for the structured `entities[]` lane: run the capture\'s validators and write NOTHING. Returns `dryRun: true` and `status: "valid"` or `"invalid"`, with every problem at once: ref and shape problems in `problems[]`, unknown relation slugs in `relationsFailed[]` (same shape as a real call, with the valid slugs named), and unknown profiles or invalid properties in `invalidEntities[]`. `notChecked[]` lists what only the real write can decide. Not supported on the `text` lane.',
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
            workspaceId: {
              type: "string",
              description:
                "Explicit workspace pin (rung-1 placement) — wins over ontology/session/relational routing and the AI's workspace guess. Pass this when you already know exactly which workspace the capture belongs in, and to ACT on a previous call's `pendingWorkspaceSwitch` (the AI's suggestion is never applied on its own — a pin that differs from it is recorded as the suggestion being corrected). Leave it out to let the resolver place it (see `workspaceRouting`).",
            },
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
                "How much latitude the backend resolver has over the AI's workspace GUESS (rung 5) specifically — it does NOT gate the deterministic rungs above it (ontology role-routing, focus-session context, relational gravity), which still run and place the capture regardless of this setting. An AI guess NEVER moves a capture through this door, in any mode: 'auto' and 'ask' now do the SAME thing — the capture stays where it would have landed and the guess comes back as `pendingWorkspaceSwitch` ({ suggestedWorkspaceId, suggestedWorkspaceName, reason, confidence }) for you to confirm with the user; there is no `movedToWorkspace` on the response any more. To ACT on a suggestion, re-call synap_capture with `workspaceId` set to `pendingWorkspaceSwitch.suggestedWorkspaceId` (that pin is recorded as the user accepting it). 'locked' = suppress the AI guess entirely, so no suggestion is returned; it does NOT freeze the capture onto the caller's/session workspace by itself. To pin an EXACT workspace and skip resolution altogether (deterministic rungs included), pass an explicit `workspaceId` (rung-1 placement) instead of relying on this setting.",
            },
            sessionId: {
              type: "string",
              description:
                "OPTIONAL focus-session override. Leave it out and the write is attributed automatically — you do NOT normally pass this. Send it ONLY to disambiguate: when two or more of your focus sessions are open, automatic attribution deliberately declines rather than guess (mis-grouping a write is worse than not grouping it), and this is the only way to say which session the write belongs to. A session that isn't yours is ignored, not an error.",
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
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
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
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
            },
          },
          required: ["workspaceId"],
        },
      },
      {
        name: "synap_list_workspaces",
        annotations: {
          title: "List workspaces",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "List the workspaces (domain lenses) you can see, pod-wide — call this to find a workspace id instead of guessing from orient. Each row: id, name, description, workspaceType, your role, accessKind (member | pod_visible), archived, entityCount, and usedByProjectIds (projects that run through it — an INDEX, not an ACL). Link a project to one with synap_project_use_workspace.",
        inputSchema: {
          type: "object",
          properties: {
            includeArchived: {
              type: "boolean",
              default: false,
              description: "Include soft-archived workspaces (default false)",
            },
            appId: {
              type: "string",
              description: "Optional filter by settings.appId",
            },
          },
          required: [],
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
          'Create a project — a cross-cutting lens for an initiative/venture that organizes entities across workspaces (a workspace is a domain lens; a project cuts across them). workspaceId = its HOME workspace (optional). A PROJECT IS A COMMITMENT WITH GRAVITY: never create one per git-repo, per-feature, or per-task — those are entities (task/plan/note). You MUST pass evidenceEntityIds: at least 5 existing entity ids that would belong to this project, or the create is rejected. If a same/similar project already exists it is reused (or surfaced) — reuse it instead of making a near-duplicate. An agent call lands as a proposal unless governance has widened it: status="proposed" is SUCCESS — say it is awaiting review, do not retry.',
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
        name: "synap_list_projects",
        annotations: {
          title: "List projects",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "List the projects (cross-cutting initiatives) you can see, pod-wide, newest first — call this to find a project id before reading, updating or linking it. Each row: id, name, description, status, phase, phaseCategory, targetDate, homeWorkspaceId, usedWorkspaceIds (domains it runs through) and its subject. Paginated: { items, pagination: { hasMore, limit, offset } }. Full read: synap_get_project.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["active", "archived", "completed"],
              description: "Optional filter by project status",
            },
            limit: {
              type: "number",
              minimum: 1,
              maximum: 1000,
              default: 50,
              description: "Page size (1-1000, default 50)",
            },
            offset: {
              type: "number",
              minimum: 0,
              default: 0,
              description: "Offset for pagination (default 0)",
            },
          },
          required: [],
        },
      },
      {
        name: "synap_get_project",
        annotations: {
          title: "Get project",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "Read one project: name, description, home workspace, and usedWorkspaces (domains this engagement spans via the uses INDEX). Call after orient when you need the span map. Not an ACL.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string", description: "Project UUID" },
          },
          required: ["projectId"],
        },
      },
      {
        name: "synap_update_project",
        annotations: {
          title: "Update project",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Update a project: rename, re-describe, change status, move its phase, or set/clear its target date. Reuse this instead of creating a twin. Find the id with synap_list_projects. Governed: `proposed` is success — surface reviewUrl.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string", description: "Project UUID" },
            name: { type: "string" },
            description: { type: "string" },
            status: {
              type: "string",
              enum: ["active", "archived", "completed"],
            },
            phase: {
              type: ["string", "null"],
              description:
                "Lifecycle position (free text, ≤120 chars, e.g. 'wedge A' or a playbook stage key). null clears it; omit to leave it.",
            },
            targetDate: {
              type: ["string", "null"],
              description:
                "Deadline as an ISO-8601 date (e.g. '2026-12-15'). null clears it; omit to leave it.",
            },
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the reviewer. One line.",
            },
          },
          required: ["projectId"],
        },
      },
      {
        name: "synap_project_use_workspace",
        annotations: {
          title: "Project uses workspace",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Stamp the INDEX edge project --uses--> workspace: this engagement runs through that domain. NOT an ACL (does not grant workspace membership). packages/apply with projectId already stamps this; call this when the workspace already exists. Idempotent. Governed: may return proposed.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            workspaceId: { type: "string" },
            reasoning: {
              type: "string",
              description:
                "Why this project uses this domain, in the person's words. One line.",
            },
          },
          required: ["projectId", "workspaceId"],
        },
      },
      {
        name: "synap_export_project_pack",
        annotations: {
          title: "Export project as suite pack",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "Serialize a live project for marketplace: returns { definition: thin suite, constituents: full workspace packages[] }. Publish constituents first, then the suite (CLI --from-project does both). NOT live entity data. Empty uses-index → error. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
          },
          required: ["projectId"],
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
          "Create a view in a workspace (recovery when the right view is missing, or proactive once data warrants it). Call synap_list_views first — don't duplicate. For a bento, call synap_list_widgets first and only place keys from that list (stat-card needs profileSlug; view-table needs a saved viewId, not a profileSlug). Type: table, kanban, list, gallery, calendar, bento, masonry, flow, whiteboard. profileId scopes to one entity type. For a whiteboard, pass initialContent to seed the shapes — it is the ONLY way to put content on a board, because content cannot be updated after create. Governed: may propose. On success the result includes `link` (`${PUBLIC_URL}/open/<id>`) — surface that URL to the user.",
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
                "whiteboard",
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
            initialContent: {
              type: "object",
              description:
                'Whiteboard only — seeds the canvas: {version:1, category:"canvas", store:{<tldrawRecordId>: <tldrawRecord>}}. Shapes can ONLY be set here; there is no content-update door, so a board is seeded once at create. Read back with synap_list_views + the view detail.',
            },
            expectedLabel: {
              type: "string",
              description:
                "The declared output slot this fulfils, exactly as declared on the session.",
            },
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
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
            detail: {
              type: "string",
              enum: ["lean", "full"],
              description:
                "lean (default) = a digest to pick an id from (the heavy config/graph omitted, see `note`); full = complete rows — pair with a small limit.",
            },
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
      {
        name: "synap_list_widgets",
        annotations: {
          title: "List compose widgets",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "Live allowlist of cells you may place in a bento. Call this BEFORE arranging or generating a dashboard — never guess a widget key. Returns builtins (stat-card, entity-list, view, …) with requiredConfig, plus generated:<slug> frame cells already on the pod. view-table / view require a saved view UUID (viewId); a profileSlug is not enough. Counts use stat-card, not entity-count.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description:
                "Optional workspace UUID. Include it so workspace-scoped generated cells appear.",
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
          "Amend a pending proposal you authored (e.g. after user feedback): its summary, its reasoning, and/or the payload it will actually apply. Does not re-run the event pipeline, and does NOT approve it — a human still decides.",
        inputSchema: {
          type: "object",
          properties: {
            proposalId: {
              type: "string",
              // Matches `synap_reject_proposal`: this door also accepts a
              // leading fragment (handlers/build.ts), which was undocumented.
              description:
                "Proposal UUID, as returned verbatim by synap_list_proposals. " +
                "A leading fragment of one also resolves, but pass the full id " +
                "you were given — do not shorten it yourself.",
            },
            summary: {
              type: "string",
              description:
                "The human-readable summary a reviewer reads when deciding.",
            },
            reasoning: {
              type: "string",
              description: "Why this change is being requested.",
            },
            patch: {
              type: "object",
              description:
                "Amend WHAT WILL BE APPLIED, not just the narrative. Use this " +
                "whenever you change the summary to describe different content " +
                "\u2014 a summary that no longer matches the payload is worse " +
                "than no revision, because the human reads the summary.",
              properties: {
                kind: {
                  type: "string",
                  enum: ["inner", "envelope"],
                  description:
                    "'inner' edits the entity-level fields the executor applies " +
                    "(the usual choice). 'envelope' edits the top-level proposal " +
                    "envelope.",
                },
                fields: {
                  type: "object",
                  description:
                    "The field edits to merge. Only the keys you pass change.",
                },
              },
              required: ["kind", "fields"],
            },
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
                // Do NOT re-advertise a "short id printed by synap_list_proposals":
                // that door emits FULL uuids (`toProposalBasic` returns `row.id`
                // verbatim) and never printed a short one. The old text cited a
                // producer that does not exist, so a model read it, saw a uuid,
                // TRUNCATED it itself to comply, and hit a resolver on a
                // narrower floor. The schema manufactured its own failing input.
                "Proposal UUID, as returned verbatim by synap_list_proposals. " +
                "A leading fragment of one also resolves, but pass the full id " +
                "you were given — do not shorten it yourself.",
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
        name: "synap_find",
        annotations: {
          title: "Find what can do this",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          "What can do this? Searches the pod's runnable verbs, the abstract-intent axis and the user's playbooks in ONE call, and returns each match WITH its argument schema, so you can run it without a second lookup. Pass `intent` as free text (not the closed intent vocabulary). A block that is absent was not searched; `matches: []` means it was searched and nothing fit. Matching is lexical, so a miss is never proof of absence — `coverage` says how much was searched and `noConfidentMatch` carries the escalation ladder. Run a hit with synap_run_capability (verbId) or synap_run_playbook (playbook id).",
        inputSchema: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              description:
                "What you want to DO, in your own words (e.g. 'clean up duplicate contacts'). Keep the NOUN — it is the most discriminating word.",
            },
            workspaceId: {
              type: "string",
              description:
                "Optional workspace lens. Omit for pod altitude, which is what 'what can this pod do?' usually means.",
            },
            catalogs: {
              type: "array",
              items: { type: "string", enum: [...FIND_CATALOGS] },
              description:
                "Which catalogs to search. Omit for all three. A catalog you leave out is ABSENT from the result, not empty.",
            },
            limit: {
              type: "number",
              description: "Max matches per catalog (default 5).",
            },
          },
          required: ["intent"],
        },
      },
      {
        name: "synap_list_capabilities",
        annotations: {
          title: "List capabilities",
          readOnlyHint: true,
          openWorldHint: false,
        },
        description:
          'Discover what the user can actually DO. Returns a SECTIONED view: `integrations` (their connected services + tools, one per name, each with its `verbs` nested — e.g. google → gmail_send, gmail_search, calendar_list; the verb `id` is what you pass to synap_run_capability), `skills` (standalone runnable skills), and `commands`. Each integration shows `connection.connected` (needs connecting if false) and each verb shows `granted`/`effectiveExecMode` (a not-yet-granted verb must be enabled in Settings → Capabilities). Core built-in tools (already available to you directly as MCP tools) and teaching docs are folded out of this actionable view BY DEFAULT and only COUNTED under `excluded` — pass kind:"builtin-tool" or kind:"teaching-doc" to list them here instead, or synap_load_skill("catalog") for every teaching doc grouped by topic. Pass `query` to search across integrations/verbs/skills (e.g. query:"send email").',
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
            containerId: {
              type: "string",
              description:
                "Only rows belonging to this capability pack (the `containerId` on integrations/skills, or `builtInPack.containerId`). The default view summarises Synap Core's first-party verbs as ONE `builtInPack` line — pass its containerId to list them.",
            },
            intent: {
              type: "string",
              // DECLARED as an enum, not merely described in prose: the
              // vocabulary is closed, so the schema is the honest place to say
              // so. Prose alone makes a caller parse the valid set out of a
              // sentence and discover a typo as a runtime rejection; an enum
              // constrains the call before it is made.
              //
              // SPREAD from the union rather than re-typed: a literal copy here
              // would be a second definition of a closed vocabulary, and the
              // parity tripwire would then only catch the drift AFTER someone
              // shipped it. Same idiom this file already uses for
              // USER_OBSERVATION_CATEGORIES and PROPOSAL_REJECTION_REASONS.
              enum: [...ABSTRACT_VERBS],
              description:
                "Reverse lookup by ABSTRACT INTENT — what you want to DO, without knowing the vendor. Returns the concrete verb ids that serve it (pass one to synap_run_capability). Closed vocabulary: search_external | find_people | enrich_entity | fetch_record | list_records | send_message | request_connection | schedule_event | manage_file | generate_media | capture_into_pod | run_external_job | connect_account. Takes precedence over `query`/`kind`/`limit`. Not every installed verb declares an intent yet, so an empty result is not proof of absence — re-run without `intent` to scan the catalog.",
            },
            limit: {
              type: "number",
              description:
                "Max entries to return (default 20 when `query` is set; unset otherwise).",
            },
          },
          // workspaceId is OPTIONAL — "what can this pod do?" is almost always
          // a pod-wide question, and the handler already treats an absent
          // workspaceId as pod altitude (capability.ts passes it straight to
          // listCapabilities, which reads null as the pod lens). Declaring it
          // required was the schema being STRICTER than the implementation: it
          // forced an orient/list_workspaces round trip purely to obtain an id
          // the call does not use — on the DISCOVERY path, which is the path
          // taken by an agent that is already lost.
          required: [],
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
        // DERIVED from the shared capability-execute contract, not hand-written
        // here — the same reasoning as the automation data contract and the
        // rule sentence above. A hand-written literal is how this tool came to
        // omit `connectionSelector`: the service accepts it, so an agent whose
        // capability has two connections had no way to say which one to run.
        inputSchema: RUN_CAPABILITY_JSON_SCHEMA as Tool["inputSchema"],
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
            detail: {
              type: "string",
              enum: ["lean", "full"],
              description:
                "lean (default) = a digest to pick an id from (the heavy config/graph omitted, see `note`); full = complete rows — pair with a small limit.",
            },
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
            /**
             * WHY this write, in the person's own words — shown verbatim to the
             * reviewer. Without it the proposal detail reads "No reason was
             * given for this write."
             */
            reasoning: {
              type: "string",
              description:
                "Why you are making this write, in the person's words — shown to the human who reviews it. One line.",
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
                "Trigger settings. cron → { expression: '0 9 * * *' }. event → { eventPattern: 'entity.create.completed', filters: { ... } }. FILTERS GRAMMAR (enforced — a filter the runtime cannot evaluate is REJECTED, because an automation with an unevaluable filter installs as 'active' and then never fires): each key is a dot-notation path into the event data ('profileSlug', 'channel.contextObjectType'); each value is EITHER a plain string/number/boolean/null (exact match) OR an operator object — $eq, $ne, $in (non-empty array), $gt, $gte, $lt, $lte (numeric). E.g. { profileSlug: 'person' }, { profileSlug: { $in: ['person','contact'] } }, { score: { $gt: 30 } }. ENTITY PROPERTIES ARE FLAT: 'entity.update.completed' spreads the entity's changed properties onto event data under their BARE slug, so the key is 'score' — NOT 'properties.score', which resolves to undefined and silently never matches. A bare array value and a nested object value are BOTH rejected: use $in for several values, and a dot-notation key to reach nested data.",
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
        name: "synap_create_rule",
        annotations: {
          title: "Create rule",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Turn a stated standing intent into a RULE — the COMPILED door, and the one to reach for whenever the user says 'always…', 'from now on…', 'never…', 'every Monday…', or states a preference that should outlive this conversation. Send their own words as `intent`.\n" +
          "• `intent` alone → a FACT rule: durable prose ('Acme prefers async') that any agent reads later while reasoning. Legitimate and complete.\n" +
          "• `intent` + `sentence` → BEHAVIOUR: the door compiles your WHEN/WHERE/THEN into a real automation, or refuses. A rule that describes something running is never stored as prose that cannot run.\n" +
          "USE THIS INSTEAD OF synap_create_automation / synap_create_skill for a standing intent. Those are raw primitives — they persist whatever you hand them, so a bad trigger installs 'active' and silently never fires, and an instruction skill only ever sits there as text. This door verifies the compiled artifact against the runtime BEFORE anything is saved. (Reach for synap_create_automation directly only when you are authoring a flow that is not a user-stated rule — a multi-step pipeline with its own data contract.)\n" +
          "WHAT IT REJECTS, and why each rejection is real: a WHEN naming an event no emitter produces (the automation could never match); a WHERE row with a field but no value (dropping it would widen the rule beyond what was written); a THEN with no configured action (a trigger wired to nothing); `run_command` (the command step has no receiver and throws every run — use an AI step). A refusal comes back as status='denied' with `failure.clause` (WHEN | WHERE | THEN) and a reason written for a human. FIX THAT CLAUSE AND RESEND — it is a verdict, not a transient error, and re-sending it unchanged will fail identically.\n" +
          "If the intent describes something that should run and you send no `sentence`, the receipt carries `needsBehaviour` — the rule was saved as prose and will not execute; say so rather than reporting it as in effect.\n" +
          "Scope: pod-wide by default; pass `workspaceId` for a domain rule, `projectId` for the cross-cutting lens. A `projectId` limit is only enforceable on WHEN events that carry a project — " +
          PROJECT_SCOPE_EVENT_PREFIXES.map((p) => `${p}*`).join(", ") +
          " — and is REFUSED (status='denied', clause WHEN) on any other trigger (e.g. a schedule); drop the project or pick one of those events. `expiresAt` makes the rule stop applying — pass one whenever the intent is situational ('while we're in the launch push'), because a standing rule with no expiry is one the user must remember to revoke.\n" +
          "Governed like every write: status='proposed' is SUCCESS, not an error — surface the returned link as a markdown link and never report a proposed rule as already in effect.",
        inputSchema: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              description:
                "The rule in the user's own words — this IS the rule an agent reads later, so keep their phrasing rather than paraphrasing it into a spec.",
            },
            sentence: RULE_SENTENCE_JSON_SCHEMA,
            scope: {
              type: "string",
              enum: ["pod", "workspace", "user"],
              description:
                "Where the rule applies. Defaults to 'workspace' when a workspaceId resolves, otherwise 'pod' (everywhere).",
            },
            workspaceId: {
              type: "string",
              description:
                "Optional workspace lens. Omit for a pod-wide rule; the ambient workspace focus is used when set.",
            },
            projectId: {
              type: "string",
              description:
                "Optional cross-cutting project lens — composes with the workspace lens.",
            },
            expiresAt: {
              type: "string",
              description:
                "ISO-8601 instant with offset (e.g. '2026-12-31T00:00:00Z') after which the rule stops applying. A non-instant is refused rather than stored.",
            },
          },
          required: ["intent"],
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
          'LAUNCH a playbook via its executor (discover via synap_list_playbooks) — instantiates a session + run channel + playbook_run and dispatches to the playbook\'s executor (is-agent | external-agent | hybrid). Pass playbookId OR an unambiguous playbookName/name (multi-match returns candidates — never a silent pick). Write home: workspaceId if set, else the playbook\'s workspace, else subject/session; pod-wide playbooks with no home reject (pass workspaceId). This LAUNCHES the executor — it is not the same as opening a working session from the template. Governed, with THREE normal outcomes: status="proposed" (an agent launch awaits approval — SUCCESS, pass on reviewUrl, do not retry), status="blocked" (nothing ran: the playbook uses skills that are not enabled yet; `unenabledSkills` names them and `enableProposals` carries ONE enable request per pack — relay the message and run it again only after that is approved), status="running" (it started; `run` + `session` are returned).',
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
          title: "Create skill",
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        description:
          "Author a skill: Documentation (always) + OPTIONAL code. Send `body` alone for a TEACHING skill — reusable prose (a process, a checklist, a house style) that any agent later pulls with synap_load_skill; a teaching skill needs a `slug`, because that is the ref load_skill resolves. Send `code` for a runnable sandboxed executable, or both. `kind` is derived from code presence — do not guess it. For a deterministic provider HTTP call on an already-installed tool use synap_create_verb instead. Governed like every write: an agent create returns status='proposed'. An agent-authored skill is born UNAPPROVED either way and does NOT load or run until the owner approves it — code executes, and instruction prose lands in a future agent's system prompt, so both need a deliberate human OK.",
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
            slug: {
              type: "string",
              description:
                "Stable ref that synap_load_skill resolves, lowercase path segments (e.g. 'biz/business-plan'). REQUIRED for a documentation-only skill — without it the skill is authored but unreachable. Pod-wide unique; 'system/' is reserved for seeded skills.",
            },
            code: {
              type: "string",
              description:
                "Optional executable source (runs sandboxed). Present ⇒ the skill is runnable; absent ⇒ it is a teaching skill.",
            },
            body: {
              type: "string",
              description:
                "Markdown documentation — for a teaching skill this IS the skill: the process/checklist/style an agent should follow. For a code skill, how it works, inputs/outputs, when to use it. Required unless `code` is given.",
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
          required: ["name"],
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
            workspaceId: {
              type: "string",
              description:
                "Optional: also include this workspace's skills (you must be a member). Omit to use your declared workspace focus, if any; otherwise only pod-wide and your own skills are read.",
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
        // The skill LENS (founder decision S2): an explicit workspaceId, else
        // the agent's DECLARED focus workspace, else none. Never guessed — no
        // membership[0] fallback. Membership is enforced by the skill
        // visibility predicate inside `resolveSkillContent`, not here.
        const explicitWs =
          typeof args.workspaceId === "string" && args.workspaceId.trim()
            ? args.workspaceId.trim()
            : undefined;
        let workspaceId = explicitWs;
        if (!workspaceId && agentUserId) {
          const { getAgentFocusWorkspaceId } =
            await import("../../../services/agent-identity-service.js");
          workspaceId =
            (await getAgentFocusWorkspaceId(agentUserId)) ?? undefined;
        }
        const content = await resolveSkillContent(
          ref,
          sessionUserId ?? userId,
          workspaceId ? { workspaceId } : undefined
        );
        // Door-aware teaching: tool names render as THIS door exposes them
        // (pod `synap_*`, or `pod__*` for the claude.ai connector's key).
        const [{ resolveSkillDoor }, { renderSkillForDoor }] =
          await Promise.all([
            import("../../../services/capability-briefs/resolve-skill-door.js"),
            import("../../../services/capability-briefs/door-tool-render.js"),
          ]);
        const door = await resolveSkillDoor("mcp", agentUserId);
        return {
          content: [
            {
              type: "text",
              text: door ? renderSkillForDoor(content, door) : content,
            },
          ],
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
        keyType,
        keyWorkspaceId
      );
    } catch (err) {
      return toSafeToolError(err, name);
    }
  },
};
