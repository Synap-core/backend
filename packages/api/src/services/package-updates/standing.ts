/**
 * THE derivation of "this installed package has an update", for every kind
 * a package installs: a space's template and the overlay packs on it
 * (workspace), capability containers, and the source-linked views, skills
 * and automations. One verdict per package (slug + kind), decided by the one
 * rule `packageHasUpdate` (`@synap-core/types/package-updates`): the version
 * the pod last converged to against the catalog's, both the Control Plane's
 * content hash of the definition.
 *
 * Every reader reads it: pod admin's Updates (`packageUpdates.list`), the CLI's
 * `market update` (Hub `GET /package-updates`), the plan and the apply of a
 * whole-package update. None of them compares versions itself.
 *
 * Cheap: local reads only (the workspaces, the capability containers, the
 * source-linked rows, `cp_catalog_cache`). The field-by-field comparison of a
 * view/skill/automation package (one definition fetch per package) is the
 * plan's (`plan.ts`), run only for the packages this says have an update.
 *
 * Cells are not here: a cell has no reconciler and no comparator, so nothing
 * could answer for it (`GET /installed` lists them with `drift: null`).
 */

import {
  db,
  workspaces,
  capabilities,
  readTemplateState,
} from "@synap/database";
import {
  contentHashVersion,
  packageHasUpdate,
  type InstalledPackageKind,
  type PackageStanding,
} from "@synap-core/types/package-updates";

import { queryCatalogCache } from "../capabilities/catalog-cache-query.js";
import { lookupCatalogEntry } from "../capabilities/marketplace-install.js";
import {
  loadInstalledStandaloneRows,
  type InstalledStandaloneRow,
} from "../capabilities/reconcile-standalone-configs-to-templates.js";
import {
  readOverlayLedger,
  resolveTemplateCatalog,
  templateHealthFor,
  templateSlugsOf,
  type TemplateLifecycle,
} from "../template-health.js";

/** A standing, with what an apply of it reaches (never on the wire). */
export interface InstalledPackage extends PackageStanding {
  /** workspace: every space holding it (its template, or an overlay on it). */
  workspaceIds: string[];
  /** capability: every container converged from it. */
  containerIds: string[];
  /** view/skill/automation: the installed rows (the plan compares them). */
  rows: InstalledStandaloneRow[];
  /** workspace: the space's last template apply did not finish. */
  unfinished?: boolean;
}

/** The reason a package is not compared, for a person. */
const NOT_STAMPED =
  "Installed without a version stamp, so it cannot be compared with the catalog.";
const NOT_IN_CATALOG = "This package is not in the pod's copy of the catalog.";
const UNFINISHED =
  "Its last update did not finish: updating it again finishes it.";

function lifecycleReason(
  lifecycle: TemplateLifecycle | null,
  replacedBy: string | null
): string {
  if (lifecycle === "retired") {
    return replacedBy
      ? `This template was retired and replaced by "${replacedBy}": its data moves there, it is not updated.`
      : "This template was retired: it is not updated any more.";
  }
  if (lifecycle === "unknown") {
    return "The pod's copy of the catalog is incomplete, so this template cannot be compared yet.";
  }
  return NOT_IN_CATALOG;
}

/** One verdict from two versions and why it could not be made. */
function verdict(
  installedVersion: string | null,
  latestVersion: string | null,
  whyNoLatest: string
): Pick<PackageStanding, "hasUpdate" | "reason"> {
  if (!latestVersion) return { hasUpdate: null, reason: whyNoLatest };
  if (!installedVersion) return { hasUpdate: null, reason: NOT_STAMPED };
  return { hasUpdate: packageHasUpdate(installedVersion, latestVersion) };
}

/** Fold one more installation of a package into its standing. */
function merge(into: InstalledPackage, next: InstalledPackage): void {
  into.workspaceIds.push(...next.workspaceIds);
  into.containerIds.push(...next.containerIds);
  into.rows.push(...next.rows);
  into.unfinished = into.unfinished || next.unfinished;
  // An update anywhere is an update of the package; one installation that
  // could not be compared does not hide another that could.
  if (next.hasUpdate === true && into.hasUpdate !== true) {
    into.hasUpdate = true;
    into.installedVersion = next.installedVersion;
    into.reason = next.reason;
  } else if (into.hasUpdate === null && next.hasUpdate === false) {
    into.hasUpdate = false;
    into.installedVersion = next.installedVersion;
    delete into.reason;
  }
}

function key(kind: InstalledPackageKind, slug: string): string {
  return `${kind}:${slug}`;
}

