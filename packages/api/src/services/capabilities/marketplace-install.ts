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
 * retryable error, never a half-install.
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

  // Every other kind REQUIRES a cache row (cell needs its inline source;
  // automation/template fetch by slug but need the row's `source`). Asserting it
  // here narrows `entry` to non-null for all the switch cases below.
  if (!entry) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Marketplace entry "${input.slug}" (${input.kind}) is no longer in the catalog cache — search again with market.search({query, kind:"${input.kind}"}).`,
    });
  }

  switch (input.kind) {
    case "cell": {
      const def = entry.definition as {
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
        name: entry.name,
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
      const definition = (await resolveDefinition(
        entry,
        input.version
      )) as unknown as WorkspaceDefinitionInput & { workspaceName?: string };
      // Idempotency: packageSlug/proposalId both set to the catalog slug, so a
      // re-install by the same user converges to the existing workspace
      // (createWorkspaceFromDefinitionIdempotent's own key, not re-derived here).
      const result = await createWorkspaceFromDefinitionIdempotent({
        definition,
        userId: input.userId,
        proposalId: input.slug,
        packageSlug: input.slug,
        packageVersion: entry.version ?? input.version ?? undefined,
        workspaceName: definition.workspaceName,
        templateId: input.slug,
        templateName: entry.name,
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
      const definition = (await resolveDefinition(entry, input.version)) as {
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
      }
      return { kind: "automation", automations: results };
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
  // (syncByDefault:false) never enter cp_catalog_cache but the CP serves them
  // by key (applyMarketInstall re-resolves via fetchCPCapabilityTemplate). This
  // is THE fix for `market install <opt-in-cap>` 500ing where `cap add` works.
  // Every other kind still requires the row.
  if (!entry && input.kind !== "capability") {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Marketplace entry "${input.slug}" (${input.kind}) not found in the catalog cache. Search first with market.search({query, kind:"${input.kind}"}).`,
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
        // `entry` is null only for an opt-in capability resolved by key; the
        // approve-executor re-resolves the definition via applyMarketInstall, so
        // source/version here are informational and safely fall back to the slug.
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
