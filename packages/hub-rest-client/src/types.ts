/**
 * @synap-core/hub-rest-client — Hub Protocol REST API Types
 *
 * Canonical TypeScript interfaces for all objects returned by the
 * Synap Hub Protocol REST API (`/api/hub/*`).
 *
 * These are the source of truth for external consumers (Raycast extension,
 * CLI, third-party integrations). Keep in sync with hub-protocol-rest.ts
 * response shapes in synap-backend.
 *
 * Zero runtime dependencies — pure TypeScript interfaces.
 */

// ─── Core entities ───────────────────────────────────────────────────────────

export interface HubEntity {
  id: string;
  title: string;
  profileSlug: string;
  workspaceId: string | null;
  /** JSONB property bag — keys depend on the profile schema */
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // Convenience shortcuts pulled from properties at response time
  status?: string;
  priority?: string;
  dueDate?: string;
  content?: string;
  url?: string;
  /** Short, server-generated summary suitable for lists and agent context. */
  preview?: string | null;
  /** Optional long-form summary returned by entity detail routes. */
  description?: string | null;
  /** Linked versioned document, when this entity has long-form content. */
  documentId?: string | null;
  /** System-managed fields returned by the canonical entity wire codec. */
  systemData?: Record<string, unknown>;
  version?: number;
}

export interface HubDocument {
  id: string;
  title: string;
  content: string;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
  userId?: string;
  type?: "text" | "markdown" | "code" | "html" | "pdf" | "docx";
  language?: string | null;
}

export interface HubChannel {
  id: string;
  name: string;
  type:
    | "personal"
    | "thread"
    | "sub_thread"
    | "feed"
    | "external"
    | "agent_collab"
    | "group"
    | "run";
  workspaceId: string | null;
  agentType?: string;
  contextObjectType?:
    | "workspace"
    | "entity"
    | "document"
    | "view"
    | "project"
    | "task"
    | "user"
    | "external"
    | null;
  contextObjectId?: string | null;
  createdAt: string;
}

export interface HubWorkspace {
  id: string;
  name: string;
  role?: string;
  description?: string | null;
  workspaceType?: string;
  accessKind?: "member" | "pod_visible";
  /** Live non-deleted entities in this workspace. */
  entityCount?: number;
  /** Projects that run through this workspace (INDEX, not an ACL). */
  usedByProjectIds?: string[];
}

/** GET /api/hub/workspaces — canonical Hub Protocol shape (not `data`). */
export interface HubWorkspacesListResponse {
  workspaces: HubWorkspace[];
}

/** GET /api/hub/users/me returns at least `id` (and `scopes`); email may be omitted. */
export interface HubUser {
  id: string;
  email?: string;
  name?: string;
  scopes?: string[];
  /** True only when the server authenticated this request as an agent credential. */
  isAgent: boolean;
}

export interface HubMemoryResult {
  id: string;
  content: string;
  score?: number;
  createdAt: string;
}

// ─── Response wrappers ───────────────────────────────────────────────────────

export interface HubListResponse<T> {
  data: T[];
  total?: number;
  hasMore?: boolean;
}

export interface HubSingleResponse<T> {
  data: T;
}

// ─── Input types ─────────────────────────────────────────────────────────────

export interface CreateEntityInput {
  profileSlug: string;
  title: string;
  workspaceId?: string;
  /** Existing project to file this entity into via `belongs_to_project`. */
  projectId?: string;
  /** Short description rendered with the entity; long-form text belongs in content. */
  description?: string;
  properties?: Record<string, unknown>;
  content?: string;
  url?: string;
  status?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  dueDate?: string;
  // Agent attribution — the IS threads these so writes are recorded as agent
  // actions (governance/provenance); the CLI omits them. The backend reads them
  // from the body (sessionId is also accepted via the x-session-id header).
  agentUserId?: string;
  sessionId?: string;
  reasoning?: string;
  /** Origin signal for audit/provenance. It does not grant permissions. */
  source?: HubWriteSource;
  sourceMessageId?: string;
  extractedFromMessageId?: string;
  /** Role profiles to attach with this entity when the write applies inline. */
  facets?: Array<{
    /** `profileSlug` is accepted by REST; `slug` remains valid for legacy callers. */
    profileSlug?: string;
    slug?: string;
    status?: string;
    properties?: Record<string, unknown>;
    contextEntityId?: string;
  }>;
}

export interface UpdateEntityInput {
  title?: string;
  properties?: Record<string, unknown>;
  content?: string;
  url?: string;
  status?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  dueDate?: string;
}

export interface CreateDocumentInput {
  title: string;
  content?: string;
  workspaceId?: string;
  entityId?: string;
  type?: HubDocument["type"];
  reasoning?: string;
  agentUserId?: string;
  sourceMessageId?: string;
  sessionId?: string;
}

/** Full-document replacement input for PATCH /documents/:id. */
export interface UpdateDocumentInput {
  content: string;
  title?: string;
  agentUserId?: string;
  sourceMessageId?: string;
  sessionId?: string;
}

export interface HubDocumentChange {
  op: "insert" | "delete" | "replace";
  position?: number;
  range?: [number, number];
  text?: string;
}

/** Submit a governed edit proposal without replacing a document directly. */
export interface CreateDocumentProposalInput {
  documentId: string;
  agentUserId?: string;
  threadId?: string;
  sourceMessageId?: string;
  sessionId?: string;
  proposalType?: "ai_edit" | "user_suggestion" | "review_comment";
  changes: HubDocumentChange[];
  proposedContent: string;
  originalContent?: string;
}

/** Proposal rows vary slightly by pod version; these stable fields are shared. */
export interface HubDocumentProposalResult {
  id?: string;
  proposalId?: string;
  status?: string;
  reviewUrl?: string;
  [key: string]: unknown;
}

export interface StoreMemoryInput {
  fact: string;
  context?: string;
  workspaceId?: string;
}

export interface SendToChannelInput {
  channelId: string;
  content: string;
  /** Defaults to the authenticated user (GET /users/me). */
  userId?: string;
  role?: "system" | "assistant" | "user";
  /** When true, may queue an IS response on AI-active threads (server-side). */
  autoRespond?: boolean;
  workspaceId?: string;
}

// ─── Setup types ─────────────────────────────────────────────────────────────

export interface AgentSetupResult {
  hubApiKey: string;
  agentUserId: string;
  workspaceId: string;
}

export interface PodStatus {
  url: string;
  healthy: boolean;
  version?: string;
}

// ─── Capture pipeline types ───────────────────────────────────────────────────

/**
 * A single tappable chip in a structured follow-up. Mirrors the IS `structure`
 * output and the frontend capture-pipeline contract EXACTLY (do NOT narrow).
 */
export interface FollowUpChip {
  label: string;
  value: string;
  action:
    "link_entity" | "set_property" | "add_relation" | "confirm" | "dismiss";
  icon?: string;
  entityId?: string;
  propertyKey?: string;
}

/** Structured follow-up the IS may emit instead of a plain string question. */
export interface StructuredFollowUp {
  question: string;
  suggestions: FollowUpChip[];
}

/** One field of an AI-authored dynamic form. `type` is a free string (field kind). */
export interface DynamicFormField {
  key: string;
  label: string;
  type: string;
  constraints?: {
    enum?: string[];
    min?: number;
    max?: number;
    pattern?: string;
  };
  required?: boolean;
  help?: string;
}

/** AI-authored guided-capture form spec (additive, null-safe). */
export interface DynamicFormSpec {
  title?: string;
  note?: string;
  fields: DynamicFormField[];
}

export interface CaptureProposal {
  tempId: string;
  profileSlug: string;
  title: string;
  description?: string;
  /** Long-form body preserved through plan → commit as a linked document. */
  content?: string;
  properties?: Record<string, unknown>;
  /** Role profiles proposed alongside the primary kind. */
  facets?: Array<{
    profileSlug: string;
    status?: string;
    properties?: Record<string, unknown>;
    /** Batch-local entity reference used by captureExecute. */
    contextTempId?: string;
  }>;
  confidence: number;
  action: "create" | "link" | "dismiss";
  linkedEntityId?: string;
  linkedEntityTitle?: string;
  dedupCandidates?: Array<{
    entityId: string;
    title: string;
    profileSlug: string;
    score: number;
  }>;
}

export interface CaptureRelation {
  sourceTempId: string;
  targetTempId: string;
  relationType: string;
}

/**
 * Input for POST /capture/structure. `text` is optional — a binary input can
 * arrive via `file` instead and be normalized to text by IS's extractor before
 * structuring — but the server's `CaptureStructureRequestSchema` `.refine`
 * requires at least one of `text` / `file` / `url`; `captureStructure()`
 * enforces the same rule client-side before sending.
 */
export interface CaptureStructureInput {
  text?: string;
  /**
   * Binary/text source normalized to text by IS before structuring. Shape
   * MIRRORS the server's `file` field (and `CaptureExecuteInput.file` below) —
   * `content` is base64/utf8 per `encoding`.
   */
  file?: {
    content: string;
    mimeType: string;
    filename?: string;
    encoding?: "base64" | "utf8";
  };
  url?: string;
  html?: string;
  context?: string;
  /** Extraction bias (e.g. lead-capture channel intake hint). */
  instructions?: string;
  workspaceId?: string;
  previousEntities?: CaptureProposal[];
}

