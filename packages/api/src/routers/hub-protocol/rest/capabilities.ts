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
import {
  ABSTRACT_VERBS,
  isAbstractVerb,
  type AbstractVerb,
} from "@synap/database/schema";
import { scoreTextMatch } from "../../../services/capabilities/capability-registry.js";
import { foldVerbsByIntent } from "../../../services/capabilities/capability-intent-index.js";
import { reconcileCapabilitiesToTemplates } from "../../../services/capabilities/reconcile-capabilities-to-templates.js";
import {
  reconcileStandaloneConfigsToTemplates,
  detachStandaloneConfigSource,
} from "../../../services/capabilities/reconcile-standalone-configs-to-templates.js";
import { capabilitiesRouter } from "../../capabilities.js";
import { playbooksRouter } from "../../playbooks.js";
import { getConfinedWorkspace } from "../confine-workspace.js";
import { createHubProtocolCallerContext } from "../utils.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  getUserAccessibleWorkspaceIds,
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";
import { playbookStagesSchema } from "../../../schemas/playbook-stage.js";

// ── Local OpenAPI schemas ────────────────────────────────────────────────────

export const ParamSpecSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  // Superset of @synap/playbooks' `PlaybookParamType` by exactly one member:
  // "password". It is an INPUT-RENDERING hint (mask the prompt) — nothing in the
  // applier reads `type` — and `proton.capability.json` ships three params
  // declaring it. Rejecting a whole capability install because a param is
  // labelled as a secret is disproportionate to what the field does.
  // FOLLOW-UP (outside this door): reconcile "password" into `PlaybookParamType`
  // so the TS union and this schema stop being a superset/subset pair.
  type: z
    .enum(["text", "number", "entity", "choice", "boolean", "password"])
    .optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

export const VaultDefSchema = z.object({
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

export const ToolDefSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["builtin", "api", "mcp", "provider", "external", "script"]),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  credentialRef: z.string().optional(),
  executor: z.enum(["is-agent", "external-agent", "hybrid"]).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  // Descriptive behavioral config stored in tool.metadata (the applier passes
  // t.metadata — omitting it here silently dropped inline-apply tool metadata).
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SkillDefSchema = z.object({
  name: z.string().min(1),
  // Mirrors @synap/playbooks CapabilitySkillDef: instruction (prompt) · code (JS
  // in the IS isolate) · declarative (in-process provider-verb spec).
  kind: z.enum(["instruction", "code", "declarative", "builtin"]).optional(),
  scope: z.enum(["pod", "user", "workspace"]).optional(),
  agentTypes: z.array(z.string()).optional(),
  description: z.string().optional(),
  // Optional: a `declarative` skill carries `providerSpec` instead of code, and
  // an `instruction` skill may carry only documentation.
  code: z.string().min(1).optional(),
  /** Declarative provider-verb spec (kind="declarative"). */
  providerSpec: z.record(z.string(), z.unknown()).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  category: z.string().optional(),
  /**
   * ROUTING intent — what this verb MEANS, independent of its vendor. Validated
   * HERE, at the door, not only in the applier: `resolveVerbIntent` throws on an
   * unknown value, and that throw lands in this route's generic catch as a
   * **500**. A caller's bad input reported as a server fault is wrong twice —
   * it misattributes the failure, and 5xx is retryable, so an agent re-sends the
   * same invalid value instead of fixing it (this repo has already watched a
   * retry loop replay a schema error four times). Zod rejects it as a 400 with
   * the valid set named.
   */
  intent: z.enum(ABSTRACT_VERBS).optional(),
  executionMode: z.enum(["sync", "async"]).optional(),
  timeoutSeconds: z.number().min(1).max(300).optional(),
  requires: z.array(z.string()).optional(),
});

// A PLAYBOOK template the definition seeds — mirrors the `playbooks.create`
// tRPC input shape (createInputSchema in routers/playbooks.ts). String fields
// support `{{param}}` interpolation like the rest of the definition.
export const PlaybookDefSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().optional(),
  goalTemplate: z.string().min(1).max(5000),
  params: z.array(z.record(z.string(), z.unknown())).optional(),
  inputStrategy: z.record(z.string(), z.unknown()).optional(),
  channelSpec: z.record(z.string(), z.unknown()).optional(),
  expectedOutputs: z.array(z.record(z.string(), z.unknown())).optional(),
  // PlaybookStage[] — the ONE runtime schema (@synap/playbooks): `category` is
  // REQUIRED and stage keys must be unique. No longer a loose bag.
  stages: playbookStagesSchema.optional(),
  // { profileSlug, filter? } — Wave 0 subject spine: which entity type the playbook operates over.
  subjectProfile: z.record(z.string(), z.unknown()).optional(),
  // Kind + Facets: { facetSlug, filter? } — the facet twin of subjectProfile
  // (which role the playbook operates over). Type-level / forward-compat only:
  // validated at the definition boundary, not yet persisted (no column).
  subjectFacet: z.record(z.string(), z.unknown()).optional(),
  schedule: z.unknown().optional(),
  executor: z.enum(["is-agent", "external-agent", "hybrid"]).optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
});

