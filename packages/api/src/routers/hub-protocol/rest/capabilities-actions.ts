/**
 * Hub Protocol REST — GET /capabilities/actions
 *
 * A thin external door over the shared runnable-action projection. Unlike the
 * broad capability catalog, this is safe to hand directly to an AI: every row
 * has a real execute bridge, is approved, and has a live required connection.
 */
import { z } from "@hono/zod-openapi";
import { ABSTRACT_VERBS, isAbstractVerb } from "@synap/database/schema";
import {
  listCapabilities,
  type ListCapabilitiesOptions,
} from "../../../services/capabilities/capability-registry.js";
import { foldVerbsByIntent } from "../../../services/capabilities/capability-intent-index.js";
import { projectRunnableActions } from "../../../services/capabilities/action-projection.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

const ActionSchema = z.object({
  skillId: z.string().optional(),
  verbId: z.string().optional(),
  label: z.string(),
  description: z.string().nullable().optional(),
  tool: z.string().nullable(),
  connection: z
    .object({
      required: z.literal(true),
      state: z.literal("connected"),
      provider: z.string(),
    })
    .optional(),
  governance: z.literal("auto"),
  executionMode: z.string().optional(),
  // Per-verb direction axis — pull (read) vs push (write/action). Optional:
  // absent for a skill-only action (honest-unknown, never defaulted).
  kind: z.enum(["read", "write", "action"]).optional(),
  // Vendor-independent routing intent (ABSTRACT_VERBS). Optional by nature —
  // a verb outside the closed vocabulary omits it rather than inventing one.
  intent: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()),
});

export function registerCapabilitiesActionsRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/capabilities/actions",
    tags: ["Capabilities"],
    summary: "List only actions an external AI can execute now",
    description:
      "Projects the shared capability registry into executable actions. Draft, " +
      "disconnected, teaching-only, and catalog-only entries are omitted. Each " +
      "action carries its real parameter schema, connection state, approval " +
      "posture, and effective execution mode. Requires a workspace lens. " +
      "Pass `intent` (a closed ABSTRACT_VERBS value) to keep only the actions " +
      "whose verb declares that routing intent — the vendor-independent way to " +
      'ask "what can send a message?". A verb that declares no intent is ' +
      "never matched (the vocabulary is closed; absence is never guessed).",
    request: {
      query: z.object({
        workspaceId: z.string().uuid(),
        query: z.string().optional(),
        kind: z.string().optional(),
        // Vendor-independent ROUTING filter over the SAME rows — "which action
        // can send a message", without knowing `gmail_send`. Resolved by the
        // shared reverse index (`foldVerbsByIntent`), never a second lookup.
        intent: z.enum(ABSTRACT_VERBS).optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
      }),
    },
    responses: {
      200: {
        description: "Runnable actions",
        schema: z.object({ actions: z.array(ActionSchema) }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/capabilities/actions", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const workspaceId = c.req.query("workspaceId");
    const parsedWorkspaceId = z.string().uuid().safeParse(workspaceId);
    if (!parsedWorkspaceId.success) {
      return c.json(
        { error: "workspaceId query param (UUID) is required" },
        400
      );
    }

    const acting = await resolveActingContext(c, {
      workspaceId: parsedWorkspaceId.data,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    const query = c.req.query("query")?.trim() || undefined;
    const kind = c.req.query("kind")?.trim() || undefined;
    const intentRaw = c.req.query("intent")?.trim() || undefined;
    // Reject an unknown intent at the door with the closed vocabulary named.
    // Silently ignoring it would answer a DIFFERENT question than was asked
    // (the whole action list, read as "these all send messages").
    if (intentRaw !== undefined && !isAbstractVerb(intentRaw)) {
      return c.json(
        {
          error: `Unknown intent "${intentRaw}". The vocabulary is closed: ${ABSTRACT_VERBS.join(", ")}`,
        },
        400
      );
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit <= 0 || limit > 100)
    ) {
      return c.json(
        { error: "limit must be an integer between 1 and 100" },
        400
      );
    }

    try {
      const options: ListCapabilitiesOptions | undefined =
        query || kind || limit !== undefined
          ? {
              ...(query ? { query } : {}),
              // The registry validates its own string union at the type boundary;
              // runtime input remains an optional discovery filter.
              ...(kind
                ? { kind: kind as ListCapabilitiesOptions["kind"] }
                : {}),
              ...(limit !== undefined ? { limit } : {}),
            }
          : undefined;
      const capabilities = await listCapabilities(
        { workspaceId: acting.workspaceId!, userId: acting.userId },
        options
      );
      const actions = projectRunnableActions(capabilities);
      if (intentRaw === undefined) return c.json({ actions }, 200);
      // Fold through the SHARED reverse index so this door's notion of "declares
      // intent X" is byte-for-byte the MCP door's (same dedup, same
      // no-intent-means-absent rule). Never re-derive `verb.intent === x` here.
      const matched = new Set(
        (foldVerbsByIntent(capabilities).get(intentRaw) ?? []).map(
          (m) => m.verbId
        )
      );
      return c.json(
        // A skill-only action carries no `verbId` and therefore no intent — it
        // is correctly absent from an intent-filtered answer.
        { actions: actions.filter((a) => !!a.verbId && matched.has(a.verbId)) },
        200
      );
    } catch (err) {
      logger.error({ err }, "capabilities actions failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