/**
 * WHY a capture degraded.
 *
 * Two families, and the difference is what a client must tell its user:
 *  • pod plumbing (`is_*`) — the structurer itself failed; retrying is sensible.
 *  • Intelligence Service extraction honesty (everything else) — the input
 *    could not be read. Several of these are PERMANENT CONFIGURATION states
 *    (`vision_provider_not_configured`, `transcription_provider_not_configured`)
 *    where telling the user to "retry when it's back" is simply false.
 *
 * Open-ended on purpose (`string & {}`): the IS owns this vocabulary and may
 * add reasons this union has not been taught. A client must humanize an
 * unknown value, never leak the raw token.
 */
export type CaptureDegradedReason =
  | "is_auth_error"
  | "is_invalid_response"
  | "is_empty_result"
  | "pdf_scanned_needs_ocr"
  | "pdf_missing_binary"
  | "vision_provider_not_configured"
  | "vision_provider_failed"
  | "image_missing_binary"
  | "transcription_provider_not_configured"
  | "audio_missing_binary"
  | "docx_missing_binary"
  | "docx_empty"
  | "html_empty"
  | "unsupported_type"
  | (string & {});

/**
 * Summary of the extraction pass, present when a `file` input was normalized to
 * text before structuring. Echo `text` back as `CaptureExecuteInput.file
 * .extractedText` so a kept original lands with a real document body.
 */
export interface CaptureExtraction {
  kind: string;
  extractor: string;
  metadata?: Record<string, unknown>;
  warnings?: string[];
  /** Extracted body text (absent on the degraded early-return branch). */
  text?: string;
  /** True when the IS truncated `text`. */
  textTruncated?: boolean;
}

export interface CaptureStructureResponse {
  proposals: CaptureProposal[];
  relations: CaptureRelation[];
  /** The structurer could not produce a real plan, so the pod returned a raw-note fallback. */
  degraded?: boolean;
  /** WHY it degraded — see `CaptureDegradedReason`. Present whenever `degraded`. */
  degradedReason?: CaptureDegradedReason;
  /** Extraction summary for a `file` input (kind/extractor/warnings/text). */
  extraction?: CaptureExtraction;
  followUp: string | StructuredFollowUp | null;
  formSpec?: DynamicFormSpec | null;
  targetWorkspaceId?: string | null;
  targetWorkspaceConfidence?: number | null;
  targetWorkspaceReason?: string | null;
  /**
   * WHERE this capture will land — the SOURCE OF TRUTH (`CapturePlacement`,
   * `@synap-core/types`): the deterministic/ambient destination plus the AI's
   * suggestion when there is one. `targetWorkspace*` mixes the two and is kept
   * for older clients. Derive the destination with
   * `deriveWorkspacePlacementView`, never by reading these fields.
   */
  placement?: {
    workspaceId: string | null;
    workspaceName: string | null;
    deterministic: boolean;
    suggestion?: {
      workspaceId: string;
      workspaceName: string;
      reason: string | null;
      /** Ranked "Why?" rows; `weight` sizes a bar, never rendered as a number. */
      alternatives: Array<{
        workspaceId: string;
        workspaceName: string;
        weight: number;
      }>;
    };
  };
  targetProjectId?: string | null;
  /**
   * Soft meta-structure suggestions (display-only chips). Never materialize.
   * Additive — absent when the model has nothing to suggest.
   */
  architectureSuggestions?: Array<{
    kind?:
      | "workspace_template"
      | "new_workspace"
      | "project"
      | "view"
      | "role"
      | "playbook";
    title: string;
    reason?: string;
    confidence?: number;
    payload?: Record<string, unknown>;
  }>;
  dedupCandidates?: Record<
    string,
    Array<{
      entityId: string;
      title: string;
      profileSlug: string;
      score: number;
    }>
  >;
}

export interface CaptureExecuteInput {
  entities: Array<{
    tempId: string;
    profileSlug: string;
    title: string;
    description?: string;
    properties?: Record<string, unknown>;
    /** Legacy structure-output field; the execute route ignores it. */
    action?: "create" | "link" | "dismiss";
    linkedEntityId?: string;
    confidence?: number;
    /** Long-form body materialized as a linked document by the capture pipeline. */
    content?: string;
    /** Reuse an existing entity instead of creating one for this batch entry. */
    existingEntityId?: string;
    /** Role profiles to attach after the primary kind materializes. */
    facets?: Array<{
      profileSlug: string;
      status?: string;
      properties?: Record<string, unknown>;
      contextTempId?: string;
    }>;
  }>;
  relations?: CaptureRelation[];
  /** Cross-cutting project lens to file the created entities into. */
  projectId?: string | null;
  /** Explicit reviewed placement override; unlike workspaceId it is never inferred. */
  targetWorkspaceId?: string | null;
  /** Preserve the original binary source with the primary derived entity. */
  keepRaw?: boolean;
  file?: {
    /** Base64 payload; server caps it at about 5MB decoded. */
    content: string;
    mimeType: string;
    filename?: string;
    /**
     * `CaptureStructureResponse.extraction.text` echoed back, so the kept
     * original is stored with a real document body instead of an empty one.
     * The pod cannot re-derive it — extraction runs in the Intelligence
     * Service and the caller is already holding the result.
     */
    extractedText?: string;
    /** Mirrors `extraction.textTruncated`; recorded on the stored document. */
    extractedTextTruncated?: boolean;
  };
  /** Client-stable retry namespace for this capture execution. */
  idempotencyKey?: string;
  /**
   * Workspace routing (shared across all capture doors). Forward the AI's
   * structure hints + the caller's mode so the door auto-routes; the backend
   * decides the final workspace (auto/ask/locked, confidence + membership gated).
   */
  workspaceRouting?: "auto" | "ask" | "locked";
  aiWorkspaceId?: string | null;
  aiWorkspaceConfidence?: number | null;
  aiWorkspaceReason?: string | null;
  /**
   * What the person did with the destination before saving — derive it with
   * `deriveWorkspacePlacementView` (`@synap-core/types`), never locally.
   * A headless caller (CLI, agent) passes `ignored` / nothing: it never shows
   * the suggestion, so the suggestion stays a proposal.
   */
  workspaceChoice?: "accepted" | "changed" | "removed" | "ignored";
}

/** One planned entity in the proposal-first graph capture door. */
export interface CaptureGraphEntity {
  /** Batch-local ID used by relations and bindings. Must be unique per request. */
  ref: string;
  profileSlug: string;
  title?: string;
  /** Short descriptive body retained on the approved entity. */
  description?: string;
  /** Long-form body materialized through the canonical document path on approval. */
  content?: string;
  properties?: Record<string, unknown>;
  /** Link this graph node to an existing entity rather than creating it. */
  existingEntityId?: string;
  /** Role profiles to attach after the primary kind materializes. */
  facets?: Array<{
    profileSlug: string;
    status?: string;
    properties?: Record<string, unknown>;
    contextRef?: string;
  }>;
}

export interface CaptureGraphRelation {
  sourceRef: string;
  targetRef: string;
  type: string;
}

/** Optional post-approval external-channel binding for an entity in the graph. */
export interface CaptureGraphBinding {
  externalChannelId: string;
  entityRef: string;
  branchPurpose?: "client-comms" | "team";
  title?: string;
}

/**
 * Bounded original-input context retained in proposal data for review/retry.
 * It is deliberately not a materialized source artifact or entity provenance.
 */
export interface CaptureGraphRawSource {
  rawText?: string;
  sourceUrl?: string;
  label?: string;
  mimeType?: string;
  hash?: string;
  idempotencyKey?: string;
}

/**
 * ── CONNECTED PLAN steps ─────────────────────────────────────────────────
 *
 * Refs share the entity ref namespace; validated in full (refs, cycles,
 * limits, ownership, evidence) by the core. These mirror the server's
 * `Composite*Op` shapes (`@synap-core/types` proposals) minus the `op`
 * discriminator, which the server stamps on before materializing.
 */
export interface CaptureGraphSessionStep {
  /** Stable handle for this session within the plan (e.g. "s1"). */
  ref: string;
  /** Short one-line name (≤ SESSION_TITLE_MAX). */
  title?: string | null;
  /** The outcome. Required. */
  goal: string;
  /** Parent = the `spawned_from` edge (a detour or planned sub-session). */
  parentRef?: string;
  parentSessionId?: string;
  /** `blocked_by` edges declared at birth. */
  blockedByRefs?: string[];
  blockedBySessionIds?: string[];
  /** The entity this session is about (a session ref or a real id). */
  subjectRef?: string;
  subjectEntityId?: string;
  /** The project it belongs to (a project ref or a real id). */
  projectRef?: string;
  projectId?: string;
  /** Declared deliverables — sanitized by the session door at apply time. */
  expectedOutputs?: Array<Record<string, unknown>>;
}

export interface CaptureGraphDocumentStep {
  ref: string;
  title: string;
  /** Markdown body. */
  content: string;
  /** Attach as that entity's body (`entities.documentId`). */
  entityRef?: string;
  entityId?: string;
  /** Record as that session's output (the session artifact ledger). */
  sessionRef?: string;
  sessionId?: string;
  /** The declared output slot of that session this document claims. */
  expectedLabel?: string;
}

