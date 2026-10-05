/**
 * Brand kit service — the ONE place that answers "which brand applies to this
 * caller, and what is in it?" (Content × Brand C2, lens model 2026-10-05).
 *
 * Two steps, both pure rules in `@synap-core/types/brand-kit` fed here with
 * floored inputs:
 *   1. the Brand SPACE (`pickBrandWorkspace`): the given workspace when it is a
 *      Brand Library, else the brand source it declares, else the library
 *      playing the `brand` provider role, else the oldest. A space is a domain,
 *      installed once — projects never get their own.
 *   2. the brand IDENTITY in that space (`pickBrandIdentity`): the project's
 *      brand, else the `default-brand` flag, else the only brand — and the kit
 *      rows of the identity's project. Project membership is read through the
 *      ONE project predicate `projectLensWhere` (never a re-derived
 *      `belongs_to_project` join).
 *
 * A "Brand Library" is a non-archived workspace the caller can see
 * (`userVisibleWhere` — the floor `workspaces.list` uses) whose settings
 * advertise the `brand.library` capability.
 *
 * Every consumer — the Hub door `GET /brand/kit` (and through it the IS brand
 * context block) and the tRPC `brand.resolve` query (and through it the
 * browser's `useBrandWorkspace`) — goes through `resolveBrand`. Do not
 * re-derive it.
 *
 * Empty ≠ failed: "no brand" is a typed `{ ok: false, reason }`; a failed read
 * THROWS.
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
  BRAND_ABSENCE_MESSAGES,
  BRAND_KIT_PROFILE_SLUGS,
  brandKitFromEntities,
  exportBrandKit,
  pickBrandIdentity,
  pickBrandWorkspace,
  type BrandCandidateWorkspace,
  type BrandKitExport,
  type BrandKitFormat,
  type BrandKitSourceEntity,
  type BrandResolution,
  type BrandSpaceRow,
} from "@synap-core/types/brand-kit";

import { AccessContext, scopedDb } from "../../access/index.js";
import { projectLensWhere } from "../../utils/project-scope.js";

type Db = typeof defaultDb;

/**
 * Resolve the Brand SPACE for the caller (step 1), or null when no visible
 * workspace is a Brand Library. Throws when the read fails.
 */
export async function resolveBrandSpace(
  args: { userId: string; workspaceId?: string },
  db: Db = defaultDb
): Promise<string | null> {
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
  return pickBrandWorkspace({ visible, workspaceId: args.workspaceId });
}

/**
 * Upper bound on brand rows read for one kit — a library is tens of rows. The
 * read is ordered by id so that, past the cap, the SAME rows (and so the same
 * kit hash) come back on every call.
 */
const BRAND_KIT_MAX_ROWS = 1000;

/**
 * Resolve the caller's brand (see the module header) and return the rows its
 * kit is built from. `kitSource` is empty unless `resolution.ok`. Throws when
 * a read fails — the caller maps that to a 5xx, never to "no brand".
 */
export async function resolveBrand(
  args: { userId: string; projectId?: string; workspaceId?: string },
  db: Db = defaultDb
): Promise<{
  resolution: BrandResolution;
  kitSource: BrandKitSourceEntity[];
}> {
  const projectId = args.projectId ?? null;
  const absent = (
    reason: Extract<BrandResolution, { ok: false }>["reason"],
    brandWorkspaceId: string | null,
    message: string = BRAND_ABSENCE_MESSAGES[reason]
  ) => ({
    resolution: {
      ok: false as const,
      reason,
      message,
      brandWorkspaceId,
      projectId,
    },
    kitSource: [],
  });

  const access = AccessContext.agent({ userId: args.userId });
  const brandWorkspaceId = await resolveBrandSpace(args, db);
  if (!brandWorkspaceId) return absent("no-brand-space", null);

  if (args.projectId) {
    // A project the caller cannot see has no brand FOR THEM — same typed
    // answer, and nothing about the project leaks.
    const project = await scopedDb(access).findFirst<{ id: string }>(projects, {
      where: eq(projects.id, args.projectId),
      columns: { id: true },
    });
    if (!project) return absent("no-brand-for-project", brandWorkspaceId);
  }

  const profileRows = await db
    .select({ id: profiles.id, slug: profiles.slug })
    .from(profiles)
    .where(inArray(profiles.slug, [...BRAND_KIT_PROFILE_SLUGS]));
  const slugById = new Map(profileRows.map((p) => [p.id, p.slug]));

  const spaceDb = scopedDb(access.withLens(brandWorkspaceId));
  const inSpace = and(
    eq(entities.workspaceId, brandWorkspaceId),
    inArray(entities.profileId, [...slugById.keys()]),
    isNull(entities.deletedAt)
  );
  const rows = slugById.size
    ? await spaceDb.findMany<{
        id: string;
        profileId: string | null;
        title: string | null;
        properties: unknown;
      }>(entities, {
        where: inSpace,
        columns: { id: true, profileId: true, title: true, properties: true },
        orderBy: [asc(entities.id)],
        limit: BRAND_KIT_MAX_ROWS,
      })
    : [];

  // Project membership of the space's brand rows, through the ONE project
  // predicate. With a project: only that project matters. Without one: every
  // project the caller can see, so the chosen identity's project is known.
  const projectIds = !rows.length
    ? []
    : args.projectId
      ? [args.projectId]
      : (
          await scopedDb(access).findMany<{ id: string }>(projects, {
            columns: { id: true },
            orderBy: [asc(projects.id)],
          })
        ).map((p) => p.id);
  const memberships = await Promise.all(
    projectIds.map(async (pid) => {
      const members = await spaceDb.findMany<{ id: string }>(entities, {
        where: and(inSpace, projectLensWhere(entities.id, pid)),
        columns: { id: true },
      });
      return { pid, ids: new Set(members.map((m) => m.id)) };
    })
  );

  const spaceRows: BrandSpaceRow[] = rows.map((r) => ({
    id: r.id,
    profileSlug: (r.profileId && slugById.get(r.profileId)) || "",
    title: r.title ?? "",
    properties:
      r.properties && typeof r.properties === "object"
        ? (r.properties as Record<string, unknown>)
        : {},
    projectIds: memberships.filter((m) => m.ids.has(r.id)).map((m) => m.pid),
  }));

  const pick = pickBrandIdentity({
    rows: spaceRows,
    ...(args.projectId ? { projectId: args.projectId } : {}),
  });
  if (!pick.ok) return absent(pick.reason, brandWorkspaceId, pick.message);
  return {
    resolution: {
      ok: true,
      brandWorkspaceId,
      brandIdentityId: pick.brandIdentityId,
      projectId: pick.projectId,
      resolvedVia: pick.resolvedVia,
    },
    kitSource: pick.kitRows.map(({ profileSlug, title, properties }) => ({
      profileSlug,
      title,
      properties,
    })),
  };
}

/** Export the kit of a resolved brand — exactly the rows `resolveBrand` chose. */
export function exportResolvedBrandKit(
  kitSource: BrandKitSourceEntity[],
  format: BrandKitFormat
): BrandKitExport {
  return exportBrandKit(brandKitFromEntities(kitSource), format);
}
