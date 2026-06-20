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
  | "project";
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
}

/** A skill the definition creates — mirrors the skills.create body. */
export interface CapabilitySkillDef {
  name: string;
  kind?: "instruction" | "code";
  scope?: "pod" | "user" | "workspace";
  agentTypes?: string[];
  description?: string;
  /** Executable source (kind="code") or instruction text (kind="instruction"). */
  code: string;
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
