/**
 * Marketplace install — the shared apply core behind the `market.install`
 * builtin verb (builtin-verbs.ts) AND the `capability.install` proposal
 * approve-executor (routers/proposals/approve-executors.ts). ONE function per
 * concern so an operator's direct install and an approved agent's install can
 * never diverge in provisioning logic (the "one door per kind" bar from
 * CAPABILITY-MARKETPLACE-PLAN.md P2.1-A).
 *
 * Kind → door (never re-implemented, only routed to):
 *   capability → `createCapabilityFromDefinition` — the SAME governed applier
 *                `/packages/apply` and the manual capability-apply flow use.
 *                Idempotent by definition (name+workspace natural key).
 *   template   → `createWorkspaceFromDefinitionIdempotent` (Phase-1 workspace
 *                door) — the templateKey flow P2.6 describes. Idempotent via
 *                its `packageSlug`/`proposalId` key (both set to the catalog
 *                slug here), so re-installing the same template for the same
 *                user converges to the existing workspace.
 *   automation → `automationsRouter.create`, applied into the CALLER's acting
 *                workspace (not a new one — installing "an automation" adds it
 *                to where the caller already is). Idempotent via a name+
 *                workspace pre-check, mirroring `/packages/apply`'s own
 *                automations step (that route is out of this wave's write
 *                scope, so the check is inlined here rather than imported).
 *   cell       → `defineCell` — the SAME governed cell upsert `POST
 *                /cells/define` and MCP `synap_create_cell` use. Idempotent by
 *                (typeKey, workspaceId).
 *
 * Definition resolution: the `cp_catalog_cache` row carries the full install
 * payload inline for capability/cell (their CP list routes return it), but
 * NULL for automation/template (the CP's public package-list route omits it
 * "can be large" — see cp-catalog-sync.ts). For those two kinds, this module
 * fetches the full definition at install time from `GET
 * {source}/api/packages/:slug[/:version]` (8s timeout) — failure returns a
 * retryable error, never a half-install. When the cache row itself is MISSING
 * for automation/template (an opt-in / just-authored package the sync never
 * saw), the same by-slug endpoint is used with the configured CP base URL
 * (`resolveDefinitionByKey`) — the uniform analog of the capability by-key
 * fallback — so a cache miss re-resolves instead of dead-ending in NOT_FOUND.
 * Only `cell` still requires a cache row (its renderer source is inline-only).
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  getWorkspaceMembership,
  automations as automationsTable,
} from "@synap/database";
import { cpCatalogCache } from "@synap/database/schema";
import type { CatalogKind } from "@synap/jobs";
import type { CapabilityDefinition } from "@synap/playbooks";
import type { WorkspaceDefinitionInput } from "@synap/database";
import type { Context } from "../../context.js";
import { assertPackageTierAccess } from "../../utils/tier-check.js";
import { createPendingProposal } from "../../utils/permission-check.js";
import { openLink } from "../../utils/deep-links.js";
import { createCapabilityFromDefinition } from "./create-from-definition.js";
import { fetchCPCapabilityTemplate } from "./cp-template-client.js";
import { createWorkspaceFromDefinitionIdempotent } from "../workspace-creation-service.js";
import { defineCell } from "../cells/define-cell.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "marketplace-install" });

export interface CatalogCacheRowFull {
  id: string;
  source: string;
  kind: string;
  slug: string;
  name: string;
  description: string | null;
  version: string | null;
  tier: string | null;
  vendor: string | null;
  definition: Record<string, unknown> | null;
}

/** Look up ONE cache row by (kind, slug) — the exact target an install needs. */
export async function lookupCatalogEntry(
  kind: CatalogKind,
  slug: string
): Promise<CatalogCacheRowFull | null> {
  const [row] = await db
    .select()
    .from(cpCatalogCache)
    .where(and(eq(cpCatalogCache.kind, kind), eq(cpCatalogCache.slug, slug)))
    .limit(1);
  return row ?? null;
}

const FETCH_TIMEOUT_MS = 8000;

/**
 * Fetch the full install payload for automation/template kinds (the cache
 * omits it for these — list-view only). Never throws a half-parsed result:
 * any failure (unreachable, non-2xx, empty body) surfaces as a retryable
 * INTERNAL_SERVER_ERROR so the caller (verb/executor) never proceeds to a
 * partial provisioning step.
 */
