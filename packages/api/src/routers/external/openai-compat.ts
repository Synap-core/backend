/**
 * OpenAI-Compatible Chat Completions API — /v1/chat/completions
 *
 * Lets OpenClaw (and any OpenAI-compatible client) use Synap's Intelligence
 * Service as their AI provider. Translates between the OpenAI wire format
 * and the Synap IS SSE protocol.
 *
 * Auth: Bearer API key with scope "chat.stream" (same as external chat).
 *
 * Supported model aliases:
 *   synap/auto     — four-tier auto-routing (default)
 *   synap/free     — DeepSeek V3
 *   synap/balanced — Kimi K2.5
 *   synap/advanced — Claude Sonnet
 *   synap/complex  — Claude Opus
 *   <any other>    — passed through as-is to IS
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { db, eq, and } from "@synap/database";
import { workspaceMembers } from "@synap/database/schema";
import { resolveIntelligenceService } from "../../utils/intelligence-routing.js";
import { iterateISChatStream } from "@synap/intelligence-client";
import { getPodCallback } from "../../utils/pod-callback.js";
import {
  ensureAgentThread,
  getAgentIdBySlug,
} from "../../utils/personal-channel.js";
import { createLogger } from "@synap-core/core";
import { externalApiKeyAuth, type ExternalApiVariables } from "./middleware.js";
import {
  beginExternalDurableTurn,
  resolveExternalRequestId,
  safeFinishExternalTurn,
  SYNAP_TURN_ID_HEADER,
  type ExternalTurnSource,
} from "../../services/chat-turns/external-durable-turn.js";
import {
  decideChatTurnClaimAction,
  hasUsefulAssistantForTurn,
  reopenChatTurn,
  type DurableChatTurn,
} from "../../services/chat-turns/chat-turn-store.js";

const logger = createLogger({ module: "openai-compat" });

// ── Custom provider env var parsing ──────────────────────────────────────────

interface CustomProviderEnv {
  idx: number;
  name: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
}

/**
 * Read CUSTOM_PROVIDER_N_* env vars. Returns a sorted list of provider configs.
 * Env vars are written by @eve/dna wire-ai.ts: CUSTOM_PROVIDER_1_BASE_URL,
 * CUSTOM_PROVIDER_1_API_KEY, CUSTOM_PROVIDER_1_NAME.
 */
function parseCustomProviderEnv(): CustomProviderEnv[] {
  const result: CustomProviderEnv[] = [];
  for (let i = 1; i <= 100; i++) {
    const baseUrl = process.env[`CUSTOM_PROVIDER_${i}_BASE_URL`];
    if (!baseUrl || baseUrl.trim() === "") break;
    result.push({
      idx: i,
      name: process.env[`CUSTOM_PROVIDER_${i}_NAME`] || `Provider ${i}`,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey: process.env[`CUSTOM_PROVIDER_${i}_API_KEY`],
      defaultModel: process.env[`CUSTOM_PROVIDER_${i}_DEFAULT_MODEL`],
    });
  }
  return result;
}

/** Check if a model name belongs to a custom provider */
function resolveCustomProviderForModel(
  model: string,
  providers: CustomProviderEnv[]
): CustomProviderEnv | null {
  for (const cp of providers) {
    if (!cp.defaultModel) continue;
    // Match by default model name exactly
    if (model === cp.defaultModel) return cp;
    // Match if the model contains the provider name (e.g. "custom-mymodel"
    // when the name is "my" or a prefix of the name matches)
    if (model.startsWith(cp.name + "/")) return cp;
  }
  return null;
}

