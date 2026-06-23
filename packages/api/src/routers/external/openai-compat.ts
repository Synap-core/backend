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

import { Hono, Context } from "hono";
import { z } from "zod";
import { db, eq, and } from "@synap/database";
import { workspaceMembers } from "@synap/database/schema";
import { resolveIntelligenceService } from "../../utils/intelligence-routing.js";
import { getPodReadKey } from "../../utils/pod-read-key.js";
import {
  ensureAgentThread,
  getAgentIdBySlug,
} from "../../utils/personal-channel.js";
import { createLogger } from "@synap-core/core";
import { externalApiKeyAuth, type ExternalApiVariables } from "./middleware.js";

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
  stream: boolean
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
      return ctx.json(
        oaiErrorBody(
          `Custom provider "${cp.name}" error (${res.status}): ${text.slice(0, 200)}`,
          "upstream_error",
          res.status.toString()
        ),
        502
      );
    }

    if (!stream) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? "";
      return ctx.json({
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
      });
    }

    // Streaming path: transform provider SSE → OpenAI SSE
    if (!res.body) {
      return ctx.json(
        oaiErrorBody(
          "Custom provider returned empty response",
          "server_error",
          "empty_response"
        ),
        500
      );
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let sentRole = false;
    let doneFlag = false;

    const transformStream = new ReadableStream({
      async start(controller) {
        const reader = res.body!.getReader();
        let buffer = "";

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
        } catch {
          if (!doneFlag) sendDone();
        } finally {
          controller.close();
        }
      },
    });

    return ctx.newResponse(transformStream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Synap-Model-Tier": "custom",
    });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    return ctx.json(
      oaiErrorBody(
        `Failed to reach custom provider "${cp.name}" at ${cp.baseUrl}: ${msg}`,
        "server_error",
        "upstream_error"
      ),
      502
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

    // ── Custom provider check: bypass IS entirely for custom providers ───────
    const customProviders = parseCustomProviderEnv();
    if (customProviders.length > 0) {
      const targetCp = resolveCustomProviderForModel(
        requestedModel,
        customProviders
      );
      if (targetCp) {
        return proxyToCustomProvider(c, targetCp, input, input.stream);
      }
    }

    // ── Resolve workspace ────────────────────────────────────────────────────
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
      return c.json(
        oaiErrorBody(
          "Intelligence service unavailable",
          "server_error",
          "service_unavailable"
        ),
        502
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
      dataPodUrl: process.env.PUBLIC_URL ?? process.env.BACKEND_URL ?? "",
      dataPodApiKey: getPodReadKey(),
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
        return c.json(
          oaiErrorBody(
            "Intelligence service unreachable",
            "server_error",
            "service_unreachable"
          ),
          502
        );
      }

      if (!isResponse.ok) {
        await isResponse.text().catch(() => "");
        return c.json(
          oaiErrorBody(
            `Upstream AI service error (${isResponse.status})`,
            "server_error",
            "upstream_error"
          ),
          502
        );
      }

      let content = "";
      try {
        const data = (await isResponse.json()) as { content?: string };
        content = data.content ?? "";
      } catch {
        return c.json(
          oaiErrorBody(
            "Failed to parse intelligence service response",
            "server_error",
            "parse_error"
          ),
          502
        );
      }

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
        },
        200,
        { "X-Synap-Model-Tier": tierLabel }
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
      return c.json(
        oaiErrorBody(
          "Intelligence service unreachable",
          "server_error",
          "service_unreachable"
        ),
        502
      );
    }

    if (!isResponse.ok) {
      await isResponse.text().catch(() => "");
      return c.json(
        oaiErrorBody(
          `Upstream AI service error (${isResponse.status})`,
          "server_error",
          "upstream_error"
        ),
        502
      );
    }

    if (!isResponse.body) {
      return c.json(
        oaiErrorBody(
          "Intelligence service returned empty response",
          "server_error",
          "empty_response"
        ),
        502
      );
    }

    // Transform IS SSE → OpenAI SSE
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let sentRole = false;
    let streamFinished = false;
    const transformStream = new ReadableStream({
      async start(controller) {
        const reader = isResponse.body!.getReader();
        let buffer = "";

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
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process complete SSE lines
            const lines = buffer.split("\n");
            // Keep the last potentially incomplete line in the buffer
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data: ")) continue;

              const dataStr = trimmed.slice(6); // Remove "data: "
              if (dataStr === "[DONE]") continue;

              let event: {
                type: string;
                content?: string;
                data?: { content?: string };
                error?: string;
              };
              try {
                event = JSON.parse(dataStr);
              } catch {
                continue; // skip malformed lines
              }

              // Only convert "content" events to OpenAI deltas
              if (event.type === "content" && event.content) {
                const delta: Record<string, string> = {};

                // Send role in first chunk
                if (!sentRole) {
                  delta.role = "assistant";
                  sentRole = true;
                }
                delta.content = event.content;

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

              // "complete" or "error" event means we're done
              if (event.type === "complete" || event.type === "error") {
                sendDone();
              }
            }
          }

          // If IS stream ended without a "complete" event, close gracefully
          if (!streamFinished && sentRole) {
            sendDone();
          }
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            "Error transforming IS SSE to OpenAI format"
          );
        } finally {
          controller.close();
        }
      },
    });

    return c.newResponse(transformStream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Synap-Model-Tier": tierLabel,
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
