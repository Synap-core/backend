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

  async createEntity(input: CreateEntityInput): Promise<HubEntity> {
    return this.request<HubEntity>("POST", "/api/hub/entities", {
      ...input,
      workspaceId: input.workspaceId ?? this.workspaceId,
    });
  }

  async updateEntity(id: string, input: UpdateEntityInput): Promise<HubEntity> {
    return this.request<HubEntity>("PATCH", `/api/hub/entities/${id}`, input);
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
