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

import { iterateISChatStream } from "./is-chat-stream.js";

/**
 * Structured follow-up the IS `structure` endpoint may emit instead of a plain
 * string question. Mirrors `@synap/hub-rest-client` and the frontend
 * capture-pipeline contract EXACTLY — defined locally to keep this internal
 * service client free of a dependency on the published Hub REST SDK.
 */
export interface FollowUpChip {
  label: string;
  value: string;
  action:
    | "link_entity"
    | "set_property"
    | "add_relation"
    | "confirm"
    | "dismiss";
  icon?: string;
  entityId?: string;
  propertyKey?: string;
}

export interface StructuredFollowUp {
  question: string;
  suggestions: FollowUpChip[];
}

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

export interface DynamicFormSpec {
  title?: string;
  note?: string;
  fields: DynamicFormField[];
}

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

/**
 * Ephemeral caller-supplied context for one agent turn.
 *
 * The Intelligence Service validates and bounds this before it reaches a prompt.
 * It remains generic so callers can describe a current surface without coupling
 * this transport package to a particular UI.
 */
export type TurnContext = Record<string, unknown>;

export interface IntelligenceHubRequest {
  query: string;
  threadId: string;
  userId: string;
  agentId?: string;
  agentType?: string;
  agentConfig?: Record<string, unknown>;
  projectId?: string;
  /**
   * Active workspace lens for the turn.
   *
   * CONTRACT: a `null`/absent workspaceId means a POD-WIDE turn — the IS scopes
   * its Hub reads to the caller's user floor (its accessible workspaces + globals)
   * and the agent places each write in the workspace that fits per-signal. A
   * non-null workspaceId pins the turn to that one workspace (reads + write
   * placement), the prior behavior.
   */
  workspaceId?: string | null;
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
  /** Entity context: channel is scoped to this entity (thread + contextObjectType='entity') */
  contextObjectType?: string;
  contextObjectId?: string;
  /** Ephemeral, untrusted context about the caller's current surface for this turn only. */
  turnContext?: TurnContext;
  /**
   * Subject entity this conversation is about (e.g. the bound client). When set,
   * the IS loads it and injects its name + key props into the prompt — sent as
   * contextObjectType="entity" + contextObjectId on the wire so it reuses the
   * existing "## Context Entity" injection seam. Optional, backward-compatible.
   */
  contextEntityId?: string;
  /**
   * Name of a skill to force-load into this turn (e.g. Discord `/skill <name>`).
   * Forwarded to the IS, which injects the skill's content into the system prompt so
   * the agent runs WITH the skill as know-how. Optional, backward-compatible.
   */
  forcedSkillName?: string;
  /** Billing channel: browser (included in subscription) | api (billable per-token) | relay */
  billingChannel?: "browser" | "api" | "relay";
  /** Channel kind: pm = private message / personal, group = workspace-shared channel */
  channelKind?: "pm" | "group";
  /**
   * Active focus session ID — when set, IS tags all hub calls with X-Session-Id
   * so proposals from this run link to the user-visible goal-bound session.
   */
  focusSessionId?: string;
  /** Abort the in-flight Pod → Intelligence Service request (never serialized). */
  signal?: AbortSignal;
}

// ── Bulk CSV-mapping analysis types ─────────────────────────────────────────
//
// Mirror of the IS `PlanSchema` in apps/intelligence-hub/src/routes/
// structure-csv-mapping.ts. Kept structurally identical so the client can
// pass the response through to callers unchanged.

export interface ColumnMappingProposal {
  header: string;
  slug: string;
  label: string;
  valueType: "string" | "number" | "date" | "boolean";
  scope: "primary" | "companion" | "context" | "skip";
  scopeTarget?: string;
  isNew: boolean;
  confidence: number;
  reasoning: string;
}

