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
  or,
  isNull,
  inArray,
  getWorkspaceMembership,
  automations as automationsTable,
} from "@synap/database";
import { cpCatalogCache, profiles, views } from "@synap/database/schema";
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
import { installCellFromDefinition } from "../cells/install-cell-from-definition.js";
import {
  buildMarketSource,
  stampMarketSource,
  readMarketSource,
} from "./market-source.js";
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
  // A 401/403/404 here is (almost always) a PRIVATE package: this pod fetch is
  // UNAUTHENTICATED (bare `fetch`), and the CP's `GET /:slug` is optionalAuth —
  // it serves a private package only to a requester whose identity matches the
  // author (or a pod-team member). The pod holds no CP user credential, so the
  // real fix is the pod→CP user-scoped auth identity seam (not yet wired); until
  // then, name the cause and the workaround rather than a generic 500.
  // TODO(identity-seam): authenticate this fetch AS the installing user/author
  // (pod→CP user-scoped auth) so private packages become fetchable server-side.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new TRPCError({
      code: res.status === 404 ? "NOT_FOUND" : "FORBIDDEN",
      message: `Cannot install "${slug}": its package definition isn't fetchable by this pod. Private packages require the CP identity seam (not yet wired); re-publish it public (synap market publish <file> --public) or install it from the browser. (nothing was provisioned)`,
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
  /**
   * RC4 payload-in: the FULL package definition supplied by an
   * already-CP-authenticated client. When present it IS the resolved definition
   * and EVERY catalog lookup/fetch is skipped (no `cp_catalog_cache` row, no
   * by-slug/by-key CP fetch) — the door that installs a PRIVATE package the pod
   * cannot fetch unauthenticated. When absent, resolution is unchanged (fetch).
   */
  definition?: Record<string, unknown>;
}

/**
 * The ONE apply function per kind. Called by BOTH the direct-operator path
 * (market.install builtin verb, no agent involved) and the `capability.install`
 * approve-executor (post-approval re-entry) — never re-implemented twice.
 */
