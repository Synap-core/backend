/**
 * Automations Schema
 *
 * Workflow automations: trigger → step chain with conditions, commands, and outputs.
 * The flow_definition JSONB is both the visual layout (ReactFlow) and the execution graph.
 *
 * Trigger types:
 *   - event: fires on a Synap event (entities.create.validated, etc.)
 *   - cron: fires on schedule ("0 9 * * MON")
 *   - webhook: fires on inbound webhook
 *   - manual: user-triggered
 *
 * Steps reference intelligence_commands by ID, with input mapping from prior step outputs.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ── Flow definition types ───────────────────────────────────────────────────

/**
 * AutomationTriggerConfig
 *
 * Typed configuration stored as JSONB on the automations table.
 * The discriminant is `automations.triggerType` (separate column), not a field here.
 *
 * For event triggers, all domain-specific filter fields are declared here so
 * TypeScript sees them without `& Record<string, unknown>` casts.
 */
/**
 * MessageShapePredicate
 *
 * A SAFE, bounded predicate over a normalized message (the matcher's
 * `MessageEnvelope`). Used by `message.received`-alias (and physical
 * message-event) automations to narrow WHICH messages fire beyond a channel
 * binding — provider-agnostic, because it reads the envelope, not a raw payload.
 *
 *   contains         — envelope.content includes `value` (case-insensitive)
 *   regex            — `value` (a RegExp source) tests against envelope.content;
 *                      bounded + try/caught so a bad pattern can never hang the
 *                      worker (see the matcher's guard)
 *   has_attachment   — envelope.attachments is non-empty (no `value`)
 *   has_url          — envelope.content contains an http(s) URL (no `value`)
 *   from_participant — envelope.participant equals `value` (case-insensitive)
 */
export interface MessageShapePredicate {
  op: "contains" | "regex" | "has_attachment" | "has_url" | "from_participant";
  /** Required for contains / regex / from_participant; ignored otherwise. */
  value?: string;
}

export interface AutomationTriggerConfig {
  // ── event trigger ──────────────────────────────────────────────────────
  /** Event pattern to match. Supports trailing wildcard: "entities.*", "capture.complete.completed" */
  eventPattern?: string;
  /**
   * Filters applied to `event.data`. Each KEY is a dot-notation path
   * ("profileSlug", "channel.contextObjectType"); each VALUE is either a plain
   * literal (exact `===` match) or an operator object — `$eq`, `$ne`, `$in`,
   * `$gt`, `$gte`, `$lt`, `$lte`.
   *
   * The grammar is declared ONCE in
   * `@synap-core/types/automations/filter-operators`: the matcher evaluates it
   * (`@synap/jobs` automation-trigger-matcher `matchFilters`) and the create /
   * update doors validate against the same constant, so this stays
   * `Record<string, unknown>` at the type level without the door accepting a
   * shape the runtime cannot evaluate. An array or a nested-object value is
   * REJECTED at the door — both compare by identity and can never match.
   */
  filters?: Record<string, unknown>;

  // ── cron trigger ───────────────────────────────────────────────────────
  /** Cron expression (e.g. "0 9 * * MON") */
  expression?: string;

  // ── webhook trigger ────────────────────────────────────────────────────
  /** Webhook subscription ID to listen on */
  webhookSubscriptionId?: string;

  // ── channel_message domain filters ────────────────────────────────────
  /** Only match messages in this specific channel */
  channelId?: string;
  /** Filter by message author role ("user" | "assistant" | "any") */
  messageRole?: "user" | "assistant" | "any";

  // ── message shape predicate (eventPattern "message.received" alias + the two
  //    physical message events) ─────────────────────────────────────────────
  /**
   * Content/attachment/participant predicate evaluated against the normalized
   * MessageEnvelope the matcher derives from EITHER `external_message.received`
   * OR `channel_message.created`. Composes WITH `channelId` (both must match).
   * Additive: absent = no shape narrowing, so existing message automations are
   * unchanged. See `MessageShapePredicate`.
   */
  shape?: MessageShapePredicate;

  // ── connector_sync domain filters ─────────────────────────────────────
  /** Only match events from this connector provider (e.g. "google-calendar", "github") */
  provider?: string;
  /** Filter by sync outcome ("success" | "error" | "any") */
  syncStatus?: "success" | "error" | "any";

  // ── relation domain filters ────────────────────────────────────────────
  /** Only match this relation type slug */
  relationType?: string;
  /** Filter by change direction ("create" | "delete" | "any") */
  changeType?: "create" | "delete" | "any";

  // ── proposal domain filters ────────────────────────────────────────────
  /** Filter by proposal lifecycle event ("created" | "approved" | "rejected" | "any") */
  proposalEventType?: "created" | "approved" | "rejected" | "any";

  // ── capture domain filters ─────────────────────────────────────────────
  /** Only fire when a specific profile was captured (e.g. "person", "company", or "any") */
  profileSlug?: string;

  // ── proactive domain filters ───────────────────────────────────────────
  /** Filter by proactive message type ("morning_briefing" | "weekly_digest" | "insight" | "any") */
  proactiveType?: string;

