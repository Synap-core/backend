/**
 * Capabilities Router
 *
 * Discovers what features and intelligence services are available.
 * Frontend SDK calls this to dynamically adapt UI.
 *
 * Health model:
 *   - `list` returns cached lastHealthCheck from DB (fast, always available)
 *   - `checkHealth` pings a specific service and updates DB (called async by UI)
 *   - `serviceUsageStats` aggregates message counts by serviceId from messages JSONB
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";
import {
  db,
  getDb,
  intelligenceServices,
  automations,
  skills,
  eq,
  and,
  or,
  isNull,
  drizzleSql,
} from "@synap/database";
import type { FlowDefinition } from "@synap/database";
import { MessageAuthorType } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { AccessContext, scopedDb } from "../access/index.js";
import { getDefaultActiveService } from "../utils/intelligence-routing.js";
import { capabilityContainersRouter } from "./capability-containers.js";
import { buildCapabilityCatalog } from "../services/capabilities/capability-catalog.js";
import {
  createCapabilityFromDefinition,
  loadCapabilityTemplate,
} from "../services/capabilities/create-from-definition.js";
import { executeCapability } from "../services/capabilities/execute-capability.js";

const logger = createLogger({ module: "capabilities" });

/** Default (proprietary) Synap Intelligence service — always available when no custom service is configured. */
const DEFAULT_INTELLIGENCE_SERVICE = {
  id: "default",
  serviceId: "default",
  name: "Synap Intelligence",
  capabilities: [
    "chat",
    "analysis",
    "commands",
    "proposals",
    "threads",
  ] as string[],
  pricing: "free" as const,
  version: "1.0",
  webhookUrl: null as string | null,
  lastHealthCheck: null as Date | null,
};

// ─── Health check helper ──────────────────────────────────────────────────────

