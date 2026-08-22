/**
 * @synap/hub-rest-client — Hub Protocol REST API Types
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

export interface CaptureStructureResponse {
  proposals: CaptureProposal[];
  relations: CaptureRelation[];
  /** The intelligence service was unavailable, so the pod returned a raw-note fallback. */
  degraded?: boolean;
  followUp: string | StructuredFollowUp | null;
  formSpec?: DynamicFormSpec | null;
  targetWorkspaceId?: string | null;
  targetWorkspaceConfidence?: number | null;
  targetWorkspaceReason?: string | null;
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
  entities: CaptureGraphEntity[];
  relations?: CaptureGraphRelation[];
  bindings?: CaptureGraphBinding[];
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
  /** Set when AUTO routing moved the capture to the AI-resolved workspace. */
  movedToWorkspace?: string;
  /** Set in ASK mode — a suggested switch for the surface to confirm. */
  pendingWorkspaceSwitch?: {
    suggestedWorkspaceId: string;
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
  [key: string]: unknown;
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
  status?: "pending" | "done";
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
  profiles: HubOrientProfile[];
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
  governance?: Record<string, unknown>;
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
    enabled: boolean;
    governance: "auto" | "propose";
    runnable: boolean;
  }>;
  nextAction: {
    kind: "add" | "connect" | "enable" | "run" | "none";
    hint: string;
  };
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
  governance: "auto";
  executionMode?: string;
  /** Direction axis of a tool verb — read = pull, write/action = push. Absent
   *  for a skill-only action (honest-unknown, never defaulted). */
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
