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
 * Which packages have an update is NOT decided here: it is the one
 * derivation `listInstalledPackages` (`standing.ts`, rule `packageHasUpdate`),
 * for every installed kind. This module plans what an update does: field by
 * field for a view/skill/automation package (`comparedBy: "field"`), as a
 * whole for a space's template or a capability (`comparedBy: "package"`: no
 * field rows; a space's changes to existing records are listed for consent).
 */

import { TRPCError } from "@trpc/server";
import { mergeText3 } from "@synap-core/markdown-core";
import {
  sql,
  pendingTemplateDataChanges,
  type TemplateDataChange,
} from "@synap/database";
import {
  countPackageFields,
  derivePackageUpdateNeeds,
  deriveWholePackageNeeds,
  packageUpdateComparedBy,
  packageUpdateReviewPath,
  type PackageDataChange,
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
import { resolveWorkspaceTemplate } from "../capabilities/resolve-workspace-template.js";
import {
  loadInstalledStandaloneRows,
  resolveInstalledRow,
  type InstalledStandaloneRow,
  type ResolvedStandaloneRow,
} from "../capabilities/reconcile-standalone-configs-to-templates.js";
import {
  listInstalledPackages,
  toStanding,
  type InstalledPackage,
} from "./standing.js";

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
  const installed = await loadInstalledStandaloneRows({ packageSlugs: [slug] });
  if (installed.length === 0) {
    const whole = (await listInstalledPackages()).find(
      (p) => p.slug === slug && packageUpdateComparedBy(p.kind) === "package"
    );
    if (whole) return wholePackagePlan(whole);
  }
  const planned = await planPackageRows(slug);
  const fields = planned.flatMap((p) => p.fields);
  const counts = countPackageFields(fields);
  const recommended = Object.assign({}, ...planned.map((p) => p.recommended));
  return {
    ...summaryHead(planned),
    comparedBy: "field",
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

const NO_FIELDS: Record<PackageFieldState, number> = {
  updates: 0,
  yours: 0,
  both: 0,
  same: 0,
};

/**
 * The changes to existing records a space's template update waits on: the
 * conversion manifest's pending ops that touch the template's profiles, each
 * counted by the engine's own dry run (`pendingTemplateDataChanges`, what
 * `POST /packages/apply` asks consent for). Throws when they cannot be read:
 * never "no changes" for a read that failed.
 */
export async function pendingSpaceDataChanges(
  slug: string
): Promise<TemplateDataChange[]> {
  const resolved = await resolveWorkspaceTemplate(slug);
  const definition = resolved?.packageDefinition as
    { profiles?: unknown } | undefined;
  const profileSlugs = (
    (definition?.profiles ?? []) as Array<{ slug?: unknown }>
  )
    .map((p) => p.slug)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  return pendingTemplateDataChanges(sql, profileSlugs);
}

/** The same changes, as the plan shows them to a person. */
export async function spaceDataChanges(
  slug: string
): Promise<PackageDataChange[]> {
  return (await pendingSpaceDataChanges(slug)).map((c) => ({
    id: c.opKey,
    sentence: c.description,
    affected: c.affected,
    destructive: c.destructive,
  }));
}

/** A whole-package update: its versions, and a space's data changes. */
async function wholePackagePlan(
  p: InstalledPackage
): Promise<PackageUpdatePlan> {
  if (p.hasUpdate !== true) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message:
        p.hasUpdate === false
          ? `"${p.slug}" is up to date: no update waits for it.`
          : `Cannot compare "${p.slug}" with the catalog: ${p.reason ?? "unknown reason"}`,
    });
  }
  const items = p.kind === "workspace" ? await spaceDataChanges(p.slug) : [];
  const consentable = items.filter((c) => !c.destructive).length;
  return {
    slug: p.slug,
    kind: p.kind,
    comparedBy: "package",
    name: p.name,
    installedVersion: p.installedVersion,
    latestVersion: p.latestVersion,
    rows: [],
    ...(items.length > 0
      ? {
          dataChanges: {
            count: items.length,
            items,
            needsPodAdmin: items.some((c) => c.destructive),
          },
        }
      : {}),
    counts: { ...NO_FIELDS },
    needs: deriveWholePackageNeeds(consentable),
  };
}

/**
 * Every installed package with an update, read off the one derivation
 * (`listInstalledPackages`), with what each needs from a person. A
 * view/skill/automation package is compared field by field here (one
 * definition fetch per package, only for those with an update); a space or a
 * capability is updated as a whole.
 *
 * `unreadable` names every package that could not be compared (no catalog
 * copy, no version stamp, a catalog read that failed) with the reason: the
 * list never reads "nothing waiting" for what it could not compare.
 * `installed` carries every package's verdict, for readers that list the
 * up-to-date ones too (the CLI). A failed read of what is installed throws.
 */
export async function listPackageUpdates(): Promise<PackageUpdateList> {
  const packages = await listInstalledPackages();
  const updates: PackageUpdateSummary[] = [];
  const unreadable: PackageUpdateList["unreadable"] = [];

  for (const p of packages) {
    if (p.hasUpdate === null) {
      unreadable.push({
        slug: p.slug,
        kind: p.kind,
        name: p.name,
        reason: p.reason ?? "unknown reason",
      });
      continue;
    }
    if (!p.hasUpdate) continue;
    try {
      if (packageUpdateComparedBy(p.kind) === "package") {
        const dataChanges =
          p.kind === "workspace"
            ? (await spaceDataChanges(p.slug)).filter((c) => !c.destructive)
                .length
            : 0;
        updates.push({
          slug: p.slug,
          kind: p.kind,
          comparedBy: "package",
          name: p.name,
          installedVersion: p.installedVersion,
          latestVersion: p.latestVersion,
          counts: { ...NO_FIELDS },
          dataChanges,
          needs: deriveWholePackageNeeds(dataChanges),
          reviewUrl: packageUpdateReviewPath(p.slug),
        });
        continue;
      }
      const planned: PlannedRow[] = [];
      for (const row of p.rows)
        planned.push(planRow(await resolveOrThrow(row)));
      const counts = countPackageFields(planned.flatMap((r) => r.fields));
      updates.push({
        ...summaryHead(planned),
        comparedBy: "field",
        counts,
        dataChanges: 0,
        needs: derivePackageUpdateNeeds(counts),
        reviewUrl: packageUpdateReviewPath(p.slug),
      });
    } catch (err) {
      unreadable.push({
        slug: p.slug,
        kind: p.kind,
        name: p.name,
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }
  return { updates, unreadable, installed: packages.map(toStanding) };
}
