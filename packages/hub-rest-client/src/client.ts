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
  AskResponse,
  HubDocument,
  HubRelation,
  HubGraphResult,
  HubConnectionsResult,
  HubProfile,
  HubPropertyDef,
  HubDiscoverResult,
  HubDiscoverOptions,
  HubOrientOptions,
  HubOrientResult,
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
  AttachFacetInput,
  HubAttachFacetResult,
  CreateViewInput,
  UpdateViewInput,
  ArrangeBentoViewInput,
  HubBentoArrangementResult,
  ExecuteCommandInput,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateDocumentProposalInput,
  HubDocumentProposalResult,
  HubCapability,
  HubCapabilityCatalogResult,
  HubRunnableCapabilityActionsResult,
  ExecuteCapabilityInput,
  ExecuteCapabilityResult,
  ListAgentSkillsOptions,
  HubAgentSkillsResult,
  HubAgentSkill,
  GetCapabilityBriefsInput,
  HubCapabilityBriefsResult,
  SubmitCaptureGraphInput,
  SubmitCaptureGraphResult,
  HubAutomation,
  CreateAutomationInput,
  UpdateAutomationInput,
  AutomationStatus,
  ReactionKind,
  ReactionLens,
  HubReactionEvent,
  CreateNotificationInput,
  HubWebhookDelivery,
} from "./types.js";