  // ── feed domain filters ────────────────────────────────────────────────
  /** Only fire for items from this archetype ("leads" | "hiring" | "investors" | "trends" | "competitors" | "press") */
  feedArchetype?: string;
  /** Minimum relevance score (0-1) — items below this score are skipped */
  feedMinRelevanceScore?: number;

  // ── focus_session stage filters ──────────────────────────────────────────
  /** Only fire when a focus session advanced INTO this stage (PlaybookStage.key) */
  toStage?: string;

  // ── entity_facet domain filters (Kind + Facets, Wave 1B) ───────────────
  //
  // EXAMPLE — fire when a `client` role is attached to any entity (e.g. to
  // kick off a client-onboarding playbook):
  //   {
  //     triggerType: "event",
  //     config: {
  //       eventPattern: "entity_facet.*",   // attach/update/detach doors + generic verbs
  //       facetProfileSlug: "client",        // only the client role
  //       facetChangeType: "attach",         // only on attach (not update/detach)
  //     }
  //   }
  /** Only match facets of this role-profile slug */
  facetProfileSlug?: string;
  /** Only match facets of this role-profile id */
  facetProfileId?: string;
  /** Filter by facet change type ("attach" | "detach" | "status_changed" | "any") */
  facetChangeType?: "attach" | "detach" | "status_changed" | "any";
  /** Only match facets with this status */
  facetStatus?: string;
}

export interface AutomationNodeBase {
  id: string;
  type:
    | "trigger"
    | "command"
    | "condition"
    | "delay"
    | "output"
    | "loop"
    | "transform"
    | "fetch"
    | "query"
    | "messages_query"
    | "runs_query"
    | "proposals_query"
    | "switch"
    | "skill"
    | "capability"
    | "sub_automation"
    | "playbook_run"
    | "entity_read"
    | "related_entities"
    | "compute"
    | "select"
    | "claim"
    | "guard";
  position: { x: number; y: number };
}

export interface TriggerNodeDef extends AutomationNodeBase {
  type: "trigger";
  data: {
    triggerType: "event" | "cron" | "webhook" | "manual";
    label: string;
    config: AutomationTriggerConfig;
  };
}

/**
 * @deprecated for NEW authoring — use a `capability` node with
 * `verbId: 'ai.generate'` (Synap Core's synchronous single-shot LLM verb).
 *
 * A `command` node is a DEAD END end-to-end: `executeCommandStep` calls
 * `requestTaskExecute` with `taskId: data.commandId`, which the IS resolves as a
 * BACKGROUND-TASK ROW (`tasks-route.ts`) — the shipped `'intelligence_execute'`
 * has ZERO occurrences in the IS, so the lookup 404s and the step throws. Even
 * with a row present, the prompt is only LOGGED: `executeTask(task, hubClient,
 * body.context ?? {})` never receives `body.action`, and switches on
 * `task.action` over four fixed analysis types. There is no generic
 * "run this prompt" receiver behind this node type.
 *
 * KEPT, NOT DELETED — deliberately. Two live authoring doors still EMIT
 * `command` nodes, so deleting the executor arm would turn a dead step into a
 * crashing flow:
 *   • `packages/api/src/routers/playbooks.ts` — the lazy starter graph handed to
 *     every playbook that has no automation yet (a user can then save it).
 *   • `packages/types/src/automations/sentence.ts` — the `run_command` sentence
 *     action COMPILES to this node type, so it is reachable from the rule/
 *     sentence authoring grammar.
 * Pod-stored flows from either door are read, never rewritten, on the execution
 * path. Retiring the node type therefore requires retiring those two doors
 * first; this deprecation marks the direction without breaking stored rows.
 */
export interface CommandNodeDef extends AutomationNodeBase {
  type: "command";
  data: {
    /** Presentational node label, as authored. Not read by the executor. */
    label?: string;
    commandId?: string;
    commandTitle?: string;
    /** Maps step inputs to prior outputs. Uses template syntax: {{trigger.payload.entity.name}} */
    inputMapping: Record<string, string>;
    /** Optional prompt override that augments the command's template */
    promptOverride?: string;
  };
}

/**
 * The LEGACY authored shape of a `command` node, as written by `relay-app`'s
 * shipped flow templates (`src/lib/relay-automations.ts`) before 2026-09-03:
 * a free-text `prompt` and a bare `input` string instead of `promptOverride`
 * and `inputMapping`.
 *
 * This is a FIELD FORK, not a rename: `input` is a `string`, `inputMapping` is
 * a `Record<string,string>`. It did not crash — `resolveInputMapping(undefined)`
 * returns `{}` and an absent `promptOverride` falls back to `commandTitle` — so
 * a run would report SUCCESS while silently dropping BOTH the authored binding
 * and the authored ~40-word prompt.
 *
 * SCOPE — this exists for STORED DOCUMENTS, not for a legacy BEHAVIOUR. The
 * broken path was barely ever reached (upstream defects prune or never fire),
 * so no production data was ever shaped by it and there is nothing to stay
 * bug-compatible with. What DOES exist is `flow_definition` JSONB installed in
 * live pods on 2026-07-17 still spelling these fields the old way, and nothing
 * rewrites an installed flow — `executeAutomationFlow` only ever READS it. So
 * this normalizes on read, and no migration is required. It is deliberately
 * NOT defensive beyond that: no coercion, no shape-guessing, no tolerance for
 * combinations that were never authorable.
 */
