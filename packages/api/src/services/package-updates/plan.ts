/**
 * THE update plan: "what would updating installed package X do, field by
 * field". The one service behind every update reader (pod admin's Updates tab
 * and Review page, the CLI, agents through Hub REST) and behind the apply.
 *
 * ONE COMPARATOR (backend-rules invariant 1). Each installed row is resolved
 * by the reconcile's own resolver (`resolveInstalledRow`) and compared by the
 * reconcile's own merge (`threeWayMergeFields`). A field the plan calls
 * `updates` is exactly a field the reconcile applies, which the parity test
 * pins (`plan.parity.pglite.test.ts`). Nothing here compares values itself:
 * the states are read off the merge's `applied` / `conflicted` / `ownerOwned`.
 *
 * Text fields both sides changed get a line-level 3-way merge
 * (`mergeText3`, `@synap-core/markdown-core`), offered only when the two edits
 * do not overlap (D2).
 *
 * Scope today: view, skill and automation packages (the rows that carry a
 * `metadata.marketSource` link). A space (workspace) update is not planned
 * here yet.
 */

import { TRPCError } from "@trpc/server";
import { mergeText3 } from "@synap-core/markdown-core";
import {
  countPackageFields,
  derivePackageUpdateNeeds,
  packageUpdateReviewPath,
  type PackageFieldState,
  type PackageUpdateChoiceName,
  type PackageUpdateField,
  type PackageUpdatePlan,
  type PackageUpdateList,
  type PackageUpdateSummary,
} from "@synap-core/types/package-updates";
import { resolvePackageFieldLabel } from "@synap-core/types/vocabulary";

import {
  threeWayMergeFields,
  type ThreeWayMergeResult,
} from "../capabilities/market-source.js";
import { lookupCatalogEntry } from "../capabilities/marketplace-install.js";
import {
  loadInstalledStandaloneRows,
  resolveInstalledRow,
  type InstalledStandaloneRow,
  type ResolvedStandaloneRow,
} from "../capabilities/reconcile-standalone-configs-to-templates.js";

/** One resolved row, compared. */
export interface PlannedRow {
  resolved: ResolvedStandaloneRow;
  merge: ThreeWayMergeResult;
  fields: PackageUpdateField[];
  /** Keyed `<rowId>:<field>`. */
  recommended: Record<string, PackageUpdateChoiceName>;
}

/** Compare one resolved row: the merge, each field's state, the merges. */
export function planRow(resolved: ResolvedStandaloneRow): PlannedRow {
  const { live, desired, source } = resolved;
  const base = source.baseline;
  const merge = threeWayMergeFields(live, base, desired);
  const applied = new Set(merge.applied);
  const conflicted = new Set(merge.conflicted);
  const ownerOwned = new Set(merge.ownerOwned);
  const rowId = resolved.row.id as string;
  const fields: PackageUpdateField[] = [];
  const recommended: Record<string, PackageUpdateChoiceName> = {};

  // The fields the catalog provides; one it dropped is left on the row and
  // never compared again (prune OFF), so it has no state to show.
  for (const key of Object.keys(desired)) {
    const state: PackageFieldState = applied.has(key)
      ? "updates"
      : conflicted.has(key)
        ? "both"
        : ownerOwned.has(key)
          ? "yours"
          : "same";
    const field: PackageUpdateField = {
      key,
      label: resolvePackageFieldLabel(key),
      state,
      base: base[key] ?? null,
      desired: desired[key] ?? null,
      live: live[key] ?? null,
    };
    if (
      state === "both" &&
      typeof base[key] === "string" &&
      typeof live[key] === "string" &&
      typeof desired[key] === "string"
    ) {
      const m = mergeText3(
        base[key] as string,
        live[key] as string,
        desired[key] as string
      );
      field.merged = m.merged;
      field.overlap = m.conflicts.length > 0;
      if (m.merged !== null) {
        // The pod's edit is already inside the catalog's text: taking the
        // catalog's loses nothing. Otherwise the merge keeps both edits.
        recommended[`${rowId}:${key}`] =
          m.merged === desired[key] ? "catalog" : "combine";
      }
    }
    fields.push(field);
  }
  return { resolved, merge, fields, recommended };
}