async function fetchFullPackageDefinition(
  source: string,
  slug: string,
  version?: string | null
): Promise<Record<string, unknown>> {
  const url = version
    ? `${source}/api/packages/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`
    : `${source}/api/packages/${encodeURIComponent(slug)}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Marketplace source unreachable fetching "${slug}" — retry the install later (nothing was provisioned).`,
    });
  }
  if (!res.ok) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Marketplace source returned ${res.status} fetching "${slug}" — retry the install later (nothing was provisioned).`,
    });
  }
  const body = (await res.json().catch(() => null)) as {
    package?: { definition?: Record<string, unknown> };
  } | null;
  const definition = body?.package?.definition;
  if (!definition) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Marketplace source returned no definition for "${slug}" — retry the install later (nothing was provisioned).`,
    });
  }
  return definition;
}

/** Resolve the full install payload for a cache row (inline, or fetched). */
async function resolveDefinition(
  entry: CatalogCacheRowFull,
  version?: string | null
): Promise<Record<string, unknown>> {
  if (entry.definition) return entry.definition;
  return fetchFullPackageDefinition(entry.source, entry.slug, version);
}

/**
 * Resolve the CP base URL — the by-key re-resolve source used when there is NO
 * cp_catalog_cache row. Mirrors cp-template-client's `cpUrl()`. Null when the
 * pod has no Control Plane configured (self-hosted).
 */
function cpBaseUrl(): string | null {
  const url = (
    process.env.CONTROL_PLANE_URL ??
    process.env.CP_URL ??
    ""
  ).replace(/\/$/, "");
  return url || null;
}

/**
 * BY-KEY re-resolve for automation/template when the cp_catalog_cache row is
 * MISSING — the uniform analog of the capability by-key fallback
 * (fetchCPCapabilityTemplate). An opt-in (syncByDefault:false) or just-authored
 * package never enters the cache, but the CP still serves it by slug at
 * `GET {CP}/api/packages/:slug` — so a cache miss RE-RESOLVES from the CP instead
 * of dead-ending in NOT_FOUND (the gap this wave closes). Throws a clear NOT_FOUND
 * only when no CP is configured to resolve from; a reachable-but-failing CP
 * surfaces `fetchFullPackageDefinition`'s retryable INTERNAL_SERVER_ERROR.
 */
async function resolveDefinitionByKey(
  slug: string,
  version?: string | null
): Promise<Record<string, unknown>> {
  const source = cpBaseUrl();
  if (!source) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Marketplace entry "${slug}" isn't in the catalog cache and no Control Plane is configured to re-resolve it — search first with market.search.`,
    });
  }
  return fetchFullPackageDefinition(source, slug, version);
}

export interface ApplyMarketInstallInput {
  kind: CatalogKind;
  slug: string;
  version?: string | null;
  params?: Record<string, unknown>;
  userId: string;
  workspaceId: string | null;
}

/**
 * The ONE apply function per kind. Called by BOTH the direct-operator path
 * (market.install builtin verb, no agent involved) and the `capability.install`
 * approve-executor (post-approval re-entry) — never re-implemented twice.
 */