export interface CaptureGraphProjectStep {
  ref: string;
  name: string;
  description?: string;
  /** The real-world thing the project is about (`project --targets--> entity`). */
  subjectRef?: string;
  subjectEntityId?: string;
  /** Plan entity refs that count as the project's evidence. */
  evidenceRefs?: string[];
  /** Existing entities that count as evidence (must be visible). */
  evidenceEntityIds?: string[];
}

/** The edges a plan may declare — both are session↔session `links` types. */
export interface CaptureGraphLinkStep {
  /** `from --blocked_by--> to` (from waits on to) · `from --spawned_from--> to` (to is from's parent). */
  type: "blocked_by" | "spawned_from";
  fromRef?: string;
  fromSessionId?: string;
  toRef?: string;
  toSessionId?: string;
}

/** Input for POST /capture/graph. The server always creates one composite proposal. */
export interface SubmitCaptureGraphInput {
  workspaceId?: string | null;
  /** Existing project to file every newly created graph entity into on approval. */
  projectId?: string | null;
  /** Origin signal preserved through proposal approval and materialization. */
  source?: HubWriteSource;
  sourceMessageId?: string;
  sessionId?: string;
  rawSource?: CaptureGraphRawSource;
  entities?: CaptureGraphEntity[];
  relations?: CaptureGraphRelation[];
  bindings?: CaptureGraphBinding[];
  // CONNECTED PLAN steps — refs share the entity ref namespace; validated
  // in full by the core. A call may carry entities, plan steps, or both.
  sessions?: CaptureGraphSessionStep[];
  documents?: CaptureGraphDocumentStep[];
  projects?: CaptureGraphProjectStep[];
  links?: CaptureGraphLinkStep[];
  summary?: string;
}

export interface SubmitCaptureGraphResult {
  /** Composite graph writes are proposal-first, so this receipt begins pending. */
  writeReceipt?: HubWriteReceipt;
  proposalId?: string;
  entityCount: number;
  relationCount: number;
  bindingCount: number;
  reviewUrl?: string;
  summary: string;
}

export interface CaptureExecuteResponse {
  created: Array<{
    tempId: string;
    entityId: string;
    profileSlug: string;
    linked: boolean;
  }>;
  relations: Array<{
    sourceTempId: string;
    targetTempId: string;
    relationType: string;
  }>;
  /**
   * The AI's pending "move to X?" — NOTHING was moved (an AI pick proposes, it
   * never places data), on every outcome (applied and proposed). Confirm it by
   * re-filing with an explicit workspace. There is no `movedToWorkspace`.
   */
  pendingWorkspaceSwitch?: {
    suggestedWorkspaceId: string;
    /** `null` when the pod could not name it (never a raw id in its place). */
    suggestedWorkspaceName: string | null;
    reason: string | null;
    confidence: number | null;
  };
}

// ─── Recall (ask) ──────────────────────────────────────────────────────────────

/** One substrate's slice of an `ask` answer (semantic / procedural / episodic). */
export interface AskAnswerBlock {
  substrate: string;
  items: Array<Record<string, unknown>>;
  status: "ok" | "error";
}

/**
 * The provenance-tagged result of `ask` — glass-box: it says which substrates
 * were queried (`routedTo`), what the query's cue suggested (`intent`), and the
 * per-substrate answer blocks. Shape mirrors the backend `AskResult`.
 */
export interface AskResponse {
  query: string;
  routedTo: string[];
  intent: string;
  answers?: AskAnswerBlock[];
  verdict?: string;
  degraded?: string[];
  pending?: KnowledgeAnswerPending;
  [key: string]: unknown;
}

/** One source cited by POST /knowledge/answer. */
export interface KnowledgeAnswerSource {
  substrate: string;
  id: string;
  title: string;
}

/** A pending capture that text-matched the query — not a fact; do not re-capture. */
export interface KnowledgeAnswerPendingMatch {
  proposalId: string;
  proposalType: string;
  summary?: string;
  entityTitle?: string;
  profileSlug?: string;
  reviewUrl: string;
  score: number;
}

export interface KnowledgeAnswerPending {
  notice: string;
  matches: KnowledgeAnswerPendingMatch[];
}

