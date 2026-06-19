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
  | "concerns";

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
