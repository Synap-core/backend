/**
 * @synap/playbooks — Playbooks & Capability Substrate contracts
 *
 * The pure, I/O-free DOMAIN contracts for the autonomous-capability spine:
 * Tool · Skill(ref) · Playbook · Link · Executor · PlaybookRun.
 *
 * Contains NO database / event / proposal side effects — ONLY types + the
 * Executor interface. Persistence ROW types live in @synap/database/schema
 * (tools / playbooks / links); the interfaces here describe the behavioral
 * shapes the loosely-typed JSONB columns conform to, applied at the domain/API
 * boundary. Small string-unions are intentionally re-declared here (rather than
 * imported from @synap/database) so this package stays dependency-free — they
 * must stay in lock-step with the `.$type<>()` unions in the schema files.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx
 */

// ── Executor — the agnostic "hands" ──────────────────────────────────────────
/** IS persona-agent · BYOA external agent (Claude Code, CLI) · hybrid. */
export type ExecutorRef = "is-agent" | "external-agent" | "hybrid";

// ── Tool — a registered integration the AI can use ───────────────────────────
export type ToolKind =
  | "builtin"
  | "api"
  | "mcp"
  | "provider"
  | "external"
  | "script";

/**
 * The verb axis of a Tool — the structured, enumerable capability matrix. A
 * Tool (an integration like Gmail or LinkedIn) exposes a SET of named verbs; each
 * verb is one concrete operation the AI can invoke. This is the catalog the
 * connector-capability-matrix is built over: one row per (connection × verb).
 *
 * Verbs are DERIVED, not hand-authored: each verb mirrors a skill that
 * `requires` the tool inside a `CapabilityDefinition` (the source of truth) — so
 * the catalog can never drift from the skills actually created. Persisted as the
 * `tools.capabilities` jsonb column (kept in lock-step with the `.$type<>()` on
 * the schema's `capabilities` column).
 */
export type ToolVerbKind = "read" | "write" | "action";

export interface ToolVerb {
  /** Stable identifier — the requiring skill's name (callable via callProvider/dispatcher). */
  id: string;
  /** Human-facing label. */
  label: string;
  /**
   * Verb axis: `read` = pull (no external mutation); `write`/`action` = push (a
   * mutation/send). Maps the verb onto the read/push capability matrix axis.
   */
  kind: ToolVerbKind;
  /** JSON-schema-ish arg shape for the verb (the requiring skill's parameters). */
  argsSchema?: Record<string, unknown>;
  /**
   * The governance default for this verb — aligns to the exec-mode the seeded
   * `vault_grants` row carries (so a verb never bypasses the approved+grant
   * model). `auto` runs directly, `propose` routes through review, `dry-run`
   * previews. The per-grant exec-mode at the gate still narrows this at run time.
   */
  govDefault: ExecMode;
}

/** A credential a Tool/Skill needs at run time — mirrors the vault taxonomy. */
export interface CredentialRequirement {
  /** Logical name the tool/skill references (e.g. "apiKey"). */
  name: string;
  secretType:
    | "api-key"
    | "credential"
    | "ssh-key"
    | "oauth-token"
    | "env-variable"
    | "connection-string";
  /** Human-facing reason, surfaced in the vault approval proposal. */
  purpose?: string;
}

// ── Capability reference — a granted thing inside a Playbook ──────────────────
/** What a Playbook can GRANT / a run uses. (Tools and Skills are linked, not merged.) */
export type GrantableKind = "tool" | "skill" | "command";
export interface CapabilityRef {
  kind: GrantableKind;
  id: string;
}

/**
 * The full subject kind set an enforcement-bearing capability grant
 * (`vault_grants` row) can authorize: the grantables PLUS `secret` (a vault
 * secret is just one grantable kind). Kept in lock-step with the
 * `grantable_type` pg enum in @synap/database/schema/secrets-vault.
 */
export type GrantSubjectKind = GrantableKind | "secret";