export interface ImportAnalysisPlan {
  rowEntityType: string;
  rowEntityReasoning: string;
  titleColumn: string | null;
  titleFallback?: string;
  columnMappings: ColumnMappingProposal[];
  warnings: string[];
  overallConfidence: number;
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

// ── Cheap routing types ──────────────────────────────────────────────────────

/**
 * Per-message routing request sent to the IS `/api/route` endpoint.
 *
 * The IS router must remain cheap (small model or heuristic) — it runs on
 * every message in a multiplayer room. Bias hard toward returning null
 * (restraint is the product thesis).
 */
export interface RouteTeammateRequest {
  /** Channel id — for logging / tracing only; IS must not query it. */
  channelId: string;
  /** The user message being evaluated. */
  message: string;
  /** Recent messages (oldest first, last N entries). Keep N small (≤ 6). */
  recentContext: Array<{ role: string; content: string }>;
  /** AI teammates that are members of this channel. */
  members: Array<{
    /** Agent-user id — returned verbatim in the response if selected. */
    id: string;
    /** Display name (for the router's reasoning). */
    name: string;
    /** Agent type / expertise hint (e.g. "code", "persona:cto"). */
    expertise?: string;
  }>;
}

/**
 * Response from the IS `/api/route` endpoint.
 *
 * `teammateId` is the agent-user id of the member who should answer, or
 * `null` when the router concludes silence is correct.
 *
 * The backend validates that the returned id is a real channel AI_AGENT
 * member before using it — the router may not inject arbitrary user ids.
 */
export interface RouteTeammateResponse {
  /** Agent-user id of the selected teammate, or null (silence). */
  teammateId: string | null;
  /** Confidence in [0, 1]. Informational — not used for routing gate. */
  confidence: number;
  /** Optional short reason (for logs/tracing; never surfaced to the user). */
  reason?: string;
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

// ── Auth-failure signal ──────────────────────────────────────────────────────
//
// Distinguishes an UPSTREAM credential failure (IS returned 401/403 → the pod's
// API key is rejected) from every other failure mode (5xx, validation, timeout,
// network), which all still surface as a graceful `null` return. Callers that
// must drive the re-provisioning loop (markServiceCredentialError) should catch
// THIS error type specifically and treat a plain `null` as a non-auth degrade.

export class IntelligenceAuthError extends Error {
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message ?? `Intelligence Service auth failed: HTTP ${status}`);
    this.name = "IntelligenceAuthError";
    this.status = status;
  }
}

/** True for HTTP statuses that mean the pod's IS credentials are rejected. */
function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

// ── Fetch helper ─────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;
/**
 * Chat-specific abort timeout (streaming + its non-streaming fallback).
 *
 * Chat runs a conversational LLM that can take far longer than the generic 30s
 * (e.g. self-hosted Qwen3 with a reasoning trace measured at 35-48s). Streaming
 * yields progressively, so a 30s TOTAL abort wrongly kills a stream that is
 * actively producing tokens. We give chat a much longer ceiling (default 120s),
 * overridable via CHAT_FETCH_TIMEOUT_MS. The short timeouts on
 * embeddings/classify/route/extract/structure are intentionally left untouched
 * — those must stay fast.
 */
