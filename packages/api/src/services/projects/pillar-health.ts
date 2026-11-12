/**
 * THE pillar read — where a project stands, space by space (goals / pillars /
 * health contract, founder validated 2026-11-12). Served by `projects.get`,
 * Hub `GET /projects/:id` and MCP `synap_get_project` (`mainGoal`,
 * `pillars`, `rootHealth`).
 *
 * A PILLAR is a space the project uses (`project --uses--> workspace`, its
 * line in `metadata.purpose`); only a linked space is one. Its goals are the
 * project's goals that advance it (`track --advances--> workspace`): the
 * PRIMARY ones (`metadata.primary`) make its health; the contributing ones
 * are listed with their own marks and change nothing — their sessions are not
 * counted here. Every number comes from an existing reader:
 *
 *   health     the pure rule (`derivePillarHealth`, `@synap-core/types/units`)
 *              over the primary goals; `sessions` = ONE union over those
 *              goals' trees, walked down PRIMARY parent edges only (a
 *              sub-goal sits in one tree), and the sessions spawned under
 *              them (`readGoalGroupWork`), never a sum per goal;
 *   stale      nothing moved in the window: no move of the pillar's things,
 *              sessions or advancing goals (`readScopeRollup` with BOTH
 *              lenses) and none in the primary goals' work;
 *   indicator  the things of declared-lifecycle kinds in the project AND the
 *              space, per kind (`readScopeRollup` `byKind`), plus a kind the
 *              space declares as an output (`readSpaceOutputs`) with none yet.
 *              No such kind ⇒ `declared: false`, never an invented one.
 *
 * Health is derived on every read, never stored. A project the caller cannot
 * see is `null`; a failed read THROWS (the doors mark it unavailable).
 *
 * NOT built (contract decision 3, follow-up): an owner's dated override
 * assertion on a pillar's health.
 */

import {
  and,
  asc,
  db,
  declaredLifecycleProfilesStatement,
  eq,
  getDb,
  inArray,
  links,
  profiles,
  projects,
  projectTracks,
  drizzleSql,
} from "@synap/database";
import type { ProjectTrack } from "@synap/database/schema";
import { isPrimaryLinkMetadata } from "@synap-core/types/connections";
import {
  derivePillarHealth,
  deriveProjectRootHealth,
  goalInPillarRollup,
  isGoalBet,
  type Pillar,
  type PillarGoal,
  type PillarIndicator,
  type PillarIndicatorCounts,
  type ProjectMainGoal,
  type ProjectPillars,
} from "@synap-core/types/units";
import type { LifecycleCategory } from "@synap-core/types/lifecycle";
import { AccessContext, scopedDb } from "../../access/index.js";
import {
  hydrateUsedWorkspaces,
  readUsesPurpose,
} from "../../utils/project-workspace.js";
import {
  readGoalGroupWork,
  readScopeRollup,
  type ScopeKindRollup,
} from "../status/status-rollup.js";
import { readSpaceOutputs } from "../lifecycle/flow-read.js";
import { loadVisibleProject } from "./load-visible-project.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "pillar-health" });

/** A goal advancing one of the project's spaces, as read. */
interface AdvancingGoal {
  workspaceId: string;
  primary: boolean;
  goal: Pick<
    ProjectTrack,
    "id" | "name" | "status" | "verdict" | "workKind" | "uncertainty"
  >;
}

const CATEGORIES: readonly LifecycleCategory[] = [
  "open",
  "active",
  "paused",
  "done",
  "lost",
];

function fullCounts(
  counts: Partial<Record<LifecycleCategory, number>>
): PillarIndicatorCounts {
  const out = {} as PillarIndicatorCounts;
  for (const c of CATEGORIES) out[c] = counts[c] ?? 0;
  return out;
}