export async function applyMarketInstall(
  input: ApplyMarketInstallInput
): Promise<Record<string, unknown>> {
  const entry = await lookupCatalogEntry(input.kind, input.slug);

  // A CAPABILITY is resolvable WITHOUT a cache row. Opt-in capabilities
  // (syncByDefault:false, e.g. unipile-linkedin, arch-backend) never enter
  // cp_catalog_cache, but the CP serves them by key — the exact door `cap add`
  // uses (fetchCPCapabilityTemplate: pod cache → CP default-list → CP by-key).
  // Requiring a cache row here is why `market.install` NOT_FOUND/500s on every
  // opt-in cap while `cap add` installs it fine — two doors, divergent results.
  // Every other kind still requires the cache row (cell needs its inline source;
  // automation/template fetch by slug but need the row's `source`).
  // Capability is handled BEFORE the cache-row requirement because it resolves
  // by key, cache-row or not.
  if (input.kind === "capability") {
    const definition = (entry
      ? await resolveDefinition(entry, input.version)
      : await fetchCPCapabilityTemplate(
          input.slug
        )) as unknown as CapabilityDefinition | null;
    if (!definition) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Capability "${input.slug}" isn't in the Control Plane catalog — check the slug, or reseed the CP if it was just authored.`,
      });
    }
    const workspaceRole = input.workspaceId
      ? (await getWorkspaceMembership(db, input.workspaceId, input.userId))
          ?.role
      : "owner";
    const ctx = {
      db,
      authenticated: true as const,
      userId: input.userId,
      workspaceId: input.workspaceId,
      workspaceRole,
    } as unknown as Context;
    const result = await createCapabilityFromDefinition(
      definition,
      input.params ?? {},
      ctx
    );
    return {
      kind: "capability",
      key: result.capabilityKey,
      created: result.created,
    };
  }

  // CELL is the only remaining kind that REQUIRES a cache row: its renderer
  // source lives ONLY in the inline `definition` (the by-slug packages endpoint
  // doesn't serve cells). automation/template re-resolve by key below when the
  // row is missing — mirroring the capability by-key fallback above — so an
  // opt-in / just-authored package that never entered cp_catalog_cache installs
  // instead of dead-ending in NOT_FOUND.
  if (!entry && input.kind === "cell") {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Marketplace entry "${input.slug}" (cell) is no longer in the catalog cache — search again with market.search({query, kind:"cell"}).`,
    });
  }

  switch (input.kind) {
    case "cell": {
      // Narrowed non-null by the cell-specific guard above.
      const cellEntry = entry!;
      const def = cellEntry.definition as {
        key?: string;
        code?: string;
        deps?: Record<string, string>;
        defaultSize?: { w: number; h: number };
        packageSlug?: string;
      } | null;
      if (!def?.code) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Cell "${input.slug}" is missing its renderer source in the catalog cache — wait for the next sync and retry.`,
        });
      }
      const [slugPackage, slugCellKey] = input.slug.includes("/")
        ? input.slug.split("/")
        : [def.packageSlug ?? "unknown", def.key ?? input.slug];
      const result = await defineCell({
        name: cellEntry.name,
        rendererSource: def.code,
        workspaceId: input.workspaceId,
        typeKey: `cell:${slugPackage}:${slugCellKey}`,
        deps: def.deps,
        defaultSize: def.defaultSize,
        userId: input.userId,
      });
      return {
        kind: "cell",
        typeKey: result.typeKey,
        changeType: result.changeType,
      };
    }

    case "template": {
      // Cache row present → resolve inline/by-slug from the row; row MISSING →
      // by-key re-resolve from the CP (opt-in / just-authored template).
      const definition = (entry
        ? await resolveDefinition(entry, input.version)
        : await resolveDefinitionByKey(
            input.slug,
            input.version
          )) as unknown as WorkspaceDefinitionInput & {
        workspaceName?: string;
      };
      // Idempotency: packageSlug/proposalId both set to the catalog slug, so a
      // re-install by the same user converges to the existing workspace
      // (createWorkspaceFromDefinitionIdempotent's own key, not re-derived here).
      const result = await createWorkspaceFromDefinitionIdempotent({
        definition,
        userId: input.userId,
        proposalId: input.slug,
        packageSlug: input.slug,
        packageVersion: entry?.version ?? input.version ?? undefined,
        workspaceName: definition.workspaceName,
        templateId: input.slug,
        templateName: entry?.name ?? input.slug,
      });
      return {
        kind: "template",
        workspaceId: result.workspaceId,
        created: result.created,
      };
    }

    case "automation": {
      // Installing "an automation" adds it to the caller's ACTING workspace —
      // it does not provision a new one (that's the template kind's job).
      if (!input.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "market.install for kind:automation requires an acting workspace (workspaceId) to add it to.",
        });
      }
      const membership = await getWorkspaceMembership(
        db,
        input.workspaceId,
        input.userId
      );
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No access to the acting workspace.",
        });
      }
      // Cache row present → resolve inline/by-slug; row MISSING → by-key
      // re-resolve from the CP (opt-in / just-authored automation package).
      const definition = (
        entry
          ? await resolveDefinition(entry, input.version)
          : await resolveDefinitionByKey(input.slug, input.version)
      ) as {
        automations?: Array<{
          name: string;
          description?: string;
          triggerType: "event" | "cron" | "webhook" | "manual";
          triggerConfig?: Record<string, unknown>;
          flowDefinition?: {
            nodes: Record<string, unknown>[];
            edges: Record<string, unknown>[];
          };
          status?: "draft" | "active" | "paused";
        }>;
      };
      const autos = definition.automations ?? [];
      if (autos.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Marketplace entry "${input.slug}" carries no automations[] in its definition — nothing to install.`,
        });
      }
      const { automationsRouter } =
        await import("../../routers/automations.js");
      const caller = automationsRouter.createCaller({
        db,
        authenticated: true as const,
        userId: input.userId,
        workspaceId: input.workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);

      const results: unknown[] = [];
      for (const a of autos) {
        // Per-item isolation: one automation that fails to create must NOT abort
        // the rest of the market.install — the failed one is reported as
        // {status:"error"} in `results` and downstream automations still run.
        // Mirrors the per-item try/catch in createCapabilityFromDefinition and
        // applyPackagePostWorkspace (the reference partial-install pattern).
        try {
          // Idempotent reuse keyed on name+workspace — mirrors /packages/apply's
          // own automations step (out of this wave's write scope to import).
          const [existing] = await db
            .select({ id: automationsTable.id })
            .from(automationsTable)
            .where(
              and(
                eq(automationsTable.name, a.name),
                eq(automationsTable.workspaceId, input.workspaceId)
              )
            )
            .limit(1);
          if (existing) {
            results.push({ name: a.name, status: "reused", id: existing.id });
            continue;
          }
          const r = await caller.create({
            workspaceId: input.workspaceId,
            name: a.name,
            description: a.description,
            triggerType: a.triggerType,
            triggerConfig: a.triggerConfig ?? {},
            flowDefinition: a.flowDefinition ?? { nodes: [], edges: [] },
            status: a.status ?? "active",
            source: "intelligence",
          });
          results.push({
            name: a.name,
            status: "created",
            id: (r as { id?: string }).id,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err, slug: input.slug, automation: a.name },
            "market.install automation create failed (isolated — install continues)"
          );
          results.push({ name: a.name, status: "error", message });
        }
      }
      return { kind: "automation", automations: results };
    }

    case "skill": {
      // A standalone `skill` package installs into the caller's context via the
      // SAME governed door the direct create + MCP `synap_create_skill` use —
      // `skillsRouter.create` (its checkPermissionOrPropose gate handles
      // approval; a `code` skill is born unapproved, an `instruction` skill
      // born approved). Cache row present → resolve inline/by-slug; row MISSING
      // → by-key re-resolve from the CP (opt-in / just-authored skill package),
      // mirroring the automation/template kinds. workspaceId is optional (a
      // skill is pod-wide when the caller has no acting workspace).
      const definition = (
        entry
          ? await resolveDefinition(entry, input.version)
          : await resolveDefinitionByKey(input.slug, input.version)
      ) as {
        name?: string;
        displayName?: string;
        description?: string;
        kind?: "instruction" | "code" | "declarative" | "builtin";
        scope?: "pod" | "user" | "workspace";
        agentTypes?: string[];
        body?: string;
        code?: string;
        providerSpec?: Record<string, unknown>;
        parameters?: Record<string, unknown>;
        category?: string;
        executionMode?: "sync" | "async";
        timeoutSeconds?: number;
      };
      const workspaceRole = input.workspaceId
        ? (await getWorkspaceMembership(db, input.workspaceId, input.userId))
            ?.role
        : "owner";
      const ctx = {
        db,
        authenticated: true as const,
        userId: input.userId,
        workspaceId: input.workspaceId,
        workspaceRole,
      } as unknown as Context;
      const { skillsRouter } = await import("../../routers/skills.js");
      const result = await skillsRouter.createCaller(ctx).create({
        workspaceId: input.workspaceId ?? undefined,
        name:
          definition.name ??
          definition.displayName ??
          entry?.name ??
          input.slug,
        description: definition.description ?? entry?.description ?? undefined,
        kind: definition.kind,
        scope: definition.scope ?? "pod",
        agentTypes: definition.agentTypes,
        body: definition.body,
        code: definition.code,
        providerSpec: definition.providerSpec,
        parameters: definition.parameters,
        category: definition.category,
        executionMode: definition.executionMode ?? "sync",
        timeoutSeconds: definition.timeoutSeconds ?? 30,
      });
      return { kind: "skill", ...result };
    }

    case "view": {
      // A standalone `view` package installs via the SAME governed door the
      // direct create + MCP `synap_create_view` use — `viewsRouter.create`.
      // Cache row present → resolve inline/by-slug; row MISSING → by-key
      // re-resolve from the CP (opt-in / just-authored view package), mirroring
      // automation/template. workspaceId is optional (a pod-wide view when the
      // caller has no acting workspace); a STRUCTURED view still requires the
      // definition to carry `scopeProfileIds` (per-pod profile UUIDs) — the
      // door rejects a structured view without them, surfaced as a clear error.
      const definition = (
        entry
          ? await resolveDefinition(entry, input.version)
          : await resolveDefinitionByKey(input.slug, input.version)
      ) as {
        name?: string;
        displayName?: string;
        description?: string;
        type?: string;
        scopeProfileIds?: string[];
        config?: Record<string, unknown>;
        query?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      };
      if (!definition.type) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `View package "${input.slug}" is missing a view \`type\` in its definition — nothing to install.`,
        });
      }
      const workspaceRole = input.workspaceId
        ? (await getWorkspaceMembership(db, input.workspaceId, input.userId))
            ?.role
        : "owner";
      const ctx = {
        db,
        authenticated: true as const,
        userId: input.userId,
        workspaceId: input.workspaceId,
        workspaceRole,
      } as unknown as Context;
      const { viewsRouter } = await import("../../routers/views.js");
      const viewCaller = viewsRouter.createCaller(ctx);
      // `type` is validated at runtime by the door's ViewTypeEnum; cast the
      // args to the caller's input type (an invalid type is rejected by zod),
      // mirroring the `view/create` approve-executor.
      const createArgs = {
        workspaceId: input.workspaceId ?? undefined,
        name:
          definition.name ??
          definition.displayName ??
          entry?.name ??
          input.slug,
        description: definition.description ?? entry?.description ?? undefined,
        type: definition.type,
        scopeProfileIds: definition.scopeProfileIds,
        config: definition.config,
        metadata: definition.metadata,
      };
      const result = await viewCaller.create(
        createArgs as Parameters<typeof viewCaller.create>[0]
      );
      return { kind: "view", ...result };
    }
  }
}