/**
 * What happens when a grant is exercised — the governance / execMode axis. The
 * same axis as `Capability.governance`; kept in lock-step with the
 * `grant_exec_mode` pg enum in @synap/database/schema/secrets-vault.
 *   - `auto`    — run the capability directly.
 *   - `propose` — route the exercise through a reviewable proposal.
 *   - `dry-run` — preview only (stub external writes/sends, keep reads + checks).
 */
export type ExecMode = "auto" | "propose" | "dry-run";

// ── Playbook — a session template (configuration) ────────────────────────────
export type PlaybookParamType =
  | "text"
  | "number"
  | "entity"
  | "choice"
  | "boolean";
export interface PlaybookParam {
  name: string;
  label?: string;
  type: PlaybookParamType;
  options?: string[];
  default?: unknown;
  required?: boolean;
}

/** "What to check" — the dynamic input set a scheduled run draws from. */
export type InputStrategy =
  | { kind: "none" }
  | { kind: "static"; items: unknown[] }
  | { kind: "rotating"; items: unknown[]; cursor: number }
  | { kind: "query"; sourceSubscriptionId: string };

export type ChannelSpecType = "GROUP" | "AGENT_COLLAB" | "THREAD";
export interface ChannelMemberSpec {
  /** A user id OR an agent-user id (both live in the users table). */
  memberId: string;
  memberKind: "human" | "ai_agent";
  /** Per-teammate caps in the session room (can only restrict, never widen). */
  canDraft?: boolean;
  canPropose?: boolean;
  canAct?: boolean;
}
export interface ChannelSpec {
  type: ChannelSpecType;
  members?: ChannelMemberSpec[];
  aiReactionMode?: "only_mentioned" | "when_confident" | "off";
}

export interface ExpectedOutput {
  kind: string;
  label: string;
  icon?: string;
}

/**
 * A first-class stage of a Playbook — an ordered phase the run advances through.
 * Stages are ADDITIVE: a playbook with no stages behaves exactly as before
 * (progress-only). The active stage's `key` is stored on
 * `focus_sessions.currentStage`; it NEVER becomes required.
 */
export interface PlaybookStage {
  /** Stable id; value stored in focus_sessions.currentStage. */
  key: string;
  name: string;
  description?: string;
  /** Stage-scoped goal when this stage is active. */
  goal?: string;
  /** Capabilities granted while this stage is active. */
  grants?: CapabilityRef[];
  /** Deliverables expected from this stage. */
  expectedOutputs?: ExpectedOutput[];
  suggestedTasks?: string[];
}

export interface PlaybookSchedule {
  /** 5-field cron expression (e.g. "0 9 * * MON"). */
  cron: string;
  enabled: boolean;
}

// ── Links — the config/runtime graph (mirrors the schema unions) ─────────────
export type LinkEndpointType =
  | "playbook"
  | "tool"
  | "skill"
  | "command"
  | "session"
  | "source"
  | "entity"
  | "channel"
  | "participant"
  | "automation"
  // A project entity (profileSlug='project'). Sessions may target a project
  // (project-centric-scope Phase 4): `session --targets--> project`.
  | "project"
  // A vault secret — TARGET of a `provides_credential` edge (dynamic tool auth).
  | "secret"
  // A capability CONTAINER (`capabilities` table). Parts attach as members:
  // `tool|skill|command --member_of--> capability`.
  | "capability";
export type LinkType =
  | "grants"
  | "requires"
  | "instantiated_from"
  | "used"
  | "targets"
  | "produced"
  | "member_of"
  | "feeds"
  | "promoted_to"
  | "provided_by"
  // knowledge↔config bridge edges (entity DATA pointing at config objects)
  | "about"
  | "documents"
  | "concerns"
  // automation → playbook (the activator relationship; mirrors links.ts schema)
  | "activates";

/** A request to create a link edge (id/createdAt assigned by the store). */
export interface LinkInput {
  workspaceId: string | null;
  fromType: LinkEndpointType;
  fromId: string;
  toType: LinkEndpointType;
  toId: string;
  linkType: LinkType;
  metadata?: Record<string, unknown>;
}

