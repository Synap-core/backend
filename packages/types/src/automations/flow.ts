/**
 * Automation flow definition — the shape of `automations.flow_definition`,
 * `automations.trigger_config` and `automation_runs.path_taken`.
 *
 * Declared HERE, once. `@synap/database` (`schema/automations.ts`) imports and
 * re-exports these declarations to type its JSONB columns, so the pod, the
 * executor and every client read the same declaration. Pure types: no runtime
 * code, nothing from the database package.
 */

import type { WorkerSize } from "../workers/index.js";

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
  /**
   * The inbound webhook source this automation listens to, BY NAME — what a
   * package declares (a row id is one pod's own). The create and update doors
   * and a template install bind it to the space's source of that name when a
   * person has created one, and set `webhookSubscriptionId`; they never create
   * a source. Created later, the source binds this automation then.
   */
  webhookSource?: { name: string };

  // ── rule scope (entity + project) ──────────────────────────────────────
  /**
   * Only fire for events ABOUT this entity. Enforced by the trigger matcher
   * (`matchRuleScopeFilters`) on the event families in
   * `RULE_SCOPE_EVENT_PREFIXES.entityId`; on any other family a rule carrying
   * it never fires (fail closed). Absent = no narrowing.
   */
  entityId?: string;
  /**
   * Only fire for events ON this project (`projects.id`): the subject belongs to
   * it via `belongs_to_project`, or its channel / session / proposal carries it.
   * Enforced by the trigger matcher on `RULE_SCOPE_EVENT_PREFIXES.projectId`;
   * other families and an unreadable membership never fire. Absent = no narrowing.
   */
  projectId?: string;

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

  // ── connection sync ────────────────────────────────────────────────────
  /**
   * Fire on events whose side-effect `origin` is `"sync"` (a bulk mirror of an
   * external source). Default (absent/false): such events are skipped by the
   * trigger matcher, so a first sync of 200 contacts does not open 200 runs.
   */
  includeSyncOrigin?: boolean;
  /**
   * Fire on events whose `origin` is `"merge"` — a role moved onto the
   * surviving entity of a merge. Default (absent/false): skipped, like sync:
   * merging two duplicate people must not re-propose "Qualify a lead".
   */
  includeMergeOrigin?: boolean;
  /**
   * The connection (`secrets` row id) this automation's capability steps run
   * against. Passed as `connectionSelector.connectionId` to every capability
   * node that does not name its own selector/connection.
   */
  connectionId?: string;
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
 * A `command` node RUNS its prompt (title or `promptOverride` + resolved
 * inputs) through `ai.generate` on the canonical capability router
 * (`executeCommandStep`); its output is the generated text. Until 2026-10-20 it
 * posted to the IS background-task receiver, which resolves `commandId` as a
 * `background_tasks` row — the shipped `'intelligence_execute'` is no such row,
 * so every command step 404'd ("New Contact Enrichment": 541/541 runs failed).
 * A `capability` node naming `ai.generate` says the same thing explicitly.
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
 * path, so they now run instead of failing. Retiring the node type still
 * requires retiring those two doors first.
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
      // Session outcome verbs (plan v5 T2, decision V4), governed like every
      // write: complete one outcome, post evidence for criteria, re-grade
      // criteria. Config: `sessionId` | `subjectEntityId`, then `outcomeKey` /
      // `evidence` / `criterionKeys`. (A line comment, not JSDoc: the api-types
      // generator would carry a JSDoc into the generated union.)
      | "complete_outcome"
      | "post_evidence"
      | "reevaluate_criterion"
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
    /**
     * AGENT SELECTOR — the `agents.slug` of the agent that should answer the
     * spawned run. Absent ⇒ the default orchestrator ("meta").
     *
     * `executePlaybookRun` (packages/jobs/src/workers/steps/playbook-run.ts) has
     * read this field since the playbook wave and forwards it to the runner, but
     * it was never DECLARED here — so no authoring door could type it, no
     * producer existed, and every playbook run resolved to "meta" regardless of
     * intent. The rule-sentence grammar now emits it
     * (`__agentType` → `data.agentType`, packages/types/src/automations/sentence.ts),
     * which makes this a typed producer rather than an untyped passthrough.
     *
     * Remaining non-producer: `buildPlaybookRunFlowDefinition` (loop/cron
     * definitions, services/playbooks/cron-automation.ts) still emits no
     * `agentType`, so a loop-authored playbook run keeps the "meta" default.
     */
    agentType?: string;
    /**
     * GOAL OVERRIDE — what the spawned session is FOR, stated by the NODE
     * instead of inherited from the playbook's own `goalTemplate`.
     *
     * Absent (every node authored before this field existed) ⇒ unchanged: the
     * playbook's `goalTemplate` is what the session's agent reads. Present ⇒ it
     * replaces that template wholesale, and is resolved by the SAME resolver in
     * the SAME two grammars — `{{trigger.payload.*}}` / `{{steps.*}}` against
     * the automation StepContext (`executePlaybookRun`'s `goalResolver`) and
     * `@{arg:name:type}` against the resolved params (`resolveGoal`, reached via
     * `runPlaybook`'s `goalTemplateOverride`). There is deliberately no second
     * interpolator: a goal that resolved differently from a goalTemplate would
     * be a fork of the template grammar.
     *
     * Producer: the rule-sentence grammar's `__goal` bookkeeping key
     * (packages/types/src/automations/sentence.ts) and the app-side writer
     * (`makePlaybookRunAction`, @synap/automation-intent).
     *
     * Non-producer, as with `agentType`: `buildPlaybookRunFlowDefinition`
     * (services/playbooks/cron-automation.ts) emits no goalOverride — the loop
     * definition schema (`LoopTriggerDef`, @synap/playbooks) has no goal field
     * to pass through, so a loop/cron-authored playbook run keeps the
     * playbook's own goalTemplate.
     */
    goalOverride?: string;
    /**
     * FILING — the PROJECT / TRACK the spawned session is born into
     * (`focus_sessions.project_id` / `track_id`). Forwarded to `runPlaybook`,
     * which validates it on its one door (`resolveTrackFiling`: visible,
     * not archived, `projectId` must be the track's project; an absent
     * `projectId` is derived from the track). Absent ⇒ an unfiled session, as
     * before. Honoured on the run and propose modes, top level and inside a
     * loop; an `appointment` node does not carry filing yet.
     */
    projectId?: string;
    trackId?: string;
    /**
     * HAND-OFF — the agent user id (`users.id`, the identity `synap_list_agents`
     * returns and `synap_start_session` `agentIds` / `synap_update_session`
     * `addAgentId` take) the spawned session is handed to. Forwarded to
     * `runPlaybook`, which resolves it ONCE through THE route
     * (`agent-dispatch/route.ts`, the hand-off reaches `dispatch` | `pull`)
     * before any session exists: an unknown, paused or foreign agent fails the
     * step by name. A handed run puts the agent on the session's roster and
     * does NOT dispatch the playbook's own executor — the named agent does the
     * work (`pull`: its orient's `handedToYou`; `dispatch`: its binding).
     * Run mode only: the step refuses it beside `appointment` / `propose`.
     * Producer: `buildPlaybookRunFlowDefinition` from the playbook's
     * `schedule.handToAgentId`. Absent ⇒ unchanged.
     */
    handToAgentId?: string;
    /**
     * WHAT this node materializes (read through `readPlaybookRunMode`,
     * `@synap-core/types/automations`, which keeps this union and its runtime
     * list in sync both ways):
     *   - absent / `"run"` — an unattended run (every pre-existing node).
     *   - `"appointment"` — a `scheduled` session waiting for the human
     *     (`buildPlaybookRunFlowDefinition` from a playbook's `schedule.mode`).
     *   - `"propose"` — a governed `playbook/run` PROPOSAL; nothing starts until
     *     a person approves, and approval replays `playbooks.run` →
     *     `runPlaybook`. Producer: the rule grammar's `__mode` key.
     */
    mode?: "run" | "appointment" | "propose";
    /**
     * STAGE WORKER — present when this node is an ENABLED worker (work model
     * L4): a playbook activator compiled for a scope. Carries what the runner
     * needs to decide whether to start, and how big the run is. Absent ⇒ an
     * ordinary playbook run, unchanged. Producer: the activator compiler
     * (`playbook-activators.ts` / `workers.ts`, via the rule grammar's
     * `__worker` key). Forwarded WHOLE by every executor call site (one field,
     * one forward — the `playbook-run-mode-honoured` tripwire pins it).
     */
    worker?: PlaybookRunWorkerSpec;
    errorHandling?: NodeErrorHandling;
  };
}

/**
 * A worker node's runtime spec. Mirrors the declared activator
 * (`WorkerActivator`, `@synap-core/types/workers`) minus what the rule's
 * trigger already encodes. `writes: "propose"` = every agent write inside a
 * per_moment batch becomes a proposal (the batch card); a per_thing worker's
 * propose mode is the node's own `mode: "propose"` instead.
 */
export interface PlaybookRunWorkerSpec {
  /** The activator's key within its playbook (`activatorKey`). */
  key: string;
  size: WorkerSize;
  /** The subject kind or role the worker works on. */
  profileSlug: string;
  /** The status its things sit in (enters_status / count / schedule). */
  status?: string;
  /** A `count` worker's threshold. */
  minCount?: number;
  maxPendingApprovals?: number;
  writes?: "run" | "propose";
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
