/**
 * Intelligence Hub Client
 *
 * REST client for calling Intelligence Hub from Backend.
 *
 * Production hardening:
 *  - 30s AbortController timeout on all fetch calls
 *  - Exponential-backoff retry (2 retries) on non-streaming calls
 *  - Per-baseUrl in-memory circuit breaker (opens after 3 failures, half-open after 30s)
 */

import type {
  HubResponse,
  HubStreamEvent,
  ExtractedEntity,
  BranchDecision,
  TokenUsage,
  AIStep,
  CreatedProposal,
} from "@synap-core/types";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface IntelligenceHubRequest {
  query: string;
  threadId: string;
  userId: string;
  agentId?: string;
  agentType?: string;
  agentConfig?: Record<string, unknown>;
  projectId?: string;
  /** Active workspace (required for entity create/update – event chain) */
  workspaceId?: string;
  /** ID of the user message that triggered this request — links proposals to the message */
  sourceMessageId?: string;
  /** Per-human AI agent user ID — used for proposal attribution in hub-protocol tool calls */
  agentUserId?: string;
  // Data Pod credentials for Hub Protocol access
  dataPodUrl?: string;
  dataPodApiKey?: string;
  /** MCP server configs for this workspace — enables browser, shell, messaging tools */
  mcpServers?: McpServerConfig[];
  /** Distributed trace ID — propagated from the originating tRPC request */
  requestId?: string;
  /** Deep Analysis mode — routes to the COMPLEX tier (Opus) for max reasoning quality */
  deepAnalysis?: boolean;
  /** Workspace settings JSONB — forwarded to IS for agentModelPreferences tier overrides */
  workspaceSettings?: Record<string, unknown>;
  /** Entity context: channel is scoped to this entity (entity_comments channels) */
  contextObjectType?: string;
  contextObjectId?: string;
  /** Billing channel: browser (included in subscription) | api (billable per-token) | relay */
  billingChannel?: "browser" | "api" | "relay";
}

// Re-export from types package
export type {
  HubResponse,
  ExtractedEntity,
  BranchDecision,
  TokenUsage,
  AIStep,
  CreatedProposal,
};

// Legacy interface for backwards compatibility
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IntelligenceHubResponse extends HubResponse {
  // All fields inherited from HubResponse
}

// ── New naming aliases ────────────────────────────────────────────────────────

/** @alias IntelligenceHubRequest */
export type AgentHubRequest = IntelligenceHubRequest;

/** @alias IntelligenceHubResponse */
export type AgentHubResponse = IntelligenceHubResponse;

// ── Circuit breaker ─────────────────────────────────────────────────────────

interface CircuitState {
  failures: number;
  openedAt: number | null;
}

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_DURATION_MS = 30_000;
const circuitBreaker = new Map<string, CircuitState>();

function isCircuitOpen(baseUrl: string): boolean {
  const state = circuitBreaker.get(baseUrl);
  if (!state || state.openedAt === null) return false;
  if (Date.now() - state.openedAt > CIRCUIT_OPEN_DURATION_MS) {
    // Transition to half-open: allow one request through
    state.openedAt = null;
    circuitBreaker.set(baseUrl, state);
    return false;
  }
  return true;
}

function recordSuccess(baseUrl: string): void {
  circuitBreaker.set(baseUrl, { failures: 0, openedAt: null });
}

function recordFailure(baseUrl: string): void {
  const state = circuitBreaker.get(baseUrl) ?? { failures: 0, openedAt: null };
  state.failures++;
  if (state.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    state.openedAt = Date.now();
    console.error(
      `[IntelligenceHubClient] Circuit opened for ${baseUrl} after ${state.failures} failures`
    );
  }
  circuitBreaker.set(baseUrl, state);
}

// ── Fetch helper ─────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [500, 1_000];

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Intelligence Hub REST Client
 */
