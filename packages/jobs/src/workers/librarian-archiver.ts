/**
 * Librarian — Project Archiver Worker (P1)
 *
 * A project is a COMMITMENT WITH GRAVITY. AI agents historically minted projects
 * per git-repo / per-feature / per-task, leaving many 0-gravity projects `active`
 * forever. This daily job proposes archival (never auto-archives) of ACTIVE
 * projects that:
 *   - are older than ARCHIVE_MIN_AGE_DAYS, AND
 *   - have ZERO `belongs_to_project` members (no entity filed into them), AND
 *   - have ZERO `project_members` rows.
 *
 * Files ONE PENDING `project/archive` proposal per project via the
 * insertPendingProposal SSOT. Idempotent: skips a project that already has an
 * open (PENDING) archive proposal. On approval the `project/archive` executor
 * flips the project to `archived`.
 *
 * workspaceId convention: pass the project's own workspaceId through — which may
 * be NULL for pod-wide projects. This mirrors pod-hygiene-near-dup, which files
 * null-workspace (pod-personal) proposals directly; the owner reviews them.
 *
 * Queue: librarian.project-archiver
 * Cron:  daily 45 3 * * * (after pod-hygiene near-dup at 03:15)
 */

import {
  db,
  projects,
  projectMembers,
  relations,
  proposals,
  insertPendingProposal,
  BELONGS_TO_PROJECT,
  ProposalStatus,
  eq,
  and,
  lt,
  inArray,
  drizzleSql,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";

const logger = createLogger({ module: "librarian-archiver" });

export const LIBRARIAN_ARCHIVER_QUEUE = "librarian.project-archiver";

/** After pod-hygiene near-dup at 03:15 — keep hygiene jobs in the 03:xx window. */
export const LIBRARIAN_ARCHIVER_CRON = "45 3 * * *";

/** A project must be at least this old (days) to be an archive candidate. */
export const ARCHIVE_MIN_AGE_DAYS = 30;

/** Safety cap: never file more than this many archive proposals in one run. */
export const MAX_ARCHIVE_PROPOSALS_PER_RUN = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Pure selection (exported for unit tests) ──────────────────────────────────

export interface ArchiveCandidateProject {
  id: string;
  name: string;
  userId: string;
  workspaceId: string | null;
  createdAt: Date;
}

/** A project is old enough to consider archiving. */
export function isArchiveEligible(
  project: { createdAt: Date },
  opts: { now: Date; minAgeDays: number }
): boolean {
  const ageMs = opts.now.getTime() - project.createdAt.getTime();
  return ageMs >= opts.minAgeDays * DAY_MS;
}

/**
 * Select archive candidates: old enough AND zero `belongs_to_project` members
 * AND zero `project_members`. Pure — the caller supplies the per-project counts.
 */
export function selectArchiveCandidates(
  candidates: ArchiveCandidateProject[],
  linkCountById: Map<string, number>,
  memberCountById: Map<string, number>,
  opts: { now: Date; minAgeDays: number }
): ArchiveCandidateProject[] {
  return candidates.filter(
    (p) =>
      isArchiveEligible(p, opts) &&
      (linkCountById.get(p.id) ?? 0) === 0 &&
      (memberCountById.get(p.id) ?? 0) === 0
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * Cron / on-demand handler.
 * Manual trigger: `await boss.send("librarian.project-archiver", {})`
 */
export async function handleLibrarianArchiver(): Promise<void> {
  const now = new Date();
  // postgres.js: never pass a Date object as a param — bind the ISO string.
  const cutoffIso = new Date(
    now.getTime() - ARCHIVE_MIN_AGE_DAYS * DAY_MS
  ).toISOString();

  logger.info(
    { cutoffIso, minAgeDays: ARCHIVE_MIN_AGE_DAYS },
    "librarian.project-archiver: starting scan"
  );

  // Active projects older than the age floor.
  const stale: ArchiveCandidateProject[] = await db
    .select({
      id: projects.id,
      name: projects.name,
      userId: projects.userId,
      workspaceId: projects.workspaceId,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(
      and(
        eq(projects.status, "active"),
        lt(projects.createdAt, drizzleSql`${cutoffIso}::timestamptz`)
      )
    );

  if (stale.length === 0) {
    logger.info("librarian.project-archiver: no stale active projects");
    return;
  }

  const ids = stale.map((p) => p.id);

  // Per-project `belongs_to_project` member counts (relation target = project id).
  const linkRows = await db
    .select({
      projectId: relations.targetEntityId,
      count: drizzleSql<number>`cast(count(*) as integer)`,
    })
    .from(relations)
    .where(
      and(
        eq(relations.type, BELONGS_TO_PROJECT),
        inArray(relations.targetEntityId, ids)
      )
    )
    .groupBy(relations.targetEntityId);
  const linkCountById = new Map<string, number>();
  for (const r of linkRows) {
    if (r.projectId) linkCountById.set(r.projectId, r.count);
  }

  // Per-project explicit member counts.
  const memberRows = await db
    .select({
      projectId: projectMembers.projectId,
      count: drizzleSql<number>`cast(count(*) as integer)`,
    })
    .from(projectMembers)
    .where(inArray(projectMembers.projectId, ids))
    .groupBy(projectMembers.projectId);
  const memberCountById = new Map<string, number>();
  for (const r of memberRows) memberCountById.set(r.projectId, r.count);

  // Idempotency: skip projects that already have an OPEN archive proposal.
  const openArchiveRows = await db
    .select({ targetId: proposals.targetId })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, "project"),
        eq(proposals.proposalType, "archive"),
        eq(proposals.status, ProposalStatus.PENDING),
        inArray(proposals.targetId, ids)
      )
    );
  const alreadyOpen = new Set(openArchiveRows.map((r) => r.targetId));

  const candidates = selectArchiveCandidates(
    stale,
    linkCountById,
    memberCountById,
    { now, minAgeDays: ARCHIVE_MIN_AGE_DAYS }
  )
    .filter((p) => !alreadyOpen.has(p.id))
    .slice(0, MAX_ARCHIVE_PROPOSALS_PER_RUN);

  let created = 0;
  for (const project of candidates) {
    try {
      const ageDays = Math.floor(
        (now.getTime() - project.createdAt.getTime()) / DAY_MS
      );
      const { proposal } = await insertPendingProposal({
        // Pass the project's own workspace (may be null for pod-wide projects) —
        // same convention pod-hygiene-near-dup uses for its owner-reviewed rows.
        workspaceId: project.workspaceId,
        targetType: "project",
        targetId: project.id,
        proposalType: "archive",
        data: {
          id: project.id,
          name: project.name,
          reason: `This project has had no entities filed into it and no members for ${ageDays} days. Archiving keeps it as a record without cluttering the active list. Nothing is deleted — approve to archive, or reject to keep it active.`,
          ageDays,
          changeType: "archive",
        },
        // The project owner is who should review; system is the producer.
        createdBy: project.userId,
        proposedByUserId: null,
      });

      // Mirror createPendingProposal's proposal.created side-effect so the inbox
      // sees the row. Fire-and-forget — never fail the scan on notification error.
      void emitSideEffects({
        subjectType: "proposal",
        action: "created",
        subjectId: proposal.id,
        userId: project.userId,
        workspaceId: project.workspaceId ?? undefined,
        data: {
          proposalStatus: "created",
          targetType: "project",
          changeType: "archive",
        },
      }).catch((err) => {
        logger.warn(
          { err, proposalId: proposal.id, projectId: project.id },
          "librarian.project-archiver: emitSideEffects failed (non-fatal)"
        );
      });

      created += 1;
    } catch (err) {
      logger.error(
        { err, projectId: project.id },
        "librarian.project-archiver: failed to file proposal, skipping"
      );
    }
  }

  logger.info(
    {
      staleActive: stale.length,
      eligible: candidates.length,
      created,
    },
    "librarian.project-archiver: scan complete"
  );
}