export interface LegacyCommandNodeData {
  /** Free-text prompt. Canonical name: `promptOverride`. */
  prompt?: string;
  /** A single unkeyed input binding. Canonical name: `inputMapping`. */
  input?: string;
}

/**
 * Fold a `command` node's legacy authored fields into the canonical contract.
 *
 * THE ONE DOOR. Every reader of `CommandNodeDef["data"]` goes through this —
 * the jobs executor (which dispatches the node) and the sentence round-trip in
 * `@synap/types` (which re-renders it for the editor). A second, local
 * `?? data.prompt` in either place would be the fork growing a third head.
 *
 * It normalizes ON READ rather than rewriting stored rows, because flows are
 * already installed in pods' `automations.flow_definition` carrying the legacy
 * names; fixing only the template source would leave every installed flow
 * broken. No migration is therefore required.
 *
 * `prompt` → `promptOverride` is a plain rename (both are one template string).
 *
 * `input` → `inputMapping` needs a KEY, and the authored form has none by
 * construction. It becomes the single entry `{ input: <template> }`:
 *   • the key is the authored field's own name, so the mapping round-trips and
 *     no new vocabulary is invented for a value the author never named;
 *   • it is what the Intelligence Service receives, both as `context.input` on
 *     the `/api/tasks/execute` payload and as the `Inputs:` prompt line.
 * A single well-known key beats guessing a semantic one (`subjectId`,
 * `entityId`, …) from the template's text — that guess would be a second
 * hand-maintained mapping table, i.e. the same defect one level down.
 *
 * The canonical fields WIN when both are present, so a re-authored node is
 * never overwritten by a stale legacy sibling.
 */
export function normalizeCommandNodeData(
  data: CommandNodeDef["data"] & LegacyCommandNodeData
): CommandNodeDef["data"] {
  // Canonical key present → it wins outright. No empty-object special-casing:
  // an `inputMapping: {}` alongside an `input` was never authorable, so
  // treating `{}` as "absent" would be a guess about a case that cannot occur.
  const inputMapping =
    data.inputMapping ?? (data.input ? { input: data.input } : {});

  return {
    label: data.label,
    commandId: data.commandId,
    commandTitle: data.commandTitle,
    inputMapping,
    promptOverride: data.promptOverride ?? data.prompt,
  };
}

export interface ConditionNodeDef extends AutomationNodeBase {
  type: "condition";
  data: {
    label: string;
    /** JS-like expression evaluated at runtime: "trigger.payload.entity.metadata.priority === 'high'" */
    expression: string;
    trueLabel?: string;
    falseLabel?: string;
  };
}

export interface DelayNodeDef extends AutomationNodeBase {
  type: "delay";
  data: {
    label?: string;
    /** Duration string: "5m", "1h", "1d" */
    duration: string;
  };
}

export interface OutputNodeDef extends AutomationNodeBase {
  type: "output";
  data: {
    label: string;
    outputType:
      | "notification"
      | "entity_create"
      | "entity_update"
      | "facet_attach"
      | "facet_update"
      | "facet_detach"
      | "relation_create"
      | "webhook"
      | "channel_message"
      | "session_update"
      | "set_state";
    config: Record<string, unknown>;
  };
}

export interface LoopNodeDef extends AutomationNodeBase {
  type: "loop";
  data: {
    label: string;
    /** Expression referencing prior step output: "steps.search.output.results" */
    iteratorExpression: string;
    /** Variable name available inside the loop: {{loop.item}} */
    itemVariable: string;
  };
}

export interface TransformNodeDef extends AutomationNodeBase {
  type: "transform";
  data: {
    label: string;
    /** JS-like pipe expression: "{{stepId.output}} | uppercase" */
    expression: string;
    /** Optional per-node error handling */
    errorHandling?: NodeErrorHandling;
  };
}

export interface FetchNodeDef extends AutomationNodeBase {
  type: "fetch";
  data: {
    label: string;
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    url: string;
    headers: Record<string, string>;
    body: string;
    /** Optional per-node error handling */
    errorHandling?: NodeErrorHandling;
  };
}

export interface QueryNodeDef extends AutomationNodeBase {
  type: "query";
  data: {
    label: string;
    profileSlug: string;
    filter: string;
    limit: number;
    /**
     * Sort key. `executeQueryStep` resolves it in this order:
     *   1. a `properties.<key>` prefix always means the jsonb blob;
     *   2. a bare `createdAt` | `updatedAt` | `title` | `type` means the real
     *      `entities` COLUMN;
     *   3. anything else is a jsonb property key.
     *
     * These fields were READ by the executor long before they were DECLARED
     * here. That drift is not cosmetic: the flow editor builds its controls
     * from this type, so a capability the engine had was one the authoring UI
     * could not offer, and the only way to use it was to hand-write JSON.
     * Keep this in sync with `parseQueryOrderBy`.
     */
    orderBy?: string;
    /** Sort direction. Anything other than `"asc"` is treated as `"desc"`. */
    orderDir?: "asc" | "desc";
    /** Visibility lens override; see `executeQueryStep`. */
    scope?: string;
    /** Optional per-node error handling */
    errorHandling?: NodeErrorHandling;
  };
}

