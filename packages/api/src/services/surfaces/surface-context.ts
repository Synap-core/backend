/**
 * `resolveSurfaceContext` — what a frame anchored to an object is about, and
 * the brand it draws in (frame contract v3, `@synap-core/types/cell-bridge`
 * `SurfaceContext`). Every host asks the pod through this one function
 * (tRPC `surfaces.context`, Hub `GET /surfaces/context`) and hands the answer
 * to its frame (`window.synap.context()`, the module frame's `synap:init`).
 *
 * What it reads, as the VIEWER (`scopedDb`, the viewer's own floor and any
 * key grant): the anchor itself (an object the viewer cannot read has no
 * context: `{ ok: false }`), the space it sits in, the project and the goal.
 *   entity    its space; its project when it is filed into exactly one the
 *             viewer can see (several: the host's project, when it is one of
 *             them; else none)
 *   document  the entity whose body it is, as an entity; else its own space
 *   workspace itself; the host's project, when the viewer can see it
 *   project   itself and its space
 *   track     its project (and that project's space); the goal is the track
 *   session   its space, project and goal (track)
 *   playbook  its space; the host's project, when visible
 *   view      its space and project
 *   profile   no space (a kind is pod-wide); the host's project, when visible
 *
 * The brand: the project's, through the ONE brand door (`resolveBrand`, the
 * rule behind `GET /brand/kit`: the project's brand, else the default one),
 * projected to `--synap-*` (`exportResolvedBrandKit(…, "synap-css")`) and
 * written as frame CSS by `brandFrameCss`. Default (overridable): an anchor in
 * NO project wears no brand, so a pod's default brand never repaints every
 * frame of every space. "No brand" (no project, no brand for it, a token set
 * that sets nothing) is `brand: null`, never a failure. A failed read THROWS.
 */

import {
  and,
  db as defaultDb,
  documents,
  entities,
  eq,
  focusSessions,
  inArray,
  isNull,
  playbooks,
  profiles,
  projects,
  projectTracks,
  relations,
  userVisibleWhere,
  views,
  workspaces,
} from "@synap/database";
import {
  brandFrameCss,
  type BrandFrameDeclarations,
  type SurfaceContext,
  type SurfaceContextBrand,
} from "@synap-core/types/cell-bridge";

import { AccessContext, scopedDb } from "../../access/index.js";
import { BELONGS_TO_PROJECT } from "../../utils/project-scope.js";
import {
  exportResolvedBrandKit,
  resolveBrand,
} from "../brand/brand-kit-service.js";

type Db = typeof defaultDb;

/** The kinds of object a frame can be anchored to (and the bodies that name themselves). */
export const SURFACE_CONTEXT_ANCHOR_KINDS = [
  "entity",
  "profile",
  "workspace",
  "project",
  "track",
  "playbook",
  "session",
  "document",
  "view",
] as const;
export type SurfaceContextAnchorKind =
  (typeof SURFACE_CONTEXT_ANCHOR_KINDS)[number];

export interface ResolveSurfaceContextInput {
  userId: string;
  /** Set when a Hub key acts for the user (an agent), as `AccessContext.agent`. */
  agentUserId?: string | null;
  anchor: { kind: SurfaceContextAnchorKind; id: string };
  /** The project the host is lensed on, if any: used only where the anchor names none. */
  projectId?: string | null;
  theme?: "light" | "dark";
  locale?: string;
}

export type SurfaceContextResult =
  | { ok: true; context: SurfaceContext }
  /** The anchor does not exist, or the viewer cannot read it. */
  | { ok: false };

interface Placement {
  workspaceId: string | null;
  /** The projects the anchor itself belongs to (visible to the viewer). */
  projectIds: string[];
  /** True when the anchor's own project is definitive (a session, a view…). */
  ownsProject: boolean;
  goalId: string | null;
}

/** Brand CSS by token-set hash and theme: the same brand is composed once. */
const BRAND_CSS_CACHE = new Map<string, string>();
const BRAND_CSS_CACHE_MAX = 200;