// ── Run — one execution of a Playbook ────────────────────────────────────────
export interface RunContext {
  workspaceId: string;
  userId: string;
  /** The instantiated session this run drives. */
  sessionId: string;
  /** The channel room for the run. */
  channelId?: string | null;
  /** Resolved goal (goalTemplate + params). */
  goal: string;
  /** The current input item when driven by an InputStrategy. */
  input?: unknown;
  /** Granted capabilities for this run. */
  capabilities: CapabilityRef[];
  /** The bound subject entity id — any entity profile; propagates so every step auto-scopes to it. */
  subjectId?: string;
  /** Resolved subject display name (so the executor can tell the agent WHAT it works on). */
  subjectName?: string;
  /** Resolved subject profile slug (entity type), e.g. "person", "deal". */
  subjectProfile?: string;
  /** The playbook's declared stages (empty/absent ⇒ progress-only run). */
  stages?: PlaybookStage[];
  /** The active stage key (mirrors focus_sessions.currentStage); null when stageless. */
  currentStage?: string | null;
}

export interface RunResult {
  /**
   * Terminal: completed | failed | proposed. Non-terminal: `running` — the
   * executor dispatched the work but it finishes ASYNCHRONOUSLY (e.g. the
   * is-agent posts into a channel and the IS responds out-of-band; the
   * external-agent fires a BYOA webhook and the agent captures back later).
   * The runner records the run as-is and the run is closed via capture-back.
   */
  status: "running" | "completed" | "failed" | "proposed";
  summary?: string;
  /** Ids of artifacts/entities produced (used to write `produced` links). */
  producedIds?: string[];
  error?: string;
}

/**
 * The agnostic hands. A Playbook names an `ExecutorRef`; the runner resolves it
 * to an Executor and dispatches. Implementations: IS-native, external-agent
 * (BYOA), hybrid. (Implemented in Phase 3.)
 */
export interface Executor {
  ref: ExecutorRef;
  run(ctx: RunContext): Promise<RunResult>;
}

// ── Capability — the unified read-model over the 4 source systems ────────────
/**
 * The normalized shape the Phase-1 adapters produce from builtin IS tools,
 * code/instruction skills, intelligence_commands, and source providers — so a
 * Playbook can grant capabilities uniformly and the AI can discover them.
 */
/** The full read-model kind set: grantables + the discoverable source systems. */
export type CapabilityKind = GrantableKind | "source-provider" | "builtin-tool";

export interface Capability {
  kind: CapabilityKind;
  id: string;
  name: string;
  description?: string | null;
  inputSchema: Record<string, unknown>;
  credentials?: CredentialRequirement[];
  executor: ExecutorRef;
  /** Whether AI use is auto-approved or routed through a proposal. */
  governance: "auto" | "propose";
  /**
   * The connection's structured verb catalog WITH each verb's resolved
   * grant-state — the capability-matrix axis. Present for tools that carry a
   * `tools.capabilities` catalog; the grant-state is joined from the active
   * `vault_grants` row for the tool (one connection × verb × grant row each).
   * Empty/undefined for capabilities with no verb catalog (skills, commands,
   * verb-less provider tools).
   */
  verbs?: CapabilityVerbState[];
}

/**
 * One row of the connection × verb × grant matrix: a Tool's verb annotated with
 * the live grant-state derived from `vault_grants`. The read-model joins each
 * `ToolVerb` (from `tools.capabilities`) with the tool's active grant so a UI /
 * the AI can see, per verb, whether it is granted and at what exec-mode.
 */
export interface CapabilityVerbState extends ToolVerb {
  /** True when an active (non-revoked, non-expired) grant exists for the tool. */
  granted: boolean;
  /**
   * The effective exec-mode for this verb: the active grant's exec-mode when
   * granted, else the verb's `govDefault`. This is what the gate would apply.
   */
  effectiveExecMode: ExecMode;
}

