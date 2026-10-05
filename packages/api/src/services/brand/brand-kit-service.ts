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
 * Every consumer — the Hub door `GET /brand/kit` (and, through it, the IS brand
 * context block) and the tRPC `brand.resolve` query (and, through it, the
 * browser's `useBrandWorkspace`) — goes through `resolveBrandWorkspace`. The
 * pure rule itself is `pickBrandWorkspace` in `@synap-core/types/brand-kit`;
 * this function only supplies its floored, oldest-first inputs. Do not
 * re-derive it.
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
  pickBrandWorkspace,
  type BrandCandidateWorkspace,
  type BrandKitExport,
  type BrandKitFormat,
  type BrandResolution,
} from "@synap-core/types/brand-kit";

import { AccessContext, scopedDb } from "../../access/index.js";
import { listWorkspacesUsedByProjects } from "../../utils/project-workspace.js";

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