const CHAT_FETCH_TIMEOUT_MS = Number(
  process.env.CHAT_FETCH_TIMEOUT_MS ?? 120_000
);
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [500, 1_000];

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
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
              dataPodApiKey: request.dataPodApiKey ?? "",
              mcpServers: request.mcpServers,
              workspaceSettings: request.workspaceSettings,
              channelKind: request.channelKind,
              focusSessionId: request.focusSessionId,
              // A bound subject entity retains precedence over the generic
              // context-object fields, while callers without one now forward
              // their existing context-object seam unchanged.
              contextObjectType: request.contextEntityId
                ? "entity"
                : request.contextObjectType,
              contextObjectId:
                request.contextEntityId ?? request.contextObjectId,
              turnContext: request.turnContext,
              // Forced skill (Discord `/skill <name>`): the IS injects this
              // skill's content into the system prompt for this turn.
              ...(request.forcedSkillName
                ? { forcedSkillName: request.forcedSkillName }
                : {}),
            }),
          },
          // Chat (non-streaming fallback) can run a slow conversational LLM —
          // use the longer chat timeout, not the generic 30s.
          CHAT_FETCH_TIMEOUT_MS
        );

        if (!response.ok) {
          const responseBody = await response
            .text()
            .catch(() => "<unreadable>");
          // 401 = credential error — don't retry, surface immediately for auto-repair
          if (response.status === 401) {
            recordFailure(this.baseUrl);
            console.error(
              `[IntelligenceHubClient] IS authentication failed at ${this.baseUrl}/api/expertise/request — check API key in intelligence_services table (status=${response.status}, body=${responseBody.slice(0, 500)}, attempt=${attempt + 1}/${MAX_RETRIES + 1})`
            );
            throw new Error(
              `Intelligence Hub credential error: 401 Unauthorized at ${this.baseUrl}`
            );
          }
          console.error(
            `[IntelligenceHubClient] Request failed: url=${this.baseUrl}/api/expertise/request, status=${response.status}, statusText=${response.statusText}, body=${responseBody.slice(0, 500)}, attempt=${attempt + 1}/${MAX_RETRIES + 1}`
          );
          throw new Error(
            `Intelligence Hub error: ${response.status} ${response.statusText} at ${this.baseUrl}`
          );
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
        // Log network-level errors (connection refused, DNS failure, timeout)
        if (!lastError.message.includes("Intelligence Hub error:")) {
          console.error(
            `[IntelligenceHubClient] IS unreachable at ${this.baseUrl} — check INTELLIGENCE_HUB_URL or intelligence_services.webhookUrl (error=${lastError.message}, attempt=${attempt + 1}/${MAX_RETRIES + 1})`
          );
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
            dataPodApiKey: request.dataPodApiKey ?? "",
            mcpServers: request.mcpServers,
            deepAnalysis: request.deepAnalysis,
            workspaceSettings: request.workspaceSettings,
            channelKind: request.channelKind,
            focusSessionId: request.focusSessionId,
            contextObjectType: request.contextEntityId
              ? "entity"
              : request.contextObjectType,
            contextObjectId: request.contextEntityId ?? request.contextObjectId,
            turnContext: request.turnContext,
          }),
        },
        // Streaming yields progressively; a 30s TOTAL abort wrongly kills a
        // stream that is still producing tokens. Use the longer chat timeout.
        CHAT_FETCH_TIMEOUT_MS,
        request.signal
      );
    } catch (error) {
      recordFailure(this.baseUrl);
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[IntelligenceHubClient] IS unreachable at ${this.baseUrl} for streaming — check INTELLIGENCE_HUB_URL or intelligence_services.webhookUrl (error=${errMsg})`
      );
      throw error;
    }

    if (!response.ok) {
      recordFailure(this.baseUrl);
      const responseBody = await response.text().catch(() => "<unreadable>");
      if (response.status === 401) {
        console.error(
          `[IntelligenceHubClient] IS authentication failed at ${this.baseUrl}/api/chat/stream — check API key in intelligence_services table (status=401, body=${responseBody.slice(0, 500)})`
        );
        throw new Error(
          `Intelligence Hub credential error: 401 Unauthorized at ${this.baseUrl}`
        );
      }
      console.error(
        `[IntelligenceHubClient] Stream request failed: url=${this.baseUrl}/api/chat/stream, status=${response.status}, body=${responseBody.slice(0, 500)}`
      );
      throw new Error(
        `Intelligence Hub error: ${response.status} ${response.statusText} at ${this.baseUrl}`
      );
    }

    // Parse SSE stream — one shared reader (see is-chat-stream.ts). Map each
    // raw IS frame to the typed HubStreamEvent vocabulary (content → chunk).
    if (!response.body) {
      recordFailure(this.baseUrl);
      throw new Error("No response body");
    }

    let sawTerminalFrame = false;
    for await (const frame of iterateISChatStream(response)) {
      if (frame.type === "content" && frame.content) {
        yield { type: "chunk", content: frame.content };
      } else if (frame.type === "step" && frame.step) {
        yield { type: "step", step: frame.step as HubStreamEvent["step"] };
      } else if (frame.type === "entities" && frame.entities) {
        yield {
          type: "entities",
          entities: frame.entities as HubStreamEvent["entities"],
        };
      } else if (frame.type === "branch_decision" && frame.decision) {
        yield {
          type: "branch_decision",
          decision: frame.decision as HubStreamEvent["decision"],
        };
      } else if (frame.type === "route_to_channel" && frame.routing) {
        yield {
          type: "route_to_channel",
          routing: frame.routing as HubStreamEvent["routing"],
        };
      } else if (frame.type === "proposal" && frame.proposal) {
        yield {
          type: "proposal",
          proposal: frame.proposal as HubStreamEvent["proposal"],
        };
      } else if (frame.type === "error") {
        sawTerminalFrame = true;
        yield { type: "error", error: frame.error };
      } else if (frame.type === "complete") {
        sawTerminalFrame = true;
        yield { type: "complete", data: frame.data };
      }
    }
    // Some older/custom Intelligence Services close the stream without a
    // terminal frame. Preserve that compatibility, but never manufacture a
    // second completion after an explicit complete (or error) frame.
    if (!sawTerminalFrame) {
      yield { type: "complete" };
    }
    recordSuccess(this.baseUrl);
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
    text?: string;
    /**
     * Binary/text source normalized to text via the hub's ContentExtractor
     * BEFORE structuring. Either `text` or `file` must be present.
     */
    file?: {
      content: string;
      mimeType: string;
      filename?: string;
      encoding?: "base64" | "utf8";
    };
    url?: string;
    html?: string;
    context?: string;
    /**
     * Optional free-text bias for the structuring pass (e.g. "new-lead intake:
     * prefer contact/company/lead; link to existing entities, don't duplicate").
     * Rides in the POST body to /api/structure; the IS prompt may use it.
     */
    instructions?: string;
    hints?: {
      preferredProfiles?: string[];
      existingEntityNames?: string[];
      availableProfiles?: Array<{
        slug: string;
        displayName: string;
        description?: string;
        propertyHints?: string;
      }>;
      availableWorkspaces?: Array<{
        id: string;
        name: string;
        description?: string;
      }>;
      availableProjects?: Array<{
        id: string;
        name: string;
        description?: string;
      }>;
      previousEntities?: Array<{
        tempId: string;
        profileSlug: string;
        title: string;
        description?: string;
        properties?: Record<string, unknown>;
      }>;
      /**
       * Routing self-improvement memory: recent user corrections (negatives —
       * the AI's pick was moved) + confirmed routes (positives). Rendered as
       * few-shot examples in the workspace-routing prompt so the model learns
       * from the user's own history. Absent/empty on cold start.
       */
      routingMemory?: {
        corrections: Array<{
          textSnippet: string;
          correctWorkspaceName: string;
          wrongWorkspaceName?: string | null;
        }>;
        confirmations: Array<{
          textSnippet: string;
          correctWorkspaceName: string;
        }>;
      } | null;
    };
    /** Abort timeout in ms (default 25000). Imports raise this for long notes. */
    timeoutMs?: number;
  }): Promise<{
    entities: Array<{
      tempId: string;
      profileSlug: string;
      title: string;
      description?: string;
      properties?: Record<string, unknown>;
      confidence: number;
      /**
       * Kind + Facets: role-profiles the IS proposes attaching to this entity
       * (a person who is a client + investor). `contextTempId` references
       * another extracted entity's `tempId` (the disambiguating context, e.g.
       * the deal a "client" role hangs off). Threaded through capture.structure
       * → capture.execute, which attaches them AFTER the entity materializes.
       */
      facets?: Array<{
        profileSlug: string;
        status?: string;
        properties?: Record<string, unknown>;
        contextTempId?: string;
      }>;
    }>;
    relations: Array<{
      sourceTempId: string;
      targetTempId: string;
      relationType: string;
    }>;
    followUp: string | StructuredFollowUp | null;
    targetWorkspaceId?: string | null;
    /**
     * The workspace NAME the AI chose, copied verbatim from the candidate list.
     * The backend reconciles this NAME → the real id (the model copies UUIDs
     * unreliably), so this is the authoritative pick signal, not the id above.
     */
    targetWorkspaceName?: string | null;
    /** AI's reason for routing to `targetWorkspaceId` (provenance). */
    targetWorkspaceReason?: string | null;
    /** AI's confidence (0–1) in the `targetWorkspaceId` routing. */
    targetWorkspaceConfidence?: number | null;
    /** Suggested cross-cutting project lens (mirror of `targetWorkspaceId`). */
    targetProjectId?: string | null;
    /** AI's reason for routing to `targetProjectId` (provenance). */
    targetProjectReason?: string | null;
    /** AI's confidence (0–1) in the `targetProjectId` routing. */
    targetProjectConfidence?: number | null;
    /**
     * Optional structured-form spec the IS may emit to drive a guided capture
     * form (mirror of the `targetProject*` routing fields — additive, null-safe).
     */
    formSpec?: DynamicFormSpec | null;
    /**
     * Soft meta-structure suggestions (display-only). Never materialize.
     * Additive / optional — absent when the model has nothing to suggest.
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
    /** Honesty markers when an input could not be fully extracted/structured. */
    degraded?: boolean;
    degradedReason?: string;
    /** Summary of the extraction pass when a `file` input was normalized to text. */
    extraction?: {
      kind: string;
      extractor: string;
      metadata?: Record<string, unknown>;
      warnings?: string[];
    };
  } | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        input.timeoutMs ?? 25_000
      );
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
        if (!response.ok) {
          console.warn(
            `[IntelligenceHubClient] structure failed: ${response.status} ${response.statusText} (baseUrl=${this.baseUrl}, hasApiKey=${!!this.apiKey})`
          );
          // Auth failures are the ONLY failure that should drive re-provisioning;
          // surface them as a typed throw so callers can distinguish them from
          // the graceful `null` we return for every other non-ok status.
          if (isAuthStatus(response.status)) {
            throw new IntelligenceAuthError(
              response.status,
              `Intelligence Service rejected credentials: ${response.status} ${response.statusText}`
            );
          }
          return null;
        }
        return (await response.json()) as Awaited<
          ReturnType<typeof this.structure>
        > & {};
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Preserve the auth signal — it must not be flattened into a null.
      if (err instanceof IntelligenceAuthError) throw err;
      console.warn(
        `[IntelligenceHubClient] structure error: ${err instanceof Error ? err.message : String(err)} (baseUrl=${this.baseUrl})`
      );
      return null;
    }
  }

  /**
   * Workspace tie-break (Wave 2, decision D3). Consulted ONLY when the backend
   * resolver reduced placement to >1 pre-approved candidates it couldn't
   * separate deterministically. The model picks one of `candidates` or abstains
   * — it may NOT invent a workspace. `null` workspaceId = abstain (→ the caller
   * keeps the ambient lens / asks). Graceful null on any transport failure, so a
   * tie-break outage degrades to "no move", never fails the capture.
   */
  async workspaceTiebreak(input: {
    content: string;
    candidates: Array<{
      id: string;
      name: string;
      description?: string;
      hint?: string;
    }>;
    facetSlugs?: string[];
    timeoutMs?: number;
  }): Promise<{
    workspaceId: string | null;
    confidence: number;
    reason: string;
  } | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        input.timeoutMs ?? 15_000
      );
      try {
        const response = await fetch(`${this.baseUrl}/api/workspace-tiebreak`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": this.apiKey,
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        if (!response.ok) {
          if (isAuthStatus(response.status)) {
            throw new IntelligenceAuthError(
              response.status,
              `Intelligence Service rejected credentials: ${response.status} ${response.statusText}`
            );
          }
          console.warn(
            `[IntelligenceHubClient] workspaceTiebreak failed: ${response.status} ${response.statusText} (baseUrl=${this.baseUrl})`
          );
          return null;
        }
        return (await response.json()) as {
          workspaceId: string | null;
          confidence: number;
          reason: string;
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (err instanceof IntelligenceAuthError) throw err;
      console.warn(
        `[IntelligenceHubClient] workspaceTiebreak error: ${err instanceof Error ? err.message : String(err)} (baseUrl=${this.baseUrl})`
      );
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
   * Bulk multi-entity extraction with SSE streaming.
   *
   * Accepts up to 200 items; the IS runs `runStructure` for each with
   * bounded concurrency (default 4, max 8) and streams per-item results.
   *
   * Yields events as they arrive. If the caller disconnects (via
   * `signal`), in-flight LLM calls are aborted on the server.
   *
   * Used by hydration-style onboarding (LinkedIn, markdown dumps, Apple
   * Notes exports) so we don't ping /api/structure 340 times client-side.
   */
  async *structureBulk(
    input: {
      items: Array<{
        clientId: string;
        text?: string;
        html?: string;
        url?: string;
        context?: string;
        sourceHint?: string;
      }>;
      hints?: {
        availableProfiles?: Array<{
          slug: string;
          displayName: string;
          description?: string;
          propertyHints?: string;
        }>;
      };
      concurrency?: number;
    },
    signal?: AbortSignal
  ): AsyncIterable<
    | { type: "item-start"; clientId: string }
    | {
        type: "item-complete";
        clientId: string;
        result: {
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
          followUp: string | StructuredFollowUp | null;
          formSpec?: DynamicFormSpec | null;
        };
      }
    | { type: "item-error"; clientId: string; error: string }
    | {
        type: "batch-complete";
        totalCompleted: number;
        totalErrored: number;
      }
    | { type: "error"; message: string }
  > {
    const controller = new AbortController();
    const abortListener = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", abortListener, { once: true });
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/structure-bulk`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "<unreadable>");
        yield {
          type: "error",
          message: `structureBulk HTTP ${response.status}: ${text.slice(0, 200)}`,
        };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              yield JSON.parse(line.slice(6));
            } catch {
              // skip malformed
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        yield {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    } finally {
      if (signal) signal.removeEventListener("abort", abortListener);
    }
  }

  /**
   * Bulk CSV-mapping analysis.
   *
   * Given the headers + a few sample rows of a tabular bulk input plus the
   * workspace's available profiles, returns a plan describing how each column
   * should be routed to entity types, properties and relation metadata.
   *
   * Read-only — the caller shows the plan to the user, no mutations happen.
   * Falls back gracefully — returns null on failure.
   */
  async analyzeBulkMapping(input: {
    headers: string[];
    sampleRows: string[][];
    intent: string;
    availableProfiles: Array<{
      slug: string;
      displayName: string;
      description?: string;
      propertyHints?: string;
    }>;
    availableRelations?: string[];
    contextHint?: string;
  }): Promise<ImportAnalysisPlan | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      try {
        const response = await fetch(
          `${this.baseUrl}/api/analyze-bulk-mapping`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": this.apiKey,
            },
            body: JSON.stringify(input),
            signal: controller.signal,
          }
        );
        if (!response.ok) {
          const body = await response.text().catch(() => "<unreadable>");
          console.warn(
            `[IntelligenceHubClient] analyzeBulkMapping failed: ${response.status} ${response.statusText} (baseUrl=${this.baseUrl}, hasApiKey=${!!this.apiKey}, body=${body.slice(0, 500)})`
          );
          return null;
        }
        return (await response.json()) as ImportAnalysisPlan;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn(
        `[IntelligenceHubClient] analyzeBulkMapping error: ${err instanceof Error ? err.message : String(err)} (baseUrl=${this.baseUrl})`
      );
      return null;
    }
  }

  /**
   * Cheap per-message routing decision for multiplayer rooms.
   *
   * Given the channel's AI teammate members, the current message, and recent
   * context, asks the IS router: "which teammate (if any) should answer?"
   *
   * RESTRAINT IS THE DEFAULT: the IS router is biased toward returning null.
   * Silence is the correct, common outcome — the IS should only return a
   * teammateId when it is confident the message is squarely in that teammate's
   * domain.
   *
   * Kept cheap: small/fast model or a heuristic. Timeout: 5 s. Never throws —
   * returns null on failure so the caller defaults to silence.
   */
  async routeTeammate(
    request: RouteTeammateRequest
  ): Promise<RouteTeammateResponse | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch(`${this.baseUrl}/api/route`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": this.apiKey,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        if (!response.ok) {
          console.warn(
            `[IntelligenceHubClient] routeTeammate: non-OK response ${response.status} from ${this.baseUrl}/api/route — defaulting to silence`
          );
          return null;
        }
        return (await response.json()) as RouteTeammateResponse;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn(
        `[IntelligenceHubClient] routeTeammate error (defaulting to silence): ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
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