// ── CapabilityDefinition — a config descriptor that INSTANTIATES a set of ─────
// {vault secrets · tools · skills}, the capability-layer counterpart to a
// workspace PackageDefinition (which instantiates {profiles · views}).
//
// The applier (`createCapabilityFromDefinition`) interpolates `{{paramName}}`
// placeholders in every string field, then creates the vault secrets, tools,
// and skills THROUGH the existing governed router callers — never raw inserts.
// A tool's `credentialRef` may point at a template-LOCAL vault `ref`; the
// applier remaps it to the real `vault://<id>` returned when the secret is
// created. These contracts are pure shapes — NO I/O, NO zod — mirroring the
// rest of this package; the Hub-REST door + service own validation.

/** A declared parameter the applier fills from the `params` map. */
export interface CapabilityParamSpec {
  name: string;
  label?: string;
  type?: PlaybookParamType;
  required?: boolean;
  default?: unknown;
  description?: string;
}

/**
 * A vault secret the definition creates. `value` is the (templated) plaintext —
 * typically `"{{apiKey}}"` so the real secret comes from a param, never the JSON.
 * `ref` is a template-LOCAL handle a ToolDef.credentialRef can reference; the
 * applier substitutes it with the real `vault://<id>` after creation.
 */
export interface CapabilityVaultDef {
  /** Template-local handle (e.g. "apiKeySecret"); referenced by tool credentialRef. */
  ref: string;
  /** Display name of the stored secret. */
  name: string;
  /** Secret value — usually a `{{param}}` placeholder. */
  value: string;
  /**
   * Vault secret type — mirrors the `secret_type` pg enum (underscore form, kept
   * in lock-step with @synap/database). Defaults to "api_key" in the applier.
   */
  type?:
    | "password"
    | "api_key"
    | "credential"
    | "note"
    | "card"
    | "identity"
    | "ssh_key"
    | "certificate"
    | "env_variable"
    | "database"
    | "oauth";
  /** Provider/service id for grouping (e.g. "stripe"). */
  service?: string;
  description?: string;
}

/** A tool the definition creates — mirrors the tools.create body (string fields templated). */
export interface CapabilityToolDef {
  name: string;
  kind: ToolKind;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /**
   * Opaque credential ref. May be a real `vault://`/`nango://` ref OR a
   * template-local vault `ref` (resolved to the created `vault://<id>`).
   */
  credentialRef?: string;
  executor?: ExecutorRef;
  config?: Record<string, unknown>;
  /** Descriptive behavioral config stored in tool.metadata (does NOT reset approval). */
  metadata?: Record<string, unknown>;
}

/**
 * Declarative spec for a `kind:'declarative'` capability verb — a deterministic
 * provider HTTP call the POD executes IN-PROCESS via `triggerProviderAction`
 * (Tier-1: no Intelligence Service, no sandbox isolate). The canonical copy of
 * this contract; `@synap/database`'s `ProviderVerbSpec` mirrors it (re-declared
 * there to keep the schema package dependency-free).
 *
 * `{{param}}` tokens in `pathTemplate`/`query`/`body` are filled from the
 * (param-mapped) call parameters. `default:"@now"` ⇒ current ISO timestamp.
 * Dot-paths in `responseShape` index into the response body.
 */