/** Resolve a row, or throw why its catalog cannot be read (never "empty"). */
async function resolveOrThrow(
  installed: InstalledStandaloneRow
): Promise<ResolvedStandaloneRow> {
  const r = await resolveInstalledRow(installed);
  if (!r.ok) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Cannot compare "${installed.source.packageSlug}" with the catalog: ${r.reason}`,
    });
  }
  return r.resolved;
}

/** Every installed row of one package, compared. Throws NOT_FOUND when none. */
export async function planPackageRows(slug: string): Promise<PlannedRow[]> {
  const installed = await loadInstalledStandaloneRows({ packageSlugs: [slug] });
  if (installed.length === 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Nothing installed on this pod comes from the package "${slug}".`,
    });
  }
  const planned: PlannedRow[] = [];
  for (const row of installed) planned.push(planRow(await resolveOrThrow(row)));
  return planned;
}

function summaryHead(planned: PlannedRow[]) {
  const first = planned[0]!.resolved;
  return {
    slug: first.source.packageSlug,
    kind: first.adapter.catalogKind as string,
    name: first.catalogName,
    installedVersion: first.source.packageVersion,
    latestVersion: first.catalogVersion,
  };
}

/** The full plan of one package: every row, every field, with values. */
export async function getPackageUpdatePlan(
  slug: string
): Promise<PackageUpdatePlan> {
  const planned = await planPackageRows(slug);
  const fields = planned.flatMap((p) => p.fields);
  const counts = countPackageFields(fields);
  const recommended = Object.assign({}, ...planned.map((p) => p.recommended));
  return {
    ...summaryHead(planned),
    rows: planned.map((p) => ({
      rowKind: p.resolved.adapter.kind,
      rowId: p.resolved.row.id as string,
      name: (p.resolved.row.name as string) ?? "",
      fields: p.fields,
    })),
    ...(Object.keys(recommended).length > 0 ? { recommended } : {}),
    counts,
    needs: derivePackageUpdateNeeds(counts),
  };
}

/**
 * Every installed package whose catalog version moved, with its counts. The
 * expensive pass (one definition fetch per package) runs only for those: a
 * package whose rows all carry the catalog's version is up to date (the
 * reconcile stamps the version only once no field is conflicted, S1).
 *
 * A package whose catalog cannot be read is listed under `unreadable` with
 * the reason: the list never reads "nothing waiting" for what it could not
 * compare. A failed read of the installed rows throws.
 */
export async function listPackageUpdates(): Promise<PackageUpdateList> {
  const installed = await loadInstalledStandaloneRows();
  const bySlug = new Map<string, InstalledStandaloneRow[]>();
  for (const row of installed) {
    const list = bySlug.get(row.source.packageSlug) ?? [];
    list.push(row);
    bySlug.set(row.source.packageSlug, list);
  }

  const updates: PackageUpdateSummary[] = [];
  const unreadable: PackageUpdateList["unreadable"] = [];
  for (const [slug, rows] of bySlug) {
    const kind = rows[0]!.adapter.catalogKind as string;
    const name = (rows[0]!.row.name as string) ?? slug;
    try {
      const entry = await lookupCatalogEntry(
        rows[0]!.adapter.catalogKind,
        slug
      );
      if (!entry) {
        unreadable.push({
          slug,
          kind,
          name,
          reason: "This package is not in the pod's copy of the catalog.",
        });
        continue;
      }
      if (rows.every((r) => r.source.packageVersion === entry.version)) {
        continue;
      }
      const planned: PlannedRow[] = [];
      for (const row of rows) planned.push(planRow(await resolveOrThrow(row)));
      const counts = countPackageFields(planned.flatMap((p) => p.fields));
      updates.push({
        ...summaryHead(planned),
        counts,
        dataChanges: 0,
        needs: derivePackageUpdateNeeds(counts),
        reviewUrl: packageUpdateReviewPath(slug),
      });
    } catch (err) {
      unreadable.push({
        slug,
        kind,
        name,
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }
  return { updates, unreadable };
}