export const McpServerDefSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(128),
  description: z.string().optional(),
  transport: z.enum(["http", "stdio"]),
  // A capability definition is a TEMPLATE: the applier interpolates `{{param}}`
  // in every string field AFTER this validation runs. `.url()` alone therefore
  // rejected the pre-interpolation text — `datagouv.capability.json` declares
  // `url: "{{mcpUrl}}"` and could not install. Accept either a real URL or a
  // string carrying a placeholder; anything else is still rejected here.
  url: z
    .string()
    .min(1)
    .refine((v) => v.includes("{{") || URL.canParse(v), {
      message: "Must be a valid URL or contain a {{param}} placeholder",
    })
    .optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  /** Trusted package install may approve the official public MCP endpoint. */
  approved: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CapabilityDefinitionSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  params: z.array(ParamSpecSchema).optional(),
  vault: z.array(VaultDefSchema).optional(),
  // OPTIONAL, defaulting to []. A capability is legitimately tools-only (a
  // Discord/Telegram bot: one transport tool, zero skills) or skills-only (an
  // `agency-skills`-style prompt pack: zero tools). Of the 25 shipped CP
  // capability templates, 8 carry `tools: []` and 8 carry `skills: []` — the
  // empty array is the norm, so REQUIRING the key was pure ceremony that made
  // an otherwise-valid definition un-appliable (the live 400 on the Discord
  // bridge's inline definition, which omits `skills` entirely).
  // `.default([])` also NORMALIZES: the applier iterates `def.tools` /
  // `def.skills` unguarded, so parsing here is what keeps that safe.
  tools: z.array(ToolDefSchema).optional().default([]),
  skills: z.array(SkillDefSchema).optional().default([]),
  // Optional: MCP servers registered so agents get live tools + mcp:// resolves.
  mcpServers: z.array(McpServerDefSchema).optional(),
  // Optional: session-template playbooks seeded alongside {vault · tools · skills}.
  playbooks: z.array(PlaybookDefSchema).optional(),
  // Optional: WHEN→THEN automations seeded alongside the capability (e.g. a
  // cron source-ingest). Loosely shaped; validated by automations.create.
  automations: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        triggerType: z.enum(["event", "cron", "webhook", "manual"]),
        triggerConfig: z.record(z.string(), z.unknown()).optional(),
        flowDefinition: z.object({
          nodes: z.array(z.record(z.string(), z.unknown())),
          edges: z.array(z.record(z.string(), z.unknown())),
        }),
        status: z.enum(["draft", "active", "paused", "error"]).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .optional(),
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
    mcpServers: z.array(z.record(z.string(), z.unknown())).optional(),
    tools: z.array(z.record(z.string(), z.unknown())),
    skills: z.array(z.record(z.string(), z.unknown())),
    playbooks: z.array(z.record(z.string(), z.unknown())),
    // `createCapabilityFromDefinition` returns an `automations` array too — keep
    // this doc schema in lockstep with the actual `CreateCapabilityResult.created`.
    automations: z.array(z.record(z.string(), z.unknown())),
  }),
  proposals: z.array(z.string()),
});

const CapabilitiesListResponseSchema = z.object({
  capabilities: z.array(z.record(z.string(), z.unknown())),
});

const CapabilityContainersListResponseSchema = z.object({
  capabilities: z.array(z.record(z.string(), z.unknown())),
});

const ReconcileCapabilitiesRequestSchema = z.object({
  dryRun: z.boolean().optional(),
});

const CapabilityReconcileEntrySchema = z.object({
  containerId: z.string(),
  name: z.string(),
  templateKey: z.string().optional(),
  reason: z.string(),
});

