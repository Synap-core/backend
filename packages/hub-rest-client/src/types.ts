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
    | "ai_thread"
    | "branch"
    | "entity_comments"
    | "document_review"
    | "view_discussion"
    | "direct"
    | "feed"
    | "agent_collab"
    | "personal"
    | "external_import";
  workspaceId: string | null;
  agentType?: string;
  createdAt: string;
}

export interface HubWorkspace {
  id: string;
  name: string;
  role?: string;
}

export interface HubUser {
  id: string;
  email: string;
  name?: string;
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
