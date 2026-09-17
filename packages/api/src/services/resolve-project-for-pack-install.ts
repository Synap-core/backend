/**
 * Resolve the engagement Project for a package install.
 *
 * Product lock: suite install can mint a Project whose **name the buyer types**,
 * then stamp uses-edges onto shared domain workspaces. Reuse by exact name for
 * the same user; never clone CRM.
 */
import {
  getDb,
  sql,
  projects,
  and,
  eq,
  ProjectRepository,
  EventRepository,
  buildProjectProvenance,
} from "@synap/database";
import { ownerPrivateVisibleWhere } from "../utils/user-visible-where.js";

export type ResolveProjectForPackInstallResult =
  { projectId: string; created: boolean; reused: boolean } | { error: string };

export async function resolveProjectForPackInstall(opts: {
  userId: string;
  agentUserId?: string;
  /** Reuse this project (must be visible). */
  projectId?: string;
  /** Create or reuse by exact name. */
  projectName?: string;
  /** Stamped into metadata for idempotent re-install. */
  packageSlug?: string;
  homeWorkspaceId?: string | null;
}): Promise<ResolveProjectForPackInstallResult> {
  const {
    userId,
    agentUserId,
    projectId,
    projectName,
    packageSlug,
    homeWorkspaceId,
  } = opts;
  const db = await getDb();

  if (projectId) {
    const [row] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          ownerPrivateVisibleWhere(
            projects.workspaceId,
            projects.userId,
            userId
          )
        )
      )
      .limit(1);
    if (!row) return { error: `Project ${projectId} not found or not visible` };
    return { projectId: row.id, created: false, reused: true };
  }

  const name = projectName?.trim();
  if (!name) return { error: "projectId or projectName is required" };

  // Exact-name reuse for this user (active).
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.name, name),
        eq(projects.status, "active"),
        ownerPrivateVisibleWhere(projects.workspaceId, projects.userId, userId)
      )
    )
    .limit(1);
  if (existing) {
    return { projectId: existing.id, created: false, reused: true };
  }

  // Agents must not skip gravity via this door — they pass projectId after a
  // governed create, or the human types the name.
  if (agentUserId) {
    return {
      error:
        "Agents cannot mint a project from projectName alone (gravity). Pass projectId from a prior synap_create_project, or have the human supply the name on install.",
    };
  }

  const eventRepo = new EventRepository(sql);
  const repo = new ProjectRepository(db, eventRepo);
  const created = await repo.create(
    {
      name,
      description: packageSlug
        ? `Engagement installed from package ${packageSlug}`
        : undefined,
      status: "active",
      userId,
      workspaceId: homeWorkspaceId ?? null,
      metadata: packageSlug
        ? { packageSlug, source: "packages.apply" }
        : { source: "packages.apply" },
      provenance: buildProjectProvenance({
        door: "hub-rest",
        agentUserId: undefined,
      }),
    },
    userId
  );

  return {
    projectId: created.id,
    created: !created.deduped,
    reused: !!created.deduped,
  };
}