/** The project's main goal, when the reader may see it. */
async function readMainGoal(
  projectId: string,
  userId: string
): Promise<ProjectMainGoal | null> {
  const [row] = await db
    .select({ mainGoalId: projects.mainGoalId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row?.mainGoalId) return null;
  const goal = await scopedDb(
    AccessContext.from({ userId })
  ).findFirst<ProjectTrack>(projectTracks, {
    where: eq(projectTracks.id, row.mainGoalId),
  });
  return goal ? { id: goal.id, name: goal.name, status: goal.status } : null;
}

/** The project's `uses` edges, oldest first, with each one's purpose. */
async function readUses(
  projectId: string
): Promise<Array<{ workspaceId: string; purpose: string | null }>> {
  // The literal keeps this reader visible to the `links-type-ssot` scan.
  const rows = await db
    .select({ workspaceId: links.toId, metadata: links.metadata })
    .from(links)
    .where(
      and(
        eq(links.linkType, "uses"),
        eq(links.fromType, "project"),
        eq(links.fromId, projectId),
        eq(links.toType, "workspace")
      )
    )
    .orderBy(asc(links.createdAt), asc(links.id));
  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    purpose: readUsesPurpose(r.metadata),
  }));
}

/** The project's goals the reader may see that advance one of `spaceIds`. */
async function readAdvancingGoals(
  projectId: string,
  spaceIds: string[],
  userId: string
): Promise<AdvancingGoal[]> {
  if (spaceIds.length === 0) return [];
  const rows = await db
    .select({
      workspaceId: links.toId,
      metadata: links.metadata,
      id: projectTracks.id,
      name: projectTracks.name,
      status: projectTracks.status,
      verdict: projectTracks.verdict,
      workKind: projectTracks.workKind,
      uncertainty: projectTracks.uncertainty,
    })
    .from(links)
    .innerJoin(
      projectTracks,
      drizzleSql`${projectTracks.id}::text = ${links.fromId}`
    )
    .where(
      and(
        eq(links.linkType, "advances"),
        eq(links.fromType, "track"),
        eq(links.toType, "workspace"),
        inArray(links.toId, spaceIds),
        eq(projectTracks.projectId, projectId),
        scopedDb(AccessContext.operator({ userId })).predicate(projectTracks)
      )
    )
    .orderBy(asc(projectTracks.createdAt), asc(projectTracks.id));
  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    primary: isPrimaryLinkMetadata(r.metadata),
    goal: {
      id: r.id,
      name: r.name,
      status: r.status,
      verdict: r.verdict,
      workKind: r.workKind,
      uncertainty: r.uncertainty,
    },
  }));
}

/**
 * The kinds a space DECLARES as its outputs (`settings.intent`) that carry a
 * declared lifecycle — listed in the indicator with zero things when the
 * project has none of them yet.
 */
async function readDeclaredOutputKinds(
  userId: string,
  workspaceId: string
): Promise<string[]> {
  const { primaryOutput, produces } = await readSpaceOutputs(
    userId,
    workspaceId
  );
  const slugs = [
    ...new Set([...(primaryOutput ? [primaryOutput] : []), ...produces]),
  ];
  if (slugs.length === 0) return [];
  const rows = await db
    .select({ slug: profiles.slug })
    .from(profiles)
    .where(
      and(
        inArray(profiles.slug, slugs),
        eq(profiles.profileKind, "kind"),
        drizzleSql`${profiles.id} IN (${declaredLifecycleProfilesStatement()})`
      )
    );
  return [...new Set(rows.map((r) => r.slug))];
}

function indicatorOf(
  kinds: readonly ScopeKindRollup[],
  declaredOutputs: readonly string[]
): PillarIndicator {
  const out = kinds.map((k) => ({
    kind: k.kind,
    byCategory: fullCounts(k.byCategory),
    stuck: k.stuck,
  }));
  for (const kind of declaredOutputs) {
    if (out.some((k) => k.kind === kind)) continue;
    out.push({ kind, byCategory: fullCounts({}), stuck: 0 });
  }
  return { declared: out.length > 0, kinds: out };
}

