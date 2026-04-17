/**
 * HubRestClient — typed HTTP client for the Synap Hub Protocol REST API.
 *
 * Uses the native `fetch` API (Node.js >= 18, browsers, Deno, Bun).
 * Zero runtime dependencies.
 *
 * @example
 * ```ts
 * const client = new HubRestClient({
 *   podUrl: "https://my-pod.synap.live",
 *   apiKey: "synap_hub_live_...",
 * });
 *
 * const entities = await client.searchEntities("meeting notes", { profileSlug: "note" });
 * ```
 */

import { HubApiError } from "./errors.js";
import type {
  HubEntity,
  HubChannel,
  HubWorkspace,
  HubUser,
  HubMemoryResult,
  HubListResponse,
  HubSingleResponse,
  HubWorkspacesListResponse,
  CreateEntityInput,
  UpdateEntityInput,
  StoreMemoryInput,
  SendToChannelInput,
  CaptureProposal,
  CaptureStructureResponse,
  CaptureExecuteInput,
  CaptureExecuteResponse,
  HubDocument,
  HubRelation,
  HubGraphResult,
  HubConnectionsResult,
  HubProfile,
  HubPropertyDef,
  HubThread,
  HubMessage,
  HubThreadContext,
  HubProposal,
  HubView,
  HubSearchResult,
  HubCommand,
  HubAgentUser,
  HubUserContext,
  HubGovernanceResult,
  CreateThreadInput,
  CreateRelationInput,
  CreateViewInput,
  ExecuteCommandInput,
  CreateDocumentInput,
} from "./types.js";

export interface HubRestClientConfig {
  /** Pod URL, e.g. https://my-pod.synap.live */
  podUrl: string;
  /** Hub Protocol API key (Bearer token) */
  apiKey: string;
  /** Default workspace ID — used when not specified per call */
  workspaceId?: string;
  /** Optional request timeout in ms (default: 30000) */
  timeoutMs?: number;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}

function formatHubErrorMessage(
  status: number,
  statusText: string,
  errorBody: unknown
): string {
  let detail = "";
  if (errorBody && typeof errorBody === "object" && "error" in errorBody) {
    detail = String((errorBody as { error: unknown }).error);
  }
  const base = `Hub API error: ${status} ${statusText}`;
  let msg = detail ? `${base} — ${detail}` : base;
  if (status === 403 && /hub-protocol\.write/i.test(detail)) {
    msg +=
      " Create or reconnect an API key that includes the hub-protocol.write scope (Settings → API keys on your pod).";
  }
  return msg;
}

function unwrapList<T>(result: T[] | HubListResponse<T>): T[] {
  return Array.isArray(result)
    ? result
    : ((result as HubListResponse<T>).data ?? []);
}

/** Hub GET /workspaces returns `{ workspaces }`, not `{ data }`. */
function unwrapWorkspacesResponse(
  result:
    | HubWorkspace[]
    | HubListResponse<HubWorkspace>
    | HubWorkspacesListResponse
): HubWorkspace[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && "workspaces" in result) {
    const w = (result as HubWorkspacesListResponse).workspaces;
    return Array.isArray(w) ? w : [];
  }
  return unwrapList(result as HubWorkspace[] | HubListResponse<HubWorkspace>);
}

function unwrapSingle<T>(result: T | HubSingleResponse<T>): T {
  if (result && typeof result === "object" && "data" in result) {
    return (result as HubSingleResponse<T>).data;
  }
  return result as T;
}