function cachedBrandCss(
  hash: string,
  theme: "light" | "dark",
  build: () => string
): string {
  const key = `${hash}:${theme}`;
  const hit = BRAND_CSS_CACHE.get(key);
  if (hit !== undefined) return hit;
  const css = build();
  if (BRAND_CSS_CACHE.size >= BRAND_CSS_CACHE_MAX) {
    const oldest = BRAND_CSS_CACHE.keys().next().value;
    if (oldest !== undefined) BRAND_CSS_CACHE.delete(oldest);
  }
  BRAND_CSS_CACHE.set(key, css);
  return css;
}

/** The projects an entity is filed into that the viewer can see, by id. */
async function entityProjectIds(
  access: AccessContext,
  entityId: string,
  db: Db
): Promise<string[]> {
  const filedInto = db
    .select({ id: relations.targetEntityId })
    .from(relations)
    .where(
      and(
        eq(relations.sourceEntityId, entityId),
        eq(relations.type, BELONGS_TO_PROJECT)
      )
    );
  const rows = await scopedDb(access).findMany<{ id: string }>(projects, {
    where: inArray(projects.id, filedInto),
    columns: { id: true },
  });
  return rows.map((r) => r.id).sort();
}

async function visibleProject(
  access: AccessContext,
  projectId: string
): Promise<{ id: string; workspaceId: string | null } | undefined> {
  return scopedDb(access).findFirst<{ id: string; workspaceId: string | null }>(
    projects,
    {
      where: eq(projects.id, projectId),
      columns: { id: true, workspaceId: true },
    }
  );
}

async function placeEntity(
  access: AccessContext,
  entityId: string,
  db: Db
): Promise<Placement | null> {
  const row = await scopedDb(access).findFirst<{
    id: string;
    workspaceId: string | null;
  }>(entities, {
    where: and(eq(entities.id, entityId), isNull(entities.deletedAt)),
    columns: { id: true, workspaceId: true },
  });
  if (!row) return null;
  return {
    workspaceId: row.workspaceId,
    projectIds: await entityProjectIds(access, row.id, db),
    ownsProject: false,
    goalId: null,
  };
}

/** Where the anchor sits, as the viewer sees it; null when they cannot read it. */
async function placeAnchor(
  access: AccessContext,
  userId: string,
  anchor: ResolveSurfaceContextInput["anchor"],
  db: Db
): Promise<Placement | null> {
  const sdb = scopedDb(access);
  const none = (workspaceId: string | null): Placement => ({
    workspaceId,
    projectIds: [],
    ownsProject: false,
    goalId: null,
  });
  switch (anchor.kind) {
    case "entity":
      return placeEntity(access, anchor.id, db);
    case "document": {
      const doc = await sdb.findFirst<{
        id: string;
        workspaceId: string | null;
      }>(documents, {
        where: and(eq(documents.id, anchor.id), isNull(documents.deletedAt)),
        columns: { id: true, workspaceId: true },
      });
      if (!doc) return null;
      // A document follows its entity (`documents.entityId` is gone: the
      // entity names its body).
      const owner = await sdb.findFirst<{ id: string }>(entities, {
        where: and(eq(entities.documentId, doc.id), isNull(entities.deletedAt)),
        columns: { id: true },
      });
      if (owner) {
        const placed = await placeEntity(access, owner.id, db);
        if (placed) return placed;
      }
      return none(doc.workspaceId);
    }
    case "workspace": {
      const [ws] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.id, anchor.id),
            isNull(workspaces.archivedAt),
            userVisibleWhere(workspaces.id, userId)
          )
        )
        .limit(1);
      return ws ? none(ws.id) : null;
    }
    case "project": {
      const project = await visibleProject(access, anchor.id);
      if (!project) return null;
      return {
        workspaceId: project.workspaceId,
        projectIds: [project.id],
        ownsProject: true,
        goalId: null,
      };
    }
    case "track": {
      const track = await sdb.findFirst<{ id: string; projectId: string }>(
        projectTracks,
        {
          where: eq(projectTracks.id, anchor.id),
          columns: { id: true, projectId: true },
        }
      );
      if (!track) return null;
      const project = await visibleProject(access, track.projectId);
      return {
        workspaceId: project?.workspaceId ?? null,
        projectIds: project ? [project.id] : [],
        ownsProject: true,
        goalId: track.id,
      };
    }
    case "session": {
      const session = await sdb.findFirst<{
        id: string;
        workspaceId: string | null;
        projectId: string | null;
        trackId: string | null;
      }>(focusSessions, {
        where: eq(focusSessions.id, anchor.id),
        columns: {
          id: true,
          workspaceId: true,
          projectId: true,
          trackId: true,
        },
      });
      if (!session) return null;
      const project = session.projectId
        ? await visibleProject(access, session.projectId)
        : undefined;
      return {
        workspaceId: session.workspaceId,
        projectIds: project ? [project.id] : [],
        ownsProject: true,
        goalId: session.trackId,
      };
    }
    case "playbook": {
      const playbook = await sdb.findFirst<{
        id: string;
        workspaceId: string | null;
      }>(playbooks, {
        where: eq(playbooks.id, anchor.id),
        columns: { id: true, workspaceId: true },
      });
      return playbook ? none(playbook.workspaceId) : null;
    }
    case "view": {
      const view = await sdb.findFirst<{
        id: string;
        workspaceId: string | null;
        projectId: string | null;
      }>(views, {
        where: eq(views.id, anchor.id),
        columns: { id: true, workspaceId: true, projectId: true },
      });
      if (!view) return null;
      const project = view.projectId
        ? await visibleProject(access, view.projectId)
        : undefined;
      return {
        workspaceId: view.workspaceId,
        projectIds: project ? [project.id] : [],
        ownsProject: !!view.projectId,
        goalId: null,
      };
    }
    case "profile": {
      // A pod-wide kind is read by every member; a space's own kind only by
      // those who see that space.
      const [profile] = await db
        .select({ id: profiles.id, workspaceId: profiles.workspaceId })
        .from(profiles)
        .where(eq(profiles.id, anchor.id))
        .limit(1);
      if (!profile) return null;
      if (!profile.workspaceId) return none(null);
      const [ws] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.id, profile.workspaceId),
            userVisibleWhere(workspaces.id, userId)
          )
        )
        .limit(1);
      return ws ? none(ws.id) : null;
    }
  }
}