async function readPillar(
  userId: string,
  projectId: string,
  space: { id: string; name: string; purpose: string | null },
  advancing: readonly AdvancingGoal[]
): Promise<Pillar> {
  const goals: PillarGoal[] = advancing
    .filter((a) => goalInPillarRollup(a.goal))
    .map((a) => ({
      goalId: a.goal.id,
      name: a.goal.name,
      status: a.goal.status,
      verdict: a.goal.verdict ?? null,
      role: a.primary ? "primary" : "contributing",
      isBet: isGoalBet(a.goal),
    }));
  const primary = advancing.filter(
    (a) => a.primary && goalInPillarRollup(a.goal)
  );
  const [scope, work, declaredOutputs] = await Promise.all([
    readScopeRollup({
      userId,
      projectId,
      workspaceId: space.id,
      byKind: true,
    }),
    // Down PRIMARY parent edges only: a sub-goal with two parents counts in
    // its primary parent's pillar, once.
    readGoalGroupWork(
      userId,
      primary.map((a) => a.goal.id),
      { primaryOnly: true }
    ),
    readDeclaredOutputKinds(userId, space.id),
  ]);
  const stale = (scope?.moved ?? 0) === 0 && work.moved === 0;
  return {
    workspaceId: space.id,
    workspaceName: space.name,
    purpose: space.purpose,
    isLinked: true,
    health: {
      ...derivePillarHealth(
        primary.map((a) => a.goal),
        stale
      ),
      sessions: work.sessions,
    },
    indicator: indicatorOf(scope?.kinds ?? [], declaredOutputs),
    goals,
  };
}

/**
 * Where one project stands, pillar by pillar. `null` = the project is not
 * visible to `userId`. THROWS on a failed read.
 */
export async function readProjectPillars(
  userId: string,
  projectId: string
): Promise<ProjectPillars | null> {
  const project = await loadVisibleProject(await getDb(), projectId, userId);
  if (!project) return null;
  const [mainGoal, uses] = await Promise.all([
    readMainGoal(projectId, userId),
    readUses(projectId),
  ]);
  // A space the reader may not see is not drawn (its name is its own data).
  const visible = await hydrateUsedWorkspaces(
    await getDb(),
    uses.map((u) => u.workspaceId),
    userId
  );
  const purposeOf = new Map(uses.map((u) => [u.workspaceId, u.purpose]));
  const advancing = await readAdvancingGoals(
    projectId,
    visible.map((w) => w.id),
    userId
  );
  const pillars = await Promise.all(
    visible.map((w) =>
      readPillar(
        userId,
        projectId,
        { id: w.id, name: w.name, purpose: purposeOf.get(w.id) ?? null },
        advancing.filter((a) => a.workspaceId === w.id)
      )
    )
  );
  return {
    projectId,
    mainGoal,
    pillars,
    rootHealth: deriveProjectRootHealth(pillars),
  };
}

/** A failed pillar read, marked — never answered as "no pillars". */
export const PILLARS_UNAVAILABLE = { status: "unavailable" } as const;

/**
 * The fields `projects.get` / Hub `GET /projects/:id` add to a project read.
 * A failed read keeps the project readable: `pillars` and `rootHealth` come
 * back `{ status: "unavailable" }` (never `[]` — an empty list would read as
 * "no pillars"), and `mainGoal` is read on its own so it survives. The
 * failure is logged with the project id.
 */
export async function readProjectPillarFields(
  userId: string,
  projectId: string
): Promise<
  | Omit<ProjectPillars, "projectId">
  | {
      mainGoal: ProjectMainGoal | null;
      pillars: typeof PILLARS_UNAVAILABLE;
      rootHealth: typeof PILLARS_UNAVAILABLE;
    }
> {
  try {
    const read = await readProjectPillars(userId, projectId);
    if (read) {
      const { projectId: _id, ...fields } = read;
      return fields;
    }
  } catch (err) {
    logger.warn({ err, projectId }, "pillar health NOT read — unavailable");
  }
  return {
    mainGoal: await readMainGoal(projectId, userId),
    pillars: PILLARS_UNAVAILABLE,
    rootHealth: PILLARS_UNAVAILABLE,
  };
}
