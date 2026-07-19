/**
 * Cache-first workspace-TEMPLATE resolution.
 *
 * `package-dependency-resolver.ts` used to read `@synap-core/workspace-templates`
 * directly (`getWorkspaceTemplate`/`toWorkspaceDefinition`/`toPackageDefinition`)
 * — a build-time-FROZEN bundle. A template edited on the Control Plane never
 * reached a running pod without a full Docker redeploy, while capability
 * templates already self-update at runtime via `cp-template-client.ts`'s
 * pod-local cache. This module closes that gap for WORKSPACE templates by
 * mirroring the same cache-first-then-source contract:
 *
 *   1. `cp_catalog_cache` (kind='template', slug) — synced every 10 min by
 *      `packages/jobs` `cp-catalog-sync` from `GET {CP}/api/packages?category=workspace`.
 *      That LIST route never carries `definition` inline (CP list routes omit
 *      it — "can be large"), so a cache HIT means "this slug is live on the
 *      CP" and its full body is fetched with ONE per-slug
 *      `GET {source}/api/packages/:slug[/:version]` (8s timeout) — same
 *      contract `marketplace-install.ts`'s `resolveDefinition` uses for
 *      capability/template installs, reused in spirit (not import — that
 *      helper THROWS on failure for an install caller that wants a hard stop;
 *      this resolver wants silent, resilient bundle fallback instead).
 *   2. On ANY miss/failure (cache row absent, CP unreachable, malformed body)
 *      — fall back to the frozen `@synap-core/workspace-templates` bundle.
 *      Never throws. Cache-miss behavior is BYTE-IDENTICAL to before this
 *      module existed.
 *
 * SHAPE COMPATIBILITY: the CP derives its `/api/packages/:slug` template rows
 * from `toPackageDefinition()` VERBATIM, plus registry-only mirror fields the
 * pod ignores (see synap-control-plane-api's
 * `seeds/flagship-to-package-definition.ts`). So a cache-hit body is
 * structurally the SAME `PackageDefinitionOutput` the bundle's
 * `toPackageDefinition(slug)` returns — a strict superset of what
 * `toWorkspaceDefinition(slug)` returns (workspace-shape fields only, no
 * `capabilities`/`playbooks`). One resolved body serves BOTH the
 * workspace-materialization call site and the post-workspace capability/
 * playbook seeding call site; `toWorkspaceDefinitionInput` below performs the
 * SAME field mapping `toWorkspaceDefinition` does, just reading from the
 * package-shaped body (note one real naming divergence: the package shape
 * calls the field `suggestedEntities`, the workspace shape calls it
 * `seedEntities` — mapped explicitly here, not cast).
 */

import { db, and, eq } from "@synap/database";
import { cpCatalogCache } from "@synap/database/schema";
import {
  getWorkspaceTemplate,
  toWorkspaceDefinition,
  toPackageDefinition,
  type PackageDefinitionOutput,
  type WorkspaceDefinitionInput as TemplateWorkspaceDefinitionInput,
} from "@synap-core/workspace-templates";

const FETCH_TIMEOUT_MS = 8000;

export interface ResolvedWorkspaceTemplate {
  /** Whether the resolution came from the pod-local CP cache or the frozen bundle. */
  source: "cache" | "bundle";
  /** CP content-hash / version stamp for this template, when known (cache only). */
  version?: string;
  dependencies: NonNullable<PackageDefinitionOutput["dependencies"]>;
  /**
   * Ready for `createWorkspaceFromDefinitionIdempotent` /
   * `reconcileWorkspaceFromDefinition` — typed as the TEMPLATES package's own
   * `WorkspaceDefinitionInput` (structurally the create/reconcile input, cast
   * across the two package boundaries at the call site, same as the boot
   * reconcile hook and the pre-existing `toWorkspaceDefinition` call sites did).
   */
  workspaceDefinition: TemplateWorkspaceDefinitionInput;
  /** Ready for `applyPackagePostWorkspace` (capabilities/playbooks layers). */
  packageDefinition: PackageDefinitionOutput;
}