/** The project's brand as frame CSS, or null when it has none to wear. */
async function projectBrand(
  args: {
    userId: string;
    projectId: string;
    theme: "light" | "dark";
  },
  db: Db
): Promise<SurfaceContextBrand | null> {
  const { resolution, kitSource } = await resolveBrand(
    { userId: args.userId, projectId: args.projectId },
    db
  );
  if (!resolution.ok) return null;
  const exported = exportResolvedBrandKit(kitSource, "synap-css");
  const css = cachedBrandCss(exported.hash, args.theme, () =>
    brandFrameCss(
      JSON.parse(exported.content) as BrandFrameDeclarations,
      args.theme
    )
  );
  if (!css) return null;
  return { id: resolution.brandIdentityId, hash: exported.hash, css };
}

/**
 * The context of a frame anchored to `anchor`, for the viewer `userId`
 * (see the module header). Throws when a read fails.
 */
export async function resolveSurfaceContext(
  input: ResolveSurfaceContextInput,
  db: Db = defaultDb
): Promise<SurfaceContextResult> {
  const access = AccessContext.agent({
    userId: input.userId,
    agentUserId: input.agentUserId ?? null,
  });
  const placed = await placeAnchor(access, input.userId, input.anchor, db);
  if (!placed) return { ok: false };

  let projectId: string | null = null;
  if (placed.ownsProject || placed.projectIds.length === 1) {
    projectId = placed.projectIds[0] ?? null;
  } else if (input.projectId) {
    const hinted =
      placed.projectIds.length > 1
        ? placed.projectIds.includes(input.projectId)
          ? input.projectId
          : null
        : ((await visibleProject(access, input.projectId))?.id ?? null);
    projectId = hinted;
  }

  const theme = input.theme === "light" ? "light" : "dark";
  const brand = projectId
    ? await projectBrand({ userId: input.userId, projectId, theme }, db)
    : null;

  return {
    ok: true,
    context: {
      anchor: { kind: input.anchor.kind, id: input.anchor.id },
      workspaceId: placed.workspaceId,
      projectId,
      goalId: placed.goalId,
      filters: {},
      brand,
      locale: input.locale ?? "en",
      theme,
    },
  };
}
