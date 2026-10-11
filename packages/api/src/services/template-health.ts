/**
 * Template Health — the ONE server-side authority for "is this workspace behind
 * its template?"
 * ==========================================================================
 *
 * Every surface that answers template drift (Hub `/workspaces` for the CLI, the
 * MCP `template_health` verb for agents, and — once the concurrent tRPC work
 * lands — `workspaces.list` for the browser) computes it HERE, so they cannot
 * disagree. This replaces the two independently-written client bypass layers
 * (the CLI's `remoteVersionBySlug` override and the browser's `remoteEntriesBySlug`
 * pre-filter) that could silently drift apart.
 *
 * Drift source: the version STAMP, not a per-row `dryRun` reconcile. That is
 * only truthful because the boot sweep now stamps in lockstep with the content
 * it reconciles (see `reconcile-workspaces-to-templates.ts`) — before that fix
 * the stamp lied and a `dryRun` diff was the only honest signal. The expensive
 * `dryRun` stays for the on-demand "what exactly would change" preview.
 */

import {
  db,
  and,
  eq,
  inArray,
  isNull,
  skills,
  workspaces,
} from "@synap/database";
import { cpCatalogCache } from "@synap/database/schema";
import {
  alwaysSkillBudgetWarning,
  alwaysSkillOverBudget,
  readSpaceBrief,
} from "@synap-core/types/space-brief";
import { candidateSlugs } from "./skills/template-skills.js";

/**
 * Is `installed` behind `latest`? Plan option (a): CP mints content-hash
 * versions ("h-<hash>") for which drift is plain inequality; a rare
 * hand-authored semver template drifts only when `latest` is strictly newer
 * (never flag a downgrade). Null-safe: an unstamped install or a cache-cold slug
 * is "not known-drifted" (`false`), never a false positive.
 */
export function isTemplateDrifted(
  installed: string | null,
  latest: string | null
): boolean {
  if (!installed || !latest || installed === latest) return false;
  // Content-hash versions: any inequality (already true here) is drift.
  if (installed.startsWith("h-") || latest.startsWith("h-")) return true;
  // Semver-ish: drift only when latest is strictly greater than installed.
  const parts = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(latest);
  const b = parts(installed);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Resolve the freshest KNOWN catalog version for each slug from
 * `cp_catalog_cache` — the remote mirror the drift surfaces trust (NOT the
 * frozen bundle, which could shadow a real CP update). One query for the whole
 * set; a cache-cold slug is simply absent from the map (→ `drifted:false`).
 */
export async function resolveLatestVersionsBySlug(
  slugs: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const distinct = [...new Set(slugs.filter((s): s is string => !!s))];
  if (distinct.length === 0) return out;
  const rows = await db
    .select({ slug: cpCatalogCache.slug, version: cpCatalogCache.version })
    .from(cpCatalogCache)
    .where(
      and(
        eq(cpCatalogCache.kind, "template"),
        inArray(cpCatalogCache.slug, distinct)
      )
    );
  for (const row of rows) if (row.version) out.set(row.slug, row.version);
  return out;
}

/** The TemplateHealth axes for one workspace's stamped template identity. */
export interface TemplateHealth {
  attached: boolean;
  stamped: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  drifted: boolean;
}

/** Compose the axes from a workspace's slug/version + a resolved latest map. */
export function templateHealthFor(
  packageSlug: string | null,
  installedVersion: string | null,
  latestBySlug: Map<string, string>
): TemplateHealth {
  const latestVersion = packageSlug
    ? (latestBySlug.get(packageSlug) ?? null)
    : null;
  return {
    attached: packageSlug != null,
    stamped: installedVersion != null,
    installedVersion,
    latestVersion,
    drifted: isTemplateDrifted(installedVersion, latestVersion),
  };
}

/** One workspace's identity + its template health — the MCP `template_health` row shape. */
export interface WorkspaceTemplateHealth extends TemplateHealth {
  workspaceId: string;
  workspaceName: string;
  packageSlug: string | null;
  /**
   * Non-fatal template problems in this space — today, an `always` skill whose
   * body is over the per-skill budget (it loads on demand instead). Empty when
   * there are none.
   */
  warnings: string[];
}

/**
 * Per workspace: a budget warning for every skill its brief links
 * `mode: "always"` whose pod-wide row body is over the per-skill budget.
 * One read for every linked slug across the whole set.
 */
async function alwaysSkillWarningsByWorkspace(
  rows: Array<{ id: string; settings: unknown }>
): Promise<Map<string, string[]>> {
  const always = rows.map((r) => ({
    id: r.id,
    refs: (readSpaceBrief(r.settings)?.skills ?? []).filter(
      (k) => k.mode === "always"
    ),
  }));
  const wanted = [
    ...new Set(
      always.flatMap((w) => w.refs.flatMap((k) => candidateSlugs(k.slug)))
    ),
  ];
  const out = new Map<string, string[]>();
  if (wanted.length === 0) return out;
  const skillRows = await db
    .select({ slug: skills.slug, body: skills.body })
    .from(skills)
    .where(
      and(
        isNull(skills.workspaceId),
        eq(skills.kind, "instruction"),
        inArray(skills.slug, wanted)
      )
    );
  const bodyBySlug = new Map(skillRows.map((r) => [r.slug as string, r.body]));
  for (const w of always) {
    const warnings: string[] = [];
    for (const ref of w.refs) {
      const slug = candidateSlugs(ref.slug).find((c) => bodyBySlug.has(c));
      const over = slug ? alwaysSkillOverBudget(bodyBySlug.get(slug)) : null;
      if (over) warnings.push(alwaysSkillBudgetWarning(ref.slug, over));
    }
    if (warnings.length) out.set(w.id, warnings);
  }
  return out;
}

/**
 * TemplateHealth for a set of workspaces — the shared body behind the MCP
 * `template_health` verb (and any other door that wants the whole list). The
 * CALLER supplies the already-access-scoped `wsIds` (e.g. via
 * `getUserAccessibleWorkspaceIds`) — this service never widens the lens, it only
 * reports health for what it's handed, so it can't leak a foreign workspace.
 */
export async function listWorkspaceTemplateHealth(
  wsIds: string[]
): Promise<WorkspaceTemplateHealth[]> {
  if (wsIds.length === 0) return [];
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      settings: workspaces.settings,
      archivedAt: workspaces.archivedAt,
    })
    .from(workspaces)
    .where(inArray(workspaces.id, wsIds));
  const active = rows.filter((r) => r.archivedAt == null);
  const latestBySlug = await resolveLatestVersionsBySlug(
    active.map(
      (r) => (r.settings as { packageSlug?: string } | null)?.packageSlug ?? ""
    )
  );
  const warningsByWs = await alwaysSkillWarningsByWorkspace(active);
  return active.map((r) => {
    const s = (r.settings ?? {}) as {
      packageSlug?: unknown;
      packageVersion?: unknown;
    };
    const pkgSlug = typeof s.packageSlug === "string" ? s.packageSlug : null;
    const installedVersion =
      typeof s.packageVersion === "string" ? s.packageVersion : null;
    return {
      workspaceId: r.id,
      workspaceName: r.name,
      packageSlug: pkgSlug,
      ...templateHealthFor(pkgSlug, installedVersion, latestBySlug),
      warnings: warningsByWs.get(r.id) ?? [],
    };
  });
}