export async function applyMarketInstall(
  input: ApplyMarketInstallInput
): Promise<Record<string, unknown>> {
  // RC4 payload-in: when the caller supplies the definition, it IS the resolved
  // definition — skip lookupCatalogEntry AND every resolve/fetch path below (so
  // a PRIVATE package the pod can't fetch unauthenticated still installs). With
  // `entry` left null, each kind branch's existing `entry ? … : …` fetch is
  // bypassed in favour of `supplied`, while the `entry?.name`/`entry?.version`
  // display fallbacks degrade harmlessly (same as the by-key re-resolve path).
  const supplied = input.definition ?? null;
  const entry = supplied
    ? null
    : await lookupCatalogEntry(input.kind, input.slug);

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
    const definition = (supplied
      ? supplied
      : entry
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
  if (!entry && !supplied && input.kind === "cell") {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Marketplace entry "${input.slug}" (cell) is no longer in the catalog cache — search again with market.search({query, kind:"cell"}).`,
    });
  }

  switch (input.kind) {
    case "cell": {
      // RC4: a supplied payload carries the renderer source inline (its `code`);
      // otherwise the cache row is required (narrowed non-null by the guard
      // above — the by-slug packages endpoint doesn't serve cell source).
      const def = (supplied ?? entry?.definition) as {
        key?: string;
        code?: string;
        deps?: Record<string, string>;
        defaultSize?: { w: number; h: number };
        packageSlug?: string;
        /** View types this cell can render (0221) — optional in the payload. */
        viewTypes?: string[];
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
      // Shared with the packages/apply inline-`cells[]` applier so the typeKey
      // derivation and the view-renderer affinity threading cannot drift
      // between the two install doors. See `install-cell-from-definition.ts`.
      const result = await installCellFromDefinition({
        definition: def,
        name: entry?.name ?? input.slug,
        packageSlug: slugPackage as string,
        cellKey: slugCellKey as string,
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
      return {
        kind: "cell",
        typeKey: result.typeKey,
        changeType: result.changeType,
      };
    }

    case "template": {
      // Supplied payload (RC4) → use directly; else cache row present → resolve
      // inline/by-slug; row MISSING → by-key re-resolve from the CP (opt-in /
      // just-authored template).
      const definition = (supplied
        ? supplied
        : entry
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
      // Supplied payload (RC4) → use directly; else cache row present → resolve
      // inline/by-slug; row MISSING → by-key re-resolve from the CP (opt-in /
      // just-authored automation package).
      const definition = (supplied ??
        (entry
          ? await resolveDefinition(entry, input.version)
          : await resolveDefinitionByKey(input.slug, input.version))) as {
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
          metadata?: Record<string, unknown>;
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
          // W4a source-link: stamp the reconcilable fields AS INSTALLED (the base
          // of every future 3-way merge) so a published fix can self-heal this
          // automation and a re-install can't silently duplicate it. `fields`
          // MUST equal exactly the values passed to create() for the baseline to
          // be an honest merge base — reuse the same vars below.
          const triggerConfig = a.triggerConfig ?? {};
          const flowDefinition = a.flowDefinition ?? { nodes: [], edges: [] };
          const fields = {
            name: a.name,
            description: a.description,
            triggerType: a.triggerType,
            triggerConfig,
            flowDefinition,
          };
          const source = buildMarketSource(fields, {
            packageSlug: input.slug,
            packageVersion: entry?.version ?? input.version ?? null,
            installedAt: new Date().toISOString(),
          });
          // Merge author metadata (e.g. `metadata.kind: "calibration-recommender"`,
          // the marker the browser CalibrationRecommenderSeam matches on) UNDER the
          // system `marketSource` stamp: `stampMarketSource` spreads the base first,
          // then writes MARKET_SOURCE_KEY last, so the author's keys survive and the
          // system provenance can never be clobbered. Mirrors the author-metadata
          // merge in package-apply-post-workspace.ts. The W4a `fields`/baseline above
          // is unaffected — metadata is not a reconcilable field.
          const metadata = stampMarketSource(a.metadata, source);
          const r = await caller.create({
            workspaceId: input.workspaceId,
            name: a.name,
            description: a.description,
            triggerType: a.triggerType,
            triggerConfig,
            flowDefinition,
            status: a.status ?? "active",
            metadata,
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
      // born approved). Supplied payload (RC4) → use directly; else cache row
      // present → resolve inline/by-slug; row MISSING → by-key re-resolve from
      // the CP (opt-in / just-authored skill package), mirroring the
      // automation/template kinds. workspaceId is optional (a skill is pod-wide
      // when the caller has no acting workspace).
      const definition = (supplied ??
        (entry
          ? await resolveDefinition(entry, input.version)
          : await resolveDefinitionByKey(input.slug, input.version))) as {
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
      // W4a source-link: `skillFields` = the resolved values written from the
      // definition; they become the merge baseline, so `fields` MUST equal what
      // create() receives (spread below) for the 3-way merge to be honest.
      const skillFields = {
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
      };
      const source = buildMarketSource(skillFields, {
        packageSlug: input.slug,
        packageVersion: entry?.version ?? input.version ?? null,
        installedAt: new Date().toISOString(),
      });
      const metadata = stampMarketSource(undefined, source);
      const result = await skillsRouter.createCaller(ctx).create({
        workspaceId: input.workspaceId ?? undefined,
        ...skillFields,
        metadata,
      });
      return { kind: "skill", ...result };
    }

    case "view": {
      // A `view` package bundles ONE OR MORE views (e.g. task-views-pack ships a
      // Kanban board, priority matrix, calendar and table). The CP shape is
      // `{ views: PackageViewDefinition[], profiles?, … }` — each view carries
      // its render `type` + `config`, and its scope as profile SLUGS
      // (`scopeProfileSlugs`), NOT the per-pod profile UUIDs `viewsRouter.create`
      // needs. So: normalize to a list of views → resolve each view's scope slugs
      // to THIS pod's profile ids → create each through the SAME governed door
      // the direct create + MCP `synap_create_view` use. Supplied payload (RC4)
      // → use directly; else cache row present → resolve inline/by-slug; row
      // MISSING → by-key re-resolve from the CP.
      const definition = (supplied ??
        (entry
          ? await resolveDefinition(entry, input.version)
          : await resolveDefinitionByKey(input.slug, input.version))) as {
        name?: string;
        displayName?: string;
        views?: Array<{
          slug?: string;
          name?: string;
          displayName?: string;
          description?: string;
          type?: string;
          config?: Record<string, unknown>;
          query?: Record<string, unknown>;
          metadata?: Record<string, unknown>;
          scopeProfileSlugs?: string[];
          scopeProfileIds?: string[];
        }>;
        // Legacy single-view shape (top-level view fields).
        slug?: string;
        description?: string;
        type?: string;
        config?: Record<string, unknown>;
        query?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
        scopeProfileSlugs?: string[];
        scopeProfileIds?: string[];
      };

      // Multi-view package `views[]`, else a single top-level view.
      const viewDefs =
        definition.views && definition.views.length > 0
          ? definition.views
          : definition.type
            ? [definition]
            : [];
      if (viewDefs.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `View package "${input.slug}" declares no views (no \`views[]\` and no top-level \`type\`) — nothing to install.`,
        });
      }
      if (!input.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Installing the view package "${input.slug}" requires an acting workspace (workspaceId) to place its views in.`,
        });
      }

      // Resolve scope profile SLUGS → this pod's profile UUIDs. Views ship slugs
      // (portable across pods); the create door needs ids. Match pod-wide (system)
      // profiles or ones in the acting workspace, preferring the workspace-scoped
      // row for a slug that exists at both levels.
      const scopeSlugs = Array.from(
        new Set(viewDefs.flatMap((v) => v.scopeProfileSlugs ?? []))
      );
      const slugToProfileId = new Map<string, string>();
      if (scopeSlugs.length > 0) {
        const profileRows = await db
          .select({
            id: profiles.id,
            slug: profiles.slug,
            workspaceId: profiles.workspaceId,
          })
          .from(profiles)
          .where(
            and(
              inArray(profiles.slug, scopeSlugs),
              or(
                isNull(profiles.workspaceId),
                eq(profiles.workspaceId, input.workspaceId)
              )
            )
          );
        for (const r of profileRows) {
          if (
            !slugToProfileId.has(r.slug) ||
            r.workspaceId === input.workspaceId
          ) {
            slugToProfileId.set(r.slug, r.id);
          }
        }
      }

      const workspaceRole =
        (await getWorkspaceMembership(db, input.workspaceId, input.userId))
          ?.role ?? "owner";
      const ctx = {
        db,
        authenticated: true as const,
        userId: input.userId,
        workspaceId: input.workspaceId,
        workspaceRole,
      } as unknown as Context;
      const { viewsRouter } = await import("../../routers/views.js");
      const viewCaller = viewsRouter.createCaller(ctx);

      // W4d dedup: a re-install must not clone views. Load the workspace's views
      // already source-linked to THIS package (metadata.marketSource.packageSlug)
      // and index them by name — the install identity for a view. A matching
      // (slug, name) row is UPDATED through the governed views door instead of
      // creating a duplicate.
      const existingViews = await db
        .select({
          id: views.id,
          name: views.name,
          metadata: views.metadata,
        })
        .from(views)
        .where(eq(views.workspaceId, input.workspaceId));
      const linkedByName = new Map<string, string>();
      for (const ev of existingViews) {
        if (
          readMarketSource(ev.metadata as Record<string, unknown> | null)
            ?.packageSlug === input.slug
        ) {
          linkedByName.set(ev.name, ev.id);
        }
      }

      const created: string[] = [];
      const updated: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const v of viewDefs) {
        const name =
          v.name ?? v.displayName ?? v.slug ?? entry?.name ?? input.slug;
        const scopeProfileIds =
          v.scopeProfileIds && v.scopeProfileIds.length > 0
            ? v.scopeProfileIds
            : (v.scopeProfileSlugs ?? [])
                .map((s) => slugToProfileId.get(s))
                .filter((id): id is string => Boolean(id));
        // W4a source-link: `fields` = the reconcilable values written from the
        // definition (the merge baseline) — MUST equal what create()/update()
        // receives for an honest 3-way merge.
        const fields = {
          name,
          type: v.type,
          query: v.query,
          config: v.config,
        };
        const source = buildMarketSource(fields, {
          packageSlug: input.slug,
          packageVersion: entry?.version ?? input.version ?? null,
          installedAt: new Date().toISOString(),
        });
        const metadata = stampMarketSource(v.metadata, source);
        try {
          const existingId = linkedByName.get(name);
          if (existingId) {
            // Re-install of an already-linked view → UPDATE in place through the
            // governed views door (no duplicate). `type` is runtime-validated by
            // the door's ViewTypeEnum.
            await viewCaller.update({
              id: existingId,
              name,
              type: v.type,
              query: v.query,
              config: v.config,
              metadata,
            } as Parameters<typeof viewCaller.update>[0]);
            updated.push(name);
          } else {
            // `type` is runtime-validated by the door's ViewTypeEnum; cast to the
            // caller's input shape (an invalid type is rejected by zod there).
            await viewCaller.create({
              workspaceId: input.workspaceId,
              name,
              description: v.description,
              type: v.type,
              scopeProfileIds,
              query: v.query,
              config: v.config,
              metadata,
            } as Parameters<typeof viewCaller.create>[0]);
            created.push(name);
          }
        } catch (err) {
          failed.push({
            name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // If NOTHING installed OR updated, surface why (most often: a scope profile
      // absent on this pod). A partial success returns all lists for the caller.
      if (created.length === 0 && updated.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `View package "${input.slug}" installed no views: ${failed
            .map((f) => `${f.name} (${f.error})`)
            .join("; ")}`,
        });
      }
      return { kind: "view", created, updated, failed };
    }
  }
}

export interface RunMarketInstallInput {
  slug: string;
  kind: CatalogKind;
  version?: string | null;
  params?: Record<string, unknown>;
  /**
   * RC4 payload-in: the FULL package definition supplied by an
   * already-CP-authenticated client (see ApplyMarketInstallInput.definition).
   * Threaded straight into the direct-execute path so an operator installs a
   * PRIVATE package the pod cannot fetch unauthenticated.
   */
  definition?: Record<string, unknown>;
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
  // cache-miss dead-end this wave removes. RC4: a supplied `definition` carries
  // the cell's renderer source inline, so it too satisfies the cell requirement.
  if (!entry && !input.definition && input.kind === "cell") {
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
    definition: input.definition,
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
  return { status: "installed", result };
}
