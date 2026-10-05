/**
 * Brand kit service — the ONE place that answers "which workspace is this
 * caller's brand, and what is in it?" (Content × Brand C2).
 *
 * Resolution order, first hit wins:
 *   1. `project`     — a Brand Library workspace the project USES (the
 *                      `project --uses--> workspace` INDEX), when a projectId
 *                      is given.
 *   2. `workspace`   — the given workspace, when it IS a Brand Library
 *                      provider; else the brand source it DECLARES
 *                      (`settings.defaultSources.brand` / `["brand.library"]`)
 *                      when that names a visible provider.
 *   3. `pod-default` — the pod's brand provider: a visible Brand Library
 *                      workspace that plays the `brand` provider role, else the
 *                      oldest visible Brand Library workspace.
 *
 * A "Brand Library provider" is a non-archived workspace the caller can see
 * (`userVisibleWhere` — the floor `workspaces.list` uses) whose settings
 * advertise the `brand.library` capability.
 *
 * Every consumer — the Hub door `GET /brand/kit` and, through it, the IS brand
 * context block — goes through `resolveBrandWorkspace`. Do not re-derive it.
 *
 * Empty ≠ failed: "no brand" is a typed result; a failed read THROWS.
 */

import {
  and,
  asc,
  db as defaultDb,
  entities,
  eq,
  inArray,
  isNull,
  profiles,
  projects,
  userVisibleWhere,
  workspaces,
} from "@synap/database";
import {
  BRAND_KIT_PROFILE_SLUGS,
  brandKitFromEntities,
  exportBrandKit,
  type BrandKitExport,
  type BrandKitFormat,
} from "@synap-core/types/brand-kit";

import { AccessContext, scopedDb } from "../../access/index.js";
import { listWorkspacesUsedByProjects } from "../../utils/project-workspace.js";

/** Mirrors `@synap-core/workspace-directory` BRAND_CAPABILITIES.library / BRAND_SOURCE_DOMAIN. */
export const BRAND_LIBRARY_CAPABILITY = "brand.library";
export const BRAND_SOURCE_DOMAIN = "brand";

export type BrandResolvedVia = "project" | "workspace" | "pod-default";

export type BrandResolution =
  | { ok: true; brandWorkspaceId: string; resolvedVia: BrandResolvedVia }
  | { ok: false; reason: "project_not_found" | "no_brand_workspace" };

/** The settings slice the picker reads. */
export interface BrandCandidateWorkspace {
  id: string;
  settings: {
    workspaceCapabilities?: unknown;
    sourceRoles?: unknown;
    defaultSources?: unknown;
  } | null;
}

function isBrandProvider(w: BrandCandidateWorkspace): boolean {
  const caps = w.settings?.workspaceCapabilities;
  return Array.isArray(caps) && caps.includes(BRAND_LIBRARY_CAPABILITY);
}

function playsBrandProviderRole(w: BrandCandidateWorkspace): boolean {
  const roles = w.settings?.sourceRoles;
  if (!roles || typeof roles !== "object") return false;
  const role = (roles as Record<string, unknown>)[BRAND_SOURCE_DOMAIN];
  return role === "provider" || role === "provider-consumer";
}

function declaredBrandSource(w: BrandCandidateWorkspace): string | undefined {
  const sources = w.settings?.defaultSources;
  if (!sources || typeof sources !== "object") return undefined;
  const s = sources as Record<string, unknown>;
  for (const key of [BRAND_SOURCE_DOMAIN, BRAND_LIBRARY_CAPABILITY]) {
    const entry = s[key];
    if (entry && typeof entry === "object") {
      const id = (entry as { workspaceId?: unknown }).workspaceId;
      if (typeof id === "string" && id) return id;
    }
  }
  return undefined;
}

/** Providers playing the `brand` role first; otherwise the given order is kept. */
function preferRole(
  providers: BrandCandidateWorkspace[]
): BrandCandidateWorkspace | undefined {
  return providers.find(playsBrandProviderRole) ?? providers[0];
}

/**
 * PURE resolution over already-floored inputs.
 *
 * @param visible           every workspace the caller can see, oldest first.
 * @param projectUsedIds    the project's used workspace ids (order kept), or
 *                          undefined when no project was given.
 * @param workspaceId       the caller's active/given workspace, if any.
 */