export interface HubRestClientConfig {
  /** Pod URL, e.g. https://my-pod.synap.live */
  podUrl: string;
  /** Hub Protocol API key (Bearer token) */
  apiKey: string;
  /** Default workspace ID — used when not specified per call */
  workspaceId?: string;
  /** Optional request timeout in ms (default: 30000). Fallback when read/write timeouts are unset. */
  timeoutMs?: number;
  /** Optional read (GET) timeout in ms (default: timeoutMs ?? 30000). */
  readTimeoutMs?: number;
  /** Optional write (non-GET) timeout in ms (default: timeoutMs ?? 30000). */
  writeTimeoutMs?: number;
  /**
   * Max attempts for a request (default: 3). Retries ONLY on network failure or
   * 5xx — never on 4xx, never on a caller-provided abort. Set to 1 to disable.
   */
  maxAttempts?: number;
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

/**
 * Unwrap a Hub list body into a plain array.
 *
 * The Hub does NOT have one list envelope. Endpoints return, variously:
 *   - a bare array                       (`/views`, `/commands`, `/entities`, …)
 *   - `{ data: [...] }`                  (the nominal envelope)
 *   - `{ <resourceName>: [...] }`        (`/relations`, `/proposals`,
 *                                         `/property-defs`, `/automations`)
 *   - `{ items: [...], lens }`           (`/subscriptions`)
 *
 * `envelopeKey` names the resource-specific key for that last family. Passing
 * it is NOT optional decoration: without it a `{ relations: [...] }` body falls
 * through to `[]`, and the caller sees an empty list instead of an error. That
 * is exactly what happened — FIVE methods here returned `[]` unconditionally,
 * on every call, for as long as they have existed:
 * `getRelations`, `listProposals`, `listPropertyDefs`, `listAutomations`,
 * `listSubscriptions`. All five verified live against a pod.
 *
 * The `{ workspaces }` case had already been found ONCE and fixed with a
 * bespoke `unwrapWorkspacesResponse` helper, whose comment noted the exact
 * defect — and it was never generalized, so the same bug kept shipping. That
 * helper is now folded in here: one door, no second table to drift.
 *
 * If you add a list method, CHECK THE BODY the route actually returns (curl it)
 * rather than assuming `{ data }`. A silent `[]` is indistinguishable from an
 * empty result at every call site.
 */
function unwrapList<T>(
  // `object` (not `Record<string, unknown>`) so declared interfaces without an
  // index signature — e.g. `HubWorkspacesListResponse` — are accepted too.
  result: T[] | HubListResponse<T> | object,
  envelopeKey?: string
): T[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.data)) return obj.data as T[];
  if (envelopeKey && Array.isArray(obj[envelopeKey])) {
    return obj[envelopeKey] as T[];
  }
  return [];
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
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly maxAttempts: number;
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
    this.readTimeoutMs = config.readTimeoutMs ?? this.timeoutMs;
    this.writeTimeoutMs = config.writeTimeoutMs ?? this.timeoutMs;
    this.maxAttempts = Math.max(1, config.maxAttempts ?? 3);
  }

  /** User id for the current API key (Hub REST requires userId on several GETs). */
  private async resolveUserId(): Promise<string> {
    if (this.resolvedUserId) return this.resolvedUserId;
    const me = await this.getMe();
    this.resolvedUserId = me.id;
    return me.id;
  }

  /**
   * The ONE shared request loop. Per-method timeout (GET = read, else write, or a
   * caller override) + up to `maxAttempts` with exponential backoff. Retries ONLY
   * on a network failure or 5xx; NEVER on a 4xx or a caller abort. Returns the raw
   * `Response` for any non-5xx (ok OR 4xx) — the typed entry points below decide
   * how to interpret it. This is the single source of retry/timeout truth, shared
   * by the CLI and the IS's `ISHubClient` (which reuses the protected entry points
   * rather than re-implementing fetch).
   */
  private async fetchWithRetry(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    timeoutMsOverride?: number
  ): Promise<Response> {
    const url = `${this.base}${path}`;
    const perAttemptTimeout =
      timeoutMsOverride ??
      (method.toUpperCase() === "GET"
        ? this.readTimeoutMs
        : this.writeTimeoutMs);

    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1_000 * attempt)); // 0, 1s, 2s, …
      }
      const timeout = AbortSignal.timeout(perAttemptTimeout);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const res = await fetch(url, {
          method,
          headers: this.headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: combined,
        });
        if (res.status < 500) return res; // ok or 4xx — caller decides; never retry
        lastError = new Error(`HTTP ${res.status}`); // 5xx — retry until exhausted
      } catch (err) {
        if (signal?.aborted) throw err; // caller asked to abort — honor it
        lastError = err; // network/abort-timeout — retry
      }
    }
    throw lastError;
  }

  /** Build a HubApiError from a non-ok Response (reads the JSON error body). */
  private async toHubError(res: Response): Promise<HubApiError> {
    const errorBody = await res.json().catch(() => ({}));
    return new HubApiError(
      formatHubErrorMessage(res.status, res.statusText, errorBody),
      res.status,
      errorBody
    );
  }

  /** Parse a 2xx body, tolerating an empty/204 response (returns undefined). */
  private async parseBody<T>(res: Response): Promise<T> {
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Typed JSON request — throws `HubApiError` on any non-2xx. Protected so the IS
   * subclass reuses it. Tolerates an empty/204 body (returns `undefined`).
   */
  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const res = await this.fetchWithRetry(method, path, body, signal);
    if (!res.ok) throw await this.toHubError(res);
    return this.parseBody<T>(res);
  }

  /**
   * Like `request<T>` but returns `null` on 404/403 (the "absent/forbidden →
   * empty" contract several IS reads use) instead of throwing.
   */
  protected async requestOrNull<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T | null> {
    const res = await this.fetchWithRetry(method, path, body, signal);
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw await this.toHubError(res);
    return this.parseBody<T | null>(res);
  }

  /**
   * The raw `Response` (same retry/timeout infra), for the few callers that read
   * `.text()`, branch on status themselves, or need a per-call timeout override.
   */
  protected async requestRaw(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    timeoutMsOverride?: number
  ): Promise<Response> {
    return this.fetchWithRetry(method, path, body, signal, timeoutMsOverride);
  }

  // ─── Identity ─────────────────────────────────────────────────────────────

  async getMe(): Promise<HubUser> {
    return this.request<HubUser>("GET", "/api/hub/users/me");
  }

  async getWorkspaces(): Promise<HubWorkspace[]> {
    const result = await this.request<
      HubWorkspace[] | HubListResponse<HubWorkspace> | HubWorkspacesListResponse
    >("GET", "/api/hub/workspaces");
    return unwrapList<HubWorkspace>(result, "workspaces");
  }

  async provisionAgentWorkspace(input: {
    agentUserId: string;
    workspaceName?: string;
  }): Promise<{ workspaceId: string; created: boolean }> {
    return this.request<{ workspaceId: string; created: boolean }>(
      "POST",
      "/api/hub/workspaces/provision-agent",
      input
    );
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
      /**
       * "workspace" (default) — applies the client workspaceId filter.
       * "all" — omits workspaceId entirely so results span all workspaces.
       */
      scope?: "workspace" | "all";
      limit?: number;
    },
    signal?: AbortSignal
  ): Promise<HubEntity[]> {
    const params = new URLSearchParams({ q: query });
    if (options?.profileSlug) params.set("profileSlug", options.profileSlug);
    // When scope === "all", intentionally omit workspaceId for cross-workspace search.
    if (options?.scope !== "all") {
      const wsId = options?.workspaceId ?? this.workspaceId;
      if (wsId) params.set("workspaceId", wsId);
    }
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
    /** "all" — omits workspaceId so results span all workspaces the user can access. */
    scope?: "workspace" | "all";
  }): Promise<HubEntity[]> {
    const params = new URLSearchParams({
      sort: "updatedAt:desc",
      limit: String(options?.limit ?? 20),
    });
    if (options?.profileSlug) params.set("profileSlug", options.profileSlug);
    if (options?.scope !== "all") {
      const wsId = options?.workspaceId ?? this.workspaceId;
      if (wsId) params.set("workspaceId", wsId);
    }

    const result = await this.request<HubEntity[] | HubListResponse<HubEntity>>(
      "GET",
      `/api/hub/entities?${params}`
    );
    return unwrapList(result);
  }

  async createEntity(input: CreateEntityInput): Promise<HubGovernanceResult> {
    const { content, url, status, priority, dueDate, properties, ...rest } =
      input;
    return this.request<HubGovernanceResult>("POST", "/api/hub/entities", {
      ...rest,
      // Entity placement is a write decision, never an ambient client default.
      // Omitted means pod/base behavior; an explicit workspace opts into its
      // overlay/membership lens. This deliberately differs from read helpers.
      ...(rest.workspaceId ? { workspaceId: rest.workspaceId } : {}),
      ...(content !== undefined ? { content } : {}),
      properties: {
        ...properties,
        ...(url !== undefined ? { url } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(dueDate !== undefined ? { dueDate } : {}),
      },
    });
  }

  async updateEntity(
    id: string,
    input: UpdateEntityInput
  ): Promise<HubEntity | HubGovernanceResult> {
    // Backend may return a full entity (approved) or a governance envelope
    // (proposed/denied). Callers MUST check `status` first when governance
    // is likely — e.g., agent-owned workspaces, destructive updates.
    const { properties, content, url, status, priority, dueDate, ...rest } =
      input;
    return this.request<HubEntity | HubGovernanceResult>(
      "PATCH",
      `/api/hub/entities/${id}`,
      {
        ...rest,
        metadata: {
          ...properties,
          ...(content !== undefined ? { content } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(dueDate !== undefined ? { dueDate } : {}),
        },
      }
    );
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
    return unwrapList(result, "relations");
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
   * Attach a role-profile through the canonical governed facet door. A result
   * may be `proposed`; callers must surface its review information instead of
   * claiming the role was applied.
   */
  async attachFacet(input: AttachFacetInput): Promise<HubAttachFacetResult> {
    const userId = await this.resolveUserId();
    return this.request<HubAttachFacetResult>(
      "POST",
      `/api/hub/entities/${input.entityId}/facets`,
      {
        userId,
        profileSlug: input.profileSlug,
        profileId: input.profileId,
        workspaceId: input.workspaceId ?? this.workspaceId,
        contextEntityId: input.contextEntityId,
        status: input.status,
        properties: input.properties,
        reasoning: input.reasoning,
      }
    );
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
   * Unified view of everything connected to an entity across the local graph:
   *   1. Graph relations — explicit rows in the relations table (both directions)
   *   2. Structural links — inbound and outbound `entity_id` property edges
   *   3. Channel and focus-session connections around this entity
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

  // ─── Session orientation & profile discovery ─────────────────────────────

  /**
   * Canonical session bootstrap shared by the MCP, CLI, and external surfaces.
   * It is deliberately a lens map, not a profile/schema dump; use discover()
   * only for the selected profiles needed by the next action.
   */
  async orient(options?: HubOrientOptions): Promise<HubOrientResult> {
    const params = new URLSearchParams();
    if (options?.detail) params.set("detail", options.detail);
    if (options?.scope?.length) params.set("scope", options.scope.join(","));
    if (options?.workspaceId) params.set("workspaceId", options.workspaceId);
    if (options?.projectId) params.set("projectId", options.projectId);
    const qs = params.toString() ? `?${params}` : "";
    return this.request<HubOrientResult>("GET", `/api/hub/orient${qs}`);
  }

  // ─── Profiles & Schema ────────────────────────────────────────────────────

  /**
   * List all entity profile types in the workspace.
   * Always call before creating entities to discover what types are available.
   * Returns system profiles (always present) + custom workspace profiles.
   */
  async listProfiles(
    workspaceId: string,
    options?: { detail?: "full" }
  ): Promise<HubProfile[]> {
    const userId = await this.resolveUserId();
    const params = new URLSearchParams({ userId, workspaceId });
    if (options?.detail) params.set("detail", options.detail);
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
    return unwrapList(result, "propertyDefs");
  }

  /**
   * Runtime discovery — profiles with property schemas + command tree.
   *
   * Call once per session at session start. Returns ground-truth profile
   * schemas (including custom workspace profiles) and the canonical CLI
   * command map. Replaces static skill file profile descriptions.
   */
  async discover(
    options?: string | HubDiscoverOptions
  ): Promise<HubDiscoverResult> {
    const userId = await this.resolveUserId();
    const normalized =
      typeof options === "string" ? { workspaceId: options } : (options ?? {});
    const params = new URLSearchParams({ userId });
    // No configured fallback: an omitted workspace asks for the base schema,
    // while an explicit one resolves only that workspace's overlays.
    if (normalized.workspaceId)
      params.set("workspaceId", normalized.workspaceId);
    if (normalized.summary !== undefined)
      params.set("summary", String(normalized.summary));
    if (normalized.profileSlugs?.length)
      params.set("profileSlugs", normalized.profileSlugs.join(","));
    return this.request<HubDiscoverResult>(
      "GET",
      `/api/hub/discover?${params}`
    );
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
    _options?: { limit?: number; before?: string }
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
   * List proposals — the audit trail of AI writes.
   *
   * Filter by status: "pending" (needs review), "approved", "rejected",
   * "auto_approved" (the write EXECUTED immediately under governance and filed
   * this row as its audit receipt), "reverted", "approval_failed",
   * "withdrawn", or "all". Mirrors the server-side `PROPOSAL_STATUS_FILTERS`.
   */
  async listProposals(options?: {
    status?:
      | "pending"
      | "approved"
      | "rejected"
      | "auto_approved"
      | "reverted"
      | "approval_failed"
      | "withdrawn"
      | "all";
    workspaceId?: string;
    /**
     * "workspace" (default) — applies the client workspaceId filter.
     * "all" — omits workspaceId so results span every workspace the user can see.
     */
    scope?: "workspace" | "all";
    limit?: number;
    /** Rows to skip. Pair with `listProposalsPage` to page a queue. */
    offset?: number;
  }): Promise<HubProposal[]> {
    const userId = await this.resolveUserId();
    const params = new URLSearchParams({ userId });
    // When scope === "all", intentionally omit workspaceId — matches searchEntities/
    // getRecentEntities so a "review everything" caller isn't silently narrowed to
    // just the connection's default workspace.
    if (options?.scope !== "all") {
      const wsId = options?.workspaceId ?? this.workspaceId;
      if (wsId) params.set("workspaceId", wsId);
    }
    if (options?.status) params.set("status", options.status);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset !== undefined) {
      params.set("offset", String(options.offset));
    }
    const result = await this.request<
      HubProposal[] | HubListResponse<HubProposal>
    >("GET", `/api/hub/proposals?${params}`);
    return unwrapList(result, "proposals");
  }

  /**
   * Same query as `listProposals`, but returns the SERVER'S pagination envelope
   * instead of just the rows.
   *
   * `listProposals` is typed to an array, so `total` / `hasMore` are dropped on
   * the floor — and a caller that cannot see `total` has to infer the size of
   * the queue from the size of the page. That inference is the exact bug this
   * pagination work exists to kill: three surfaces rendered 322 / 100 / 50 for
   * one question, two of them page sizes wearing a total's clothes.
   *
   * This is an ADDITIVE sibling rather than a changed return type on
   * `listProposals`, on purpose: the Intelligence Service overrides
   * `listProposals` with a deliberately different signature, and widening the
   * base method's return would break that override silently.
   *
   * `total` is the size of the whole matching queue; `proposals.length` is the
   * size of this page. They are different numbers — do not render the second
   * where you mean the first.
   */
  async listProposalsPage(options?: {
    status?:
      | "pending"
      | "approved"
      | "rejected"
      | "auto_approved"
      | "reverted"
      | "approval_failed"
      | "withdrawn"
      | "all";
    workspaceId?: string;
    scope?: "workspace" | "all";
    limit?: number;
    offset?: number;
  }): Promise<{
    proposals: HubProposal[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    const userId = await this.resolveUserId();
    const params = new URLSearchParams({ userId });
    if (options?.scope !== "all") {
      const wsId = options?.workspaceId ?? this.workspaceId;
      if (wsId) params.set("workspaceId", wsId);
    }
    if (options?.status) params.set("status", options.status);
    if (options?.limit !== undefined)
      params.set("limit", String(options.limit));
    if (options?.offset !== undefined) {
      params.set("offset", String(options.offset));
    }
    const result = await this.request<Record<string, unknown>>(
      "GET",
      `/api/hub/proposals?${params}`
    );
    const proposals = unwrapList<HubProposal>(result, "proposals");
    // A pod that predates the pagination fix returns `{ proposals }` with no
    // envelope fields. Degrade HONESTLY rather than inventing a total: report
    // the page length and `hasMore:false`, which is what the old wire actually
    // supports — never a fabricated count.
    const total =
      typeof result.total === "number" ? result.total : proposals.length;
    return {
      proposals,
      total,
      limit: typeof result.limit === "number" ? result.limit : proposals.length,
      offset: typeof result.offset === "number" ? result.offset : 0,
      hasMore: result.hasMore === true,
    };
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
      metadata: input.metadata,
      agentUserId: input.agentUserId,
      reasoning: input.reasoning,
      sourceMessageId: input.sourceMessageId,
    });
  }

  /** Update a view through the existing governed Hub route. */
  async updateView(
    viewId: string,
    input: UpdateViewInput
  ): Promise<HubView | HubGovernanceResult> {
    const userId = input.userId ?? (await this.resolveUserId());
    return this.request<HubView | HubGovernanceResult>(
      "PATCH",
      `/api/hub/views/${viewId}`,
      {
        userId,
        workspaceId: input.workspaceId ?? this.workspaceId,
        name: input.name,
        config: input.config,
        metadata: input.metadata,
        agentUserId: input.agentUserId,
        reasoning: input.reasoning,
        sourceMessageId: input.sourceMessageId,
      }
    );
  }

  /** Replace a bento view's widget arrangement through the existing Hub route. */
  async arrangeBentoView(
    viewId: string,
    input: ArrangeBentoViewInput
  ): Promise<HubBentoArrangementResult> {
    const userId = input.userId ?? (await this.resolveUserId());
    const workspaceId = input.workspaceId ?? this.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required for arrangeBentoView");
    }
    return this.request<HubBentoArrangementResult>(
      "POST",
      `/api/hub/views/${viewId}/arrange`,
      {
        userId,
        workspaceId,
        widgets: input.widgets,
        agentUserId: input.agentUserId,
        reasoning: input.reasoning,
        sourceMessageId: input.sourceMessageId,
      }
    );
  }

  // ─── Documents ────────────────────────────────────────────────────────────

  /**
   * Get a document by ID with full markdown content.
   */
  async getDocument(documentId: string): Promise<HubDocument> {
    const userId = await this.resolveUserId();
    const params = new URLSearchParams({ userId });
    const result = await this.request<HubDocument | { document: HubDocument }>(
      "GET",
      `/api/hub/documents/${documentId}?${params}`
    );
    return "document" in result ? result.document : result;
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
      type: input.type,
      reasoning: input.reasoning,
      agentUserId: input.agentUserId,
      sourceMessageId: input.sourceMessageId,
      sessionId: input.sessionId,
    });
  }

  /** Propose a full document-content replacement through the governed Hub route. */
  async updateDocument(
    documentId: string,
    input: UpdateDocumentInput
  ): Promise<HubDocumentProposalResult> {
    const userId = await this.resolveUserId();
    return this.request<HubDocumentProposalResult>(
      "PATCH",
      `/api/hub/documents/${documentId}`,
      {
        userId,
        content: input.content,
        title: input.title,
        agentUserId: input.agentUserId,
        sourceMessageId: input.sourceMessageId,
        sessionId: input.sessionId,
      }
    );
  }

  /** Submit a structured, reviewable document-edit proposal. */
  async createDocumentProposal(
    input: CreateDocumentProposalInput
  ): Promise<HubDocumentProposalResult> {
    const userId = await this.resolveUserId();
    return this.request<HubDocumentProposalResult>(
      "POST",
      "/api/hub/documents/proposals",
      {
        userId,
        ...input,
      }
    );
  }

  // ─── Capabilities & teaching substrate ───────────────────────────────────

  /** Flat capability read-model. Prefer getCapabilityCatalog() for presentation. */
  async listCapabilities(options?: {
    workspaceId?: string;
  }): Promise<HubCapability[]> {
    const workspaceId = options?.workspaceId ?? this.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required for listCapabilities");
    }
    const params = new URLSearchParams({ workspaceId });
    const result = await this.request<{ capabilities: HubCapability[] }>(
      "GET",
      `/api/hub/capabilities?${params}`
    );
    return result.capabilities;
  }

  /** Status-computed, pack-grouped capability catalog for every external surface. */
  async getCapabilityCatalog(options?: {
    workspaceId?: string;
    extraKey?: string;
  }): Promise<HubCapabilityCatalogResult> {
    const workspaceId = options?.workspaceId ?? this.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required for getCapabilityCatalog");
    }
    const params = new URLSearchParams({ workspaceId });
    if (options?.extraKey) params.set("extraKey", options.extraKey);
    return this.request<HubCapabilityCatalogResult>(
      "GET",
      `/api/hub/capabilities/catalog?${params}`
    );
  }

  /** List only approved, connected actions that this client can execute now. */
  async listRunnableCapabilityActions(options?: {
    workspaceId?: string;
    query?: string;
    kind?: string;
    limit?: number;
  }): Promise<HubRunnableCapabilityActionsResult> {
    const workspaceId = options?.workspaceId ?? this.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "workspaceId is required for listRunnableCapabilityActions"
      );
    }
    const params = new URLSearchParams({ workspaceId });
    if (options?.query) params.set("query", options.query);
    if (options?.kind) params.set("kind", options.kind);
    if (options?.limit !== undefined)
      params.set("limit", String(options.limit));
    return this.request<HubRunnableCapabilityActionsResult>(
      "GET",
      `/api/hub/capabilities/actions?${params}`
    );
  }

  /** Run one registered capability through the shared governance gate. */
  async executeCapability(
    input: ExecuteCapabilityInput
  ): Promise<ExecuteCapabilityResult> {
    return this.request<ExecuteCapabilityResult>(
      "POST",
      "/api/hub/capabilities/execute",
      {
        ...input,
        // Graph proposals follow the same explicit-scope rule as direct writes.
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      }
    );
  }

  /** List the compact system teaching catalog, or search the available skill index. */
  async listAgentSkills(
    options?: ListAgentSkillsOptions
  ): Promise<HubAgentSkillsResult> {
    const params = new URLSearchParams();
    if (options?.topic) params.set("topic", options.topic);
    if (options?.query) params.set("q", options.query);
    if (options?.tag) params.set("tag", options.tag);
    if (options?.system !== undefined)
      params.set("system", String(options.system));
    const workspaceId = options?.workspaceId ?? this.workspaceId;
    if (workspaceId) params.set("workspaceId", workspaceId);
    if (options?.limit !== undefined)
      params.set("limit", String(options.limit));
    if (options?.offset !== undefined)
      params.set("offset", String(options.offset));
    const qs = params.toString() ? `?${params}` : "";
    return this.request<HubAgentSkillsResult>(
      "GET",
      `/api/hub/agent-skills${qs}`
    );
  }

  /** Load one skill body only when it is relevant to the agent's next action. */
  async getAgentSkillBySlug(
    slug: string,
    options?: { workspaceId?: string }
  ): Promise<HubAgentSkill> {
    const workspaceId = options?.workspaceId ?? this.workspaceId;
    const qs = workspaceId ? `?${new URLSearchParams({ workspaceId })}` : "";
    return this.request<HubAgentSkill>(
      "GET",
      `/api/hub/agent-skills/by-slug/${encodeURIComponent(slug)}${qs}`
    );
  }

  /** Compose just-in-time teaching and governance briefs for selected tools. */
  async getCapabilityBriefs(
    input: GetCapabilityBriefsInput
  ): Promise<HubCapabilityBriefsResult> {
    if (input.tools.length === 0) return { briefs: {} };
    const workspaceId = input.workspaceId ?? this.workspaceId;
    const params = new URLSearchParams({ tools: input.tools.join(",") });
    if (workspaceId) params.set("workspaceId", workspaceId);
    if (input.door) params.set("door", input.door);
    return this.request<HubCapabilityBriefsResult>(
      "GET",
      `/api/hub/briefs?${params}`
    );
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
        // Keep this exact routing bundle in lockstep with CaptureExecuteInput
        // and the REST codec. Dropping it here silently made CLI/Raycast capture
        // behave differently from MCP despite all three using the same backend.
        projectId: input.projectId,
        targetWorkspaceId: input.targetWorkspaceId,
        keepRaw: input.keepRaw,
        file: input.file,
        idempotencyKey: input.idempotencyKey,
        workspaceRouting: input.workspaceRouting,
        aiWorkspaceId: input.aiWorkspaceId,
        aiWorkspaceConfidence: input.aiWorkspaceConfidence,
        aiWorkspaceReason: input.aiWorkspaceReason,
      }
    );
  }

  /**
   * Submit a designed entity graph as ONE reviewable composite proposal.
   *
   * This is intentionally distinct from captureExecute(): execute materializes
   * a prior structure result immediately, while this door keeps an autonomous
   * graph plan reviewable and applies entities, relations, and bindings together
   * only after approval.
   */
  async submitCaptureGraph(
    input: SubmitCaptureGraphInput
  ): Promise<SubmitCaptureGraphResult> {
    const { workspaceId, relations, bindings, ...body } = input;
    return this.request<SubmitCaptureGraphResult>(
      "POST",
      "/api/hub/capture/graph",
      {
        ...body,
        // Proposal audience and schema overlays are explicit write choices.
        ...(workspaceId ? { workspaceId } : {}),
        relations: relations ?? [],
        bindings: bindings ?? [],
      }
    );
  }

  // ─── Recall: the one door ──────────────────────────────────────────────────

  /**
   * `ask` — the unified recall verb. Routes a natural-language question across
   * all knowledge substrates (semantic entities, procedural runbooks, episodic
   * facts) server-side and returns ONE provenance-tagged answer. The canonical
   * recall door — prefer it over the fragmented searchEntities / recallMemory.
   * The server builds the profile catalog from the caller's workspace; the
   * client only sends the query (+ optional scope).
   */
  async ask(input: {
    query: string;
    workspaceId?: string;
    limit?: number;
    /**
     * Return just the glass-box understanding + routing (no retrieval) — for a
     * caller that routes a query before fetching results (e.g. a palette
     * completing a type word). `answers` comes back empty.
     */
    parseOnly?: boolean;
  }): Promise<AskResponse> {
    return this.request<AskResponse>("POST", "/api/hub/knowledge/ask", {
      query: input.query,
      workspaceId: input.workspaceId ?? this.workspaceId,
      limit: input.limit,
      parseOnly: input.parseOnly,
    });
  }

  // ─── Automations ───────────────────────────────────────────────────────────

  /**
   * List automations for the current user, optionally filtered by workspace and status.
   */
  async listAutomations(options?: {
    workspaceId?: string;
    status?: AutomationStatus;
    limit?: number;
  }): Promise<HubAutomation[]> {
    const userId = await this.resolveUserId();
    const wsId = options?.workspaceId ?? this.workspaceId;
    const params = new URLSearchParams({ userId });
    if (wsId) params.set("workspaceId", wsId);
    if (options?.status) params.set("status", options.status);
    if (options?.limit) params.set("limit", String(options.limit));
    const result = await this.request<
      HubAutomation[] | HubListResponse<HubAutomation>
    >("GET", `/api/hub/automations?${params}`);
    return unwrapList(result, "automations");
  }

  /**
   * Get a single automation by ID.
   */
  async getAutomation(
    automationId: string,
    options?: { workspaceId?: string }
  ): Promise<HubAutomation> {
    const userId = await this.resolveUserId();
    const wsId = options?.workspaceId ?? this.workspaceId;
    const params = new URLSearchParams({ userId });
    if (wsId) params.set("workspaceId", wsId);
    return this.request<HubAutomation>(
      "GET",
      `/api/hub/automations/${automationId}?${params}`
    );
  }

  /**
   * Create an automation. Defaults to status=draft.
   * Use activateAutomation() to enable it.
   */
  async createAutomation(input: CreateAutomationInput): Promise<HubAutomation> {
    const userId = input.userId ?? (await this.resolveUserId());
    const wsId = input.workspaceId ?? this.workspaceId;
    return this.request<HubAutomation>("POST", "/api/hub/automations/create", {
      ...input,
      userId,
      workspaceId: wsId ?? null,
    });
  }

  /**
   * Update an automation's definition or metadata.
   */
  async updateAutomation(
    automationId: string,
    input: UpdateAutomationInput
  ): Promise<HubAutomation> {
    const userId = input.userId ?? (await this.resolveUserId());
    const wsId = input.workspaceId ?? this.workspaceId;
    if (!wsId) throw new Error("workspaceId is required for updateAutomation");
    return this.request<HubAutomation>(
      "PATCH",
      `/api/hub/automations/${automationId}`,
      { ...input, userId, workspaceId: wsId }
    );
  }

  /**
   * Manually trigger an automation once with an optional payload.
   * Bypasses the automation's normal trigger config.
   */
  async triggerAutomation(
    automationId: string,
    options?: {
      payload?: Record<string, unknown>;
      workspaceId?: string;
    }
  ): Promise<{ status: string; runId?: string; result?: unknown }> {
    const userId = await this.resolveUserId();
    const wsId = options?.workspaceId ?? this.workspaceId;
    return this.request<{ status: string; runId?: string; result?: unknown }>(
      "POST",
      `/api/hub/automations/${automationId}/trigger`,
      { userId, workspaceId: wsId ?? null, payload: options?.payload }
    );
  }

  /**
   * Activate a draft or paused automation (sets status=active).
   */
  async activateAutomation(
    automationId: string,
    options?: { workspaceId?: string }
  ): Promise<HubAutomation> {
    const userId = await this.resolveUserId();
    const wsId = options?.workspaceId ?? this.workspaceId;
    if (!wsId)
      throw new Error("workspaceId is required for activateAutomation");
    return this.request<HubAutomation>(
      "POST",
      `/api/hub/automations/${automationId}/activate`,
      { userId, workspaceId: wsId }
    );
  }

  /**
   * Pause an active automation (sets status=paused).
   */
  async pauseAutomation(
    automationId: string,
    options?: { workspaceId?: string }
  ): Promise<HubAutomation> {
    const userId = await this.resolveUserId();
    const wsId = options?.workspaceId ?? this.workspaceId;
    if (!wsId) throw new Error("workspaceId is required for pauseAutomation");
    return this.request<HubAutomation>(
      "POST",
      `/api/hub/automations/${automationId}/pause`,
      { userId, workspaceId: wsId }
    );
  }

  // ─── Subscriptions / Reactions (Pulse) ────────────────────────────────────

  /**
   * List the user-wide Pulse feed — the timestamp-sorted union of reactive events.
   * Call getSubscriptionFanout() on an individual event for its dense reactions[].
   */
  async listSubscriptions(options?: {
    workspaceId?: string;
    kind?: ReactionKind;
    eventType?: string;
    lens?: ReactionLens;
    limit?: number;
  }): Promise<HubReactionEvent[]> {
    const wsId = options?.workspaceId ?? this.workspaceId;
    const params = new URLSearchParams();
    if (wsId) params.set("workspaceId", wsId);
    if (options?.kind) params.set("kind", options.kind);
    if (options?.eventType) params.set("eventType", options.eventType);
    if (options?.lens) params.set("lens", options.lens);
    if (options?.limit) params.set("limit", String(options.limit));
    const qs = params.toString() ? `?${params}` : "";
    const result = await this.request<
      HubReactionEvent[] | HubListResponse<HubReactionEvent>
    >("GET", `/api/hub/subscriptions${qs}`);
    return unwrapList(result, "items");
  }

  /**
   * Get the reaction fan-out for a single event — full reactions[] populated.
   */
  async getSubscriptionFanout(
    eventId: string,
    options?: { lens?: ReactionLens }
  ): Promise<HubReactionEvent> {
    const params = new URLSearchParams();
    if (options?.lens) params.set("lens", options.lens);
    const qs = params.toString() ? `?${params}` : "";
    return this.request<HubReactionEvent>(
      "GET",
      `/api/hub/subscriptions/${eventId}/fanout${qs}`
    );
  }

  // ─── Notifications ─────────────────────────────────────────────────────────

  /**
   * Persist a notification and emit notification:new to the frontend.
   * Use for IS-originated events (skill.triggered, agent actions, etc.).
   * Backend-originated notifications (vault, proposals) use NotificationService directly.
   */
  async createNotification(
    input: CreateNotificationInput
  ): Promise<{ id: string }> {
    return this.request<{ id: string }>(
      "POST",
      "/api/hub/notifications",
      input
    );
  }

  // ─── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * List delivery log for a webhook subscription.
   * Powers the Reactions Health tab and replay flows.
   */
  async getWebhookDeliveries(
    subscriptionId: string,
    options?: { limit?: number }
  ): Promise<HubWebhookDelivery[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    const qs = params.toString() ? `?${params}` : "";
    const result = await this.request<
      HubWebhookDelivery[] | HubListResponse<HubWebhookDelivery>
    >("GET", `/api/hub/webhooks/${subscriptionId}/deliveries${qs}`);
    return unwrapList(result);
  }
}