export interface ProviderVerbSpec {
  /** Tool NAME — passed verbatim to `triggerProviderAction.provider`. */
  tool: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path with `{{param}}` interpolation. */
  pathTemplate: string;
  /** Query params; values may be `{{param}}`; arrays → repeated query keys. */
  query?: Record<string, string | string[]>;
  body?: Record<string, unknown>;
  baseUrlOverride?: string;
  /** Static custom request headers (e.g. Cal.com's `cal-api-version`). Auth wins. */
  headers?: Record<string, string>;
  paramMapping?: Record<
    string,
    {
      required?: boolean;
      default?: unknown;
      clampMin?: number;
      clampMax?: number;
      encode?: "uri";
    }
  >;
  responseShape?: {
    /** Dot-path to the collection array in the response body. */
    collectionPath?: string;
    /** Output key for the mapped collection (default "results"). */
    collectionAs?: string;
    /** outField → dot-path within each collection element. */
    item?: Record<string, string>;
    /** outField → dot-path on the root body (value may be `{{param}}` or `@count`). */
    scalar?: Record<string, string>;
    /** outField → header-name (case-insensitive) — extracts `payload.headers:[{name,value}]`. */
    headers?: Record<string, string>;
  };
  expand?: {
    /** Dot-path (in the shaped list result) to the array of items to expand. */
    forEachIdFrom: string;
    /** Per-id detail call (its own responseShape merged into each list item). */
    detail: Omit<ProviderVerbSpec, "tool" | "expand">;
    /** Bounded parallelism for the detail fan-out (default 5). */
    concurrency?: number;
    merge: "detail-into-list-item";
  };
}

/** A skill the definition creates — mirrors the skills.create body. */
export interface CapabilitySkillDef {
  name: string;
  /**
   * instruction — prompt text · code — JS run in the IS isolate (Tier-2) ·
   * declarative — provider-verb spec run in-process on the pod (Tier-1) ·
   * builtin — first-party op run in-process via a governed handler (Tier-0).
   */
  kind?: "instruction" | "code" | "declarative" | "builtin";
  scope?: "pod" | "user" | "workspace";
  agentTypes?: string[];
  description?: string;
  /**
   * Executable source (kind="code") or instruction text (kind="instruction").
   * Optional — a `kind:'declarative'` skill carries `providerSpec` instead, and
   * a `kind:'builtin'` skill carries neither (its name resolves to a handler).
   */
  code?: string;
  /** Declarative provider-verb spec (kind="declarative"). */
  providerSpec?: ProviderVerbSpec;
  parameters?: Record<string, unknown>;
  category?: string;
  executionMode?: "sync" | "async";
  timeoutSeconds?: number;
  /**
   * Names of `tools[]` in THIS definition the skill requires. The applier maps
   * each name to the created tool's id and writes `skill → requires → tool` links.
   */
  requires?: string[];
}

/**
 * The full capability template. `key` identifies it; `params` declare the
 * substitution variables; `vault`/`tools`/`skills` are created in that order.
 */
export interface CapabilityDefinition {
  key: string;
  name: string;
  description?: string;
  params?: CapabilityParamSpec[];
  vault?: CapabilityVaultDef[];
  tools: CapabilityToolDef[];
  skills: CapabilitySkillDef[];
  /**
   * Content-addressed hash of this template's canonical definition, injected by
   * the Control Plane into the served definition (flows through
   * `capability_template_cache.definition` jsonb). CONSUMED, never recomputed,
   * by the pod: a fast equality check against an installed capability's
   * `metadata.contentHash` short-circuits the reconcile drift diff. Absent on
   * older cache rows — treat as "unknown" and fall back to a structural diff.
   */
  contentHash?: string;
  /**
   * How the boot-time/on-demand capability reconcile should converge a drifted
   * install: `"auto"` (default) re-applies through the governed
   * `createCapabilityFromDefinition` door; `"notify"` reports the drift as an
   * `updatesAvailable` entry without applying, deferring to a human/UI decision.
   */
  updatePolicy?: "auto" | "notify";
}

// ── LoopDefinition — a config descriptor that INSTANTIATES an autonomy loop ────
// The proactive/autonomous counterpart to a `CapabilityDefinition`. Where a
// CapabilityDefinition instantiates {vault · tools · skills}, a LoopDefinition
// instantiates {playbooks · triggers}: a proactive loop becomes a GOVERNED set
// of session-template playbooks plus the automation triggers that fire them.
//
// The applier (`createLoopFromDefinition`) interpolates `{{paramName}}`
// placeholders in every string field (the SAME `{{var}}` scheme + shared
// `interpolateDeep` the capability applier uses), then creates each playbook
// THROUGH the governed `playbooksRouter.create` caller (which auto-materializes
// the playbook's inline cron `schedule` via the one shared cron primitive) and
// each trigger THROUGH the governed `automationsRouter.create` caller (a
// trigger → single `playbook_run` flow node, the SAME flow primitive the
// playbook-schedule sugar emits). These contracts are pure shapes — NO I/O,
// NO zod — mirroring the rest of this package; the Hub-REST door + service own
// validation.