export interface KnowledgeAnswerFailure {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * POST /knowledge/answer — retrieve (same as ask) then synthesize.
 * `answer` is null when synthesis is unavailable; sources/pending still return.
 */
export interface KnowledgeAnswerResponse {
  answer: string | null;
  sources: KnowledgeAnswerSource[];
  routedTo: string[];
  degraded: string[];
  pending?: KnowledgeAnswerPending;
  /**
   * Present only when the context budget dropped retrieved items.
   * `omittedSources` names the dropped items so the caller can fetch them by id
   * — without it the caller was told its answer was partial and given no door
   * to complete it.
   */
  truncated?: {
    omitted: number;
    total: number;
    /**
     * OPTIONAL for VERSION SKEW, not because the pod may omit it.
     *
     * A current pod always sends this. But the IS and the CLI talk to pods
     * they do not deploy in lockstep, and a pod running the build before this
     * field existed returns `truncated` WITHOUT it. Typing it as required made
     * every consumer's `truncated.omittedSources.length` a crash against an
     * older pod — turning a graceful degradation into an outage. Read it as
     * "the ids, when the pod is new enough to send them".
     */
    omittedSources?: KnowledgeAnswerSource[];
  };
  error?: string;
  failure?: KnowledgeAnswerFailure;
}

// ─── Diagnose (third door alongside ask + capture) ───────────────────────────

/**
 * Input for POST /api/hub/diagnose. Mode is derived from payload shape, not a
 * chosen endpoint: {} → whole-pod health · {type} → class surface · {id} →
 * auto-detect object · {agentId} → agent scorecard · {runId,flowType} /
 * {flowType,flowId} → run feed/detail.
 */
export interface HubDiagnoseInput {
  agentId?: string;
  id?: string;
  type?: "proposal" | "session" | "capability" | "agent" | "entity" | "run";
  workspaceId?: string | null;
  stuckThresholdHours?: number;
  flowType?:
    "automation" | "playbook" | "capture" | "capability" | "session" | "chat";
  flowId?: string;
  runId?: string;
  limit?: number;
}

/** Diagnose response — server returns z.any(); shape varies by mode. */
export type HubDiagnoseResult = unknown;

// ─── Focus Sessions ──────────────────────────────────────────────────────────

/**
 * One expected-output chip on session create. Mirrors REST
 * ExpectedOutputItemSchema on POST /api/hub/focus-sessions.
 */
export interface FocusSessionExpectedOutput {
  kind: string;
  label: string;
  icon?: string;
  /** Stamped ONLY by `satisfyExpectedOutputs` on approval of a session proposal. */
  status?: "pending" | "done";
  /** The agent's own (unverified) claim that it produced this output. */
  claimedDone?: boolean;
  /** Lineage: the approved proposal whose apply satisfied this output. */
  satisfiedByProposalId?: string;
  /** Agent TYPE this slot was delegated to. A delegation, never a delivery. */
  delegatedTo?: string;
  /** ISO timestamp of the delegation. */
  delegatedAt?: string;
  /** Reviewer's reason, set when a proposal claiming this slot was rejected. */
  returnedReason?: string;
  /** ISO timestamp of the return. */
  returnedAt?: string;
  /**
   * WHO the slot is waiting on. ABSENT MEANS `agent` — no backfill, no default;
   * a stored "agent" and an absent value must stay indistinguishable.
   * `human` is the agent declaring work it CANNOT take.
   */
  owner?: "human" | "agent";
  /**
   * Why the agent could not take it — a CLOSED set, mirrored from
   * `BLOCKED_REASONS` (@synap/playbooks). This package is dependency-free by
   * design, so the union is duplicated rather than imported; the pod's
   * `expectedOutputWireSchema` is the enforcing copy and will reject anything
   * outside it. Only meaningful with `owner: 'human'`.
   */
  blockedReason?:
    | "credential"
    | "permission"
    | "capability"
    | "policy"
    | "decision"
    | "physical";
  /** One line: WHICH thing is missing, not its class. Max 500 chars. */
  why?: string;
  /**
   * ISO timestamp of the moment the slot became the human's — server-stamped,
   * present IFF `owner === 'human'`. Read it, never author it: the pod's
   * reconciler overwrites a value that contradicts `owner`, and it is what an
   * owed-work feed orders and ages its rows by (`focus_sessions.updatedAt`
   * cannot serve — any unrelated write to the session would resurface the row).
   */
  owedSince?: string;
  /**
   * ATTESTATION receipt — the human owner discharged this slot ("I did this").
   * Read-only here: the pod exposes attestation on tRPC only, deliberately, so
   * an agent cannot report that a human did the work the agent could not.
   * Distinct from `satisfiedByProposalId`, which is an APPROVAL's lineage — a
   * `done` slot carries one or the other, and they are different evidence.
   */
  attestedBy?: string;
  /** ISO timestamp of the attestation above. */
  attestedAt?: string;
  /**
   * RETIREMENT receipt — the declaring session was CANCELLED, so the slot
   * stopped being owed without being delivered. Never a delete: the blocker,
   * the `why` and the `owedSince` all remain, and clearing these two fields
   * puts the slot back on the board.
   */
  retiredAt?: string;
  /** Mirrored from `OUTPUT_RETIRED_REASONS` (@synap/playbooks). */
  retiredReason?: "session_cancelled";
  /**
   * WHERE to go for this deliverable — an in-pod object or an external link.
   * ONE union, two arms; nothing else (free text is `why`).
   *
   * This package is dependency-free by design, so the union is duplicated from
   * `OutputRef` (@synap/playbooks) rather than imported — the pod's
   * `outputRefWireSchema` is the enforcing copy and will reject anything else,
   * including a `{kind}` outside the six the visibility floor can adjudicate
   * and a `{url}` that is not http(s).
   *
   * `null` is a WIRE value only and means CLEAR: silence on a wholesale patch
   * means KEEP, so removing a pointer needs a way to say itself. A slot READ
   * back never carries `null` — the pod deletes the key — so a reader may test
   * it for truthiness alone.
   */
  ref?:
    | {
        kind:
          "view" | "cell" | "document" | "entity" | "automation" | "playbook";
        id: string;
      }
    | { url: string }
    | null;
  /**
   * For an ESCALATED-CRITERION slot, the `SessionCriterion.key` it stands for.
   * Read-only here: the pod stamps it where the escalation files the slot, and
   * `expectedOutputWireSchema` refuses a caller authoring one. Absent on every
   * ordinary slot and on criterion slots filed before the field existed —
   * absence means "no criterion to point at", never an error, and never a
   * reason to match the slot's prose label back to a criterion.
   */
  criterionKey?: string;
}

/**
 * Input for POST /api/hub/focus-sessions.
 * Provide `workspaceId` and/or `projectId` (at least one). `userId` is resolved
 * by the client from GET /users/me — callers must not pass it.
 */
export interface CreateFocusSessionInput {
  /** Workspace lens — optional when `projectId` is set. */
  workspaceId?: string;
  /** Project lens — optional when `workspaceId` is set. */
  projectId?: string;
  goal: string;
  correlationId?: string;
  templateId?: string;
  expectedOutputs?: FocusSessionExpectedOutput[];
  channelId?: string;
  agentIds?: string[];
}

/** Applied focus-session row returned by POST /api/hub/focus-sessions. */
export interface HubFocusSession {
  id: string;
  goal: string;
  workspaceId: string | null;
  projectId: string | null;
  status: string;
  userId?: string;
  correlationId?: string | null;
  templateId?: string | null;
  expectedOutputs?: unknown;
  channelId?: string | null;
  progress?: number | null;
  currentStage?: string | null;
  agentIds?: string[];
  closedAt?: string | null;
  verificationReport?: unknown;
  metadata?: unknown;
  startedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/**
 * Governance-gated create: either a pending proposal receipt or the applied
 * session row. `proposed` is normal — never treat it as an error.
 */
export type CreateFocusSessionResult =
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl?: string;
      reviewPath?: string;
      summary?: string;
      message?: string;
      session: null;
    }
  | HubFocusSession;

/**
 * `focus_sessions.status`, duplicated from `@synap-core/types/focus-sessions`
 * for the same dependency-free reason as the rest of this file. `"all"` is the
 * LIST door's own filter value, never a stored state; `"stale"` is stamped
 * only by the reaper, never client-writable (see `UpdatableFocusSessionStatus`).
 */
export type FocusSessionStatus =
  | "active"
  | "paused"
  | "forming"
  | "scheduled"
  | "closed"
  | "failed"
  | "cancelled"
  | "stale";

/** Every `FocusSessionStatus` a CLIENT may WRITE — every one except `stale`. */
export type UpdatableFocusSessionStatus = Exclude<FocusSessionStatus, "stale">;

/**
 * A session's population lens, duplicated from `SESSION_KINDS`
 * (`@synap/api/services/focus-sessions/session-kind.ts`) — projected, never
 * stored.
 */
export type FocusSessionKind = "work" | "run" | "receipt";

/** Options for GET /api/hub/focus-sessions. */
export interface ListFocusSessionsOptions {
  /** Required by the door; defaults to the client's own `workspaceId`. */
  workspaceId?: string;
  /** `"all"` (default here) covers every stored status, `stale` included. */
  status?: FocusSessionStatus | "all";
  limit?: number;
  /**
   * Triage lens — same vocabulary as tRPC `focusSessions.list`. Default here
   * is `"all"`: an agent listing sessions is usually looking for the one it
   * just opened, which a human `"default"` lens would hide.
   */
  lens?: "default" | "triage" | "all";
  /** Population lens. Default here is `"all"` (differs from the human tRPC lens). */
  kind?: FocusSessionKind | "all";
  /** Narrow to the sessions of ONE flow definition. */
  playbookId?: string;
  automationId?: string;
  /** Narrow to sessions ABOUT this subject-spine entity. */
  subjectEntityId?: string;
}

/**
 * One row from GET /api/hub/focus-sessions — `HubFocusSession` plus the two
 * lens projections every LIST row carries (`attachTriage` + `attachSessionKind`
 * — never projected on the single-row GET, which is why they live here and
 * not on `HubFocusSession` itself).
 */
export interface HubFocusSessionListItem extends HubFocusSession {
  kind: FocusSessionKind;
  triage: {
    pending: boolean;
    acceptedAt: string | null;
    acceptedBy: string | null;
  };
}

/** Options for GET /api/hub/focus-sessions/:id. */
export interface GetFocusSessionOptions {
  /**
   * Optional. Provided: membership check + workspace floor (legacy callers).
   * Omitted: owner/user floor only — resolves project-scoped (workspaceId
   * null) sessions too.
   */
  workspaceId?: string;
}

/**
 * GET /api/hub/focus-sessions/:id — the row plus its continuation packet.
 * `rerun` and `continuation` are opaque here (`projectContinuationPacket`'s
 * shape is not re-declared in this dependency-free package — read it, don't
 * guess its fields); `criteria`/`verdict`/`evaluations` are present only when
 * the continuation's own evaluation projection succeeded.
 */
export interface HubFocusSessionWithContinuation extends HubFocusSession {
  rerun: unknown;
  continuation: unknown;
  criteria?: unknown;
  verdict?: unknown;
  evaluations?: unknown;
}

/**
 * One binary acceptance criterion. Duplicated from `sessionCriterionSchema`
 * (`@synap/api/schemas/session-criteria.ts`) / `CRITERION_CHECK_KINDS`
 * (`@synap/playbooks`) for the same dependency-free reason as the rest of this
 * file — the pod's own schema is the enforcing copy.
 */
export interface HubSessionCriterion {
  key: string;
  statement: string;
  required?: boolean;
  check: {
    kind: "evidence" | "capability" | "judge" | "human";
    capability?: string;
    evidenceKey?: string;
    hint?: string;
  };
  stageKey?: string;
}

/**
 * Input for PATCH /api/hub/focus-sessions/:id. Every field is a WHOLESALE
 * replace except `expectedOutputs` (merged server-side by label — see
 * `FocusSessionExpectedOutput`), `metadata`/`verificationReport` (shallow-
 * merged into the existing bag) and `addAgentId` (an APPEND alongside the
 * `agentIds` replace). `null` on `title`/`subjectEntityId`/`followPlaybookId`/
 * `followStageKey` CLEARS the field; `undefined` (the default) leaves it alone.
 */
export interface UpdateFocusSessionInput {
  status?: UpdatableFocusSessionStatus;
  progress?: number;
  channelId?: string;
  correlationId?: string;
  title?: string | null;
  goal?: string;
  agentIds?: string[];
  addAgentId?: string;
  expectedOutputs?: FocusSessionExpectedOutput[];
  verificationReport?: Record<string, unknown>;
  currentStage?: string;
  subjectEntityId?: string | null;
  metadata?: Record<string, unknown>;
  criteria?: HubSessionCriterion[];
  followPlaybookId?: string | null;
  followStageKey?: string | null;
  agentUserId?: string;
  reasoning?: string;
}

/**
 * Governance-gated update: either a pending proposal receipt or the applied
 * row, same shape as `CreateFocusSessionResult` — `proposed` is normal, never
 * an error. `blockGuidelines` rides only when `expectedOutputs` newly declared
 * a blocked slot; `follow` only when `followPlaybookId`/`followStageKey` acted.
 */
export type UpdateFocusSessionResult =
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl?: string;
      reviewPath?: string;
      summary?: string;
      message?: string;
      reasoning?: string;
      session: null;
    }
  | (HubFocusSession & {
      blockGuidelines?: unknown;
      follow?: unknown;
    });

/** Input for POST /api/hub/focus-sessions/:id/complete. */
export interface CompleteFocusSessionInput {
  summary?: string;
  verificationReport?: Record<string, unknown>;
  /** Which terminal state to land in. Defaults to `"closed"` server-side. */
  terminalStatus?: "closed" | "cancelled" | "failed";
}

/** One proposal in the close pack (`pendingProposals`). */
export interface FocusSessionProposalPackItem {
  id: string;
  status: string;
  proposalType: string | null;
  summary: string | null;
  workspaceId: string | null;
  createdAt: string | null;
}

/**
 * Governance-gated complete: either a pending proposal receipt (governance
 * still forced one — the lifecycle escape should normally prevent this) or the
 * close pack. `proposed` is normal, never an error.
 */