/** Proxy a chat completion request to a custom OpenAI-compatible provider */
async function proxyToCustomProvider(
  ctx: Context<{ Variables: ExternalApiVariables }>,
  cp: CustomProviderEnv,
  input: z.infer<typeof completionRequestSchema>,
  stream: boolean,
  durableTurn: DurableChatTurn
) {
  const url = `${cp.baseUrl}/v1/chat/completions`;
  const oaiMessages: Array<{ role: string; content: string }> = [];
  for (const m of input.messages) {
    oaiMessages.push({ role: m.role, content: m.content });
  }

  const body: Record<string, unknown> = {
    model: input.model,
    messages: oaiMessages,
    stream,
  };
  if (input.temperature !== undefined) body.temperature = input.temperature;
  if (input.max_tokens !== undefined) body.max_tokens = input.max_tokens;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 120_000);
  const turnHeaders = { [SYNAP_TURN_ID_HEADER]: durableTurn.id };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cp.apiKey ? { Authorization: `Bearer ${cp.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      await safeFinishExternalTurn({
        turnId: durableTurn.id,
        status: "failed",
        error: `Custom provider "${cp.name}" error (${res.status})`,
      });
      return ctx.json(
        {
          ...oaiErrorBody(
            `Custom provider "${cp.name}" error (${res.status}): ${text.slice(0, 200)}`,
            "upstream_error",
            res.status.toString()
          ),
          turnId: durableTurn.id,
        },
        502,
        turnHeaders
      );
    }

    if (!stream) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? "";
      await safeFinishExternalTurn({
        turnId: durableTurn.id,
        status: "completed",
      });
      return ctx.json(
        {
          id: generateId(),
          object: "chat.completion" as const,
          created: Math.floor(Date.now() / 1000),
          model: input.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant" as const, content },
              finish_reason: "stop" as const,
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          turnId: durableTurn.id,
        },
        200,
        turnHeaders
      );
    }

    // Streaming path: transform provider SSE → OpenAI SSE
    if (!res.body) {
      await safeFinishExternalTurn({
        turnId: durableTurn.id,
        status: "failed",
        error: "Custom provider returned empty response",
      });
      return ctx.json(
        {
          ...oaiErrorBody(
            "Custom provider returned empty response",
            "server_error",
            "empty_response"
          ),
          turnId: durableTurn.id,
        },
        500,
        turnHeaders
      );
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let sentRole = false;
    let doneFlag = false;
    let turnFinished = false;
    const finishTurnOnce = (status: "completed" | "failed", error?: string) => {
      if (turnFinished) return;
      turnFinished = true;
      void safeFinishExternalTurn({
        turnId: durableTurn.id,
        status,
        error,
      });
    };

    const transformStream = new ReadableStream({
      async start(controller) {
        const reader = res.body!.getReader();
        let buffer = "";
        let terminalStatus: "completed" | "failed" = "completed";
        let terminalError: string | undefined;

        function sendDone() {
          if (doneFlag) return;
          doneFlag = true;
          const finalChunk = {
            id: generateId(),
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: input.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`)
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data: ")) continue;
              const dataStr = trimmed.slice(6);
              if (dataStr === "[DONE]") {
                sendDone();
                continue;
              }
              let event: {
                delta?: { content?: string; role?: string };
                finish_reason?: string;
              };
              try {
                event = JSON.parse(dataStr);
              } catch {
                continue;
              }
              if (event.delta?.content) {
                const delta: Record<string, string> = {};
                if (!sentRole) {
                  delta.role = "assistant";
                  sentRole = true;
                }
                delta.content = event.delta.content;
                const chunk = {
                  id: generateId(),
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: input.model,
                  choices: [{ index: 0, delta, finish_reason: null }],
                };
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
              }
              if (event.finish_reason) sendDone();
            }
          }
          if (!doneFlag && sentRole) sendDone();
        } catch (err) {
          terminalStatus = "failed";
          terminalError =
            err instanceof Error
              ? err.message
              : "custom provider stream failed";
          if (!doneFlag) sendDone();
        } finally {
          finishTurnOnce(terminalStatus, terminalError);
          controller.close();
        }
      },
      cancel() {
        finishTurnOnce("failed", "client disconnected");
      },
    });

    return ctx.newResponse(transformStream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Synap-Model-Tier": "custom",
      ...turnHeaders,
    });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    await safeFinishExternalTurn({
      turnId: durableTurn.id,
      status: "failed",
      error: msg,
    });
    return ctx.json(
      {
        ...oaiErrorBody(
          `Failed to reach custom provider "${cp.name}" at ${cp.baseUrl}: ${msg}`,
          "server_error",
          "upstream_error"
        ),
        turnId: durableTurn.id,
      },
      502,
      turnHeaders
    );
  }
}

// ── Model alias → IS tier mapping ────────────────────────────────────────────

const MODEL_TIER_MAP: Record<string, string> = {
  "synap/auto": "auto",
  "synap/free": "free",
  "synap/balanced": "balanced",
  "synap/advanced": "advanced",
  "synap/complex": "complex",
};