/** Read one entity by id within the automation's workspace/pod lens. */
export interface EntityReadNodeDef extends AutomationNodeBase {
  type: "entity_read";
  data: {
    label?: string;
    entityId: string;
    errorHandling?: NodeErrorHandling;
  };
}

/** Traverse a bounded set of generic graph relations and project counterparties. */
export interface RelatedEntitiesNodeDef extends AutomationNodeBase {
  type: "related_entities";
  data: {
    label?: string;
    entityId: string;
    direction?: "outbound" | "inbound" | "both";
    relationTypes?: string[];
    propertyEquals?: Record<string, unknown>;
    /** Match any supplied property/value set (OR across predicates). */
    propertyAnyEquals?: Record<string, unknown[]>;
    /** Exclude a known related entity (for example the trigger entity itself). */
    excludeEntityId?: string;
    limit?: number;
    errorHandling?: NodeErrorHandling;
  };
}

/** Finite numeric operations over literal or template-bound scalar values. */
export interface ComputeNodeDef extends AutomationNodeBase {
  type: "compute";
  data: {
    label?: string;
    operation: "add" | "subtract" | "multiply" | "divide" | "coalesce" | "now";
    left?: unknown;
    right?: unknown;
    /** First finite numeric value wins; useful for declarative fee precedence. */
    values?: unknown[];
    errorHandling?: NodeErrorHandling;
  };
}

/** Choose one typed value from a boolean produced by a prior deterministic step. */
export interface SelectNodeDef extends AutomationNodeBase {
  type: "select";
  data: {
    label?: string;
    when: unknown;
    ifTrue: unknown;
    ifFalse: unknown;
    errorHandling?: NodeErrorHandling;
  };
}

/**
 * Atomically reserves a durable, namespace-scoped key. This is a generic
 * workflow primitive for one-time policy decisions (not a CRM concept): the
 * run that first claims a key observes `claimed: true`; subsequent runs see
 * `claimed: false`. Re-delivery of the owning run remains `claimed: true`.
 * Claims are released when that run terminally fails, so the same idempotent
 * graph can be retried without wedging a record.
 */
export interface ClaimNodeDef extends AutomationNodeBase {
  type: "claim";
  data: {
    label?: string;
    namespace: string;
    key: string;
    errorHandling?: NodeErrorHandling;
  };
}

/** Structured, fail-closed business guard with an actionable retry reason. */
export interface GuardNodeDef extends AutomationNodeBase {
  type: "guard";
  data: {
    label?: string;
    checks: Array<{
      path: string;
      exists?: boolean;
      equals?: unknown;
      notEquals?: unknown;
      arrayIncludes?: unknown;
      lengthEquals?: number;
      /**
       * Minimum length of a string or array, AFTER trimming for strings.
       *
       * WHY THIS EXISTS SEPARATELY FROM `exists`: `exists: true` is a NULL
       * check — `""`, `0` and `{}` all satisfy it. So a guard written to mean
       * "refuse to continue without a body" does not actually stop an empty
       * body; it only stops a missing one. That gap shipped: the report flow's
       * "refusing to write an empty report" guard passed an empty-string body
       * straight through to the writer, and the reader then showed "Nothing
       * written yet" for a report the run had reported as successful.
       * Use `minLength: 1` (or higher) whenever a guard is meant to assert
       * that a value has CONTENT, not merely that a key is present.
       */
      minLength?: number;
      numberGte?: number;
      numberLte?: number;
      /** At least one path/literal pair must match. */
      anyOf?: Array<{ path: string; equals: unknown }>;
      message: string;
    }>;
    errorHandling?: NodeErrorHandling;
  };
}

/**
 * Source node that reads stored chat messages for a client. Either reads a
 * channel directly (`channelId`) or resolves the channel(s) bound to a subject
 * entity (`channels.contextObjectId`).
 *
 * DEFAULT output (scope="single-external" / explicit channelId):
 * `{ messages: [{ role, content, authorName, createdAt }], channelId, count }`
 * so a downstream loop can iterate `steps.<id>.output.messages`.
 *
 * FAN-OUT output (scope="all-channels") is a SUPERSET of the above — the same
 * `messages`/`channelId`/`count` keys plus:
 *   - each message carries a `source` tag `{ channelId, channelType, branchPurpose, title }`
 *     so a downstream `ai.generate` prompt can attribute who said what where;
 *   - `channels: [{ id, channelType, branchPurpose, title }]` — the gathered set;
 *   - `truncated: boolean` — true when the merged history hit the per-gather ceiling.
 * `channelId` is `null` in fan-out mode (there is no single channel). Consumers
 * that use the DEFAULT mode are byte-for-byte unaffected.
 *
 * When `includeDocuments` is true (either mode, requires `subjectEntityId`), the
 * output also carries `documents: [{ documentId, entityId, title, body }]` —
 * the entity's own body document plus the bodies of linked file/document
 * entities (DB-only preview, workspace-floored).
 */