export type CompleteFocusSessionResult =
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl?: string;
      reviewPath?: string;
      summary?: string;
      message?: string;
      reasoning?: string;
      session: null;
    }
  | {
      /** The status the ROW now holds — never a literal echo of the request. */
      status: string;
      session: HubFocusSession;
      /** Pending proposals attributed to this session (review pack). */
      pendingProposals: FocusSessionProposalPackItem[];
      counts: {
        pending: number;
        unfinishedOutputs: number;
        expiredEphemerals: number;
        retiredSlots: number;
      };
      warnings: string[];
    };

/** Input for POST /api/hub/focus-sessions/:id/rerun. */
export interface RerunFocusSessionInput {
  /**
   * `"add"` layers new material onto the parent's existing outputs.
   * `"replace"` reverts the parent's applied proposals first — an AGENT
   * credential asking for `replace` is refused (403): reverting approved work
   * is a human decision.
   */
  mode: "replace" | "add";
  /** Narrow the rerun to specific stored sources; omitted reruns all of them. */
  scope?: { sourceDocumentIds: string[] };
  /** Counts + cap verdict only — nothing written. */
  dryRun?: boolean;
  reason?: string;
}

/** One source re-analysed by the rerun. */
export type RerunItemOutcome =
  | "proposed"
  | "applied"
  | "deduplicated"
  | "not_structured"
  | "needs_input"
  | "failed";

export interface RerunItemResult {
  sourceDocumentIds: string[];
  door: "capture" | "import";
  outcome: RerunItemOutcome;
  proposalId?: string;
  reviewUrl?: string;
  reason?: string;
}

/** What the rerun would do / did to the parent's sources. */
export interface RerunPlan {
  sources: {
    selected: number;
    capture: number;
    import: number;
    degraded: number;
    missing: string[];
    notInRun: string[];
  };
  replaceWouldRevert: number;
  parentPending: number;
  estimatedStructureCalls: number;
  cap: { max: number; withinCap: boolean };
}

/**
 * POST /api/hub/focus-sessions/:id/rerun result. Only the `ok: true` shapes
 * are reachable from the client method — every `ok: false` refusal
 * (`not_found` 404, `replace_is_a_human_decision` 403, everything else 409)
 * answers a non-2xx status and surfaces as a thrown `HubApiError` instead,
 * same convention as every other door in this file.
 */
export type RerunFocusSessionResult =
  | {
      ok: true;
      status: "dry_run";
      parentSessionId: string;
      mode: "replace" | "add";
      plan: RerunPlan;
      availability: {
        available: boolean;
        reason?: "no_manifest" | "in_flight" | "availability_unknown";
      };
    }
  | {
      ok: true;
      /** An identical request inside the dedupe window already started this child. */
      status: "reused";
      reused: true;
      sessionId: string;
      parentSessionId: string;
      mode: "replace" | "add";
      idempotencyNamespace: string;
      plan: RerunPlan;
    }
  | {
      ok: true;
      /** `rerun`: every item structured · `partial`: some did not · `failed`: none did. */
      status: "rerun" | "partial" | "failed";
      reused: false;
      sessionId: string;
      parentSessionId: string;
      mode: "replace" | "add";
      idempotencyNamespace: string;
      plan: RerunPlan;
      /** False when the child's lineage (parent, mode, namespace) could not be recorded. */
      lineageRecorded: boolean;
      /** `replace` only — opaque here; read `rerun-session.ts` before branching on it. */
      revert?: unknown;
      items: RerunItemResult[];
      counts: Record<RerunItemOutcome, number>;
    };

// ─── Relations & Graph ───────────────────────────────────────────────────────

export interface HubRelation {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: string;
  label?: string;
  createdAt: string;
}

export interface HubGraphNode extends HubEntity {
  depth: number;
}

export interface HubGraphEdge {
  sourceId: string;
  targetId: string;
  type: string;
  label?: string;
}

export interface HubGraphResult {
  nodes: HubGraphNode[];
  edges: HubGraphEdge[];
}

/**
 * A single link returned by getConnections() across the local graph:
 *  - `"graph"` : an explicit row in the relations table
 *  - `"property"` : an inbound or outbound `entity_id` property edge
 *  - `"thread"` / `"context_channel"` : a channel that touched or is about this entity
 *  - `"focus_session"` : a session anchored to this entity
 */
export interface HubConnection {
  entityId: string;
  entity: HubEntity | null;
  label: string;
  direction: "outgoing" | "incoming" | "structural";
  source: "graph" | "property" | "thread" | "context_channel" | "focus_session";
  relationId?: string;
  relationType?: string;
  propertySlug?: string;
  propertyLabel?: string;
  channelId?: string;
  channelRelationshipType?: string;
  channelTitle?: string | null;
  channelWorkspaceId?: string | null;
  focusSessionId?: string;
  focusSessionGoal?: string;
  focusSessionStatus?: string;
  focusSessionWorkspaceId?: string | null;
  createdAt?: string | null;
}

export interface HubConnectionsResult {
  connections: HubConnection[];
  counts: {
    total: number;
    graph: number;
    structural: number;
    threads: number;
    contextChannels?: number;
    focusSessions?: number;
  };
}

// ─── Profiles & Property Defs ────────────────────────────────────────────────

export interface HubProfile {
  id: string;
  slug: string;
  displayName: string;
  description?: string;
  entityScope: "pod" | "workspace";
  parentSlug?: string;
  icon?: string;
  color?: string;
  properties?: HubPropertyDef[];
  /** Primary entity kind or attachable role/facet. Defaults to kind on old pods. */
  profileKind?: "kind" | "role";
  /** Kinds this role can be attached to; null means the pod did not constrain it. */
  applicableKinds?: string[] | null;
}

export interface HubPropertyDef {
  id: string;
  slug: string;
  displayName: string;
  type:
    | "string"
    | "number"
    | "boolean"
    | "date"
    | "entity_id"
    | "array"
    | "object"
    | "secret";
  required?: boolean;
  options?: string[];
}

// ─── Discover ────────────────────────────────────────────────────────────────

export interface HubDiscoverProperty {
  slug: string;
  displayName: string;
  type: string;
  options?: string[];
  required?: boolean;
  /** Default the validator applies when this property is omitted. */
  defaultValue?: unknown;
  /** Exact validation constraints used by the property validator. */
  constraints?: Record<string, unknown>;
  /** Target kind for an entity_id property, when configured. */
  targetProfileSlug?: string;
  /** Base definitions are always visible; workspace definitions require this lens. */
  schemaScope?: "base" | "workspace";
  workspaceId?: string | null;
}

export interface HubDiscoverProfile {
  slug: string;
  displayName: string;
  scope: "pod" | "workspace";
  description?: string | null;
  icon?: string | null;
  /** Omitted by the summary tier. */
  properties?: HubDiscoverProperty[];
  /** Omitted by the summary tier. */
  createCommand?: string;
  profileKind?: "kind" | "role";
  applicableKinds?: string[] | null;
}

export interface HubDiscoverResult {
  profiles: HubDiscoverProfile[];
  commands: Record<string, string>;
  hint: string;
}

/** Progressive-disclosure controls for GET /discover. */
export interface HubDiscoverOptions {
  /**
   * Omit to read the base/pod schema only. Supplying a workspace resolves only
   * that workspace's overlays; callers must never substitute a default here.
   */
  workspaceId?: string;
  /** Return the digest tier without property schemas. */
  summary?: boolean;
  /** Limit full discovery to these profile slugs when the pod supports it. */
  profileSlugs?: string[];
}

export type HubOrientScope = "workspaces" | "projects" | "profiles";
export type HubOrientDetail = "light" | "full";

export interface HubOrientProfile {
  slug: string;
  name: string;
  profileKind: "kind" | "role";
  applicableKinds?: string[] | null;
  /** Placement for entities of this kind; distinct from profile visibility. */
  entityScope?: "pod" | "workspace" | null;
}

export interface HubOrientWorkspace {
  id: string;
  name: string;
  domain: string | null;
  entityCount: number;
  onboarding?: Record<string, unknown>;
  description?: string | null;
  profiles?: HubOrientProfile[];
}

export interface HubOrientProject {
  id: string;
  name: string;
  description: string | null;
  status: string | null;
  workspaceId: string | null;
  homeWorkspace: string | null;
}

/**
 * Prompt-facing team roster for a workspace (no emails). Present when the
 * pinned/sample workspace has human members. Treat as internal — not contacts.
 */
export interface HubOrientTeamRoster {
  instructionBlock: string | null;
  names: string[];
  members: Array<{ displayName: string; personId?: string | null }>;
}

/** Canonical session bootstrap response shared by MCP, CLI, and REST surfaces. */
export interface HubOrientResult {
  me: { userId: string; scopes: string[] };
  detail: HubOrientDetail;
  projects: HubOrientProject[];
  projectCount: number;
  workspaces: HubOrientWorkspace[];
  workspaceCount: number;
  /** Empty domains hidden from the light list — omitted when none/full. */
  hiddenEmptyWorkspaceCount?: number;
  /**
   * Entity-type inventory. detail:'full' only (or an explicit
   * scope:['profiles']) — light omits it; use the profile-listing endpoint.
   */
  profiles?: HubOrientProfile[];
  /** Durable user model as prose — omitted when the pod holds none. */
  who?: string;
  note: string;
  /** Internal team for the pinned/sample workspace — omitted when empty. */
  teamRoster?: HubOrientTeamRoster;
}

export interface HubOrientOptions {
  detail?: HubOrientDetail;
  scope?: HubOrientScope[];
  workspaceId?: string;
  projectId?: string;
}

