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
}

export interface HubDocument {
  id: string;
  title: string;
  content: string;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
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
    | "agent_collab";
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
  properties?: Record<string, unknown>;
  content?: string;
  url?: string;
  status?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  dueDate?: string;
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

export interface CaptureProposal {
  tempId: string;
  profileSlug: string;
  title: string;
  description?: string;
  properties?: Record<string, unknown>;
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
  followUp: string | null;
  dedupCandidates?: Record<
    string,
    Array<{ entityId: string; title: string; score: number }>
  >;
}

export interface CaptureExecuteInput {
  entities: Array<{
    tempId: string;
    profileSlug: string;
    title: string;
    description?: string;
    properties?: Record<string, unknown>;
    action: "create" | "link" | "dismiss";
    linkedEntityId?: string;
    confidence?: number;
  }>;
  relations?: CaptureRelation[];
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
}

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
 * A single link returned by getConnections() — unified view across three sources:
 *  - `"graph"` : an explicit row in the relations table
 *  - `"property"` : derived from another entity's `entity_id` property pointing here
 *  - `"thread"` : a chat thread created, updated, or referenced this entity
 */
export interface HubConnection {
  entityId: string;
  entity: HubEntity | null;
  label: string;
  direction: "outgoing" | "incoming" | "structural";
  source: "graph" | "property" | "thread";
  relationType?: string;
  propertySlug?: string;
  propertyLabel?: string;
  channelId?: string;
  channelRelationshipType?: string;
  createdAt?: string | null;
}

export interface HubConnectionsResult {
  connections: HubConnection[];
  counts: {
    total: number;
    graph: number;
    structural: number;
    threads: number;
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
    | "agent_collab";
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

export interface HubGovernanceResult {
  status: "approved" | "proposed" | "denied";
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
   * Pod-relative path for the review UI: `/proposals/{id}`.
   * Present on `proposed` responses.
   */
  reviewPath?: string;
  /**
   * Absolute URL for the review UI (defaults to `studio.synap.live`,
   * overridable via `SYNAP_APP_URL` on the pod). Surface this directly to
   * the user so they can approve without digging through the app.
   */
  reviewUrl?: string;
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

export interface CreateViewInput {
  name: string;
  type: HubView["type"];
  profileSlug?: string;
  workspaceId: string;
  config?: Record<string, unknown>;
  userId?: string;
}

export interface ExecuteCommandInput {
  slug: string;
  workspaceId?: string;
  parameters?: Record<string, unknown>;
  userId?: string;
}