export function pickBrandWorkspace(input: {
  visible: BrandCandidateWorkspace[];
  projectUsedIds?: readonly string[];
  workspaceId?: string;
}): Extract<BrandResolution, { ok: true }> | null {
  const byId = new Map(input.visible.map((w) => [w.id, w]));
  const providers = input.visible.filter(isBrandProvider);
  const providerIds = new Set(providers.map((w) => w.id));

  if (input.projectUsedIds?.length) {
    const used = input.projectUsedIds
      .filter((id) => providerIds.has(id))
      .map((id) => byId.get(id)!);
    const hit = preferRole(used);
    if (hit)
      return { ok: true, brandWorkspaceId: hit.id, resolvedVia: "project" };
  }

  if (input.workspaceId) {
    const given = byId.get(input.workspaceId);
    if (given && providerIds.has(given.id)) {
      return { ok: true, brandWorkspaceId: given.id, resolvedVia: "workspace" };
    }
    const declared = given ? declaredBrandSource(given) : undefined;
    if (declared && providerIds.has(declared)) {
      return { ok: true, brandWorkspaceId: declared, resolvedVia: "workspace" };
    }
  }

  const fallback = preferRole(providers);
  return fallback
    ? { ok: true, brandWorkspaceId: fallback.id, resolvedVia: "pod-default" }
    : null;
}

type Db = typeof defaultDb;

/**
 * Resolve the caller's brand workspace (see the module header). Throws when a
 * read fails — the caller maps that to a 5xx, never to "no brand".
 */
export async function resolveBrandWorkspace(
  args: { userId: string; projectId?: string; workspaceId?: string },
  db: Db = defaultDb
): Promise<BrandResolution> {
  let projectUsedIds: string[] | undefined;
  if (args.projectId) {
    const project = await scopedDb(
      AccessContext.agent({ userId: args.userId })
    ).findFirst<{ id: string }>(projects, {
      where: eq(projects.id, args.projectId),
      columns: { id: true },
    });
    if (!project) return { ok: false, reason: "project_not_found" };
    projectUsedIds =
      (
        await listWorkspacesUsedByProjects(db, [args.projectId], args.userId)
      ).get(args.projectId) ?? [];
  }

  const visible = (await db
    .select({ id: workspaces.id, settings: workspaces.settings })
    .from(workspaces)
    .where(
      and(
        isNull(workspaces.archivedAt),
        userVisibleWhere(workspaces.id, args.userId)
      )
    )
    .orderBy(
      asc(workspaces.createdAt),
      asc(workspaces.id)
    )) as BrandCandidateWorkspace[];

  return (
    pickBrandWorkspace({
      visible,
      projectUsedIds,
      workspaceId: args.workspaceId,
    }) ?? { ok: false, reason: "no_brand_workspace" }
  );
}

/**
 * Upper bound on brand rows read for one kit — a library is tens of rows. The
 * read is ordered by id so that, past the cap, the SAME rows (and so the same
 * kit hash) come back on every call.
 */
const BRAND_KIT_MAX_ROWS = 1000;

/**
 * Read the Brand Library rows of one workspace through the access layer
 * (entities `VisibilityRule`, lensed to that workspace) and export the kit.
 */
export async function readBrandKit(
  args: { userId: string; brandWorkspaceId: string; format: BrandKitFormat },
  db: Db = defaultDb
): Promise<BrandKitExport> {
  const profileRows = await db
    .select({ id: profiles.id, slug: profiles.slug })
    .from(profiles)
    .where(inArray(profiles.slug, [...BRAND_KIT_PROFILE_SLUGS]));
  const slugById = new Map(profileRows.map((p) => [p.id, p.slug]));

  const rows = slugById.size
    ? await scopedDb(
        AccessContext.agent({ userId: args.userId }).withLens(
          args.brandWorkspaceId
        )
      ).findMany<{
        profileId: string | null;
        title: string | null;
        properties: unknown;
      }>(entities, {
        where: and(
          eq(entities.workspaceId, args.brandWorkspaceId),
          inArray(entities.profileId, [...slugById.keys()]),
          isNull(entities.deletedAt)
        ),
        columns: { profileId: true, title: true, properties: true },
        orderBy: [asc(entities.id)],
        limit: BRAND_KIT_MAX_ROWS,
      })
    : [];

  const kit = brandKitFromEntities(
    rows.map((r) => ({
      profileSlug: (r.profileId && slugById.get(r.profileId)) || "",
      title: r.title ?? "",
      properties:
        r.properties && typeof r.properties === "object"
          ? (r.properties as Record<string, unknown>)
          : {},
    }))
  );
  return exportBrandKit(kit, args.format);
}