/**
 * Same field mapping `toWorkspaceDefinition` performs, sourced from a
 * PackageDefinitionOutput-shaped body instead of the raw YAML template. Note
 * one real naming divergence between the two converters' installed shapes:
 * the package shape calls the field `suggestedEntities`, the workspace shape
 * calls it `seedEntities` — mapped explicitly, not cast. The bento union
 * (`bentoLayout` on the package shape) is carried into `bentoViewBlocks` (the
 * workspace shape's single bento field in the installed
 * `@synap-core/workspace-templates` version) verbatim — exactly what a direct
 * `toWorkspaceDefinition(slug)` call already does.
 */
function toWorkspaceDefinitionInput(
  pkg: PackageDefinitionOutput
): TemplateWorkspaceDefinitionInput {
  return {
    workspaceName: pkg.workspaceName,
    description: pkg.description,
    proposalId: pkg._meta?.slug,
    profiles: pkg.profiles,
    views: pkg.views ?? [],
    entityLinks: pkg.entityLinks ?? [],
    seedEntities: pkg.suggestedEntities ?? [],
    suggestedRelations: pkg.suggestedRelations,
    displayTemplates: pkg.displayTemplates,
    layoutConfig: pkg.layoutConfig,
    bentoViewName: pkg.bentoViewName,
    bentoViewBlocks: pkg.bentoLayout,
    profileEntityBentoTemplates: pkg.profileEntityBentoTemplates,
    workspaceSubtype: pkg.workspaceSubtype,
    workspaceType: pkg.workspaceType,
    workspaceVisibility: pkg.workspaceVisibility,
    workspaceCapabilities: pkg.workspaceCapabilities,
    sourceRoles: pkg.sourceRoles,
    defaultSources: pkg.defaultSources,
    onboarding: pkg.onboarding,
    dependencies: pkg.dependencies,
  };
}

/** Per-slug per-source per-kind full-body fetch. Resilient — returns `null` on ANY failure, never throws. */
async function fetchFullDefinitionResilient(
  source: string,
  slug: string,
  version?: string | null
): Promise<PackageDefinitionOutput | null> {
  const url = version
    ? `${source}/api/packages/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`
    : `${source}/api/packages/${encodeURIComponent(slug)}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      package?: { definition?: PackageDefinitionOutput };
    } | null;
    return body?.package?.definition ?? null;
  } catch {
    return null;
  }
}

function fromBundle(slug: string): ResolvedWorkspaceTemplate | null {
  const tpl = getWorkspaceTemplate(slug);
  if (!tpl) return null;
  let packageDefinition: PackageDefinitionOutput;
  let workspaceDefinition: TemplateWorkspaceDefinitionInput;
  try {
    packageDefinition = toPackageDefinition(slug);
    workspaceDefinition = toWorkspaceDefinition(slug).definition;
  } catch {
    return null;
  }
  return {
    source: "bundle",
    dependencies: tpl.dependencies ?? [],
    workspaceDefinition,
    packageDefinition,
  };
}

/**
 * Resolve ONE workspace template — `cp_catalog_cache`-first (the FRESHEST
 * template a synced pod knows about), frozen-bundle fallback on any cache
 * miss or CP failure. Never throws.
 */
export async function resolveWorkspaceTemplate(
  slug: string
): Promise<ResolvedWorkspaceTemplate | null> {
  try {
    const [row] = await db
      .select({
        source: cpCatalogCache.source,
        version: cpCatalogCache.version,
        definition: cpCatalogCache.definition,
      })
      .from(cpCatalogCache)
      .where(
        and(eq(cpCatalogCache.kind, "template"), eq(cpCatalogCache.slug, slug))
      )
      .limit(1);

    if (row) {
      const packageDefinition =
        (row.definition as unknown as PackageDefinitionOutput | null) ??
        (await fetchFullDefinitionResilient(row.source, slug, row.version));
      if (packageDefinition) {
        return {
          source: "cache",
          version: row.version ?? undefined,
          dependencies: packageDefinition.dependencies ?? [],
          workspaceDefinition: toWorkspaceDefinitionInput(packageDefinition),
          packageDefinition,
        };
      }
      // Row exists but the full body could not be fetched (CP down) — fall
      // through to the bundle rather than surfacing "template not found".
    }
  } catch {
    // Cache read failed — fall through to the bundle.
  }

  return fromBundle(slug);
}