// ── Zod schemas ──────────────────────────────────────────────────────────────

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const completionRequestSchema = z.object({
  model: z.string().default("synap/auto"),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  /** Client idempotency key (UUID). Also accepted via X-Request-Id header. */
  requestId: z.string().uuid().optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Build an OpenAI-format error body */
function oaiErrorBody(message: string, type: string, code: string | null) {
  return { error: { message, type, param: null, code } };
}

/**
 * Extract the last user message as the query, and build system prompt
 * from system messages.
 */
function extractQueryAndHistory(messages: z.infer<typeof messageSchema>[]): {
  query: string;
  systemPrompt: string | undefined;
} {
  let query = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      query = messages[i].content;
      break;
    }
  }

  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content);
  const systemPrompt =
    systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

  return { query, systemPrompt };
}

// ── Route ────────────────────────────────────────────────────────────────────

export const openaiCompatApp = new Hono<{
  Variables: ExternalApiVariables;
}>();

openaiCompatApp.post(
  "/chat/completions",
  externalApiKeyAuth("chat.stream"),
  async (c) => {
    const userId = c.get("userId");
    const completionId = generateId();
    const created = Math.floor(Date.now() / 1000);

    // ── Parse request ────────────────────────────────────────────────────────
    let input: z.infer<typeof completionRequestSchema>;
    try {
      const raw = await c.req.json();
      const parsed = completionRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          oaiErrorBody(
            parsed.error.issues.map((i) => i.message).join("; "),
            "invalid_request_error",
            "invalid_body"
          ),
          400
        );
      }
      input = parsed.data;
    } catch {
      return c.json(
        oaiErrorBody(
          "Request body must be valid JSON",
          "invalid_request_error",
          "parse_error"
        ),
        400
      );
    }

    const { query, systemPrompt } = extractQueryAndHistory(input.messages);
    if (!query) {
      return c.json(
        oaiErrorBody(
          "No user message found in messages array",
          "invalid_request_error",
          "missing_user_message"
        ),
        400
      );
    }

    // ── Resolve model tier ───────────────────────────────────────────────────
    const requestedModel = input.model;
    const knownTier = MODEL_TIER_MAP[requestedModel];
    // knownTier is defined for synap/* aliases, undefined for pass-through models
    const tierLabel = knownTier ?? "passthrough";

    // ── Resolve workspace (before turn — channel needs a workspace) ──────────
    const workspaceIdHeader = c.req.header("x-synap-workspace-id");
    let resolvedWorkspaceId: string;

    if (workspaceIdHeader) {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, workspaceIdHeader),
          eq(workspaceMembers.userId, userId)
        ),
        columns: { workspaceId: true },
      });
      if (!membership) {
        return c.json(
          oaiErrorBody(
            "Workspace not found or access denied",
            "invalid_request_error",
            "workspace_not_found"
          ),
          404
        );
      }
      resolvedWorkspaceId = membership.workspaceId;
    } else {
      const membership = await db.query.workspaceMembers.findFirst({
        where: eq(workspaceMembers.userId, userId),
        columns: { workspaceId: true },
      });
      if (!membership) {
        return c.json(
          oaiErrorBody(
            "No workspace found for this user",
            "invalid_request_error",
            "no_workspace"
          ),
          404
        );
      }
      resolvedWorkspaceId = membership.workspaceId;
    }

    // ── Resolve channel (auto-create personal channel) ───────────────────────
    let resolvedChannelId: string;
    try {
      const orchestratorId = await getAgentIdBySlug("orchestrator");
      if (!orchestratorId) throw new Error("Default agent not found");
      const personalChannel = await ensureAgentThread(userId, orchestratorId);
      resolvedChannelId = personalChannel.id;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to ensure personal channel"
      );
      return c.json(
        oaiErrorBody(
          "Failed to resolve chat channel",
          "server_error",
          "channel_error"
        ),
        500
      );
    }

    // ── Reserve durable chat_turn (full external ledger) ─────────────────────
    const requestId = resolveExternalRequestId(
      c.req.header("x-request-id") ?? c.req.header("X-Request-Id"),
      input.requestId
    );

    // Detect custom provider early so metadata source is accurate.
    const customProviders = parseCustomProviderEnv();
    const targetCp =
      customProviders.length > 0
        ? resolveCustomProviderForModel(requestedModel, customProviders)
        : null;
    const turnSource: ExternalTurnSource = targetCp
      ? "openai_compat_custom"
      : "openai_compat";

    let durableTurn: DurableChatTurn;
    let turnCreated: boolean;
    try {
      const claimed = await beginExternalDurableTurn({
        channelId: resolvedChannelId,
        userId,
        requestId,
        content: query,
        source: turnSource,
      });
      durableTurn = claimed.turn;
      turnCreated = claimed.created;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to create durable chat turn"
      );
      return c.json(
        oaiErrorBody(
          "Failed to start chat turn",
          "server_error",
          "turn_create_failed"
        ),
        500
      );
    }

    const turnHeaders = {
      [SYNAP_TURN_ID_HEADER]: durableTurn.id,
    };

    // Idempotent claim policy under the same requestId (D5):
    // completed → skip; running → in_progress; failed + no assistant → reopen.
    if (!turnCreated) {
      const hasUsefulAssistant = await hasUsefulAssistantForTurn(
        durableTurn.assistantMessageId
      );
      const action = decideChatTurnClaimAction({
        created: false,
        status: durableTurn.status,
        hasUsefulAssistant,
      });

      if (action === "reopen_and_run") {
        const claimedReopen = await reopenChatTurn(durableTurn.id);
        if (!claimedReopen) {
          // Lost CAS race — another worker reopened first; do not double-bill.
          if (input.stream) {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              },
            });
            return new Response(stream, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                ...turnHeaders,
              },
            });
          }
          return c.json(
            {
              id: completionId,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: input.model ?? "synap",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "" },
                  finish_reason: "stop",
                },
              ],
            },
            200,
            turnHeaders
          );
        }
        durableTurn = {
          ...durableTurn,
          status: "running",
          error: null,
          completedAt: null,
        };
        // Fall through to IS / custom provider.
      } else if (input.stream) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Stay OpenAI-compatible: no non-OAI frames. Header carries turnId.
            if (action === "skip_completed") {
              const finalChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`)
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } else {
              const errChunk = {
                error: {
                  message:
                    action === "in_progress"
                      ? "Turn already in progress for this requestId"
                      : (durableTurn.error ?? "Turn already finished"),
                  type: "invalid_request_error",
                  param: null,
                  code: "turn_reused",
                },
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`)
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
            controller.close();
          },
        });
        return c.newResponse(stream, 200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "X-Synap-Model-Tier": tierLabel,
          ...turnHeaders,
        });
      } else if (action === "skip_completed") {
        return c.json(
          {
            id: completionId,
            object: "chat.completion" as const,
            created,
            model: requestedModel,
            choices: [
              {
                index: 0,
                message: { role: "assistant" as const, content: "" },
                finish_reason: "stop" as const,
              },
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
            turnId: durableTurn.id,
            reused: true,
          },
          200,
          { "X-Synap-Model-Tier": tierLabel, ...turnHeaders }
        );
      } else {
        return c.json(
          {
            ...oaiErrorBody(
              action === "in_progress"
                ? "Turn already in progress for this requestId"
                : (durableTurn.error ?? "Turn already finished"),
              "invalid_request_error",
              "turn_reused"
            ),
            turnId: durableTurn.id,
          },
          action === "in_progress" ? 409 : 400,
          turnHeaders
        );
      }
    }

    // ── Custom provider: bypass IS entirely ──────────────────────────────────
    if (targetCp) {
      return proxyToCustomProvider(
        c,
        targetCp,
        input,
        input.stream,
        durableTurn
      );
    }

    // ── Resolve IS endpoint ──────────────────────────────────────────────────
    let isUrl: string;
    let isApiKey: string;
    try {
      const resolved = await resolveIntelligenceService({
        userId,
        workspaceId: resolvedWorkspaceId,
      });
      isUrl = resolved.endpoint;
      isApiKey = resolved.serviceApiKey;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to resolve intelligence service"
      );
      await safeFinishExternalTurn({
        turnId: durableTurn.id,
        status: "failed",
        error: "Intelligence service unavailable",
      });
      return c.json(
        {
          ...oaiErrorBody(
            "Intelligence service unavailable",
            "server_error",
            "service_unavailable"
          ),
          turnId: durableTurn.id,
        },
        502,
        turnHeaders
      );
    }

    // ── Build IS request ─────────────────────────────────────────────────────
    const agentConfig: Record<string, unknown> = {};

    if (knownTier) {
      // Known synap/* alias
      if (knownTier === "complex") {
        // deepAnalysis flag routes to Opus tier
      }
      // For non-auto tiers, pass tier preference via workspace settings
    } else {
      // Pass-through model: forward as explicit modelId
      agentConfig.modelId = requestedModel;
    }

    if (input.temperature !== undefined) {
      agentConfig.temperature = input.temperature;
    }

    if (systemPrompt) {
      agentConfig.systemPromptOverride = systemPrompt;
    }

    const isBody: Record<string, unknown> = {
      query,
      threadId: resolvedChannelId,
      userId,
      workspaceId: resolvedWorkspaceId,
      agentType: "meta",
      ...getPodCallback(),
      stream: input.stream,
    };

    if (knownTier === "complex") {
      isBody.deepAnalysis = true;
    }

    if (knownTier && knownTier !== "auto") {
      isBody.workspaceSettings = {
        agentModelPreferences: { defaultTier: knownTier },
      };
    }

    if (Object.keys(agentConfig).length > 0) {
      isBody.agentConfig = agentConfig;
    }

    // ── Non-streaming path ───────────────────────────────────────────────────
    if (!input.stream) {
      let isResponse: Response;
      try {
        isResponse = await fetch(`${isUrl}/api/chat/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": isApiKey,
            "X-Synap-Channel": "api",
          },
          body: JSON.stringify(isBody),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "Failed to reach intelligence service"
        );
        await safeFinishExternalTurn({
          turnId: durableTurn.id,
          status: "failed",
          error: "Intelligence service unreachable",
        });
        return c.json(
          {
            ...oaiErrorBody(
              "Intelligence service unreachable",
              "server_error",
              "service_unreachable"
            ),
            turnId: durableTurn.id,
          },
          502,
          turnHeaders
        );
      }

      if (!isResponse.ok) {
        await isResponse.text().catch(() => "");
        await safeFinishExternalTurn({
          turnId: durableTurn.id,
          status: "failed",
          error: `Upstream AI service error (${isResponse.status})`,
        });
        return c.json(
          {
            ...oaiErrorBody(
              `Upstream AI service error (${isResponse.status})`,
              "server_error",
              "upstream_error"
            ),
            turnId: durableTurn.id,
          },
          502,
          turnHeaders
        );
      }

      let content = "";
      try {
        const data = (await isResponse.json()) as { content?: string };
        content = data.content ?? "";
      } catch {
        await safeFinishExternalTurn({
          turnId: durableTurn.id,
          status: "failed",
          error: "Failed to parse intelligence service response",
        });
        return c.json(
          {
            ...oaiErrorBody(
              "Failed to parse intelligence service response",
              "server_error",
              "parse_error"
            ),
            turnId: durableTurn.id,
          },
          502,
          turnHeaders
        );
      }

      await safeFinishExternalTurn({
        turnId: durableTurn.id,
        status: "completed",
      });

      return c.json(
        {
          id: completionId,
          object: "chat.completion" as const,
          created,
          model: requestedModel,
          choices: [
            {
              index: 0,
              message: { role: "assistant" as const, content },
              finish_reason: "stop" as const,
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
          turnId: durableTurn.id,
        },
        200,
        { "X-Synap-Model-Tier": tierLabel, ...turnHeaders }
      );
    }

    // ── Streaming path ───────────────────────────────────────────────────────
    let isResponse: Response;
    try {
      isResponse = await fetch(`${isUrl}/api/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": isApiKey,
          "X-Synap-Channel": "api",
        },
        body: JSON.stringify(isBody),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to reach intelligence service"
      );
      await safeFinishExternalTurn({
        turnId: durableTurn.id,
        status: "failed",
        error: "Intelligence service unreachable",
      });
      return c.json(
        {
          ...oaiErrorBody(
            "Intelligence service unreachable",
            "server_error",
            "service_unreachable"
          ),
          turnId: durableTurn.id,
        },
        502,
        turnHeaders
      );
    }

    if (!isResponse.ok) {
      await isResponse.text().catch(() => "");
      await safeFinishExternalTurn({
        turnId: durableTurn.id,
        status: "failed",
        error: `Upstream AI service error (${isResponse.status})`,
      });
      return c.json(
        {
          ...oaiErrorBody(
            `Upstream AI service error (${isResponse.status})`,
            "server_error",
            "upstream_error"
          ),
          turnId: durableTurn.id,
        },
        502,
        turnHeaders
      );
    }

    if (!isResponse.body) {
      await safeFinishExternalTurn({
        turnId: durableTurn.id,
        status: "failed",
        error: "Intelligence service returned empty response",
      });
      return c.json(
        {
          ...oaiErrorBody(
            "Intelligence service returned empty response",
            "server_error",
            "empty_response"
          ),
          turnId: durableTurn.id,
        },
        502,
        turnHeaders
      );
    }

    // Transform IS SSE → OpenAI SSE (wire format unchanged; turnId via header).
    // Frame rewrite path finishes the turn in finally/cancel (once).
    const encoder = new TextEncoder();

    let sentRole = false;
    let streamFinished = false;
    let turnFinished = false;
    const finishTurnOnce = (status: "completed" | "failed", error?: string) => {
      if (turnFinished) return;
      turnFinished = true;
      void safeFinishExternalTurn({
        turnId: durableTurn.id,
        status,
        error,
      });
    };

    const transformStream = new ReadableStream({
      async start(controller) {
        let terminalStatus: "completed" | "failed" = "completed";
        let terminalError: string | undefined;

        function sendDone() {
          if (streamFinished) return;
          streamFinished = true;
          const finalChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: requestedModel,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`)
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }

        try {
          for await (const frame of iterateISChatStream(isResponse)) {
            // Only convert "content" frames to OpenAI deltas
            if (frame.type === "content" && frame.content) {
              const delta: Record<string, string> = {};

              // Send role in first chunk
              if (!sentRole) {
                delta.role = "assistant";
                sentRole = true;
              }
              delta.content = frame.content;

              const chunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [
                  {
                    index: 0,
                    delta,
                    finish_reason: null,
                  },
                ],
              };

              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
              );
            }

            // "complete" or "error" frame means we're done
            if (frame.type === "complete" || frame.type === "error") {
              if (frame.type === "error") {
                terminalStatus = "failed";
                terminalError =
                  typeof frame.error === "string"
                    ? frame.error
                    : "upstream stream error";
              }
              sendDone();
            }
          }

          // If IS stream ended without a "complete" event, close gracefully
          if (!streamFinished && sentRole) {
            sendDone();
          }
        } catch (err) {
          terminalStatus = "failed";
          terminalError =
            err instanceof Error ? err.message : "stream transform failed";
          logger.error(
            { err: terminalError },
            "Error transforming IS SSE to OpenAI format"
          );
        } finally {
          finishTurnOnce(terminalStatus, terminalError);
          controller.close();
        }
      },
      cancel() {
        finishTurnOnce("failed", "client disconnected");
      },
    });

    return c.newResponse(transformStream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Synap-Model-Tier": tierLabel,
      ...turnHeaders,
    });
  }
);

// ── Models listing (useful for OpenAI-compatible clients) ────────────────────

/**
 * Fetch locally available Ollama models. Returns empty array on any error
 * (Ollama not installed, timeout, etc.) — callers must treat this as best-effort.
 */
async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return (json.models ?? []).map((m) => m.name).filter(Boolean);
  } catch {
    return [];
  }
}

openaiCompatApp.get("/models", externalApiKeyAuth("chat.stream"), async (c) => {
  // Fixed Synap tier aliases — always present regardless of provider config.
  const tierModels = [
    {
      id: "synap/auto",
      object: "model" as const,
      created: 1700000000,
      owned_by: "synap",
    },
    {
      id: "synap/free",
      object: "model" as const,
      created: 1700000000,
      owned_by: "synap",
    },
    {
      id: "synap/balanced",
      object: "model" as const,
      created: 1700000000,
      owned_by: "synap",
    },
    {
      id: "synap/advanced",
      object: "model" as const,
      created: 1700000000,
      owned_by: "synap",
    },
    {
      id: "synap/complex",
      object: "model" as const,
      created: 1700000000,
      owned_by: "synap",
    },
  ];

  // Dynamic models: the user's configured default model (if any) and locally
  // running Ollama models. Eve writes OLLAMA_BASE_URL to the deploy .env when
  // Ollama is installed; DEFAULT_AI_MODEL comes from the active provider config.
  const seen = new Set(tierModels.map((m) => m.id));
  const extra: typeof tierModels = [];

  const configuredModel = process.env.DEFAULT_AI_MODEL;
  if (configuredModel && !seen.has(configuredModel)) {
    seen.add(configuredModel);
    extra.push({
      id: configuredModel,
      object: "model",
      created: 1700000000,
      owned_by: "external",
    });
  }

  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL;
  if (ollamaBaseUrl) {
    const ollamaModels = await fetchOllamaModels(ollamaBaseUrl);
    for (const name of ollamaModels) {
      if (!seen.has(name)) {
        seen.add(name);
        extra.push({
          id: name,
          object: "model",
          created: 1700000000,
          owned_by: "ollama",
        });
      }
    }
  }

  // DB-backed providers: expose each enabled provider's models as "{providerId}/{modelId}".
  // The IS's buildModelById strips the prefix and routes to the named provider.
  try {
    const dbProviders = await db.query.aiProviders.findMany({
      where: (t, { eq: eqFn }) => eqFn(t.enabled, true),
      orderBy: (t, { asc }) => [asc(t.priority)],
    });
    for (const p of dbProviders) {
      const models = Array.isArray(p.models)
        ? (p.models as Array<{ id: string }>)
        : [];
      for (const m of models) {
        const fullId = `${p.providerId}/${m.id}`;
        if (!seen.has(fullId)) {
          seen.add(fullId);
          extra.push({
            id: fullId,
            object: "model",
            created: 1700000000,
            owned_by: p.providerId,
          });
        }
      }
    }
  } catch {
    // DB unavailable — skip; tier models still returned
  }

  // Custom providers: list their default model + try to fetch from their /api/tags endpoint.
  for (const cp of parseCustomProviderEnv()) {
    if (cp.defaultModel && !seen.has(cp.defaultModel)) {
      seen.add(cp.defaultModel);
      extra.push({
        id: cp.defaultModel,
        object: "model",
        created: 1700000000,
        owned_by: cp.name,
      });
    }
    // Try to discover additional models from the custom provider's /api/tags (OpenAI-compat doesn't have /models for non-Ollama)
    // For generic OpenAI-compat providers, just list the default model.
    // For Ollama-like providers, probe /api/tags.
    if (cp.defaultModel && !cp.apiKey?.trim()) {
      // Likely an Ollama instance — probe for additional models
      const cpModels = await fetchOllamaModels(cp.baseUrl);
      for (const name of cpModels) {
        if (!seen.has(name)) {
          seen.add(name);
          extra.push({
            id: name,
            object: "model",
            created: 1700000000,
            owned_by: cp.name,
          });
        }
      }
    }
  }

  return c.json({ object: "list" as const, data: [...tierModels, ...extra] });
});

/**
 * GET /v1/config
 *
 * Returns the active AI provider configuration as seen by Synap IS at runtime.
 * Used by the Eve dashboard to show which provider/model each component is
 * actually configured to use, rather than relying solely on secrets.json.
 *
 * Auth: same Bearer API key as /v1/models.
 */
openaiCompatApp.get("/config", externalApiKeyAuth("chat.stream"), (c) => {
  const provider = process.env.DEFAULT_AI_PROVIDER ?? null;
  const model = process.env.DEFAULT_AI_MODEL ?? null;
  const ollamaUrl = process.env.OLLAMA_BASE_URL ?? null;

  const customProviders = parseCustomProviderEnv().map((cp) => ({
    name: cp.name,
    baseUrl: cp.baseUrl,
    defaultModel: cp.defaultModel ?? null,
  }));

  return c.json({
    provider,
    model,
    ollamaEnabled: !!ollamaUrl,
    customProviders,
    hasOpenai: !!process.env.OPENAI_API_KEY,
    hasAnthropic: !!process.env.ANTHROPIC_API_KEY,
    hasOpenrouter: !!process.env.OPENROUTER_API_KEY,
  });
});
