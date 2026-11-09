/**
 * GET /api/hub/ai-providers/available — the models an app may pick for a chat
 * turn: only the providers the pod has ENABLED, each model with the id
 * `POST /chat/stream` accepts as `model`, a label, and which one is the default.
 *
 * Why not `GET /ai-providers`: that door returns the whole row (base URL,
 * priority, key presence) and stays an operator door, refused to a scoped key.
 * This one answers ONLY the selectable list (`enabled-models.ts`).
 *
 * Gate: the grant fence admits a scoped key that holds `chat.stream` (the verb
 * that lets an app run a turn at all, `GRANT_REST_GET_READS`); a key that may
 * not run a turn has no use for the list. Needs `hub-protocol.read`.
 */
import { z } from "@hono/zod-openapi";
import { createLogger } from "@synap-core/core";
import { listEnabledModels } from "../../../services/chat-turns/enabled-models.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, httpStatusForTrpcError, type HubHono } from "./_shared.js";

const logger = createLogger({ module: "hub-ai-providers-available" });

const AvailableModelsSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      providerId: z.string(),
      providerName: z.string(),
      tier: z.string().nullable(),
      isDefault: z.boolean(),
    })
  ),
  defaultModelId: z.string().nullable(),
});

export function registerAiProvidersAvailableRoute(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/ai-providers/available",
    tags: ["Chat"],
    summary: "The AI models the pod has enabled, selectable for a chat turn",
    description:
      "Enabled providers' models only: the id a chat turn's `model` accepts, a label, the provider, " +
      "and which model is the default. Never a key, credential, base URL or priority. " +
      "Requires hub-protocol.read; a scoped key needs `chat.stream`.",
    responses: {
      200: { description: "Selectable models", schema: AvailableModelsSchema },
      403: {
        description: "Missing scope or outside the grant",
        schema: z.object({ error: z.string() }),
      },
    },
  });

  app.get("/ai-providers/available", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    try {
      const models = await listEnabledModels();
      return c.json({
        models,
        defaultModelId: models.find((m) => m.isDefault)?.id ?? null,
      });
    } catch (err) {
      const status = httpStatusForTrpcError(err);
      if (status === 500)
        logger.error({ err }, "Could not read the enabled AI models");
      return c.json({ error: "Could not read the enabled AI models" }, status);
    }
  });
}