/** A declared parameter the loop applier fills from the `params` map. */
export interface LoopParamSpec {
  name: string;
  label?: string;
  type?: PlaybookParamType;
  required?: boolean;
  default?: unknown;
  description?: string;
}

/**
 * A playbook (session template) the loop definition creates. `ref` is a
 * template-LOCAL handle a LoopTriggerDef.playbookRef references; the applier
 * maps it to the created playbook's real id. Mirrors the `playbooks.create`
 * body (string fields templated). An inline `schedule` auto-materializes its
 * backing cron automation for free (via the governed create path).
 */
export interface LoopPlaybookDef {
  /** Template-local handle (e.g. "briefing"); referenced by trigger playbookRef. */
  ref: string;
  name: string;
  goalTemplate: string;
  description?: string;
  /** Declared run-params. Conforms to PlaybookParam; stored loosely (validated at the boundary). */
  params?: Record<string, unknown>[];
  executor?: ExecutorRef;
  /** "What to check" — conforms to InputStrategy; stored loosely (validated at the boundary). */
  inputStrategy?: Record<string, unknown>;
  /** Session-room spec — conforms to ChannelSpec; stored loosely (validated at the boundary). */
  channelSpec?: Record<string, unknown>;
  /** Conforms to ExpectedOutput[]; stored loosely (validated at the boundary). */
  expectedOutputs?: Record<string, unknown>[];
  /** Capabilities granted to the playbook (resolved local refs → `grants` links). */
  grants?: CapabilityRef[];
  /** Inline schedule — materializes the backing cron automation via the create path. */
  schedule?: PlaybookSchedule;
  /** Conforms to PlaybookStage[]; stored loosely (validated at the boundary). The
   * authored-loop path (create-from-definition) MUST thread these — playbooks.create
   * already persists them; without this they were silently dropped. */
  stages?: Record<string, unknown>[];
  /** Subject-profile config (jsonb); stored loosely. Threaded alongside `stages`. */
  subjectProfile?: Record<string, unknown>;
  /**
   * Kind + Facets: subject-FACET config — which role (role-profile) this
   * playbook operates over, the facet twin of `subjectProfile`. Shape:
   * `{ facetSlug: string; filter?: Record<string, unknown> }`. Type-level /
   * forward-compat only for now: validated at the definition boundary, not yet
   * persisted (no dedicated column — a kind playbook targets `subjectProfile`).
   */
  subjectFacet?: Record<string, unknown>;
}

/**
 * A trigger that fires one of the loop's playbooks. Maps to a single
 * `automations` row (trigger → `playbook_run` node). `playbookRef` resolves
 * against a LoopPlaybookDef.ref created in the same apply.
 */
export interface LoopTriggerDef {
  name: string;
  description?: string;
  trigger: {
    type: "cron" | "event" | "manual";
    /** 5-field cron expression when type="cron". */
    cron?: string;
    /** Event pattern when type="event". */
    eventType?: string;
  };
  /** Template-local ref of the playbook this trigger runs. */
  playbookRef: string;
  /** Static params mapped onto the run. */
  params?: Record<string, unknown>;
}

/**
 * The full loop template. `key` identifies it; `params` declare the
 * substitution variables; `playbooks` then `triggers` are created in order.
 */
export interface LoopDefinition {
  key: string;
  name: string;
  description?: string;
  params?: LoopParamSpec[];
  playbooks: LoopPlaybookDef[];
  triggers?: LoopTriggerDef[];
}