async function pingServiceHealth(webhookUrl: string): Promise<boolean> {
  try {
    const healthUrl = `${webhookUrl.replace(/\/+$/, "")}/health`;
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(5000),
      method: "GET",
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const capabilitiesRouter = router({
  /** Capability CONTAINERS (the named bundles) — CRUD + part attach/detach. */
  containers: capabilityContainersRouter,

  /**
   * List all available capabilities.
   *
   * Returns core features, plugins, and intelligence services with cached
   * health status (lastHealthCheck). Does NOT ping services — use checkHealth
   * for that so this query stays fast.
   */
  list: publicProcedure.query(async () => {
    logger.debug("Listing capabilities");

    const plugins: Array<{ name: string; version: string; enabled: boolean }> =
      [];

    // Include health-check columns
    const dbServices = await db.query.intelligenceServices.findMany({
      where: eq(intelligenceServices.status, "active"),
      columns: {
        id: true,
        serviceId: true,
        name: true,
        capabilities: true,
        pricing: true,
        version: true,
        webhookUrl: true,
        lastHealthCheck: true,
        lastHealthStatus: true,
      },
    });

    const hasDefault = dbServices.some((s) => s.serviceId === "default");
    const services = hasDefault
      ? dbServices
      : [DEFAULT_INTELLIGENCE_SERVICE, ...dbServices];

    return {
      core: {
        version: "1.0.0",
        features: [
          "notes",
          "tasks",
          "chat",
          "entities",
          "events",
          "files",
          "inbox",
        ],
      },
      plugins,
      intelligenceServices: services.map((s) => ({
        id: s.id,
        serviceId: s.serviceId,
        name: s.name,
        capabilities: s.capabilities,
        pricing: s.pricing || "free",
        version: s.version,
        webhookUrl: s.webhookUrl ?? null,
        lastHealthCheck: s.lastHealthCheck ?? null,
        lastHealthStatus:
          ("lastHealthStatus" in s ? s.lastHealthStatus : null) ?? null,
      })),
    };
  }),

  /**
   * Pack-grouped, status-computed capability CATALOG for a workspace.
   *
   * tRPC mirror of the Hub REST `GET /capabilities/catalog` door. Delegates to
   * the SAME `buildCapabilityCatalog` service: deriving the acting userId from
   * the authenticated ctx and the workspace from input. Returns one
   * `CapabilityCard` per pack (installed containers + available templates).
   */
  catalog: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return buildCapabilityCatalog({
        workspaceId: input.workspaceId,
        userId: ctx.userId,
      });
    }),

  /**
   * Apply a capability template — instantiate {vault · tools · skills · playbooks}
   * from an inline `definition` or a seed `templateKey`.
   *
   * tRPC mirror of the Hub REST `POST /capabilities/apply` door. Resolves the
   * definition the same way (inline body wins, else load the seed template) then
   * delegates to the GOVERNED `createCapabilityFromDefinition` service, scoping it
   * to `input.workspaceId` via the ctx.
   */
  install: protectedProcedure
    .input(
      z.object({
        templateKey: z.string().optional(),
        definition: z.any().optional(),
        workspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const definition =
        input.definition ??
        (await loadCapabilityTemplate(input.templateKey!, {
          workspaceId: input.workspaceId,
        }));

      return createCapabilityFromDefinition(
        definition,
        {},
        {
          ...ctx,
          workspaceId: input.workspaceId,
        }
      );
    }),

  /**
   * Execute a registered capability — resolve a verb (= backing skill name) and
   * run it through the SAME governance gate every capability path uses.
   *
   * tRPC mirror of the Hub REST `POST /capabilities/execute` door. Delegates to
   * the shared `executeCapability` core (acting as the authenticated operator) and
   * returns its discriminated result verbatim (run / proposed / deny / not_found).
   */
  execute: protectedProcedure
    .input(
      z.object({
        verbId: z.string(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        workspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return executeCapability({
        verbId: input.verbId,
        parameters: input.parameters,
        workspaceId: input.workspaceId,
        userId: ctx.userId,
      });
    }),

  /**
   * Dry-run a capability verb — preview the intended effects WITHOUT committing.
   *
   * Resolves the verb's backing skill exactly like `execute` (verb NAME scoped
   * pod-wide OR this workspace OR owned by the actor), then proxies to the IS
   * dry-run executor (`POST {IS}/api/skills/:id/dry-run`) — the SAME contract the
   * Hub REST `/skills/:id/dry-run` door uses (external writes stubbed, reads real).
   *
   * Provider verbs (`kind:"provider"`) are declarative in-process executors with
   * no isolate sandbox, so there is no dry-run path — we return a clear
   * "not available" result rather than executing them.
   */
  dryRun: protectedProcedure
    .input(
      z.object({
        verbId: z.string(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        workspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [skillRow] = await db
        .select({ id: skills.id, kind: skills.kind })
        .from(skills)
        .where(
          and(
            eq(skills.name, input.verbId),
            or(
              isNull(skills.workspaceId),
              eq(skills.workspaceId, input.workspaceId),
              eq(skills.userId, ctx.userId)
            )
          )
        )
        .limit(1);

      if (!skillRow) {
        return {
          kind: "not_found" as const,
          message: `Verb "${input.verbId}" not found in this workspace.`,
        };
      }

      // Declarative provider verbs run in-process — no isolate dry-run sandbox.
      if (skillRow.kind === "provider") {
        return {
          kind: "dry-run-unavailable" as const,
          skillId: skillRow.id,
          message: "Dry-run not available for provider verbs.",
        };
      }

      const { endpoint: isUrl, apiKey: isApiKey } =
        await getDefaultActiveService();
      const res = await fetch(`${isUrl}/api/skills/${skillRow.id}/dry-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": isApiKey,
        },
        body: JSON.stringify({
          userId: ctx.userId,
          parameters: input.parameters ?? {},
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Skill dry-run failed (${res.status}) ${body}`.trim(),
        });
      }

      const data = (await res.json().catch(() => null)) as {
        result?: unknown;
        dryRunEffects?: unknown[];
      } | null;

      return {
        kind: "dry-run" as const,
        skillId: skillRow.id,
        result: data?.result ?? null,
        dryRunEffects: data?.dryRunEffects ?? [],
      };
    }),

  /**
   * "Use in an automation" — scaffold a DRAFT automation from a single capability
   * verb. Builds a minimal FlowDefinition (trigger → ONE capability node) and
   * inserts it via the SAME path `automations.create` uses for an operator-direct
   * write: operator identity (no agentUserId), RBAC-gated, never proposed.
   */
  createFromVerbCapability: protectedProcedure
    .input(
      z.object({
        verbId: z.string(),
        capabilityId: z.string().optional(),
        capabilityName: z.string(),
        verbLabel: z.string(),
        verbKind: z.enum(["read", "write", "action"]).optional(),
        workspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();

      // Operator direct write — enforce workspace RBAC (deny if not permitted),
      // but never propose. Mirrors the operator branch of automations.create.
      const { verifyPermission } = await import("@synap/database");
      const { requiredPermissionFor } = await import("@synap/governance-policy");
      const result = await verifyPermission({
        db: database,
        userId: ctx.userId!,
        workspace: { id: input.workspaceId },
        requiredPermission: requiredPermissionFor("create"),
      });
      if (!result.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: result.reason || "Permission denied",
        });
      }

      const flowDefinition = {
        nodes: [
          { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
          {
            id: "step-1",
            type: "capability",
            position: { x: 0, y: 140 },
            data: {
              capabilityId: input.capabilityId,
              capabilityName: input.capabilityName,
              verbId: input.verbId,
              verbLabel: input.verbLabel,
              verbKind: input.verbKind,
              inputMapping: {},
              label: `${input.capabilityName} · ${input.verbLabel}`,
            },
          },
        ],
        edges: [{ id: "e1", source: "trigger", target: "step-1" }],
      } as unknown as FlowDefinition;

      const [row] = await database
        .insert(automations)
        .values({
          workspaceId: input.workspaceId,
          createdBy: ctx.userId!,
          name: `New automation: ${input.verbLabel}`,
          triggerType: "manual",
          triggerConfig: {},
          flowDefinition,
          status: "draft",
          metadata: { createdVia: "manual" as const },
        })
        .returning({ id: automations.id });

      return { automationId: row.id };
    }),

  /**
   * "Used in processes" — backlinks from a capability verb to the automations
   * that reference it. Matches any automation whose flow_definition has a
   * `type:"capability"` node with `data.verbId == verbId`, via a JSONB
   * containment query on the nodes array. Membership-scoped via the access layer
   * (mirrors automations.list) so a foreign workspaceId leaks nothing.
   */
  usedInProcesses: protectedProcedure
    .input(
      z.object({
        verbId: z.string(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const database = await getDb();
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(
        automations
      );

      const containment = drizzleSql`${automations.flowDefinition} -> 'nodes' @> ${JSON.stringify(
        [{ type: "capability", data: { verbId: input.verbId } }]
      )}::jsonb`;

      const rows = await database
        .select({
          automationId: automations.id,
          name: automations.name,
          status: automations.status,
        })
        .from(automations)
        .where(
          and(
            visibility,
            input.workspaceId
              ? eq(automations.workspaceId, input.workspaceId)
              : undefined,
            containment
          )
        )
        .orderBy(automations.name);

      return rows.map((r) => ({
        automationId: r.automationId,
        name: r.name,
        status: r.status,
      }));
    }),

  /**
   * Ping a specific intelligence service's /health endpoint.
   * Updates lastHealthCheck in DB and returns the health result.
   * Call this asynchronously from the UI — do NOT await on first paint.
   */
  checkHealth: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .mutation(async ({ input }) => {
      // Built-in default service: cannot be pinged (same process)
      if (input.serviceId === "default") {
        return { serviceId: "default", isHealthy: true, checkedAt: new Date() };
      }

      const svc = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.serviceId, input.serviceId),
        columns: { id: true, webhookUrl: true },
      });

      if (!svc) {
        return {
          serviceId: input.serviceId,
          isHealthy: false,
          checkedAt: new Date(),
        };
      }

      const isHealthy = await pingServiceHealth(svc.webhookUrl);
      const checkedAt = new Date();

      await db
        .update(intelligenceServices)
        .set({
          lastHealthCheck: checkedAt,
          lastHealthStatus: isHealthy ? "healthy" : "unhealthy",
          updatedAt: checkedAt,
        })
        .where(eq(intelligenceServices.id, svc.id));

      logger.debug(
        { serviceId: input.serviceId, isHealthy },
        "Health check complete"
      );
      return { serviceId: input.serviceId, isHealthy, checkedAt };
    }),

  /**
   * Usage statistics per intelligence service.
   * Aggregates message counts + token usage from the messages table JSONB.
   *
   * Returns per-service stats for the given period (default: last 30 days).
   */
  serviceUsageStats: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        days: z.number().min(1).max(365).default(30),
      })
    )
    .query(async ({ input }) => {
      const since = new Date();
      since.setDate(since.getDate() - input.days);

      // Query: group by metadata->>'serviceId', count messages and sum tokens
      const rows = await db.execute(
        drizzleSql`
          SELECT
            COALESCE(metadata->>'serviceId', 'default') AS service_id,
            COUNT(*)::int                               AS message_count,
            SUM(COALESCE((metadata->>'tokens')::int, 0))::int AS total_tokens,
            AVG(COALESCE((metadata->>'latency')::float, 0))::float AS avg_latency_ms
          FROM messages
          WHERE author_type = ${MessageAuthorType.AI_AGENT}
            AND timestamp  >= ${since.toISOString()}
            AND deleted_at IS NULL
          GROUP BY service_id
          ORDER BY message_count DESC
        `
      );

      const stats = (
        rows as unknown as Array<{
          service_id: string;
          message_count: number;
          total_tokens: number;
          avg_latency_ms: number;
        }>
      ).map((r) => ({
        serviceId: r.service_id,
        messageCount: Number(r.message_count),
        totalTokens: Number(r.total_tokens),
        avgLatencyMs: Math.round(Number(r.avg_latency_ms)),
      }));

      return { stats, since: since.toISOString(), days: input.days };
    }),

  /**
   * Check if a specific capability is available.
   */
  hasCapability: publicProcedure
    .input(z.object({ capability: z.string() }))
    .query(async ({ input }) => {
      const dbServices = await db.query.intelligenceServices.findMany({
        where: eq(intelligenceServices.status, "active"),
      });

      const hasDefaultCapability =
        DEFAULT_INTELLIGENCE_SERVICE.capabilities.includes(input.capability);
      const hasDbCapability = dbServices.some((s) =>
        (s.capabilities as string[]).includes(input.capability)
      );

      return { available: hasDefaultCapability || hasDbCapability };
    }),
});
