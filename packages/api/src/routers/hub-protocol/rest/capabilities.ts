/**
 * Hub Protocol REST — capabilities (capability-template applier)
 *
 * Headless seam so an external CLI (eve) can apply a CAPABILITY TEMPLATE — a
 * config descriptor that instantiates a set of {vault secrets · tools · skills}
 * in ONE call. The capability-layer counterpart to `workspaces.createFromDefinition`
 * (which instantiates {profiles · views}).
 *
 * Reuse, not duplication: this is a thin HTTP door. It resolves the trusted
 * acting identity (resolveActingContext — closes the cross-tenant IDOR), builds
 * a hub-protocol caller context (the SAME pattern rest/tools.ts & rest/skills-crud.ts
 * use), then delegates to `createCapabilityFromDefinition`, which itself creates
 * every tool/skill through the GOVERNED router callers (so governance, audit, and
 * side-effects are identical to the Phase-1 POST /tools & POST /skills routes).
 *
 * Routes:
 *   POST /capabilities/apply  — apply a CapabilityDefinition (inline) or a
 *                               seed templateKey + params (proposal-gated per resource)
 */

import { z } from "@hono/zod-openapi";

import {
  createCapabilityFromDefinition,
  loadCapabilityTemplate,
} from "../../../services/capabilities/create-from-definition.js";
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

const VaultDefSchema = z.object({
  ref: z.string().min(1),
  name: z.string().min(1),
  value: z.string(),
  type: z
    .enum([
      "password",
      "api_key",
      "credential",
      "note",
      "card",
      "identity",
      "ssh_key",
      "certificate",
      "env_variable",
      "database",
      "oauth",
    ])
    .optional(),
  service: z.string().optional(),
  description: z.string().optional(),
});

const ToolDefSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["builtin", "api", "mcp", "provider", "external", "script"]),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  credentialRef: z.string().optional(),
  executor: z.enum(["is-agent", "external-agent", "hybrid"]).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const SkillDefSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["instruction", "code"]).optional(),
  scope: z.enum(["pod", "user", "workspace"]).optional(),
  agentTypes: z.array(z.string()).optional(),
  description: z.string().optional(),
  code: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
  category: z.string().optional(),
  executionMode: z.enum(["sync", "async"]).optional(),
  timeoutSeconds: z.number().min(1).max(300).optional(),
  requires: z.array(z.string()).optional(),
});

const CapabilityDefinitionSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  params: z.array(ParamSpecSchema).optional(),
  vault: z.array(VaultDefSchema).optional(),
  tools: z.array(ToolDefSchema),
  skills: z.array(SkillDefSchema),
});

const ApplyCapabilityRequestSchema = z
  .object({
    /** Apply an inline definition. Mutually exclusive with templateKey. */
    definition: CapabilityDefinitionSchema.optional(),
    /** Apply a seed template loaded by key (e.g. "generic-apikey"). */
    templateKey: z
      .string()
      .max(64)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    /** Param values substituted into `{{param}}` placeholders. */
    params: z.record(z.string(), z.unknown()).optional(),
    /** Omit for pod-wide. */
    workspaceId: z.string().uuid().optional(),
  })
  .refine((b) => !!b.definition || !!b.templateKey, {
    message: "Either definition or templateKey is required",
  });

const ApplyCapabilityResponseSchema = z.object({
  capabilityKey: z.string(),
  created: z.object({
    vault: z.array(z.record(z.string(), z.unknown())),
    tools: z.array(z.record(z.string(), z.unknown())),
    skills: z.array(z.record(z.string(), z.unknown())),
  }),
  proposals: z.array(z.string()),
});

// ── Register function ──────────────────────────────────────────────────────

export function registerCapabilitiesRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/capabilities/apply",
    tags: ["Capabilities"],
    summary: "Apply a capability template",
    description:
      "Instantiates a set of {vault secrets · tools · skills} from a config " +
      "descriptor (inline `definition` or a seed `templateKey`) + `params`. " +
      "`{{param}}` placeholders are interpolated; each tool/skill is created " +
      "through the governed routers (proposal-gated — proposal ids are surfaced " +
      "in `proposals`). Requires hub-protocol.write scope.",
    request: { body: ApplyCapabilityRequestSchema },
    responses: {
      200: {
        description: "Applied capability (created + proposed resources)",
        schema: ApplyCapabilityResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Template not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/capabilities/apply", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const parsed = ApplyCapabilityRequestSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const body = parsed.data;

    try {
      // Trusted acting identity + workspace (closes the cross-tenant IDOR).
      const acting = await resolveActingContext(c, {
        workspaceId: body.workspaceId,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      // Resolve the definition: inline body wins, else load the seed template.
      let definition;
      try {
        definition =
          body.definition ?? loadCapabilityTemplate(body.templateKey!);
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
        body.workspaceId ?? null
      );

      const result = await createCapabilityFromDefinition(
        definition,
        body.params ?? {},
        ctx
      );
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err }, "capabilities apply failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