const ReconcileCapabilitiesResponseSchema = z.object({
  checked: z.number(),
  dryRun: z.boolean(),
  applied: z.array(CapabilityReconcileEntrySchema),
  skipped: z.array(CapabilityReconcileEntrySchema),
  updatesAvailable: z.array(CapabilityReconcileEntrySchema),
  conflicts: z.array(CapabilityReconcileEntrySchema),
});

const StandaloneKindSchema = z.enum(["view", "skill", "automation"]);

const ReconcileConfigsRequestSchema = z.object({
  dryRun: z.boolean().optional(),
});

const StandaloneReconcileEntrySchema = z.object({
  kind: StandaloneKindSchema,
  id: z.string(),
  name: z.string(),
  packageSlug: z.string().optional(),
  reason: z.string(),
});

const ReconcileConfigsResponseSchema = z.object({
  checked: z.number(),
  dryRun: z.boolean(),
  updated: z.array(StandaloneReconcileEntrySchema),
  ownerOwnedSkipped: z.array(StandaloneReconcileEntrySchema),
  skipped: z.array(StandaloneReconcileEntrySchema),
  conflicts: z.array(StandaloneReconcileEntrySchema),
});

const DetachConfigRequestSchema = z.object({
  kind: StandaloneKindSchema,
  id: z.string().uuid(),
});

const DetachConfigResponseSchema = z.object({
  detached: z.boolean(),
  kind: StandaloneKindSchema,
  id: z.string(),
  outcome: z.enum(["updated", "proposed"]).optional(),
  reason: z.string().optional(),
});

// ── Register function ──────────────────────────────────────────────────────

/**
 * Container ids holding at least one member brick that declares `intent`.
 *
 * `intent` is a property of a VERB, and the container list door returns
 * `capabilities` rows plus member COUNTS — no verbs. So the match cannot be
 * folded out of the containers themselves; it is resolved against the capability
 * REGISTRY (the one place verbs and their intents live, and the same
 * `foldVerbsByIntent` the `/capabilities` door and `synap_list_capabilities`
 * use) and mapped back through each brick's DERIVED `containerId`.
 *
 * Same lens shape as every other pod-wide read here: a workspace narrows to that
 * lens, its absence fans out over every accessible workspace and merges deduped
 * by capability id — one fold AFTER the merge, because `foldVerbsByIntent`
 * prefers a GRANTED duplicate and folding per-workspace could keep an un-granted
 * copy and drop the granted one.
 *
 * A brick with `containerId == null` (in no container) contributes nothing: it
 * is reachable through `GET /capabilities`, which has its own intent filter, and
 * inventing a container for it would be a placeholder, not an answer.
 */
async function containerIdsDeclaringIntent(
  userId: string,
  scopes: string[],
  workspaceId: string | null,
  intent: AbstractVerb
): Promise<Set<string>> {
  const wsIds = workspaceId
    ? [workspaceId]
    : await getUserAccessibleWorkspaceIds(userId);
  const settled = await Promise.allSettled(
    wsIds.map(async (wsId) => {
      const ctx = await createHubProtocolCallerContext(userId, scopes, wsId);
      return playbooksRouter
        .createCaller(ctx as never)
        .capabilityRegistry.list();
    })
  );
  const seen = new Set<string>();
  const caps = settled
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .filter((cap) => {
      if (seen.has(cap.id)) return false;
      seen.add(cap.id);
      return true;
    });
  const containerOf = new Map<string, string | null>(
    caps.map((cap) => [
      cap.id,
      (cap as { containerId?: string | null }).containerId ?? null,
    ])
  );
  const out = new Set<string>();
  // NO CAST. `caps` is already RegistryCapability[] here, and the cast this
  // replaces is exactly what hid the containers-door defect: `as never` was
  // added because a container row is NOT a RegistryCapability, which erased the
  // one signal that would have said so. Typechecked without it — if a future
  // change makes this argument the wrong shape, tsc must say so.
  for (const match of foldVerbsByIntent(caps).get(intent) ?? []) {
    const containerId = containerOf.get(match.capabilityId);
    if (containerId) out.add(containerId);
  }
  return out;
}

