/**
 * Hub Protocol Test Client
 *
 * Typed HTTP client for Hub Protocol endpoints used across E2E tests.
 * Avoids duplicating fetch boilerplate across test files.
 *
 * Usage:
 *   const client = new HubProtocolTestClient(baseUrl, apiKey);
 *   const { status, body } = await client.getHealth();
 */

export interface HubResponse<T = unknown> {
  status: number;
  body: T | null;
}

export class HubProtocolTestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<HubResponse<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as T | null,
    };
  }

  // ── Health ────────────────────────────────────────────────────────────────

  async getHealth() {
    return this.request("GET", "/api/hub/health");
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  async getMe() {
    return this.request("GET", "/api/hub/users/me");
  }

  // ── Workspaces ────────────────────────────────────────────────────────────

  async getWorkspaces() {
    return this.request("GET", "/api/hub/workspaces");
  }

  // ── Entities ──────────────────────────────────────────────────────────────

  async createEntity(data: Record<string, unknown>) {
    return this.request("POST", "/api/hub/entities", data);
  }

  async searchEntities(q: string) {
    return this.request("GET", `/api/hub/entities?q=${encodeURIComponent(q)}`);
  }

  async getEntity(id: string) {
    return this.request("GET", `/api/hub/entities/${id}`);
  }

  async updateEntity(id: string, data: Record<string, unknown>) {
    return this.request("PATCH", `/api/hub/entities/${id}`, data);
  }

  async deleteEntity(id: string) {
    return this.request("DELETE", `/api/hub/entities/${id}`);
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  async createDocument(data: Record<string, unknown>) {
    return this.request("POST", "/api/hub/documents", data);
  }

  async getDocument(id: string) {
    return this.request("GET", `/api/hub/documents/${id}`);
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  async storeMemory(data: { fact: string; context?: string }) {
    return this.request("POST", "/api/hub/memory", data);
  }

  // ── Channels ──────────────────────────────────────────────────────────────

  async getChannels() {
    return this.request("GET", "/api/hub/channels");
  }

  async createChannel(data: Record<string, unknown>) {
    return this.request("POST", "/api/hub/channels", data);
  }

  // ── Proposals ─────────────────────────────────────────────────────────────

  async getProposals() {
    return this.request("GET", "/api/hub/proposals");
  }

  // ── Unauthenticated requests (for auth boundary tests) ────────────────────

  async requestNoAuth(method: string, path: string): Promise<HubResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, { method });
    return {
      status: res.status,
      body: await res.json().catch(() => null),
    };
  }
}