export interface MessagesQueryNodeDef extends AutomationNodeBase {
  type: "messages_query";
  data: {
    label: string;
    /** Read messages for the channel(s) bound to this entity. */
    subjectEntityId?: string;
    /** Read this channel directly (wins over subjectEntityId + scope). */
    channelId?: string;
    /** Most-recent N messages per channel (default 40, capped 200). */
    limit?: number;
    /**
     * Gather scope. DEFAULT `"single-external"` = today's exact behavior (the
     * single EXTERNAL client-comms channel bound to `subjectEntityId`).
     * `"all-channels"` fans across EVERY channel bound to the entity (Discord +
     * email client-comms + team threads + Fireflies meeting transcripts + feed),
     * reads each channel's recent history, and MERGES chronologically. Ignored
     * when an explicit `channelId` is given (that is always a single channel).
     */
    scope?: "single-external" | "all-channels";
    /**
     * `all-channels` only: restrict the fan-out to these channelTypes
     * (e.g. `["external","thread"]`). Omit = all types bound to the entity.
     */
    channelTypes?: string[];
    /**
     * `all-channels` only: restrict the fan-out to this firewall branchPurpose
     * (e.g. `"client-comms"`). Omit = any purpose.
     */
    branchPurpose?: string;
    /**
     * Also gather the entity's linked documents (title + DB-only body preview).
     * Requires `subjectEntityId`. Default false → output unchanged.
     */
    includeDocuments?: boolean;
    /** Optional per-node error handling */
    errorHandling?: NodeErrorHandling;
  };
}

/**
 * Source node that reads this pod's OWN automation run ledger
 * (`automation_runs`), optionally with each run's `automation_step_runs`
 * children. The point is self-narration: a report/ops flow that says "3 runs
 * failed last night, here is what broke" needs to READ the ledger, and until
 * this node existed the only source node over non-entity data was
 * `messages_query` — `query` reads `entities` and nothing else.
 *
 * Output:
 * `{ runs: [{ id, flowName, status, startedAt, completedAt, error,
 *             stepsCompleted, stepsFailed, steps? }], count }`
 * — deliberately the same projection `getRun` (packages/api services/runs)
 * returns to RunDetailPanel, so a generated report and the browser tell the
 * SAME story about the same run.
 */
export interface RunsQueryNodeDef extends AutomationNodeBase {
  type: "runs_query";
  data: {
    label: string;
    /** Only runs of this automation. Template-resolvable. */
    automationId?: string;
    /** Run status filter: one value or a comma-separated list. */
    status?: string;
    /** Only runs started at/after this instant (ISO-8601 / epoch ms). */
    since?: string;
    /** Only runs launched ABOUT this entity (`automation_runs.subject_entity_id`). */
    subjectEntityId?: string;
    /** Most-recent N runs (default 20, capped 100). */
    limit?: number;
    /**
     * Also load each returned run's `automation_step_runs` rows as `steps[]`.
     * `automation_step_runs` has NO visibility column of its own, so children
     * are ONLY ever fetched by the ids of runs this node already authorized —
     * never by a caller-supplied run id. See `executeRunsQueryStep`.
     */
    includeSteps?: boolean;
    /** Optional per-node error handling */
    errorHandling?: NodeErrorHandling;
  };
}

/**
 * Source node that reads this pod's OWN proposal queue (`proposals`) — the
 * governance twin of `runs_query`. Lets a flow NARRATE what the agents proposed
 * ("5 pending proposals from last night's enrichment run, 3 of them creates")
 * instead of a human having to open the review inbox.
 *
 * `correlationId` / `sessionId` are indexed columns and are how a GROUP of
 * proposals is addressed — there is no proposal-group object in the schema, the
 * grouping IS the shared correlation/session id.
 *
 * Output:
 * `{ proposals: [{ id, status, targetType, targetId, changeType, summary,
 *                  reasoning, correlationId, sessionId, createdAt }], count }`
 */
export interface ProposalsQueryNodeDef extends AutomationNodeBase {
  type: "proposals_query";
  data: {
    label: string;
    /** Proposal status filter: one value or a comma-separated list. */
    status?: string;
    /** `proposals.target_type` ("entity", "facet", "document", …). */
    targetType?: string;
    /**
     * The normalized change kind. Matched against `data->>'changeType'` OR the
     * `proposal_type` column, exactly as the review surfaces normalize it
     * (routers/proposals.ts: "Prefer changeType, fall back to proposalType").
     */
    changeType?: string;
    /** All proposals of one request chain. */
    correlationId?: string;
    /** All proposals produced in one agent session. */
    sessionId?: string;
    /** Explicit ids (comma-separated string or array). */
    proposalIds?: string | string[];
    /** Only proposals created at/after this instant (ISO-8601 / epoch ms). */
    since?: string;
    /** Most-recent N proposals (default 20, capped 100). */
    limit?: number;
    /** Optional per-node error handling */
    errorHandling?: NodeErrorHandling;
  };
}

export interface SwitchNodeDef extends AutomationNodeBase {
  type: "switch";
  data: {
    label: string;
    /** Template expression to evaluate: "{{trigger.status}}" */
    expression: string;
    /** Cases to match against the resolved expression value */
    cases: Array<{ value: string; label: string }>;
    /** Optional per-node error handling */
    errorHandling?: NodeErrorHandling;
  };
}

/** Per-node error handling configuration */
export interface NodeErrorHandling {
  /** Don't fail the whole run on error — record error and continue */
  continueOnError?: boolean;
  /** Number of retry attempts (0–3) */
  maxRetries?: number;
  /** Milliseconds to wait between retries */
  retryDelay?: number;
}