export function registerCapabilitiesRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/capabilities",
    tags: ["Capabilities"],
    summary: "List the capability read-model (verb × grant × approval matrix)",
    description:
      "Returns the unified `Capability[]` read-model for a workspace (pod-wide + " +
      "the given workspace): tools + skills + commands, each with `verbs` " +
      "(label/kind/granted/effectiveExecMode/govDefault), `governance`, and the " +
      "tool's `approved` state. Reuses the same `listCapabilities` adapter the " +
      "tRPC `playbooks.capabilityRegistry.list` exposes. Requires " +
      "hub-protocol.read scope. Pass `workspaceId` to scope to one workspace; " +
      "OMIT it for the pod-wide read (all accessible workspaces + globals, deduped). " +
      "Pass `intent` (a closed ABSTRACT_VERBS value) to keep only the capabilities " +
      "declaring at least one verb with that vendor-independent routing intent — " +
      "applied AFTER the pod-wide merge, so a capability visible through two " +
      "workspaces is judged once. A verb declaring no intent never matches.",
    request: {
      query: z.object({
        workspaceId: z.string().uuid().optional(),
        intent: z.enum(ABSTRACT_VERBS).optional(),
      }),
    },
    responses: {
      200: {
        description: "Capability read-model",
        schema: CapabilitiesListResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── GET /capabilities ──────────────────────────────────────────────────────
  // Door over the tRPC `playbooks.capabilityRegistry.list` (a workspaceProcedure).
  // workspaceId is OPTIONAL: provided → scope to that workspace; omitted → fan out
  // across the caller's accessible workspaces + pod-wide globals and merge (deduped).
  app.get("/capabilities", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const workspaceId = c.req.query("workspaceId");
    // workspaceId is OPTIONAL now: present → validate + scope to it; absent →
    // pod-wide read. Only reject a malformed (non-UUID) value that was supplied.
    if (
      workspaceId !== undefined &&
      !z.string().uuid().safeParse(workspaceId).success
    ) {
      return c.json({ error: "workspaceId query param must be a UUID" }, 400);
    }

    const intentRaw = c.req.query("intent")?.trim() || undefined;
    // Rejected at the door, never ignored: silently dropping an unknown filter
    // returns the WHOLE catalog under a question it did not answer.
    if (intentRaw !== undefined && !isAbstractVerb(intentRaw)) {
      return c.json(
        {
          error: `Unknown intent "${intentRaw}". The vocabulary is closed: ${ABSTRACT_VERBS.join(", ")}`,
        },
        400
      );
    }

    /**
     * Keep the capabilities declaring `intentRaw`, via the SHARED reverse index
     * — the same fold `synap_list_capabilities({intent})` uses, so the two doors
     * can never disagree about what "declares send_message" means.
     *
     * Deliberately applied to the MERGED, deduped list (and to the single-lens
     * list) rather than inside the fan-out: `foldVerbsByIntent` prefers a GRANTED
     * duplicate, so folding per-workspace and then merging could keep an
     * un-granted copy and drop the granted one. One fold, after the merge.
     */
    const applyIntentFilter = <T extends { id: string }>(caps: T[]): T[] => {
      if (intentRaw === undefined) return caps;
      const matchedCapIds = new Set(
        (foldVerbsByIntent(caps as never).get(intentRaw) ?? []).map(
          (m) => m.capabilityId
        )
      );
      return caps.filter((cap) => matchedCapIds.has(cap.id));
    };

    try {
      const acting = await resolveActingContext(c, { workspaceId });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const scopes = c.get("scopes") as string[];

      // POD-WIDE (no workspace lens): the registry read is workspace-scoped
      // (pod-wide globals + the one workspace), so fan out across every workspace
      // the caller can access and merge, deduped by capability id. Mirrors the
      // GET /entities `scope=all` merge.
      if (!acting.workspaceId) {
        const wsIds = await getUserAccessibleWorkspaceIds(acting.userId);
        const settled = await Promise.allSettled(
          wsIds.map(async (wsId) => {
            const ctx = await createHubProtocolCallerContext(
              acting.userId,
              scopes,
              wsId
            );
            return playbooksRouter
              .createCaller(ctx as never)
              .capabilityRegistry.list();
          })
        );
        const seen = new Set<string>();
        const capabilities = settled
          .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
          .filter((cap) => {
            if (seen.has(cap.id)) return false;
            seen.add(cap.id);
            return true;
          });
        return c.json({ capabilities: applyIntentFilter(capabilities) }, 200);
      }

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        scopes,
        acting.workspaceId
      );
      const caller = playbooksRouter.createCaller(ctx as never);
      const capabilities = await caller.capabilityRegistry.list();
      return c.json({ capabilities: applyIntentFilter(capabilities) }, 200);
    } catch (err) {
      logger.error({ err }, "capabilities list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  registerOpenApi(app, {
    method: "get",
    path: "/capabilities/containers",
    tags: ["Capabilities"],
    summary:
      "List capability CONTAINERS (named bundles) the agent can discover",
    description:
      "Returns the capability containers visible in a workspace (pod-wide + the " +
      "given workspace). Each container is a named bundle of parts — Connections " +
      "(tools), Skills, and Built-ins — grouped via the `links` table as " +
      "`tool|skill --member_of--> capability`. Each returned container includes " +
      "its `parts` (connections/builtins/skills with names + kinds) so the agent " +
      "knows what each bundle contains. Thin door over the tRPC " +
      "`capabilities.containers.list` + `.get` callers. Pass `query` to SEARCH " +
      "(ranked match over container name/description + member names) instead of " +
      "the full dump; `limit` caps the result count (default 20 with a query). " +
      "No `kind` filter here — a container is a bundle, not a single-kind verb " +
      "(use the plain `/capabilities` list's `kind` filter for that axis). " +
      "Requires hub-protocol.read scope. Pass `workspaceId` to scope to one " +
      "workspace; OMIT it for the pod-wide read (all accessible workspaces + " +
      "globals, deduped). Pass `intent` (a closed ABSTRACT_VERBS value) to keep " +
      "only the containers holding at least one MEMBER brick that declares that " +
      "vendor-independent routing intent — the intent lives on the verb, so the " +
      "match is resolved against the capability REGISTRY and mapped back through " +
      "each brick's `containerId`. A container whose members declare no intent " +
      "never matches.",
    request: {
      query: z.object({
        workspaceId: z.string().uuid().optional(),
        query: z.string().optional(),
        intent: z.enum(ABSTRACT_VERBS).optional(),
        limit: z.coerce.number().int().positive().optional(),
      }),
    },
    responses: {
      200: {
        description: "Capability containers with their member parts",
        schema: CapabilityContainersListResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── GET /capabilities/containers ───────────────────────────────────────────
  // Thin door over the tRPC `capabilities.containers.list` + per-container `.get`
  // (both queries on a protectedProcedure). Static route — declared BEFORE any
  // dynamic `/capabilities/:id` (none today) per the Hono ordering rule.
  app.get("/capabilities/containers", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const workspaceId = c.req.query("workspaceId");
    // workspaceId is OPTIONAL: present → validate + scope to it; absent →
    // pod-wide read. Only reject a malformed (non-UUID) value that was supplied.
    if (
      workspaceId !== undefined &&
      !z.string().uuid().safeParse(workspaceId).success
    ) {
      return c.json({ error: "workspaceId query param must be a UUID" }, 400);
    }

    const intentRaw = c.req.query("intent")?.trim() || undefined;
    // Rejected at the door, never ignored: silently dropping an unknown filter
    // returns the WHOLE catalog under a question it did not answer.
    if (intentRaw !== undefined && !isAbstractVerb(intentRaw)) {
      return c.json(
        {
          error: `Unknown intent "${intentRaw}". The vocabulary is closed: ${ABSTRACT_VERBS.join(", ")}`,
        },
        400
      );
    }

    const query = c.req.query("query")?.trim() || undefined;
    const limitCheck = z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .safeParse(c.req.query("limit"));
    const limit = limitCheck.success ? limitCheck.data : undefined;

    try {
      const acting = await resolveActingContext(c, { workspaceId });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const scopes = c.get("scopes") as string[];

      // Enrich a workspace's containers with their member parts (names + kinds)
      // so the agent sees what each bundle holds, not just counts.
      const enrichForWs = async (wsId: string) => {
        const ctx = await createHubProtocolCallerContext(
          acting.userId,
          scopes,
          wsId
        );
        const caller = capabilitiesRouter.createCaller(ctx as never);
        const containers = await caller.containers.list({ workspaceId: wsId });
        return Promise.all(
          containers.map(async (container) => {
            const detail = await caller.containers.get({ id: container.id });
            return { ...container, members: detail.parts };
          })
        );
      };

      // POD-WIDE (no workspace lens): the container read is workspace-scoped, so
      // fan out across every accessible workspace and merge, deduped by container
      // id. Mirrors the GET /entities `scope=all` merge. A provided workspaceId
      // scopes to just that workspace (unchanged).
      let enriched: Awaited<ReturnType<typeof enrichForWs>>;
      if (!acting.workspaceId) {
        const wsIds = await getUserAccessibleWorkspaceIds(acting.userId);
        // One caller per workspace (a cheap ctx object), reused for the list AND
        // the detail fetch.
        const callerForWs = new Map<
          string,
          ReturnType<typeof capabilitiesRouter.createCaller>
        >();
        const getCaller = async (wsId: string) => {
          let caller = callerForWs.get(wsId);
          if (!caller) {
            const ctx = await createHubProtocolCallerContext(
              acting.userId,
              scopes,
              wsId
            );
            caller = capabilitiesRouter.createCaller(ctx as never);
            callerForWs.set(wsId, caller);
          }
          return caller;
        };

        // LIST across every accessible workspace, then dedup container ids
        // BEFORE the per-container `.get()` enrichment. A pod-wide global
        // container appears in EVERY workspace lens, so enriching per
        // (workspace, container) was an O(W×C) N+1 that fetched the same detail
        // repeatedly and deduped AFTER. Dedup first — keeping the first-seen
        // workspace so the surviving object and its detail-caller match the
        // prior dedup-after result — then fetch each unique container's detail
        // exactly once. `containers.get` scopes by userVisibleWhere(userId), so
        // the detail is identical regardless of which workspace's caller runs it.
        const listed = await Promise.allSettled(
          wsIds.map(async (wsId) => {
            const caller = await getCaller(wsId);
            const containers = await caller.containers.list({
              workspaceId: wsId,
            });
            return containers.map((container) => ({ container, wsId }));
          })
        );
        const seen = new Set<string>();
        const uniqueContainers = listed
          .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
          .filter(({ container }) => {
            if (seen.has(container.id)) return false;
            seen.add(container.id);
            return true;
          });
        const settled = await Promise.allSettled(
          uniqueContainers.map(async ({ container, wsId }) => {
            const caller = await getCaller(wsId);
            const detail = await caller.containers.get({ id: container.id });
            return { ...container, members: detail.parts };
          })
        );
        enriched = settled.flatMap((r) =>
          r.status === "fulfilled" ? [r.value] : []
        );
      } else {
        enriched = await enrichForWs(acting.workspaceId);
      }

      // INTENT filter — applied here, after BOTH branches have produced the
      // merged/deduped list, and BEFORE `query`/`limit` so the intent narrows
      // the corpus the text matcher then ranks rather than the other way round.
      //
      // NOT the same fold as `GET /capabilities`. `intent` lives on a VERB
      // (`RegistryCapability.verbs[].intent`) and a container row carries no
      // verbs at all — it is a `capabilities` row plus member COUNTS. Folding
      // the containers themselves therefore matched nothing, ever, and returned
      // an empty list for every intent while typechecking clean behind the
      // `as never` the fold's argument needed. Resolve against the registry and
      // map back through each brick's `containerId` instead.
      if (intentRaw !== undefined) {
        const matched = await containerIdsDeclaringIntent(
          acting.userId,
          scopes,
          acting.workspaceId,
          intentRaw
        );
        enriched = enriched.filter((container) => matched.has(container.id));
      }

      // Search (D1): rank containers against `query` using the SAME matcher the
      // registry's `list_capabilities(query)` uses — no second implementation.
      // Matches the container name (primary), member names (secondary), and
      // description (tertiary).
      let result = enriched;
      if (query) {
        result = result
          .map((container) => {
            const memberNames = [
              ...container.members.connections,
              ...container.members.builtins,
              ...container.members.skills,
            ].map((p) => p.name);
            const score = scoreTextMatch(query, {
              primary: container.name,
              secondary: memberNames,
              tertiary: container.description,
            });
            return { container, score };
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((s) => s.container)
          .slice(0, limit ?? 20);
      } else if (limit !== undefined) {
        result = result.slice(0, limit);
      }

      return c.json({ capabilities: result }, 200);
    } catch (err) {
      logger.error({ err }, "capabilities containers list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

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
      // SERVICE-KEY CONFINEMENT (Item 3): positive-pin a bound service key to its
      // workspace BEFORE the value reaches the acting-context resolve, the template
      // load, or the caller ctx (a mismatching body → 403). The door ctx-clamp does
      // NOT reach here — createCapabilityFromDefinition runs on a DIRECT
      // createHubProtocolCallerContext (not getCaller), and the inner resources read
      // the value we hand in.
      const workspaceId = getConfinedWorkspace(c, body.workspaceId);

      // Trusted acting identity + workspace (closes the cross-tenant IDOR).
      const acting = await resolveActingContext(c, {
        workspaceId: workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      // Resolve the definition: inline body wins, else load the seed template.
      let definition;
      try {
        definition =
          body.definition ??
          (await loadCapabilityTemplate(body.templateKey!, {
            workspaceId: workspaceId ?? null,
          }));
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
        workspaceId ?? null
      );

      // NORMALIZE the two collection fields the applier iterates unguarded
      // (`for (const t of def.tools)` / `for (const s of def.skills)` in
      // create-from-definition.ts). The INLINE path already gets `[]` from the
      // schema's `.default([])`; the templateKey path never touches that schema
      // (parsing a CP definition through it would STRIP contentHash/emits/
      // updatePolicy/metadata), so a tools-only CP template — e.g. `discord-bot`,
      // which ships no `skills` key at all — would otherwise TypeError into a 500.
      // Spread-then-override: every other CP-injected field survives untouched.
      const normalized = {
        ...(definition as Record<string, unknown>),
        tools: Array.isArray((definition as { tools?: unknown }).tools)
          ? (definition as { tools: unknown[] }).tools
          : [],
        skills: Array.isArray((definition as { skills?: unknown }).skills)
          ? (definition as { skills: unknown[] }).skills
          : [],
      };

      const result = await createCapabilityFromDefinition(
        // Inline defs are structurally validated by CapabilityDefinitionSchema;
        // `providerSpec` is passed through as opaque JSON (the applier re-casts it
        // to Record), so a boundary cast to the applier's input type is safe.
        normalized as unknown as Parameters<
          typeof createCapabilityFromDefinition
        >[0],
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
      logger.error({ err }, "capabilities apply failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /capabilities/reconcile ───────────────────────────────────────────
  // On-demand trigger for the capability→template reconcile (the same pass the
  // boot hook runs). Runs in-process and returns the report synchronously —
  // both a manual "converge now" and the door to push an already-fixed CP
  // template (e.g. the `nango-google` `calendar_list` fix) onto a running pod
  // without waiting for the next restart.
  registerOpenApi(app, {
    method: "post",
    path: "/capabilities/reconcile",
    tags: ["Capabilities"],
    summary:
      "Reconcile installed capabilities to their Control-Plane templates",
    description:
      "Re-projects drifted capability-template skills (providerSpec/parameters/" +
      "code/description) onto their installed containers through the governed " +
      "`createCapabilityFromDefinition` applier — add-only, never touches a " +
      "skill the template doesn't declare. `dryRun:true` computes the report " +
      "without writing. Requires hub-protocol.write scope.",
    request: { body: ReconcileCapabilitiesRequestSchema },
    responses: {
      200: {
        description: "Reconcile report",
        schema: ReconcileCapabilitiesResponseSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/capabilities/reconcile", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const parsed = ReconcileCapabilitiesRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    // A non-dryRun reconcile fans out ADD-ONLY re-projection writes across every
    // installed capability pod-wide (each attributed to its own owner). That is an
    // operator/admin convergence action, NOT an agent action — an agent credential
    // must never trigger a pod-wide re-projection (same stance as rejectAgentReviewer).
    // A dryRun is read-only (no writes), so it's allowed for anyone with the scope.
    const agentUserId = c.get("agentUserId");
    if (agentUserId && !parsed.data.dryRun) {
      logger.warn(
        { agentUserId },
        "agent credential attempted a pod-wide capability reconcile — blocked (operator action)"
      );
      return c.json(
        {
          error:
            "An agent credential cannot trigger a pod-wide capability reconcile. Run it from a human/operator session, or pass { dryRun: true } to preview.",
        },
        403
      );
    }
    // Resolve a trusted acting identity (not just a bearer scope) — closes the
    // "any write-scoped key" gap; boot-time reconcile is unaffected (it never
    // hits this route).
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    try {
      const report = await reconcileCapabilitiesToTemplates({
        dryRun: parsed.data.dryRun,
      });
      return c.json(report, 200);
    } catch (err) {
      logger.error({ err }, "capabilities reconcile failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /configs/reconcile ────────────────────────────────────────────────
  // On-demand trigger for the STANDALONE-CONFIG reconcile (views / skills /
  // automations) — the lighter-config counterpart to POST /capabilities/reconcile
  // and the same pass the boot hook runs. Field-level 3-way merge: never
  // overwrites a user-edited field. `dryRun:true` computes the report without
  // writing. Requires hub-protocol.write scope.
  registerOpenApi(app, {
    method: "post",
    path: "/configs/reconcile",
    tags: ["Capabilities"],
    summary:
      "Reconcile standalone-installed views/skills/automations to their templates",
    description:
      "Advances each standalone-installed view/skill/automation's untouched " +
      "fields to its source marketplace template through the governed per-kind " +
      "`.update` door. A user-edited field is owner-owned — left alone and " +
      "reported. A private/unsynced package is skipped. `dryRun:true` computes " +
      "the report without writing. Requires hub-protocol.write scope.",
    request: { body: ReconcileConfigsRequestSchema },
    responses: {
      200: {
        description: "Reconcile report",
        schema: ReconcileConfigsResponseSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/configs/reconcile", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const parsed = ReconcileConfigsRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    // A non-dryRun reconcile fans out convergence writes across every installed
    // standalone config pod-wide — an operator/admin action, NOT an agent one
    // (same stance as the capability reconcile above). A dryRun is read-only and
    // allowed for anyone with the scope.
    const agentUserId = c.get("agentUserId");
    if (agentUserId && !parsed.data.dryRun) {
      logger.warn(
        { agentUserId },
        "agent credential attempted a pod-wide config reconcile — blocked (operator action)"
      );
      return c.json(
        {
          error:
            "An agent credential cannot trigger a pod-wide config reconcile. Run it from a human/operator session, or pass { dryRun: true } to preview.",
        },
        403
      );
    }
    // Resolve a trusted acting identity (not just a bearer scope).
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    try {
      const report = await reconcileStandaloneConfigsToTemplates({
        dryRun: parsed.data.dryRun,
      });
      return c.json(report, 200);
    } catch (err) {
      logger.error({ err }, "configs reconcile failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /configs/detach ───────────────────────────────────────────────────
  // Sever a standalone config's marketplace source-link so it stops reconciling.
  // Persists through the governed per-kind `.update` door (attributed to the
  // acting user). Requires hub-protocol.write scope.
  registerOpenApi(app, {
    method: "post",
    path: "/configs/detach",
    tags: ["Capabilities"],
    summary: "Detach a view/skill/automation from its marketplace template",
    description:
      "Clears the `marketSource` source-link on a standalone-installed " +
      "view/skill/automation so a future template change no longer reconciles " +
      "onto it. Persisted through the governed per-kind `.update` door. Requires " +
      "hub-protocol.write scope.",
    request: { body: DetachConfigRequestSchema },
    responses: {
      200: { description: "Detach result", schema: DetachConfigResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/configs/detach", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const parsed = DetachConfigRequestSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    // Detach is a mutating config-lifecycle action — an operator one, NOT an agent
    // one (same stance as /configs/reconcile above). Block a bare agent credential
    // so the write can't skip the AI-governance ladder by being attributed to the
    // acting human at the downstream .update door.
    const agentUserId = c.get("agentUserId");
    if (agentUserId) {
      logger.warn(
        { agentUserId, ...parsed.data },
        "agent credential attempted a config detach — blocked (operator action)"
      );
      return c.json(
        {
          error:
            "An agent credential cannot detach a config from its template. Run it from a human/operator session.",
        },
        403
      );
    }

    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    try {
      const result = await detachStandaloneConfigSource({
        kind: parsed.data.kind,
        id: parsed.data.id,
        userId: acting.userId,
      });
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err }, "config detach failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── DELETE /capabilities/containers/:id ──────────────────────────────────
  // Remove a capability CONTAINER (and its member_of links). The member parts
  // (tools/skills) themselves are untouched — only the bundle grouping is dropped.
  // Used by `synap cap rm` to clean up stale/duplicate containers. Delegates to
  // the tRPC `containers.delete`, which gates write access on the loaded row's
  // workspaceId (assertWorkspaceWrite) — so a pod-wide or owned container deletes,
  // a foreign-workspace one is refused.
  registerOpenApi(app, {
    method: "delete",
    path: "/capabilities/containers/{id}",
    tags: ["Capabilities"],
    summary: "Delete a capability container by id (member parts untouched)",
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: { description: "Deleted", schema: z.object({ ok: z.boolean() }) },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.delete("/capabilities/containers/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return c.json({ error: "id path param (UUID) is required" }, 400);
    }
    try {
      const acting = await resolveActingContext(c, {
        workspaceId: c.req.query("workspaceId"),
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[],
        null
      );
      const caller = capabilitiesRouter.createCaller(ctx as never);
      const result = await caller.containers.delete({ id });
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err }, "capabilities container delete failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