export class HubRestClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  readonly workspaceId: string | undefined;

  /** Cached from GET /users/me — avoids repeated identity calls. */
  private resolvedUserId: string | null = null;

  constructor(config: HubRestClientConfig) {
    this.base = normalizeUrl(config.podUrl);
    this.headers = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    };
    this.workspaceId = config.workspaceId;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  /** User id for the current API key (Hub REST requires userId on several GETs). */
  private async resolveUserId(): Promise<string> {
    if (this.resolvedUserId) return this.resolvedUserId;
    const me = await this.getMe();
    this.resolvedUserId = me.id;
    return me.id;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const url = `${this.base}${path}`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: combined,
    });

    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      throw new HubApiError(
        formatHubErrorMessage(res.status, res.statusText, errorBody),
        res.status,
        errorBody
      );
    }

    return res.json() as Promise<T>;
  }

  // ─── Identity ─────────────────────────────────────────────────────────────

  async getMe(): Promise<HubUser> {
    return this.request<HubUser>("GET", "/api/hub/users/me");
  }

  async getWorkspaces(): Promise<HubWorkspace[]> {
    const result = await this.request<
      HubWorkspace[] | HubListResponse<HubWorkspace> | HubWorkspacesListResponse
    >("GET", "/api/hub/workspaces");
    return unwrapWorkspacesResponse(result);
  }

  /**
   * Get full activity context for a user — recent entities, active threads, workspace summary.
   * Use at session start to orient the agent to the user's current state.
   */
  async getUserContext(
    userId: string,
    options?: { workspaceId?: string }
  ): Promise<HubUserContext> {
    const params = new URLSearchParams();
    const wsId = options?.workspaceId ?? this.workspaceId;
    if (wsId) params.set("workspaceId", wsId);
    const qs = params.toString() ? `?${params}` : "";
    return this.request<HubUserContext>(
      "GET",
      `/api/hub/users/${userId}/context${qs}`
    );
  }

  // ─── Entities ─────────────────────────────────────────────────────────────

  async searchEntities(
    query: string,
    options?: {
      profileSlug?: string;
      workspaceId?: string;
      limit?: number;
    },
    signal?: AbortSignal
  ): Promise<HubEntity[]> {
    const wsId = options?.workspaceId ?? this.workspaceId;
    const params = new URLSearchParams({ q: query });
    if (options?.profileSlug) params.set("profileSlug", options.profileSlug);
    if (wsId) params.set("workspaceId", wsId);
    if (options?.limit) params.set("limit", String(options.limit));

    const result = await this.request<HubEntity[] | HubListResponse<HubEntity>>(
      "GET",
      `/api/hub/entities?${params}`,
      undefined,
      signal
    );
    return unwrapList(result);
  }

  async getEntity(id: string): Promise<HubEntity> {
    const result = await this.request<HubEntity | HubSingleResponse<HubEntity>>(
      "GET",
      `/api/hub/entities/${id}`
    );
    return unwrapSingle(result);
  }

  async getRecentEntities(options?: {
    profileSlug?: string;
    workspaceId?: string;
    limit?: number;
  }): Promise<HubEntity[]> {
    const wsId = options?.workspaceId ?? this.workspaceId;
    const params = new URLSearchParams({
      sort: "updatedAt:desc",
      limit: String(options?.limit ?? 20),
    });
    if (options?.profileSlug) params.set("profileSlug", options.profileSlug);
    if (wsId) params.set("workspaceId", wsId);

    const result = await this.request<HubEntity[] | HubListResponse<HubEntity>>(
      "GET",
      `/api/hub/entities?${params}`
    );
    return unwrapList(result);
  }

  async createEntity(input: CreateEntityInput): Promise<HubGovernanceResult> {
    return this.request<HubGovernanceResult>("POST", "/api/hub/entities", {
      ...input,
      workspaceId: input.workspaceId ?? this.workspaceId,
    });
  }

  async updateEntity(id: string, input: UpdateEntityInput): Promise<HubEntity> {
    return this.request<HubEntity>("PATCH", `/api/hub/entities/${id}`, input);
  }

  // ─── Unified Search ───────────────────────────────────────────────────────

  /**
   * Unified full-text search across entities, documents, and views.
   * Use when you don't know the content type. For entity-only search use searchEntities().
   *
   * Note: The backend GET /search requires userId as a query param; this method resolves
   * the current user automatically.
   */
  async search(
    query: string,
    options?: {
      collections?: Array<"entities" | "documents" | "views">;
      workspaceId?: string;
      limit?: number;
    },
    signal?: AbortSignal
  ): Promise<HubSearchResult> {
    const userId = await this.resolveUserId();
    const wsId = options?.workspaceId ?? this.workspaceId;
    const params = new URLSearchParams({ userId, query });
    if (wsId) params.set("workspaceId", wsId);
    if (options?.collections?.length)
      params.set("collections", options.collections.join(","));
    if (options?.limit) params.set("limit", String(options.limit));
    return this.request<HubSearchResult>(
      "GET",
      `/api/hub/search?${params}`,
      undefined,
      signal
    );
  }

  // ─── Relations & Graph ────────────────────────────────────────────────────

  /**
   * Get all relations for an entity — inbound and outbound.
   * Use to discover connections before graph traversal.
   *
   * Note: The backend GET /relations requires both userId and workspaceId.
   * This method resolves userId automatically; workspaceId falls back to client default.
   */
  async getRelations(
    entityId: string,
    options?: { workspaceId?: string }
  ): Promise<HubRelation[]> {
    const userId = await this.resolveUserId();
    const wsId = options?.workspaceId ?? this.workspaceId;
    if (!wsId) throw new Error("workspaceId is required for getRelations");
    const params = new URLSearchParams({ userId, workspaceId: wsId, entityId });
    const result = await this.request<
      HubRelation[] | HubListResponse<HubRelation>
    >("GET", `/api/hub/relations?${params}`);
    return unwrapList(result);
  }

  /**
   * Create a typed relation between two entities.
   * Type is a free string — conventions: "related_to", "parent_of", "child_of",
   * "belongs_to", "authored_by", "depends_on", "references".
   * Goes through governance — may return "proposed".
   */
  async createRelation(
    input: CreateRelationInput
  ): Promise<HubGovernanceResult> {
    const userId = input.userId ?? (await this.resolveUserId());
    const wsId = input.workspaceId ?? this.workspaceId;
    if (!wsId) throw new Error("workspaceId is required for createRelation");
    return this.request<HubGovernanceResult>("POST", "/api/hub/relations", {
      userId,
      workspaceId: wsId,
      sourceEntityId: input.sourceEntityId,
      targetEntityId: input.targetEntityId,
      type: input.type,
    });
  }

  /**
   * Delete a relation by ID (get from getRelations()).
   */
  async deleteRelation(relationId: string): Promise<void> {
    const userId = await this.resolveUserId();
    await this.request<unknown>("DELETE", `/api/hub/relations/${relationId}`, {
      userId,
    });
  }

  /**
   * Traverse the knowledge graph from an entity using BFS.
   * Returns nodes and edges up to maxDepth hops away.
   * maxDepth: 1=direct neighbors, 2=neighborhood (recommended), 3=extended (expensive).
   *
   * @example
   * const graph = await client.traverseGraph(projectId, { maxDepth: 2 });
   * const tasks = graph.nodes.filter(n => n.profileSlug === "task");
   */
  async traverseGraph(
    entityId: string,
    options?: { maxDepth?: number; workspaceId?: string }
  ): Promise<HubGraphResult> {
    const userId = await this.resolveUserId();
    const params = new URLSearchParams({
      userId,
      startEntityId: entityId,
      maxDepth: String(options?.maxDepth ?? 2),
    });
    const wsId = options?.workspaceId ?? this.workspaceId;
    if (wsId) params.set("workspaceId", wsId);
    return this.request<HubGraphResult>(
      "GET",
      `/api/hub/graph/traverse?${params}`
    );
  }

  /**
   * Unified view of everything connected to an entity. Merges three sources:
   *   1. Graph relations — explicit rows in the relations table (both directions)
   *   2. Structural links — entities whose `entity_id` properties point to this entity
   *   3. Thread connections — chat threads that touched this entity
   *
   * Prefer this over `getRelations()` / `traverseGraph()` when you want the complete
   * picture — those only see the relations table and miss property-based links that
   * haven't been synced (notably custom profiles without a `relationDefId` mapping).
   *
   * Each connection carries a `source` field so callers can filter by origin.
   *
   * @example
   * const { connections } = await client.getConnections(entityId);
   * const tasks = connections.filter(c => c.entity?.profileSlug === "task");
   */
  async getConnections(
    entityId: string,
    options?: { workspaceId?: string; limit?: number }
  ): Promise<HubConnectionsResult> {
    const userId = await this.resolveUserId();
    const wsId = options?.workspaceId ?? this.workspaceId;
    const params = new URLSearchParams({ userId });
    if (wsId) params.set("workspaceId", wsId);
    if (options?.limit) params.set("limit", String(options.limit));
    return this.request<HubConnectionsResult>(
      "GET",
      `/api/hub/entities/${entityId}/connections?${params}`
    );
  }

  // ─── Profiles & Schema ────────────────────────────────────────────────────

  /**
   * List all entity profile types in the workspace.
   * Always call before creating entities to discover what types are available.
   * Returns system profiles (always present) + custom workspace profiles.
   */
  async listProfiles(workspaceId: string): Promise<HubProfile[]> {
    const userId = await this.resolveUserId();
    const params = new URLSearchParams({ userId, workspaceId });
    const result = await this.request<
      HubProfile[] | HubListResponse<HubProfile>
    >("GET", `/api/hub/profiles?${params}`);
    return unwrapList(result);
  }

  /**
   * List property definitions for a workspace, optionally filtered by profile.
   */
  async listPropertyDefs(
    workspaceId: string,
    options?: { profileSlug?: string }
  ): Promise<HubPropertyDef[]> {
    const userId = await this.resolveUserId();
    const params = new URLSearchParams({ userId, workspaceId });
    if (options?.profileSlug) params.set("profileId", options.profileSlug);
    const result = await this.request<
      HubPropertyDef[] | HubListResponse<HubPropertyDef>
    >("GET", `/api/hub/property-defs?${params}`);
    return unwrapList(result);
  }

  // ─── Threads & Channels ───────────────────────────────────────────────────

  /**
   * List threads (channels) accessible to a user.
   */
  async listThreads(
    userId: string,
    options?: { workspaceId?: string; type?: string }
  ): Promise<HubThread[]> {
    const wsId = options?.workspaceId ?? this.workspaceId;
    const params = new URLSearchParams({ userId });
    if (wsId) params.set("workspaceId", wsId);
    if (options?.type) params.set("type", options.type);
    const result = await this.request<HubThread[] | HubListResponse<HubThread>>(
      "GET",
      `/api/hub/threads?${params}`
    );
    return unwrapList(result);
  }

  /**
   * Get the user's personal channel — their private AI conversation thread.
   * Use as default destination for messages and proactive posts.
   *
   * Note: The backend GET /channels/personal requires both userId and workspaceId.
   */
  async getPersonalChannel(
    userId: string,
    workspaceId?: string
  ): Promise<HubThread> {
    const wsId = workspaceId ?? this.workspaceId;
    if (!wsId)
      throw new Error("workspaceId is required for getPersonalChannel");
    const params = new URLSearchParams({ userId, workspaceId: wsId });
    return this.request<HubThread>(
      "GET",
      `/api/hub/channels/personal?${params}`
    );
  }

  /**
   * Create a new thread. Pass entityId to auto-link on creation.
   *
   * Note: The backend POST /threads requires workspaceId in the body.
   */
  async createThread(input: CreateThreadInput): Promise<HubThread> {
    const userId = input.userId ?? (await this.resolveUserId());
    const wsId = input.workspaceId ?? this.workspaceId;
    if (!wsId) throw new Error("workspaceId is required for createThread");
    return this.request<HubThread>("POST", "/api/hub/threads", {
      userId,
      workspaceId: wsId,
      title: input.name,
      agentType: input.agentType,
      contextObjectType: input.entityId
        ? "entity"
        : input.documentId
          ? "document"
          : undefined,
      contextObjectId: input.entityId ?? input.documentId,
    });
  }

  /**
   * Get full thread context: messages + all linked entities and documents.
   * Call before sending a message to orient the AI with conversation history.
   */
  async getThreadContext(threadId: string): Promise<HubThreadContext> {
    return this.request<HubThreadContext>(
      "GET",
      `/api/hub/threads/${threadId}/context`
    );
  }

  /**
   * Get messages in a thread.
   */
  async getMessages(
    threadId: string,
    options?: { limit?: number; before?: string }
  ): Promise<HubMessage[]> {
    // The backend GET /threads/:threadId/messages does not accept query params in
    // the current implementation — returns all messages ordered by timestamp.
    const result = await this.request<
      HubMessage[] | HubListResponse<HubMessage>
    >("GET", `/api/hub/threads/${threadId}/messages`);
    return unwrapList(result);
  }

  /**
   * Link an entity to a thread so it appears in thread context for AI.
   */
  async linkEntityToThread(threadId: string, entityId: string): Promise<void> {
    const userId = await this.resolveUserId();
    await this.request<unknown>(
      "POST",
      `/api/hub/threads/${threadId}/link-entity`,
      { userId, entityId }
    );
  }

  /**
   * Link a document to a thread.
   */
  async linkDocumentToThread(
    threadId: string,
    documentId: string
  ): Promise<void> {
    const userId = await this.resolveUserId();
    await this.request<unknown>(
      "POST",
      `/api/hub/threads/${threadId}/link-document`,
      { userId, documentId }
    );
  }

  /**
   * Get research branches of a thread — parallel AI investigations.
   */
  async getThreadBranches(
    threadId: string
  ): Promise<
    Array<{ channelId: string; branchPurpose: string | null; status: string }>
  > {
    const result = await this.request<{
      branches: Array<{
        channelId: string;
        branchPurpose: string | null;
        status: string;
      }>;
    }>("GET", `/api/hub/threads/${threadId}/branches`);
    return result.branches ?? [];
  }

  // ─── Memory ───────────────────────────────────────────────────────────────

  async storeMemory(input: StoreMemoryInput): Promise<{ id: string }> {
    const userId = await this.resolveUserId();
    const fact =
      input.context && String(input.context).trim().length > 0
        ? `[${String(input.context).trim()}] ${input.fact}`
        : input.fact;
    return this.request<{ id: string }>("POST", "/api/hub/memory", {
      userId,
      fact,
    });
  }

  async recallMemory(
    query: string,
    options?: { workspaceId?: string; limit?: number }
  ): Promise<HubMemoryResult[]> {
    const wsId = options?.workspaceId ?? this.workspaceId;
    const userId = await this.resolveUserId();
    const params = new URLSearchParams({
      userId,
      query,
      limit: String(options?.limit ?? 10),
    });
    if (wsId) params.set("workspaceId", wsId);

    const result = await this.request<
      HubMemoryResult[] | HubListResponse<HubMemoryResult>
    >("GET", `/api/hub/memory?${params}`);
    return unwrapList(result);
  }

  /**
   * Delete a stored memory fact by ID.
   */
  async deleteMemory(memoryId: string): Promise<void> {
    const userId = await this.resolveUserId();
    const params = new URLSearchParams({ userId });
    await this.request<unknown>(
      "DELETE",
      `/api/hub/memory/${memoryId}?${params}`
    );
  }

  // ─── Channels (Hub REST: channels are listed via GET /threads) ────────────

  async getChannels(options?: { workspaceId?: string }): Promise<HubChannel[]> {
    const wsId = options?.workspaceId ?? this.workspaceId;
    const userId = await this.resolveUserId();
    const params = new URLSearchParams({ userId });
    if (wsId) params.set("workspaceId", wsId);

    const result = await this.request<
      HubChannel[] | HubListResponse<HubChannel>
    >("GET", `/api/hub/threads?${params}`);
    return unwrapList(result);
  }

  async sendToChannel(input: SendToChannelInput): Promise<{ id: string }> {
    const userId = input.userId ?? (await this.resolveUserId());
    return this.request<{ id: string }>(
      "POST",
      `/api/hub/threads/${input.channelId}/messages`,
      {
        role: input.role ?? "user",
        content: input.content,
        userId,
        ...(input.autoRespond !== undefined
          ? { autoRespond: input.autoRespond }
          : {}),
      }
    );
  }

  // ─── Proposals ────────────────────────────────────────────────────────────

  /**
   * List proposals — pending AI writes awaiting human review.
   * Filter by status: "pending" (needs review), "approved", "rejected".
   */
  async listProposals(options?: {
    status?: "pending" | "approved" | "rejected";
    workspaceId?: string;
    limit?: number;
  }): Promise<HubProposal[]> {
    const userId = await this.resolveUserId();
    const wsId = options?.workspaceId ?? this.workspaceId;
    const params = new URLSearchParams({ userId });
    if (options?.status) params.set("status", options.status);
    if (wsId) params.set("workspaceId", wsId);
    if (options?.limit) params.set("limit", String(options.limit));
    const result = await this.request<
      HubProposal[] | HubListResponse<HubProposal>
    >("GET", `/api/hub/proposals?${params}`);
    return unwrapList(result);
  }

  /**
   * Approve or reject a proposal.
   *
   * Note: The backend PATCH /proposals/:id is an AI-revision endpoint that updates
   * the proposal data/summary, not a review (approve/reject) endpoint.
   * Use this to update proposal data before human review.
   */
  async reviewProposal(
    proposalId: string,
    decision: "approved" | "rejected",
    reason?: string
  ): Promise<HubProposal> {
    return this.request<HubProposal>(
      "PATCH",
      `/api/hub/proposals/${proposalId}`,
      {
        data: { status: decision },
        summary: reason,
      }
    );
  }

  // ─── Views ────────────────────────────────────────────────────────────────

  /**
   * List data views in a workspace.
   */
  async listViews(
    workspaceId: string,
    options?: { profileSlug?: string }
  ): Promise<HubView[]> {
    const userId = await this.resolveUserId();
    const params = new URLSearchParams({ userId, workspaceId });
    if (options?.profileSlug) params.set("profileId", options.profileSlug);
    const result = await this.request<HubView[] | HubListResponse<HubView>>(
      "GET",
      `/api/hub/views?${params}`
    );
    return unwrapList(result);
  }

  /**
   * Create a new view. Goes through governance.
   */
  async createView(input: CreateViewInput): Promise<HubGovernanceResult> {
    const userId = input.userId ?? (await this.resolveUserId());
    return this.request<HubGovernanceResult>("POST", "/api/hub/views", {
      userId,
      workspaceId: input.workspaceId ?? this.workspaceId,
      name: input.name,
      type: input.type,
      profileId: input.profileSlug,
      config: input.config,
    });
  }

  // ─── Documents ────────────────────────────────────────────────────────────

  /**
   * Get a document by ID with full markdown content.
   */
  async getDocument(documentId: string): Promise<HubDocument> {
    const userId = await this.resolveUserId();
    const params = new URLSearchParams({ userId });
    return this.request<HubDocument>(
      "GET",
      `/api/hub/documents/${documentId}?${params}`
    );
  }

  /**
   * Create a document. Use for long-form content: meeting notes, research, writeups.
   * Goes through governance.
   */
  async createDocument(
    input: CreateDocumentInput & { workspaceId?: string }
  ): Promise<HubGovernanceResult> {
    const userId = await this.resolveUserId();
    return this.request<HubGovernanceResult>("POST", "/api/hub/documents", {
      userId,
      workspaceId: input.workspaceId ?? this.workspaceId,
      title: input.title,
      content: input.content ?? "",
    });
  }

  // ─── Commands & Agents ────────────────────────────────────────────────────

  /**
   * List available commands (automation shortcuts) in the workspace.
   */
  async listCommands(workspaceId?: string): Promise<HubCommand[]> {
    const wsId = workspaceId ?? this.workspaceId;
    const params = new URLSearchParams();
    if (wsId) params.set("workspaceId", wsId);
    const qs = params.toString() ? `?${params}` : "";
    const result = await this.request<
      HubCommand[] | HubListResponse<HubCommand>
    >("GET", `/api/hub/commands${qs}`);
    return unwrapList(result);
  }

  /**
   * Execute a command by slug.
   *
   * Note: The backend POST /commands/execute uses a `command` field (the shell command
   * string) and `userId`, not a `slug`. This maps ExecuteCommandInput.slug to `command`.
   */
  async executeCommand(
    input: ExecuteCommandInput
  ): Promise<{ status: string; result?: unknown }> {
    const userId = input.userId ?? (await this.resolveUserId());
    return this.request<{ status: string; result?: unknown }>(
      "POST",
      "/api/hub/commands/execute",
      {
        command: input.slug,
        userId,
        workspaceId: input.workspaceId ?? this.workspaceId,
        ...(input.parameters ? { parameters: input.parameters } : {}),
      }
    );
  }

  /**
   * List agent users provisioned in the workspace.
   */
  async listAgentUsers(workspaceId?: string): Promise<HubAgentUser[]> {
    const wsId = workspaceId ?? this.workspaceId;
    const params = new URLSearchParams();
    if (wsId) params.set("workspaceId", wsId);
    const qs = params.toString() ? `?${params}` : "";
    const result = await this.request<
      HubAgentUser[] | HubListResponse<HubAgentUser>
    >("GET", `/api/hub/agent-users${qs}`);
    return unwrapList(result);
  }

  // ─── Proactive posting ────────────────────────────────────────────────────

  /**
   * Post a proactive message to the user's personal channel.
   * For AI-initiated insights and summaries. Rate-limited: 3/hour, 10/day.
   * proactiveType must be one of: insight, suggestion, alert, nudge,
   * morning_briefing, weekly_digest, health_check.
   */
  async postProactive(
    userId: string,
    content: string,
    options?: { workspaceId?: string; type?: string }
  ): Promise<{ id: string }> {
    const wsId = options?.workspaceId ?? this.workspaceId;
    if (!wsId) throw new Error("workspaceId is required for postProactive");
    return this.request<{ id: string }>("POST", "/api/hub/proactive/post", {
      userId,
      workspaceId: wsId,
      content,
      proactiveType: options?.type ?? "insight",
    });
  }

  // ─── Capture pipeline ─────────────────────────────────────────────────────

  async captureStructure(input: {
    text: string;
    url?: string;
    workspaceId?: string;
    previousEntities?: CaptureProposal[];
  }): Promise<CaptureStructureResponse> {
    const userId = await this.resolveUserId();
    return this.request<CaptureStructureResponse>(
      "POST",
      "/api/hub/capture/structure",
      {
        userId,
        text: input.text,
        url: input.url,
        workspaceId: input.workspaceId ?? this.workspaceId,
        previousEntities: input.previousEntities,
      }
    );
  }

  async captureExecute(
    input: CaptureExecuteInput & { workspaceId?: string }
  ): Promise<CaptureExecuteResponse> {
    const userId = await this.resolveUserId();
    return this.request<CaptureExecuteResponse>(
      "POST",
      "/api/hub/capture/execute",
      {
        userId,
        entities: input.entities,
        relations: input.relations ?? [],
        workspaceId: input.workspaceId ?? this.workspaceId,
      }
    );
  }
}