export interface SkillNodeDef extends AutomationNodeBase {
  type: "skill";
  data: {
    label: string;
    skillId: string;
    skillTitle?: string;
    inputMapping: Record<string, string>;
    errorHandling?: NodeErrorHandling;
  };
}

/**
 * Typed, governed Tool → Verb step (Process builder). The author picks a Tool
 * (`capabilityId` = the tool row id) and a Verb on it (`verbId` = the requiring
 * skill's NAME — see `ToolVerbCatalogEntry.id`). The executor resolves the verb
 * to its backing skill and runs it through the SAME capability gate the `skill`
 * node uses. Display fields (`capabilityName`/`verbLabel`/`verbKind`/`granted`/
 * `execMode`) are authored by the FE for the canvas and not required at run time.
 */
export interface CapabilityNodeDef extends AutomationNodeBase {
  type: "capability";
  data: {
    label?: string;
    /** Tool row id of the selected capability. */
    capabilityId?: string;
    /** Display name of the chosen tool. */
    capabilityName?: string;
    /** Verb id = the requiring skill's name (resolves to the backing skill). */
    verbId?: string;
    verbLabel?: string;
    verbKind?: "read" | "write" | "action";
    granted?: boolean;
    execMode?: "auto" | "propose" | "dry-run";
    /** Maps verb args to prior step outputs ({{steps.id.output}}). */
    inputMapping?: Record<string, string>;
    errorHandling?: NodeErrorHandling;
  };
}

export interface SubAutomationNodeDef extends AutomationNodeBase {
  type: "sub_automation";
  data: {
    label: string;
    automationId: string;
    automationName?: string;
    payloadMapping: Record<string, string>;
    errorHandling?: NodeErrorHandling;
  };
}

export interface PlaybookRunNodeDef extends AutomationNodeBase {
  type: "playbook_run";
  data: {
    label: string;
    /** Resolve the playbook by id, OR by `playbookName` (template-friendly:
     *  a capability references its seeded playbook by stable name). One required. */
    playbookId?: string;
    playbookName?: string;
    /** Maps automation step outputs to playbook params */
    paramsMapping?: Record<string, string>;
    errorHandling?: NodeErrorHandling;
  };
}

export type AutomationNode =
  | TriggerNodeDef
  | CommandNodeDef
  | ConditionNodeDef
  | DelayNodeDef
  | OutputNodeDef
  | LoopNodeDef
  | TransformNodeDef
  | FetchNodeDef
  | QueryNodeDef
  | EntityReadNodeDef
  | RelatedEntitiesNodeDef
  | ComputeNodeDef
  | SelectNodeDef
  | ClaimNodeDef
  | GuardNodeDef
  | MessagesQueryNodeDef
  | RunsQueryNodeDef
  | ProposalsQueryNodeDef
  | SwitchNodeDef
  | SkillNodeDef
  | CapabilityNodeDef
  | SubAutomationNodeDef
  | PlaybookRunNodeDef;

export interface AutomationEdge {
  id: string;
  source: string;
  target: string;
  /** "yes" | "no" for condition nodes; case value (e.g. "active") for switch nodes */
  sourceHandle?: string;
  animated?: boolean;
  label?: string;
}

export interface FlowDefinition {
  nodes: AutomationNode[];
  edges: AutomationEdge[];
  /**
   * Optional flow-level precondition (Wave 4.V3). A single comparison expression
   * (same grammar as a `condition` node — e.g. "trigger.payload.stage === 'won'")
   * evaluated against the run context BEFORE any step runs. When it evaluates
   * false the run finalizes `skipped` (no side effect, no session) instead of
   * fake-`completed`, so a precondition-gated run is honestly distinguishable
   * from one that did work. Absent/empty → the flow always runs.
   */
  precondition?: string;
}

// ── Automations table ───────────────────────────────────────────────────────