// ─── Threads & Channels ──────────────────────────────────────────────────────

export interface HubThread {
  id: string;
  name?: string;
  type:
    | "personal"
    | "thread"
    | "sub_thread"
    | "feed"
    | "external"
    | "agent_collab"
    | "group"
    | "run";
  workspaceId?: string;
  agentType?: string;
  contextObjectType?:
    | "workspace"
    | "entity"
    | "document"
    | "view"
    | "project"
    | "task"
    | "user"
    | "external";
  contextObjectId?: string;
  parentChannelId?: string;
  linkedEntityIds?: string[];
  linkedDocumentIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HubMessage {
  id: string;
  content: string;
  role: "user" | "assistant" | "system";
  userId?: string;
  createdAt: string;
}

export interface HubThreadContext {
  thread: HubThread;
  messages: HubMessage[];
  linkedEntities: HubEntity[];
  linkedDocuments: HubDocument[];
}

// ─── Proposals ───────────────────────────────────────────────────────────────

export interface HubProposal {
  id: string;
  status: "pending" | "approved" | "rejected";
  action: "create" | "update" | "delete";
  subjectType: string;
  data: Record<string, unknown>;
  reason?: string;
  createdAt: string;
  reviewedAt?: string;
}

// ─── Views ───────────────────────────────────────────────────────────────────

export interface HubView {
  id: string;
  name: string;
  type:
    | "table"
    | "kanban"
    | "list"
    | "grid"
    | "gallery"
    | "calendar"
    | "timeline"
    | "graph"
    | "bento"
    | string;
  profileSlug?: string;
  workspaceId?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  profileId?: string | null;
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One row from GET /widget-definitions. Hub listWidgetDefs already merges
 * compose-catalog builtins (source: "compose-catalog") with DB rows — this is
 * the compose allowlist, not raw seeder output. Extra DB columns are allowed.
 */
export interface HubWidgetDefinition {
  id: string;
  typeKey?: string;
  name?: string;
  description?: string | null;
  category?: string;
  rendererType?: string;
  rendererSource?: unknown;
  workspaceId?: string | null;
  isActive?: boolean;
  defaultSize?: { w: number; h: number };
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  aliasOf?: string | null;
  source?: string;
  notes?: string;
  /** Stale OpenAPI field on some pods. Prefer `typeKey`. */
  kind?: string;
  [key: string]: unknown;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface HubSearchResult {
  entities: HubEntity[];
  documents: HubDocument[];
  total: number;
}

// ─── Commands ────────────────────────────────────────────────────────────────

export interface HubCommand {
  id: string;
  name: string;
  slug: string;
  description?: string;
  workspaceId?: string;
}

// ─── Agent Users ─────────────────────────────────────────────────────────────

export interface HubAgentUser {
  id: string;
  name: string;
  agentType?: string;
  workspaceId?: string;
}

// ─── User Context ─────────────────────────────────────────────────────────────

export interface HubUserContext {
  recentEntities: HubEntity[];
  activeThreads: HubThread[];
  workspaceSummary?: Record<string, unknown>;
}

// ─── Governance ───────────────────────────────────────────────────────────────

export type HubWriteSource =
  | "intelligence"
  | "agent"
  | "openwebui-pipeline"
  | "extension"
  | "cli"
  | "n8n"
  | "raycast";

/**
 * Truthful outcome envelope shared by direct and proposal-first write doors.
 * `partial` means independently-applied sub-operations failed; it never
 * implies an atomic rollback.
 */
export interface HubWriteReceipt {
  state: "pending" | "applied" | "partial";
  proposalId?: string;
  reviewUrl?: string;
  entityId?: string;
  proposedEntityId?: string;
  profileSlug?: string;
  effectiveWorkspaceId?: string | null;
  projectId?: string;
  source?: HubWriteSource;
  facets?: Array<{
    slug: string;
    outcome: "attached" | "proposed" | "dropped" | "error" | string;
    facetId?: string;
    proposalId?: string;
    error?: string;
  }>;
  warnings?: string[];
}

export interface HubGovernanceResult {
  /** `created` is an inline, materialized write; `proposed` remains pending. */
  status: "approved" | "created" | "proposed" | "denied";
  id?: string;
  proposalId?: string;
  reason?: string;
  message?: string;
  /**
   * Short human-readable summary of what was proposed. Present on `proposed`
   * responses. Example: `Delete task "Q2 plan review"`.
   */
  summary?: string;
  /**
   * Reasoning — echoed from the AI's rationale or the policy's explanation
   * of why review is needed. Present on `proposed` responses.
   */
  reasoning?: string;
  /**
   * Pod-relative path into the app: `/open/{id}`.
   * Present on `proposed` responses.
   */
  reviewPath?: string;
  /**
   * Absolute clickable link into the app: `${PUBLIC_URL}/open/{id}`. The pod
   * resolves the id's type server-side and bounces to the Electron app. Surface
   * this directly to the user so they can approve without digging through the app.
   */
  reviewUrl?: string;
  /** Additive receipt for write-aware clients. Legacy clients may keep using status/id. */
  writeReceipt?: HubWriteReceipt;
}

// ─── Write input types ────────────────────────────────────────────────────────

export interface CreateThreadInput {
  name?: string;
  type?: HubThread["type"];
  workspaceId?: string;
  agentType?: string;
  entityId?: string;
  documentId?: string;
  userId?: string;
}

export interface CreateRelationInput {
  sourceEntityId: string;
  targetEntityId: string;
  type: string;
  label?: string;
  workspaceId?: string;
  userId?: string;
}

/**
 * Create a project (the cross-cutting lens). Mirrors the pod's POST
 * /api/hub/projects body. An AGENT key must pass `evidenceEntityIds` (≥5
 * caller-visible entities that belong to it); a human caller may omit it.
 */
export interface CreateProjectInput {
  name: string;
  description?: string;
  status?: "active" | "archived" | "completed";
  workspaceId?: string;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  evidenceEntityIds?: string[];
}

/**
 * POST /api/hub/projects outcome: the created row (201), a pending governance
 * proposal (202, with its review link), an idempotent reuse of an exact-name
 * match (200), or a near-duplicate refusal (409) returned as data so the caller
 * can offer the candidates instead of losing them. A missing-evidence refusal
 * (400) and every other non-2xx throw HubApiError.
 */
export type HubCreateProjectResult =
  | ({ status?: undefined; id: string; name: string } & Record<string, unknown>)
  | {
      status: "proposed";
      proposalId: string;
      reviewPath?: string;
      reviewUrl?: string;
    }
  | { status: "deduped"; projectId: string; reusedProjectId: string }
  | {
      status: "near_duplicate";
      error: string;
      dedupCandidates: Array<Record<string, unknown>>;
    };

/** A project row as the Hub REST project doors return it. */
export interface HubProject {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived" | "completed";
  phase: string | null;
  targetDate: string | null;
  /** Home workspace; null = pod-personal (owner-only). */
  workspaceId: string | null;
  /** Workspaces this project runs through (INDEX, not an ACL). */
  usedWorkspaceIds?: string[];
  /** GET /projects/:id only: the same ids, hydrated. */
  usedWorkspaces?: Array<{ id: string; name: string; domain: string | null }>;
  createdAt: string;
  updatedAt: string;
}

/**
 * PATCH /api/hub/projects/:id body. Omitted = untouched; `null` on
 * `phase`/`targetDate` CLEARS it. `reasoning` is shown to the reviewer and
 * never stored on the project.
 */
export interface UpdateProjectInput {
  name?: string;
  description?: string;
  status?: "active" | "archived" | "completed";
  phase?: string | null;
  /** ISO-8601 date. */
  targetDate?: string | null;
  reasoning?: string;
}

/** A governed write that filed a proposal instead of applying. */
export interface HubProposedResult {
  status: "proposed";
  proposalId: string;
  reviewPath?: string;
  reviewUrl?: string;
}

/** PATCH /api/hub/projects/:id — the updated row (200) or a proposal (202). */
export type HubUpdateProjectResult = HubProject | HubProposedResult;

/** POST /api/hub/links (`project --uses--> workspace`) outcome. */
export type HubLinkProjectWorkspaceResult =
  { status: "created"; uses?: { indexed: boolean } } | HubProposedResult;

/** Attach an existing role-profile to a primary-kind entity. */
export interface AttachFacetInput {
  entityId: string;
  profileSlug?: string;
  profileId?: string;
  workspaceId?: string | null;
  contextEntityId?: string | null;
  status?: string;
  properties?: Record<string, unknown>;
  reasoning?: string;
}

/**
 * Result of `POST /entities/{entityId}/facets`.
 *
 * NOT a `HubGovernanceResult`: the facet door's inline-write status is
 * `attached` (never `created`/`approved`), and it reports the new row as
 * `facetId` rather than `id`. Source of truth for both branches:
 * `entities.attachFacet` in `packages/api/src/routers/entities.ts`.
 */
export interface HubAttachFacetResult {
  status: "attached" | "proposed";
  message?: string;
  /** Present on the inline `attached` branch. */
  facetId?: string;
  /** The materialized facet row on `attached`; `null` on `proposed`. */
  facet?: Record<string, unknown> | null;
  /** Present on the `proposed` branch. */
  proposalId?: string;
  proposalType?: string;
  reviewUrl?: string;
}

export interface CreateViewInput {
  name: string;
  type: HubView["type"];
  profileSlug?: string;
  workspaceId: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  userId?: string;
  agentUserId?: string;
  reasoning?: string;
  sourceMessageId?: string;
}

export interface UpdateViewInput {
  name?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  workspaceId?: string;
  userId?: string;
  agentUserId?: string;
  reasoning?: string;
  sourceMessageId?: string;
}

export interface BentoWidgetInput {
  /** Canonical Hub-router field naming the cell type. */
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: Record<string, unknown>;
  props?: Record<string, unknown>;
}

export interface ArrangeBentoViewInput {
  workspaceId?: string;
  userId?: string;
  widgets: BentoWidgetInput[];
  agentUserId?: string;
  reasoning?: string;
  sourceMessageId?: string;
}

export interface HubBentoArrangementResult {
  status: string;
  viewId?: string;
  widgetCount?: number;
  message?: string;
  proposalId?: string;
  reviewUrl?: string;
}

// ─── Capabilities & teaching substrate ─────────────────────────────────────

export interface HubCapabilityVerb {
  id?: string;
  verbId?: string;
  label?: string;
  type?: "read" | "write";
  enabled?: boolean;
  granted?: boolean;
  runnable?: boolean;
  governance?: "auto" | "propose";
  effectiveExecMode?: string;
  govDefault?: string;
  [key: string]: unknown;
}

/** Flat capability read-model for callers that need every granted verb. */
export interface HubCapability {
  id?: string;
  name?: string;
  key?: string;
  kind?: string;
  description?: string | null;
  verbs?: HubCapabilityVerb[];
  /** Run posture for an agent: `auto` runs now, `propose` files a review,
   *  `none` nothing here runs through the execute door. Not approval. */
  governance?: "auto" | "propose" | "none";
  /** The approval gate (the row's `approved` column). */
  enabled?: boolean;
  approved?: boolean;
  [key: string]: unknown;
}

export interface HubCapabilityCatalogConnection {
  required: boolean;
  kind: "provider" | "vault" | null;
  provider?: string;
  /** `unavailable`: this pod's Nango doesn't declare the provider — no connect action exists. */
  state: "connected" | "missing" | "expired" | "unavailable";
  account?: string;
}

export interface HubCapabilityCatalogCard {
  id: string | null;
  key: string;
  name: string;
  description?: string | null;
  source: "installed" | "available";
  status:
    | "available"
    | "needs_connection"
    | "connected"
    | "draft"
    | "ready"
    | "partial"
    | "unavailable";
  connection?: HubCapabilityCatalogConnection;
  verbs: Array<{
    verbId: string;
    label: string;
    type: "read" | "write";
    /** The enable/approval gate (backing skill approved). */
    enabled: boolean;
    /** Run posture for an agent: `auto` runs now, `propose` files a review.
     *  Honours the lens's grant; not approval (that is `enabled`). */
    governance: "auto" | "propose";
    runnable: boolean;
  }>;
  nextAction: {
    kind: "add" | "connect" | "enable" | "run" | "none";
    hint: string;
    /** Where the human step happens, when there is one. */
    url?: string;
    opensIn?: "desktop";
  };
  /**
   * The pod's built-in pack (Synap Core). Listings show it as one line; pass
   * `key` to `getCapabilityCatalog` to list its verbs. Absent on older pods.
   */
  builtIn?: boolean;
}

export interface HubCapabilityCatalogResult {
  capabilities: HubCapabilityCatalogCard[];
}

/** One action the shared capability execute door can launch immediately. */
export interface HubRunnableCapabilityAction {
  skillId?: string;
  verbId?: string;
  label: string;
  description?: string | null;
  tool: string | null;
  connection?: {
    required: true;
    state: "connected";
    provider: string;
  };
  /** Run posture: `auto` runs now, `propose` files a review. Not approval. */
  governance: "auto" | "propose";
  /** The enable/approval gate — always true here (drafts are omitted). */
  enabled: true;
  executionMode?: string;
  /** Direction axis — read = pull, write/action = push. Absent only for a
   *  non-builtin skill-only action (honest-unknown, never defaulted). */
  kind?: "read" | "write" | "action";
  /** Vendor-independent routing intent (ABSTRACT_VERBS). Absent when the verb
   *  fits none of the closed values, or for a skill-only action. */
  intent?: string;
  parameters: Record<string, unknown>;
}

export interface HubRunnableCapabilityActionsResult {
  actions: HubRunnableCapabilityAction[];
}

export interface ExecuteCapabilityInput {
  verbId?: string;
  skillId?: string;
  parameters?: Record<string, unknown>;
  workspaceId?: string;
  connectionSelector?: {
    connectionId?: string;
    contextObjectId?: string;
  };
  /**
   * #4 instruction-provenance: the triggering inbound message id of the agent
   * turn. The backend resolves it to the acting channel (`messages.channelId`)
   * so a capability run triggered from an untrusted-origin channel (external /
   * bridge) force-proposes instead of auto-running (rung 2.55). Tighten-only:
   * omit for a non-turn / owner run and origin-trust simply no-ops.
   */
  sourceMessageId?: string;
}

export type ExecuteCapabilityResult =
  | {
      status: "run" | "dry-run";
      skillId: string;
      result?: unknown;
      dryRun?: boolean;
    }
  | { proposed: true; proposalId: string; reviewUrl?: string };

export interface HubAgentSkill {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  topics: string[];
  body: string | null;
  source: string | null;
  author: string | null;
  version: string | null;
  tags: string[];
  teachesTools: string[];
  skillGroup: string | null;
  alwaysOn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListAgentSkillsOptions {
  topic?: string;
  query?: string;
  tag?: string;
  /** Restrict to the seeded system/* teaching catalog. */
  system?: boolean;
  /** Include visible workspace-scoped skills for this selected lens. */
  workspaceId?: string;
  limit?: number;
  offset?: number;
}

export interface HubAgentSkillsResult {
  skills: HubAgentSkill[];
  total: number;
}

export interface GetCapabilityBriefsInput {
  tools: string[];
  workspaceId?: string;
  door?: "chat" | "automation";
}

export interface HubCapabilityBriefsResult {
  briefs: Record<string, string>;
}

export interface ExecuteCommandInput {
  slug: string;
  workspaceId?: string;
  parameters?: Record<string, unknown>;
  userId?: string;
}

// ─── Automations ──────────────────────────────────────────────────────────────

export type AutomationStatus = "draft" | "active" | "paused" | "error";
export type AutomationTriggerType = "event" | "cron" | "webhook" | "manual";

export interface HubAutomation {
  id: string;
  userId: string;
  workspaceId?: string | null;
  name: string;
  description?: string | null;
  triggerType: AutomationTriggerType;
  triggerConfig?: Record<string, unknown>;
  flowDefinition?: {
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
  };
  status: AutomationStatus;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateAutomationInput {
  name: string;
  triggerType: AutomationTriggerType;
  workspaceId?: string | null;
  description?: string;
  triggerConfig?: Record<string, unknown>;
  flowDefinition?: {
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
  };
  status?: AutomationStatus;
  metadata?: Record<string, unknown>;
  userId?: string;
  agentUserId?: string;
}

export interface UpdateAutomationInput {
  name?: string;
  description?: string;
  triggerType?: AutomationTriggerType;
  triggerConfig?: Record<string, unknown>;
  flowDefinition?: {
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
  };
  status?: AutomationStatus;
  metadata?: Record<string, unknown>;
  workspaceId?: string;
  userId?: string;
}

// ─── Subscriptions / Reactions (Pulse) ───────────────────────────────────────

export type ReactionKind =
  "automation" | "ai_feed" | "ai_react" | "notify" | "webhook" | "message_out";

export type ReactionLens = "all" | "internal" | "external";

/** Opaque reaction event from the Pulse feed — shape varies by kind. */
export interface HubReactionEvent {
  id: string;
  eventType: string;
  kind?: ReactionKind;
  workspaceId?: string | null;
  userId?: string;
  createdAt: string;
  reactions?: Record<string, unknown>[];
  [key: string]: unknown;
}

// ─── Notifications ────────────────────────────────────────────────────────────

export type NotificationSourceType =
  "proposal" | "connector" | "agent" | "system" | "inbox_item";

export interface CreateNotificationInput {
  userId: string;
  workspaceId: string;
  type: string;
  sourceType?: NotificationSourceType;
  sourceId?: string;
  workspaceUrl?: string;
  groupKey?: string;
  data?: Record<string, unknown>;
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export interface HubWebhookDelivery {
  id: string;
  subscriptionId: string;
  status: string;
  responseStatus?: number;
  attempt: number;
  deliveredAt?: string;
  createdAt: string;
}

// ─── Structure doors: kinds, roles, workspaces, cells ───────────────────────
//
// Every write below is GOVERNED. An agent caller gets `status: "proposed"` —
// that is SUCCESS (the write awaits the owner's review), never an error. The
// result types are deliberately wide (all-optional fields, `status: string` on
// cells) so `ISHubClient`'s pre-existing same-named overrides stay assignable.

/** A field definition sent with `createProfile`. */
export interface HubProfileFieldInput {
  slug: string;
  /** A `property_defs.value_type` value (string, number, date, enum…). */
  valueType: string;
  displayName?: string;
  required?: boolean;
  defaultValue?: unknown;
  constraints?: Record<string, unknown>;
  uiHints?: Record<string, unknown>;
  displayOrder?: number;
  /** Workspace overlay instead of a base field. */
  overlay?: boolean;
}

/** `POST /api/hub/profiles` — define a kind (default) or a role. */
export interface CreateProfileInput {
  slug: string;
  displayName: string;
  /** 'kind' (default) = a primary type; 'role' = an attachable facet type. */
  profileKind?: "kind" | "role";
  /** For a role: base kinds it attaches to. Omitted → company, person. */
  applicableKinds?: string[];
  roleCategory?: string;
  /** Omit to let the pod decide (kind → pod, role → workspace). */
  entityScope?: "pod" | "workspace";
  description?: string;
  icon?: string;
  uiHints?: Record<string, unknown>;
  defaultValues?: Record<string, unknown>;
  parentProfileId?: string;
  fields?: HubProfileFieldInput[];
  reasoning?: string;
  /** Defaults to the client's workspace. Required by the pod. */
  workspaceId?: string;
  userId?: string;
  agentUserId?: string;
  sourceMessageId?: string;
}

/** One field's own outcome — a rejected field never discards the others. */
export interface HubProfileFieldResult {
  slug: string | null;
  status?: string;
  error?: string;
  [key: string]: unknown;
}

export interface HubCreateProfileResult {
  status?: "created" | "proposed" | "approved" | (string & {});
  profile?: unknown;
  existing?: boolean;
  proposalId?: string | null;
  message?: string;
  reviewUrl?: string;
  /** Per-field ledger, or `deferred` while the profile itself is proposed. */
  properties?:
    | HubProfileFieldResult[]
    | { status: "deferred"; message: string; pending: number };
  [key: string]: unknown;
}

/** `POST /api/hub/workspaces/from-definition`. Extra definition fields pass through. */
export interface CreateWorkspaceFromDefinitionInput {
  name?: string;
  workspaceName?: string;
  /** Idempotency key: same key + same user → same workspace. */
  proposalId?: string;
  templateId?: string;
  templateName?: string;
  workspaceType?: "personal" | "agent" | "project" | "operational";
  ownerUserId?: string;
  profiles?: Array<{
    slug: string;
    displayName?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export type HubWorkspaceFromDefinitionResult =
  | { status: "proposed"; proposalId: string }
  | { workspaceId: string; created: boolean };

/** `POST /api/hub/cells/define`. Omit `workspaceId` for a pod-global cell. */
export interface DefineCellInput {
  name: string;
  rendererSource: string;
  workspaceId?: string | null;
  typeKey?: string;
  description?: string;
  defaultSize?: { w: number; h: number };
  viewTypes?: string[];
  contentKind?: string;
  deps?: Record<string, string>;
  agentUserId?: string;
  reasoning?: string;
}

export interface HubDefineCellResult {
  /** `proposed` for an agent caller; absent on a direct define (`success`). */
  status?: string;
  proposalId?: string;
  summary?: string;
  reasoning?: string;
  reviewPath?: string;
  reviewUrl?: string;
  deduped?: boolean;
  message?: string;
  success?: boolean;
  typeKey?: string;
}

// ─── Playbooks ────────────────────────────────────────────────────────────────

export type PlaybookStatus = "draft" | "active" | "paused" | "archived";

export interface HubPlaybook {
  id: string;
  name: string;
  description?: string | null;
  goalTemplate?: string | null;
  status: PlaybookStatus;
  workspaceId: string | null;
  executor?: string | null;
  createdAt: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ListPlaybooksOptions {
  /** Narrows only — pod-wide playbooks are still included. */
  workspaceId?: string;
  status?: PlaybookStatus;
  limit?: number;
  cursor?: string;
}

export interface HubPlaybookPage {
  playbooks: HubPlaybook[];
  nextCursor: string | null;
}

export interface CreatePlaybookInput {
  name: string;
  /** May contain {{param}} placeholders. */
  goalTemplate: string;
  description?: string;
  stages?: Array<Record<string, unknown>>;
  /** Defaults to active. */
  status?: PlaybookStatus;
  /** The playbook's home. Defaults to the client's workspace; required by the pod. */
  workspaceId?: string;
  agentUserId?: string;
}

export interface HubCreatePlaybookResult {
  status: "created" | "proposed";
  playbook: HubPlaybook | null;
  proposalId: string | null;
  message: string;
  reviewUrl?: string;
}

export interface RunPlaybookInput {
  /** Write home for the run. Omit to use the playbook's own workspace. */
  workspaceId?: string;
  subjectId?: string;
  params?: Record<string, unknown>;
  agentIds?: string[];
  reasoning?: string;
  agentUserId?: string;
}

/** One request to enable a pack a blocked playbook depends on. */
export type HubCapabilityEnableOffer =
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl: string;
      title: string;
      skills: Array<{ id: string; name: string; [key: string]: unknown }>;
      originalActionRan: false;
      message: string;
    }
  | {
      status: "failed";
      error: string;
      originalActionRan: false;
      message: string;
    };

export type HubRunPlaybookResult =
  | {
      status: "running";
      run: Record<string, unknown>;
      session: Record<string, unknown> | null;
      proposalId: null;
      message: string;
    }
  | {
      status: "proposed";
      run: null;
      session: null;
      proposalId: string;
      message: string;
      reviewUrl?: string;
    }
  | {
      /** Nothing ran: the playbook uses skills that are not enabled yet. */
      status: "blocked";
      run: null;
      session: null;
      proposalId: null;
      message: string;
      unenabledSkills: Array<{
        id: string;
        name: string;
        [key: string]: unknown;
      }>;
      enableProposals: HubCapabilityEnableOffer[];
    };

// ─── Skills / Rules (prompt-injecting authoring doors) ───────────────────────
// BOTH of these write PROSE that the pod's dynamic-skill-loader can inject into
// the owner's own agents' prompts. That is why an agent-authored write here is
// born UNAPPROVED and/or routed to a proposal by the capability gate — the
// client never asks for, and must never gain, an auto-approve affordance.

export interface CreateSkillInput {
  /** Stable skill name, e.g. "normalize_phone_numbers". */
  name: string;
  /** One line: what it does + when to use it. */
  description?: string;
  /**
   * Markdown documentation. For a teaching skill this IS the skill — the pod
   * stores it in `skills.body`, which is the ONLY column `load_skill`
   * resolves. Required unless `code` is given.
   */
  body?: string;
  /** Optional executable source (sandboxed). Present ⇒ the skill is runnable. */
  code?: string;
  /**
   * Stable ref `load_skill` resolves (lowercase path segments, e.g.
   * "biz/business-plan"). REQUIRED when there is no `code` — without it a
   * documentation skill is authored but unreachable.
   */
  slug?: string;
  /** Optional runtime parameter schema (shorthand types). */
  parameters?: Record<string, unknown>;
  /** Optional workspace lens. Omit for a pod-wide skill. */
  workspaceId?: string;
}

export interface HubCreateSkillResult {
  id: string;
  /** `"proposed"` is SUCCESS — the write is queued for the owner's review. */
  status: "created" | "proposed";
  proposalId: string | null;
  requires?: string[];
}

/** One WHERE row of a rule sentence. */
export interface HubRuleCondition {
  id: string;
  key: string;
  operator: string;
  value: string;
}

/** The rule's structured WHEN / WHERE / THEN. The pod compiles it or refuses. */
export interface HubRuleSentence {
  trigger: Record<string, unknown> | null;
  conditions: HubRuleCondition[];
  actions: Array<{ type: string | null; config: Record<string, unknown> }>;
}

export interface CreateRuleInput {
  /** The rule in the user's own words — this IS the prose an agent reads later. */
  intent: string;
  scope: {
    kind: "pod" | "workspace" | "user";
    workspaceId?: string;
    /** Cross-cutting project lens — composes with the workspace lens. */
    projectId?: string;
  };
  /** ISO-8601 instant with offset after which the rule stops applying. */
  expiresAt?: string;
  factSkillId?: string;
  automationIds?: string[];
  /** Omit for a prose-only FACT rule; send it to compile a BEHAVIOUR rule. */
  sentence?: HubRuleSentence;
}

/**
 * What the rule door answers.
 *
 * `denied` is returned by the pod with HTTP 403, so `createRule` THROWS a
 * `HubApiError` for it rather than resolving to this arm — the arm is kept
 * because the pod's wire contract has it and a future non-throwing reader
 * must not have to re-derive the shape.
 *
 * `needsBehaviour` means the intent read as something that should RUN but no
 * `sentence` was sent: the rule was stored as prose and will not execute. Say
 * so; do not report it as in effect.
 */
export type HubCreateRuleResult =
  | {
      status: "created";
      ruleId: string;
      automationIds?: string[];
      needsBehaviour?: { shape: string; reason: string };
      scopeNote?: string;
    }
  /** SUCCESS, queued for review — never an error. */
  | {
      status: "proposed";
      /** The pod returns no reviewUrl on this door — build it with `openUrl`. */
      proposalId: string;
      needsBehaviour?: { shape: string; reason: string };
      scopeNote?: string;
    }
  | {
      status: "denied";
      reason: string;
      /** Names the failing clause when the refusal came from COMPILING. */
      failure?: { clause?: string; [key: string]: unknown };
    };