export class IntelligenceHubClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl =
      baseUrl || process.env.INTELLIGENCE_HUB_URL || "http://localhost:3002";
    this.apiKey = apiKey || process.env.INTELLIGENCE_HUB_API_KEY || "";
  }

  /**
   * Send message to orchestrator agent (non-streaming, with retry + circuit breaker)
   */
  async sendMessage(
    request: IntelligenceHubRequest
  ): Promise<IntelligenceHubResponse> {
    if (isCircuitOpen(this.baseUrl)) {
      throw new Error(
        `Intelligence service ${this.baseUrl} is temporarily unavailable (circuit open)`
      );
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
      }

      try {
        const response = await fetchWithTimeout(
          `${this.baseUrl}/api/expertise/request`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": this.apiKey,
              ...(request.requestId
                ? { "X-Request-Id": request.requestId }
                : {}),
              ...(request.billingChannel
                ? { "X-Synap-Channel": request.billingChannel }
                : {}),
            },
            body: JSON.stringify({
              query: request.query,
              threadId: request.threadId,
              userId: request.userId,
              agentId: request.agentId || "orchestrator",
              agentType: request.agentType,
              agentConfig: request.agentConfig,
              projectId: request.projectId,
              workspaceId: request.workspaceId,
              sourceMessageId: request.sourceMessageId,
              agentUserId: request.agentUserId,
              deepAnalysis: request.deepAnalysis,
              dataPodUrl:
                request.dataPodUrl ||
                process.env.PUBLIC_URL ||
                "http://localhost:3000",
              dataPodApiKey:
                request.dataPodApiKey || process.env.HUB_PROTOCOL_API_KEY || "",
              mcpServers: request.mcpServers,
              workspaceSettings: request.workspaceSettings,
            }),
          }
        );

        if (!response.ok) {
          // 401 = credential error — don't retry, surface immediately for auto-repair
          if (response.status === 401) {
            recordFailure(this.baseUrl);
            throw new Error(
              `Intelligence Hub credential error: 401 Unauthorized`
            );
          }
          throw new Error(`Intelligence Hub error: ${response.statusText}`);
        }

        const data = (await response.json()) as IntelligenceHubResponse;
        recordSuccess(this.baseUrl);
        return data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Don't retry 401s — break immediately so auto-repair can kick in
        if (lastError.message.includes("401 Unauthorized")) {
          break;
        }
        if (attempt === MAX_RETRIES) {
          recordFailure(this.baseUrl);
        }
      }
    }

    throw lastError!;
  }

  /**
   * Generate embedding for text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetchWithTimeout(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      throw new Error(
        `Intelligence Hub embedding error: ${response.statusText}`
      );
    }

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }

  /**
   * Send message with streaming support.
   * Streaming is not retried (partial content would be duplicated).
   * Circuit breaker still applies.
   */
  async *sendMessageStream(
    request: IntelligenceHubRequest
  ): AsyncGenerator<HubStreamEvent> {
    if (isCircuitOpen(this.baseUrl)) {
      throw new Error(
        `Intelligence service ${this.baseUrl} is temporarily unavailable (circuit open)`
      );
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${this.baseUrl}/api/chat/stream`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "X-API-Key": this.apiKey,
            ...(request.requestId ? { "X-Request-Id": request.requestId } : {}),
            ...(request.billingChannel
              ? { "X-Synap-Channel": request.billingChannel }
              : {}),
          },
          body: JSON.stringify({
            query: request.query,
            threadId: request.threadId,
            userId: request.userId,
            agentId: request.agentId || "orchestrator",
            agentType: request.agentType,
            agentConfig: request.agentConfig,
            projectId: request.projectId,
            stream: true,
            workspaceId: request.workspaceId,
            sourceMessageId: request.sourceMessageId,
            agentUserId: request.agentUserId,
            dataPodUrl:
              request.dataPodUrl ||
              process.env.PUBLIC_URL ||
              "http://localhost:3000",
            dataPodApiKey:
              request.dataPodApiKey || process.env.HUB_PROTOCOL_API_KEY || "",
            mcpServers: request.mcpServers,
            deepAnalysis: request.deepAnalysis,
            workspaceSettings: request.workspaceSettings,
          }),
        },
        STREAM_TIMEOUT_MS
      );
    } catch (error) {
      recordFailure(this.baseUrl);
      throw error;
    }

    if (!response.ok) {
      recordFailure(this.baseUrl);
      if (response.status === 401) {
        throw new Error(`Intelligence Hub credential error: 401 Unauthorized`);
      }
      throw new Error(`Intelligence Hub error: ${response.statusText}`);
    }

    // Parse SSE stream
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      recordFailure(this.baseUrl);
      throw new Error("No response body");
    }

    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          yield { type: "complete" };
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === "content" && data.content) {
                yield { type: "chunk", content: data.content };
              } else if (data.type === "step" && data.step) {
                yield { type: "step", step: data.step };
              } else if (data.type === "entities" && data.entities) {
                yield { type: "entities", entities: data.entities };
              } else if (data.type === "branch_decision" && data.decision) {
                yield { type: "branch_decision", decision: data.decision };
              } else if (data.type === "error") {
                yield { type: "error", error: data.error };
              } else if (data.type === "complete") {
                yield { type: "complete", data: data.data };
              }
            } catch (parseError) {
              console.error("Failed to parse SSE data:", line, parseError);
            }
          }
        }
      }
      recordSuccess(this.baseUrl);
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Extract structured entity data from a web page.
   * Used by the browser Save button's AI extraction strategy.
   *
   * Falls back gracefully — never throws (returns null on failure).
   *
   * @deprecated Use structure() instead
   */
  async extractEntity(input: {
    url: string;
    html: string;
    title?: string;
  }): Promise<{
    profileSlug: string;
    title: string;
    description?: string;
    properties?: Record<string, unknown>;
    confidence: number;
  } | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6_000); // 6s max
      try {
        const response = await fetch(`${this.baseUrl}/api/extract`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": this.apiKey,
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        if (!response.ok) return null;
        const data = (await response.json()) as {
          success: boolean;
          data: {
            profileSlug: string;
            title: string;
            description?: string;
            properties?: Record<string, unknown>;
            confidence: number;
          };
        };
        return data.success ? data.data : null;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }

  /**
   * Classify raw text/URL into a structured entity type.
   * Used by the intelligence.classifyCapture tRPC procedure.
   * Falls back gracefully — returns null on failure.
   *
   * @deprecated Use structure() instead
   */
  async classifyCapture(input: { text: string; url?: string }): Promise<{
    profileSlug: string;
    title: string;
    properties: Record<string, unknown>;
    confidence: number;
    tokensUsed: number;
  } | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6_000);
      try {
        const response = await fetch(`${this.baseUrl}/api/classify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": this.apiKey,
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        if (!response.ok) return null;
        return (await response.json()) as {
          profileSlug: string;
          title: string;
          properties: Record<string, unknown>;
          confidence: number;
          tokensUsed: number;
        };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }

  /**
   * Multi-entity structure extraction from raw text.
   * Returns entity proposals with relations and optional follow-up question.
   * Used by the capture.structure tRPC procedure.
   * Falls back gracefully — returns null on failure.
   */
  async structure(input: {
    text: string;
    url?: string;
    html?: string;
    context?: string;
    hints?: {
      preferredProfiles?: string[];
      existingEntityNames?: string[];
      availableProfiles?: Array<{
        slug: string;
        displayName: string;
        description?: string;
        propertyHints?: string;
      }>;
      previousEntities?: Array<{
        tempId: string;
        profileSlug: string;
        title: string;
        description?: string;
        properties?: Record<string, unknown>;
      }>;
    };
  }): Promise<{
    entities: Array<{
      tempId: string;
      profileSlug: string;
      title: string;
      description?: string;
      properties?: Record<string, unknown>;
      confidence: number;
    }>;
    relations: Array<{
      sourceTempId: string;
      targetTempId: string;
      relationType: string;
    }>;
    followUp: string | null;
  } | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      try {
        const response = await fetch(`${this.baseUrl}/api/structure`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": this.apiKey,
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        if (!response.ok) return null;
        return (await response.json()) as Awaited<
          ReturnType<typeof this.structure>
        > & {};
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }

  /**
   * Multi-entity structure extraction with SSE streaming.
   * Yields partial results as the LLM generates them, enabling progressive UI rendering.
   * Falls back gracefully — yields nothing on connection failure (no throw).
   */
  async *structureStream(input: {
    text: string;
    url?: string;
    html?: string;
    context?: string;
    hints?: {
      preferredProfiles?: string[];
      existingEntityNames?: string[];
      availableProfiles?: Array<{
        slug: string;
        displayName: string;
        description?: string;
        propertyHints?: string;
      }>;
    };
  }): AsyncGenerator<
    | { type: "partial"; data: Record<string, unknown> }
    | { type: "complete" }
    | { type: "error"; message: string }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${this.baseUrl}/api/structure-stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                yield JSON.parse(line.slice(6));
              } catch {
                /* skip malformed */
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      // Graceful failure — caller gets no events
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${this.baseUrl}/health`,
        {},
        5_000
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Singleton instance
export const intelligenceHubClient = new IntelligenceHubClient();

/** @alias IntelligenceHubClient */
export const AgentHubClient = IntelligenceHubClient;
