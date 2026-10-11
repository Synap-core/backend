/**
 * reconcile-installed-playbooks — converge package-installed playbooks to their
 * template (the effectful half of `playbook-market-source.ts`).
 *
 * Two callers, one engine:
 *  - the package applier's REUSE branch (`package-apply-post-workspace.ts`): a
 *    re-install / version update of a package now reaches the playbook it
 *    already installed instead of silently reusing it as-is;
 *  - the boot pass (`apps/api/src/startup/reconcile-workspaces-to-templates.ts`)
 *    for every workspace's base template and every pack recorded in
 *    `settings.installedPacks` — so a playbook installed by ANY door (including
 *    the browser/loop door, which stamps nothing) is adopted and converged.
 *
 * Every write goes through the GOVERNED `playbooks.update` caller (never a raw
 * UPDATE), exactly like the standalone-config reconcile. Owner-edited fields are
 * reported, never overwritten. Tracks are never touched (they run off their own
 * `definition_snapshot`). Non-fatal per row.
 *
 * Boot does NOT create a playbook the template added after install: creation
 * needs grant resolution and an install context — that is the apply door's job
 * (`POST /packages/apply` creates it, also on a same-version re-apply). Such a
 * playbook is reported `missing`, and a `missing` playbook WITHHOLDS the version
 * stamp (`playbookReportConverged`): a stamp that claimed the template while a
 * playbook it declares was never created would make the next apply short-circuit
 * as up to date, and the playbook would reach the pod never.
 *
 * A template playbook the OWNER archived is not missing: it is reported
 * `ownerArchived`, never recreated by the apply door, and does not withhold the
 * stamp ({@link findOwnerArchivedPlaybook} is the one predicate both use).
 */

import type { Context } from "../../types/context.js";
import { planPlaybookReconcile } from "./playbook-market-source.js";

export interface InstalledPlaybookReconcileResult {
  playbookId: string;
  name: string;
  kind: "up-to-date" | "updated" | "adopted" | "foreign" | "proposed";
  applied: string[];
  ownerOwned: string[];
}

/** Reconcile ONE installed row against its template element. */
export async function reconcileInstalledPlaybook(args: {
  ctx: Context;
  row: Record<string, unknown>;
  templateElement: unknown;
  packageSlug: string;
  packageVersion: string | null;
  installedAt: string;
  dryRun?: boolean;
}): Promise<InstalledPlaybookReconcileResult> {
  const plan = planPlaybookReconcile(args);
  const base = {
    playbookId: args.row.id as string,
    name: (args.row.name as string) ?? "",
    applied: plan.applied,
    ownerOwned: plan.ownerOwned,
  };
  const needsWrite = Object.keys(plan.patch).length > 0 || !!plan.metadata;
  if (plan.kind === "foreign" || !needsWrite || args.dryRun) {
    // Nothing to write — but the declared activators may still owe a rule (a
    // denied/failed compile on an earlier pass, a rule its owner deleted).
    // Converge them; the write path below does it inside `playbooks.update`.
    if (plan.kind !== "foreign" && !args.dryRun) {
      await convergeActivators(base.playbookId, args.ctx);
    }
    return { ...base, kind: plan.kind };
  }
  const { playbooksRouter } = await import("../../routers/playbooks.js");
  const res = (await playbooksRouter.createCaller(args.ctx).update({
    id: base.playbookId,
    ...plan.patch,
    ...(plan.metadata ? { metadata: plan.metadata } : {}),
  } as Parameters<
    ReturnType<typeof playbooksRouter.createCaller>["update"]
  >[0])) as { status?: string };
  return {
    ...base,
    kind: res?.status === "proposed" ? "proposed" : plan.kind,
  };
}

/** Non-fatal (the ONE wrapper): an activator pass never fails the reconcile. */
async function convergeActivators(playbookId: string, ctx: Context) {
  const userId = ctx.userId;
  if (!userId) return; // no actor to attribute a rule to — the next write converges
  const { convergePlaybookActivatorsSafely } =
    await import("./playbook-activators.js");
  await convergePlaybookActivatorsSafely({ playbookId, userId });
}

/**
 * The owner archived this template playbook: an archived row of that name in
 * the workspace, and no live one (the caller has already looked for a live
 * one). The apply door does not recreate it and boot does not report it
 * `missing` — archive is how an owner deletes a playbook (`playbooks.archive`;
 * there is no hard delete), so the template must not bring it back.
 */