/** Spaces: each one's template and the overlay packs composed onto it. */
async function workspacePackages(): Promise<InstalledPackage[]> {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      settings: workspaces.settings,
      packageSlug: workspaces.packageSlug,
      archivedAt: workspaces.archivedAt,
    })
    .from(workspaces);
  // An archived space is frozen: no pass converges it, nothing updates it.
  const active = rows.filter((w) => w.archivedAt == null);
  const slugs = active.flatMap((w) =>
    templateSlugsOf(w.settings).concat(w.packageSlug ? [w.packageSlug] : [])
  );
  if (slugs.length === 0) return [];
  const catalog = await resolveTemplateCatalog(slugs);
  const names = new Map(
    (await queryCatalogCache({ kind: "workspace" })).map((e) => [
      e.slug,
      e.name,
    ])
  );

  const out: InstalledPackage[] = [];
  for (const w of active) {
    const state = readTemplateState(w.settings, { packageSlug: w.packageSlug });
    const slug = state?.slug ?? null;
    if (slug) {
      const health = templateHealthFor(
        slug,
        state?.version ?? null,
        catalog,
        w.settings
      );
      // `health.drifted` is the rule (`isTemplateDrifted` = `packageHasUpdate`)
      // OR a last apply that did not finish, which the same apply finishes.
      const unfinished =
        health.drifted &&
        !packageHasUpdate(health.installedVersion, health.latestVersion);
      const v = unfinished
        ? { hasUpdate: true, reason: UNFINISHED }
        : verdict(
            health.installedVersion,
            health.latestVersion,
            lifecycleReason(health.lifecycle, health.replacedBy)
          );
      out.push({
        slug,
        kind: "workspace",
        name: w.name,
        installedVersion: health.installedVersion,
        latestVersion: health.latestVersion,
        ...v,
        ...(unfinished ? { unfinished: true } : {}),
        workspaceIds: [w.id],
        containerIds: [],
        rows: [],
      });
    }
    for (const overlay of readOverlayLedger(w.settings)) {
      const health = templateHealthFor(
        overlay.slug,
        overlay.version,
        catalog,
        null
      );
      out.push({
        slug: overlay.slug,
        kind: "workspace",
        name: names.get(overlay.slug) ?? overlay.slug,
        installedVersion: health.installedVersion,
        latestVersion: health.latestVersion,
        ...verdict(
          health.installedVersion,
          health.latestVersion,
          lifecycleReason(health.lifecycle, health.replacedBy)
        ),
        workspaceIds: [w.id],
        containerIds: [],
        rows: [],
      });
    }
  }
  return out;
}

/**
 * Capability containers converged from a catalog template: the container's
 * stamp (`metadata.contentHash`, the full hash) against the catalog's, both
 * in version form. The same comparison the after-sync reconcile makes
 * (`containersWithChangedTemplates`).
 */
async function capabilityPackages(): Promise<InstalledPackage[]> {
  const cache = new Map(
    (await queryCatalogCache({ kind: "capability" })).map((e) => [e.slug, e])
  );
  const rows = await db
    .select({
      id: capabilities.id,
      name: capabilities.name,
      templateKey: capabilities.templateKey,
      metadata: capabilities.metadata,
    })
    .from(capabilities);
  const out: InstalledPackage[] = [];
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const slug =
      row.templateKey ??
      (typeof meta.templateKey === "string" ? meta.templateKey : null);
    if (!slug) continue; // not converged from a template: not an install
    const entry = cache.get(slug);
    const installedVersion = contentHashVersion(
      typeof meta.contentHash === "string" ? meta.contentHash : null
    );
    const latestVersion =
      entry?.version ?? contentHashVersion(entry?.contentHash ?? null);
    out.push({
      slug,
      kind: "capability",
      name: entry?.name ?? row.name,
      installedVersion,
      latestVersion,
      ...verdict(installedVersion, latestVersion, NOT_IN_CATALOG),
      workspaceIds: [],
      containerIds: [row.id],
      rows: [],
    });
  }
  return out;
}

/** Views, skills and automations installed from a package (`marketSource`). */
async function standalonePackages(): Promise<InstalledPackage[]> {
  const out: InstalledPackage[] = [];
  const latestBySlug = new Map<
    string,
    { version: string | null; name: string | null } | { error: string }
  >();
  for (const row of await loadInstalledStandaloneRows()) {
    const slug = row.source.packageSlug;
    const kind = row.adapter.catalogKind as InstalledPackageKind;
    const k = key(kind, slug);
    if (!latestBySlug.has(k)) {
      try {
        const entry = await lookupCatalogEntry(row.adapter.catalogKind, slug);
        latestBySlug.set(k, {
          version: entry?.version ?? null,
          name: entry?.name ?? null,
        });
      } catch (err) {
        // A retired package (the lookup refuses a tombstone) or a failed read.
        latestBySlug.set(k, {
          error: err instanceof Error ? err.message : "unknown error",
        });
      }
    }
    const latest = latestBySlug.get(k)!;
    const installedVersion = row.source.packageVersion;
    const base = {
      slug,
      kind,
      installedVersion,
      workspaceIds: [],
      containerIds: [],
      rows: [row],
    };
    if ("error" in latest) {
      out.push({
        ...base,
        name: (row.row.name as string) ?? slug,
        latestVersion: null,
        hasUpdate: null,
        reason: latest.error,
      });
      continue;
    }
    out.push({
      ...base,
      name: latest.name ?? (row.row.name as string) ?? slug,
      latestVersion: latest.version,
      ...verdict(installedVersion, latest.version, NOT_IN_CATALOG),
    });
  }
  return out;
}

/**
 * Every installed package with its verdict, one per slug + kind, sorted by
 * kind then slug. A failed read THROWS: a reader must never show "nothing
 * waiting" for a list it could not load.
 */
export async function listInstalledPackages(): Promise<InstalledPackage[]> {
  const all = [
    ...(await workspacePackages()),
    ...(await capabilityPackages()),
    ...(await standalonePackages()),
  ];
  const byKey = new Map<string, InstalledPackage>();
  for (const p of all) {
    const k = key(p.kind, p.slug);
    const seen = byKey.get(k);
    if (seen) merge(seen, p);
    else byKey.set(k, { ...p });
  }
  return [...byKey.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.slug.localeCompare(b.slug)
  );
}

/** The wire shape of a standing (what an apply reaches stays here). */
export function toStanding(p: InstalledPackage): PackageStanding {
  return {
    slug: p.slug,
    kind: p.kind,
    name: p.name,
    installedVersion: p.installedVersion,
    latestVersion: p.latestVersion,
    hasUpdate: p.hasUpdate,
    ...(p.reason ? { reason: p.reason } : {}),
  };
}