export const automations = pgTable(
  "automations",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Ownership
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    createdBy: text("created_by").notNull(),

    // Definition
    name: text("name").notNull(),
    description: text("description"),

    // Trigger (exactly one per automation)
    triggerType: text("trigger_type", {
      enum: ["event", "cron", "webhook", "manual"],
    }).notNull(),
    triggerConfig: jsonb("trigger_config")
      .$type<AutomationTriggerConfig>()
      .default({})
      .notNull(),

    // Flow: nodes + edges + layout (single source of truth)
    flowDefinition: jsonb("flow_definition")
      .$type<FlowDefinition>()
      .default({ nodes: [], edges: [] })
      .notNull(),

    // Status
    // "archived" is a terminal soft-delete state (0230): a name-dedup casualty
    // or a retired automation. It is EXCLUDED from the name-uniqueness index
    // (archived rows free the name) and from scheduling/matching (both filter
    // status = 'active'), so it never fires. Not a user-selectable input value —
    // the create/update/list zod enums stay draft|active|paused|error.
    status: text("status", {
      enum: ["draft", "active", "paused", "error", "archived"],
    })
      .notNull()
      .default("draft"),
    errorMessage: text("error_message"),

    // Monotonic definition version (D3c). Bumped on a governed update that
    // changes a definition-affecting field (flowDefinition/triggerType/
    // triggerConfig); a run snapshots it into automation_runs.definitionSnapshot.
    // Distinct from the legacy free-form metadata.version bag.
    version: integer("version").notNull().default(1),

    // Execution stats
    lastRunAt: timestamp("last_run_at", { mode: "date", withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { mode: "date", withTimezone: true }),
    runCount: integer("run_count").default(0).notNull(),
    successCount: integer("success_count").default(0).notNull(),
    failureCount: integer("failure_count").default(0).notNull(),

    // Per-automation persistent state (watermark/cursor). Read into the run
    // context so templates can resolve {{automation.state.<key>}}; written back
    // by an explicit `output` node with outputType "set_state" (author-controlled,
    // never automatic). Concurrent runs last-writer-merge via jsonb `||`.
    state: jsonb("state")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    // Metadata
    metadata: jsonb("metadata")
      .$type<{
        tags?: string[];
        version?: number;
        createdVia?: "ai" | "manual" | "template";
        averageExecutionTime?: number;
        suggestedByPattern?: boolean;
        patternConfidence?: number;
        description?: string;
        [key: string]: unknown;
      }>()
      .default({})
      .notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceIdx: index("automations_workspace_id_idx").on(table.workspaceId),
    statusIdx: index("automations_status_idx").on(table.status),
    triggerTypeIdx: index("automations_trigger_type_idx").on(table.triggerType),
    nextRunAtIdx: index("automations_next_run_at_idx").on(table.nextRunAt),
    createdByIdx: index("automations_created_by_idx").on(table.createdBy),
    // Name-identity backstop (0230, mirrors playbooks_workspace_name_active_uq /
    // 0227): at-most-one non-archived automation per (workspace | pod-wide,
    // lower(name)). MCP create_automation re-authored the SAME automation into a
    // 2nd row on every run (`Stellar Grant ×4` live) because there was no name
    // identity. Expression index — the create door recovers SQLSTATE 23505 by
    // re-selecting the winner (reuse-by-name), NOT ON CONFLICT (which cannot
    // target an expression index cleanly via drizzle). NULL workspace coalesced
    // to a sentinel UUID so pod-wide rows participate in uniqueness.
    workspaceNameActiveUniq: uniqueIndex("automations_workspace_name_active_uq")
      .on(
        sql`COALESCE(${table.workspaceId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`lower(${table.name})`
      )
      .where(sql`${table.status} <> 'archived'`),
  })
);

export type Automation = typeof automations.$inferSelect;
export type NewAutomation = typeof automations.$inferInsert;
export const insertAutomationSchema = createInsertSchema(automations);
export const selectAutomationSchema = createSelectSchema(automations);

/**
 * Per-run record of the path through the flow graph (D3d). Edge ids are
 * `AutomationEdge.id` values from the run's `definitionSnapshot.flowDefinition`.
 * Both lists are sets (deduped, order-insensitive) and are UNION-MERGED across a
 * delay resumption, so a multi-invocation run accumulates rather than overwrites.
 */
export interface RunPathTaken {
  /** Live edges whose source node executed — control was released along them. */
  traversedEdgeIds: string[];
  /** Edges on an untaken condition/switch branch (exact executor decision). */
  prunedEdgeIds: string[];
}

// ── Automation runs ─────────────────────────────────────────────────────────

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"),
    /** Entity the run was explicitly launched about, when applicable. */
    subjectEntityId: uuid("subject_entity_id"),
    triggeredBy: text("triggered_by"), // userId or "system"

    triggerPayload: jsonb("trigger_payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    // 'skipped' (Wave 4.V3) — a run whose flow-level precondition evaluated false
    // at start: finalized before any step executes, distinct from a genuine
    // 'completed'. 'blocked_by_policy' — a run whose effect a GOVERNANCE verdict
    // refused (an agent-produced trigger fired a human-owned automation and the
    // producer ladder / a policy floor blocked the THEN-action): a calm governance
    // OUTCOME, not a transport error, so it reads distinct from 'failed'. The DB
    // column is unconstrained `text` (no CHECK; see 0000_baseline_schema.sql), so
    // both are TS-only enum widenings — exactly as automation_step_runs.status
    // added 'skipped' with no migration. Nothing to migrate at the DB level, and
    // schema-coherence validates column existence, not enum membership.
    status: text("status", {
      enum: [
        "running",
        "completed",
        "failed",
        "cancelled",
        "skipped",
        "blocked_by_policy",
      ],
    })
      .notNull()
      .default("running"),
    errorMessage: text("error_message"),

    stepsCompleted: integer("steps_completed").default(0).notNull(),
    stepsFailed: integer("steps_failed").default(0).notNull(),
    outputSummary: jsonb("output_summary").$type<Record<string, unknown>>(),

    // The automation definition this run executed (D3c) —
    // { version, flowDefinition }. Plain JSON snapshot so "what ran" survives
    // later edits to the automation. Stamped once at execution start.
    definitionSnapshot: jsonb("definition_snapshot").$type<{
      version: number;
      flowDefinition: FlowDefinition;
    }>(),
    /**
     * Which edges of the flow this run actually walked (D3d). Written by the
     * executor at the point the branch decisions are already made — NOT
     * re-derivable client-side without a second copy of `markDescendantsSkipped`.
     *
     * - `prunedEdgeIds` — edges on an untaken condition/switch branch (exact:
     *   the executor pruned them by id).
     * - `traversedEdgeIds` — live edges whose SOURCE node executed, i.e. control
     *   was released along them. An edge whose source never ran (the run failed
     *   fast upstream) appears in NEITHER list — that absence is honest
     *   "undecided", not "not taken".
     *
     * NULL for every run that predates this column and for runs finalized by the
     * reaper without executing — render as "unknown", never as "nothing pruned".
     */
    pathTaken: jsonb("path_taken").$type<RunPathTaken>(),
    /** Soft self-reference to the run this one replays (schema support only). */
    replayOf: uuid("replay_of"),

    /**
     * The one run-narration summary message posted for this run (Wave 3.N1).
     * NULL until `postRunSummary` claims it; the claim
     * (`SET summary_message_id=$mid WHERE id=$runId AND summary_message_id IS NULL`)
     * is the exactly-once guard so the finalizer and the reaper can never both
     * post for the same terminal run. Soft ref to `messages.id`.
     */
    summaryMessageId: uuid("summary_message_id"),

    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => ({
    automationIdx: index("automation_runs_automation_id_idx").on(
      table.automationId
    ),
    statusIdx: index("automation_runs_status_idx").on(table.status),
    startedAtIdx: index("automation_runs_started_at_idx").on(table.startedAt),
    subjectEntityIdIdx: index("automation_runs_subject_entity_id_idx").on(
      table.subjectEntityId
    ),
  })
);

export type AutomationRun = typeof automationRuns.$inferSelect;
export type NewAutomationRun = typeof automationRuns.$inferInsert;

// ── Automation step runs ────────────────────────────────────────────────────

export const automationStepRuns = pgTable(
  "automation_step_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(), // matches AutomationNode.id in flow_definition

    commandId: uuid("command_id"), // FK to intelligence_commands (null for non-command steps)

    // 'blocked_by_policy' — this step's effect was refused by a governance verdict
    // (confused-deputy guard / agent-ladder deny) rather than breaking: a calm
    // governance outcome, distinct from 'failed'. TS-only widening on this
    // unconstrained `text` column, mirroring how 'skipped' was added (no migration).
    status: text("status", {
      enum: [
        "pending",
        "running",
        "completed",
        "failed",
        "skipped",
        "blocked_by_policy",
      ],
    })
      .notNull()
      .default("pending"),

    resolvedInputs: jsonb("resolved_inputs")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    output: jsonb("output")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    errorMessage: text("error_message"),

    // Per-step token/cost attribution (D3, cheap-now). numeric maps to string
    // in Drizzle. `cost_usd` stays NULL until a provider reports a price —
    // honest-by-design, never a fabricated 0.
    tokensUsed: integer("tokens_used"),
    costUsd: numeric("cost_usd"),

    // ── AI telemetry across the pod↔IS seam (0224) ──────────────────────────
    // Drained from the AI-usage collector when a step made one or more IS
    // generations (see @synap/intelligence-client ai-usage-collector.ts). NULL
    // on a non-AI step, and NULL when the provider reported no usage.
    //
    // `finishReason` is the field that EXPLAINS an empty output: `length` (the
    // maxTokens budget truncated it), `content-filter`, `error`, or `stop` (the
    // model genuinely emitted nothing). Before 0224 an empty generation was
    // unexplainable without SSH-ing to the IS container.
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    finishReason: text("finish_reason"),

    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => ({
    runIdx: index("automation_step_runs_run_id_idx").on(table.runId),
  })
);

export type AutomationStepRun = typeof automationStepRuns.$inferSelect;
export type NewAutomationStepRun = typeof automationStepRuns.$inferInsert;

// ── Durable workflow claims ─────────────────────────────────────────────────

/**
 * A compact, generic exactly-one decision ledger. It deliberately stores no
 * domain data: templates choose their namespace/key and use the boolean result
 * in the graph. The composite unique index is the concurrency boundary.
 */
export const automationClaims = pgTable(
  "automation_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id"),
    namespace: text("namespace").notNull(),
    claimKey: text("claim_key").notNull(),
    ownerRunId: uuid("owner_run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceNamespaceKeyUniq: uniqueIndex(
      "automation_claims_workspace_namespace_key_uniq"
    ).on(
      sql`COALESCE(${table.workspaceId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      table.namespace,
      table.claimKey
    ),
  })
);

export type AutomationClaim = typeof automationClaims.$inferSelect;

// ── Drizzle relations (enables db.query.automations) ────────────────────────

export const automationsRelations = relations(automations, ({ many }) => ({
  runs: many(automationRuns),
}));

export const automationRunsRelations = relations(
  automationRuns,
  ({ one, many }) => ({
    automation: one(automations, {
      fields: [automationRuns.automationId],
      references: [automations.id],
    }),
    stepRuns: many(automationStepRuns),
  })
);

export const automationStepRunsRelations = relations(
  automationStepRuns,
  ({ one }) => ({
    run: one(automationRuns, {
      fields: [automationStepRuns.runId],
      references: [automationRuns.id],
    }),
  })
);