export async function findOwnerArchivedPlaybook(
  workspaceId: string,
  name: string
): Promise<{ id: string } | null> {
  const {
    db,
    and,
    eq,
    drizzleSql,
    playbooks: playbooksTable,
  } = await import("@synap/database");
  const [row] = await db
    .select({ id: playbooksTable.id })
    .from(playbooksTable)
    .where(
      and(
        drizzleSql`lower(${playbooksTable.name}) = lower(${name})`,
        eq(playbooksTable.workspaceId, workspaceId),
        eq(playbooksTable.status, "archived")
      )
    )
    .limit(1);
  return row ?? null;
}

export interface WorkspacePlaybooksReconcileReport {
  results: InstalledPlaybookReconcileResult[];
  /** Template playbooks with no row in the workspace (the apply door creates them). */
  missing: string[];
  /** Template playbooks the owner archived — respected, never recreated. */
  ownerArchived: string[];
  /** Rows whose reconcile threw — reported, never fatal. */
  failed: Array<{ name: string; error: string }>;
}

/**
 * Did this workspace's playbooks CONVERGE? The only question a version stamp may
 * answer (backend-rules invariant 1: never stamp a marker you did not earn).
 * A `proposed` row is a change QUEUED for review, not applied — counting it as
 * converged advanced the stamp and re-filed the proposal every boot. A
 * `missing` playbook was never created, so it is not converged either (an
 * owner-archived one is not missing). Every
 * stamping caller (the installed-packs ledger, the boot base-template pass)
 * asks this one predicate.
 */
export function playbookReportConverged(
  report: Pick<
    WorkspacePlaybooksReconcileReport,
    "results" | "failed" | "missing"
  >
): boolean {
  return (
    report.failed.length === 0 &&
    report.missing.length === 0 &&
    report.results.every((r) => r.kind !== "proposed")
  );
}

/**
 * Reconcile every playbook a template declares into ONE workspace. `workspaceId`
 * null = the pod-wide rows (a pack's project-scope methods).
 */
export async function reconcileWorkspacePlaybooksToTemplate(args: {
  workspaceId: string | null;
  /** Governed-write attribution: the workspace owner (or the installing user). */
  userId: string;
  templatePlaybooks: unknown[];
  packageSlug: string;
  packageVersion: string | null;
  installedAt: string;
  dryRun?: boolean;
}): Promise<WorkspacePlaybooksReconcileReport> {
  const report: WorkspacePlaybooksReconcileReport = {
    results: [],
    missing: [],
    ownerArchived: [],
    failed: [],
  };
  if (args.templatePlaybooks.length === 0) return report;
  const {
    db,
    and,
    eq,
    ne,
    isNull,
    asc,
    drizzleSql,
    playbooks: playbooksTable,
  } = await import("@synap/database");
  const ctx = {
    db,
    authenticated: true,
    userId: args.userId,
    workspaceId: args.workspaceId,
    workspaceRole: "owner",
  } as unknown as Context;

  for (const el of args.templatePlaybooks) {
    const name =
      el && typeof el === "object"
        ? ((el as { name?: unknown }).name as string | undefined)
        : undefined;
    if (!name) continue;
    try {
      const [row] = await db
        .select()
        .from(playbooksTable)
        .where(
          and(
            drizzleSql`lower(${playbooksTable.name}) = lower(${name})`,
            args.workspaceId
              ? eq(playbooksTable.workspaceId, args.workspaceId)
              : isNull(playbooksTable.workspaceId),
            ne(playbooksTable.status, "archived")
          )
        )
        .orderBy(asc(playbooksTable.createdAt), asc(playbooksTable.id))
        .limit(1);
      if (!row) {
        if (
          args.workspaceId &&
          (await findOwnerArchivedPlaybook(args.workspaceId, name))
        ) {
          report.ownerArchived.push(name);
        } else {
          report.missing.push(name);
        }
        continue;
      }
      report.results.push(
        await reconcileInstalledPlaybook({
          ctx,
          row: row as unknown as Record<string, unknown>,
          templateElement: el,
          packageSlug: args.packageSlug,
          packageVersion: args.packageVersion,
          installedAt: args.installedAt,
          dryRun: args.dryRun,
        })
      );
    } catch (err) {
      report.failed.push({
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}
