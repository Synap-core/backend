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
            },
            body: JSON.stringify({
              query: request.query,
              threadId: request.threadId,
              userId: request.userId,
              agentId: request.agentId || "orchestrator",
              projectId: request.projectId,
              workspaceId: request.workspaceId,
              dataPodUrl:
                request.dataPodUrl ||
                process.env.PUBLIC_URL ||
                "http://localhost:3000",
              dataPodApiKey:
                request.dataPodApiKey || process.env.HUB_PROTOCOL_API_KEY || "",
              mcpServers: request.mcpServers,
            }),
          }
        );

        if (!response.ok) {
          throw new Error(`Intelligence Hub error: ${response.statusText}`);
        }

        const data = (await response.json()) as IntelligenceHubResponse;
        recordSuccess(this.baseUrl);
        return data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
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
