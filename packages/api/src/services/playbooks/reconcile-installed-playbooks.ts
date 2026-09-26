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
 * needs grant resolution and an install context — that is the install door's
 * job. Such a playbook is reported `missing`.
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

export interface WorkspacePlaybooksReconcileReport {
  results: InstalledPlaybookReconcileResult[];
  /** Template playbooks with no live row in the workspace (install creates them). */
  missing: string[];
  /** Rows whose reconcile threw — reported, never fatal. */
  failed: Array<{ name: string; error: string }>;
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
        report.missing.push(name);
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
