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

  constructor(config: HubRestClientConfig) {
    this.base = normalizeUrl(config.podUrl);
    this.headers = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    };
    this.workspaceId = config.workspaceId;
    this.timeoutMs = config.timeoutMs ?? 30_000;
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
        `Hub API error: ${res.status} ${res.statusText}`,
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
    return this.request<{ id: string }>("POST", "/api/hub/memory", {
      ...input,
      workspaceId: input.workspaceId ?? this.workspaceId,
    });
  }

  async recallMemory(
    query: string,
    options?: { workspaceId?: string; limit?: number }
  ): Promise<HubMemoryResult[]> {
    const wsId = options?.workspaceId ?? this.workspaceId;
    const params = new URLSearchParams({
      q: query,
      limit: String(options?.limit ?? 10),
    });
    if (wsId) params.set("workspaceId", wsId);

    const result = await this.request<
      HubMemoryResult[] | HubListResponse<HubMemoryResult>
    >("GET", `/api/hub/memory?${params}`);
    return unwrapList(result);
  }

  // ─── Channels ─────────────────────────────────────────────────────────────

  async getChannels(options?: { workspaceId?: string }): Promise<HubChannel[]> {
    const wsId = options?.workspaceId ?? this.workspaceId;
    const params = new URLSearchParams();
    if (wsId) params.set("workspaceId", wsId);

    const result = await this.request<
      HubChannel[] | HubListResponse<HubChannel>
    >("GET", `/api/hub/threads?${params}`);
    return unwrapList(result);
  }

  async sendToChannel(input: SendToChannelInput): Promise<{ id: string }> {
    return this.request<{ id: string }>(
      "POST",
      `/api/hub/channels/${input.channelId}/send`,
      {
        content: input.content,
        workspaceId: input.workspaceId ?? this.workspaceId,
      }
    );
  }
}