export interface RunMarketInstallInput {
  slug: string;
  kind: CatalogKind;
  version?: string | null;
  params?: Record<string, unknown>;
  userId: string;
  workspaceId: string | null;
  /** The acting AGENT (agent-user id), when this call originates from an agent. */
  agentUserId?: string | null;
}

export type MarketInstallOutcome =
  | { status: "installed"; result: Record<string, unknown> }
  | { status: "proposed"; proposalId: string; reviewUrl: string };

/**
 * Entry point for the `market.install` builtin verb. (P2.1-A / D3): an
 * agent-initiated call ALWAYS proposes — never auto-provisions, regardless of
 * whether the outer capability gate already let this call through (a grant on
 * `market.install` itself governs INVOKING the verb, not the provisioning it
 * performs). An operator call (no agentUserId) executes directly.
 */
export async function runMarketInstall(
  input: RunMarketInstallInput
): Promise<MarketInstallOutcome> {
  const entry = await lookupCatalogEntry(input.kind, input.slug);
  // Capability resolves by key even without a cache row — opt-in caps
  // (syncByDefault:false) never enter cp_catalog_cache but the CP serves them by
  // key (applyMarketInstall re-resolves via fetchCPCapabilityTemplate). The same
  // now holds for automation/template: an opt-in / just-authored package the
  // cache never saw re-resolves by slug from the CP (resolveDefinitionByKey)
  // instead of dead-ending here. Only `cell` still REQUIRES the row (its renderer
  // source is inline-only). Requiring a row for automation/template was the
  // cache-miss dead-end this wave removes.
  if (!entry && input.kind === "cell") {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Marketplace entry "${input.slug}" (cell) not found in the catalog cache. Search first with market.search({query, kind:"cell"}).`,
    });
  }

  // Tier pre-check (P2.5) — fail early, before any proposal or provisioning.
  await assertPackageTierAccess(input.userId, input.slug);

  if (input.agentUserId) {
    const proposal = await createPendingProposal({
      userId: input.userId,
      workspaceId: input.workspaceId,
      targetType: "capability",
      targetId: `market:${input.kind}:${input.slug}`,
      proposalType: "capability.install",
      agentUserId: input.agentUserId,
      data: {
        slug: input.slug,
        kind: input.kind,
        // `entry` is null for any by-key re-resolve (opt-in capability, or an
        // automation/template with no cache row); the approve-executor re-resolves
        // the definition via applyMarketInstall, so source/version here are
        // informational and safely fall back to the slug.
        version: input.version ?? entry?.version ?? null,
        source: entry?.source ?? null,
        params: input.params ?? {},
      },
      notificationDescription: `Install "${entry?.name ?? input.slug}" (${input.kind}) v${entry?.version ?? "latest"} from the marketplace`,
    });
    return {
      status: "proposed",
      proposalId: proposal.id,
      reviewUrl: openLink(proposal.id),
    };
  }

  const result = await applyMarketInstall({
    kind: input.kind,
    slug: input.slug,
    version: input.version,
    params: input.params,
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
  return { status: "installed", result };
}
