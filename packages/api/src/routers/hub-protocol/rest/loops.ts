/**
 * Hub Protocol REST — loops (loop-template applier)
 *
 * Headless seam so an external CLI (eve) can apply a LOOP TEMPLATE — a config
 * descriptor that instantiates an autonomy loop ({playbooks · triggers}) in ONE
 * call. The proactive/autonomous counterpart to `POST /capabilities/apply`
 * (which instantiates {vault · tools · skills}).
 *
 * Reuse, not duplication: this is a thin HTTP door. It resolves the trusted
 * acting identity (resolveActingContext — closes the cross-tenant IDOR), builds
 * a hub-protocol caller context (the SAME pattern rest/capabilities.ts uses),
 * then delegates to `createLoopFromDefinition`, which itself creates every
 * playbook/trigger through the GOVERNED router callers (so governance, audit,
 * and side-effects are identical to the playbooks.create / automations.create
 * routes).
 *
 * Routes:
 *   POST /loops/apply  — apply a LoopDefinition (inline) or a seed templateKey
 *                        + params (proposal-gated per resource)
 */

import { z } from "@hono/zod-openapi";

import {
  createLoopFromDefinition,
  loadLoopTemplate,
} from "../../../services/loops/create-from-definition.js";
import { getConfinedWorkspace } from "../confine-workspace.js";
import { createHubProtocolCallerContext } from "../utils.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

// ── Local OpenAPI schemas ────────────────────────────────────────────────────

const ParamSpecSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  type: z.enum(["text", "number", "entity", "choice", "boolean"]).optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

const PlaybookParamSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  type: z.enum(["text", "number", "entity", "choice", "boolean"]),
  options: z.array(z.string()).optional(),
  default: z.unknown().optional(),
  required: z.boolean().optional(),
});

const GrantSchema = z.object({
  kind: z.enum(["tool", "skill", "command"]),
  id: z.string().min(1),
});

const ScheduleSchema = z.object({
  cron: z.string().min(1),
  enabled: z.boolean(),
});

const LoopPlaybookDefSchema = z.object({
  ref: z.string().min(1),
  name: z.string().min(1),
  goalTemplate: z.string().min(1),
  description: z.string().optional(),
  params: z.array(PlaybookParamSchema).optional(),
  executor: z.enum(["is-agent", "external-agent", "hybrid"]).optional(),
  inputStrategy: z.record(z.string(), z.unknown()).optional(),
  channelSpec: z.record(z.string(), z.unknown()).optional(),
  expectedOutputs: z.array(z.record(z.string(), z.unknown())).optional(),
  grants: z.array(GrantSchema).optional(),
  schedule: ScheduleSchema.optional(),
  // First-class stages + subject profile — threaded into playbooks.create so the
  // authored (.loop.json) path no longer drops them (root-cause fix).
  stages: z.array(z.record(z.string(), z.unknown())).optional(),
  subjectProfile: z.record(z.string(), z.unknown()).optional(),
  // Kind + Facets: subject-FACET selector (the facet twin of subjectProfile).
  // Type-level / forward-compat — validated here, not yet persisted.
  subjectFacet: z.record(z.string(), z.unknown()).optional(),
});

const LoopTriggerDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: z.object({
    type: z.enum(["cron", "event", "manual"]),
    cron: z.string().optional(),
    eventType: z.string().optional(),
  }),
  playbookRef: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

const LoopDefinitionSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  params: z.array(ParamSpecSchema).optional(),
  playbooks: z.array(LoopPlaybookDefSchema),
  triggers: z.array(LoopTriggerDefSchema).optional(),
});

const ApplyLoopRequestSchema = z
  .object({
    /** Apply an inline definition. Mutually exclusive with templateKey. */
    definition: LoopDefinitionSchema.optional(),
    /** Apply a seed template loaded by key (e.g. "morning-briefing"). */
    templateKey: z.string().optional(),
    /** Param values substituted into `{{param}}` placeholders. */
    params: z.record(z.string(), z.unknown()).optional(),
    /** Omit for pod-wide. */
    workspaceId: z.string().uuid().optional(),
  })
  .refine((b) => !!b.definition || !!b.templateKey, {
    message: "Either definition or templateKey is required",
  });

const ApplyLoopResponseSchema = z.object({
  loopKey: z.string(),
  created: z.object({
    playbooks: z.array(z.record(z.string(), z.unknown())),
    triggers: z.array(z.record(z.string(), z.unknown())),
  }),
  proposals: z.array(z.string()),
});

// ── Register function ──────────────────────────────────────────────────────

export function registerLoopsRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/loops/apply",
    tags: ["Loops"],
    summary: "Apply a loop (autonomy) template",
    description:
      "Instantiates an autonomy loop ({playbooks · triggers}) from a config " +
      "descriptor (inline `definition` or a seed `templateKey`) + `params`. " +
      "`{{param}}` placeholders are interpolated; each playbook/trigger is " +
      "created through the governed routers (proposal-gated — proposal ids are " +
      "surfaced in `proposals`). A playbook's inline `schedule` materializes its " +
      "backing cron automation for free. Requires hub-protocol.write scope.",
    request: { body: ApplyLoopRequestSchema },
    responses: {
      200: {
        description: "Applied loop (created + proposed resources)",
        schema: ApplyLoopResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Template not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/loops/apply", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const parsed = ApplyLoopRequestSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const body = parsed.data;

    try {
      // SERVICE-KEY CONFINEMENT (Item 3): positive-pin a bound service key to its
      // workspace BEFORE the value reaches the acting-context resolve or the caller
      // ctx (a mismatching body → 403). The door ctx-clamp does NOT reach here —
      // createLoopFromDefinition runs on a DIRECT createHubProtocolCallerContext
      // (not getCaller), and the inner resources read the value we hand in.
      const workspaceId = getConfinedWorkspace(c, body.workspaceId);

      // Trusted acting identity + workspace (closes the cross-tenant IDOR).
      const acting = await resolveActingContext(c, {
        workspaceId: workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      // Resolve the definition: inline body wins, else load the seed template.
      let definition;
      try {
        definition = body.definition ?? loadLoopTemplate(body.templateKey!);
      } catch (loadErr) {
        return c.json(
          {
            error:
              loadErr instanceof Error ? loadErr.message : "Template not found",
          },
          404
        );
      }

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[],
        workspaceId ?? null,
        null,
        null,
        // Forward the acting agent (agent-key linkedUserId remap) so an AI
        // caller's loop apply routes each playbook/trigger create through the
        // governance membrane (propose, not auto-apply). Undefined for
        // operator/human-driven keys, which stay synchronous.
        (c.get("agentUserId") as string | undefined) ?? null
      );

      const result = await createLoopFromDefinition(
        definition,
        body.params ?? {},
        ctx
      );
      return c.json(result, 200);
    } catch (err) {
      // SERVICE-KEY CONFINEMENT: a bound service key targeting another workspace
      // throws FORBIDDEN — surface 403, not a blanket 500. Duck-typed on `.code`
      // (bundled-build TRPCError identity defeats instanceof).
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      logger.error({ err }, "loops apply failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
