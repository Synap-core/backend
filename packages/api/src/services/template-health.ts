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
  getCatalogSyncStamps,
  type CatalogSyncStamp,
  templateApplyUnfinished,
  readTemplateState,
  type TemplateState,
} from "@synap/database";
import {
  cpCatalogCache,
  proposals,
  ProposalStatus,
} from "@synap/database/schema";
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
 * A RETIRED row is not a version to update to, so it is left out too.
 */
export async function resolveLatestVersionsBySlug(
  slugs: string[]
): Promise<Map<string, string>> {
  return (await resolveTemplateCatalog(slugs)).latestBySlug;
}

/**
 * Where a workspace's template stands in the catalog (TEMPLATE-LIFECYCLE
 * Contract A):
 *   - `current`  — in the catalog cache, not retired;
 *   - `retired`  — in the cache as a tombstone (`replacedBy` may name the move);
 *   - `unlisted` — absent from the cache AND the last template sync was a
 *     provably COMPLETE fetch, so "not in the catalog" is a fact;
 *   - `unknown`  — absent, and the last sync was not provably complete (failed,
 *     partial, empty, never ran). An empty result and a failed read are
 *     different facts: this is the one we cannot call "unlisted".
 */
export type TemplateLifecycle = "current" | "retired" | "unlisted" | "unknown";

/** One template's catalog row as health needs it. */
interface TemplateCatalogEntry {
  version: string | null;
  retired: boolean;
  replacedBy: string | null;
  retiredReason: string | null;
}

/** The catalog as template health sees it, resolved ONCE for a set of slugs. */
export interface TemplateCatalogView {
  /** Latest version per CURRENT (non-retired) slug — the drift comparand. */
  latestBySlug: Map<string, string>;
  /** Every cached row (current AND retired) for the asked slugs. */
  entryBySlug: Map<string, TemplateCatalogEntry>;
  /** Was the last template sync provably complete? Gates `unlisted`. */
  complete: boolean;
}

/**
 * Is the template catalog cache provably COMPLETE? Only when at least one
 * template stamp exists and EVERY template stamp (one per catalog source) last
 * finished `ok` — the sync worker stamps `ok` only after a complete fetch it
 * pruned against. `empty`, `partial`, `unreachable`, `misconfigured` or no
 * stamp at all ⇒ not provable. A stamp left by a source that is no longer
 * configured keeps this false (the safe direction: `unknown`, never a false
 * `unlisted`). An `ok` stamp from a source that could not report retired rows
 * (`retirementsUnreported`, an older CP) is complete for LIVE rows only: an
 * absent slug may be a retirement it never told us about, so it is not proof.
 */
export function isTemplateCatalogComplete(
  stamps: Record<string, CatalogSyncStamp>
): boolean {
  const template = Object.entries(stamps).filter(([key]) =>
    key.endsWith("::template")
  );
  return (
    template.length > 0 &&
    template.every(
      ([, s]) => s.lastStatus === "ok" && s.retirementsUnreported !== true
    )
  );
}

/**
 * Resolve the catalog view for a set of slugs: one cache read + one stamp read.
 * A stamp read that FAILS yields `complete:false` (→ `unknown`), never a guess.
 */
export async function resolveTemplateCatalog(
  slugs: string[]
): Promise<TemplateCatalogView> {
  const latestBySlug = new Map<string, string>();
  const entryBySlug = new Map<string, TemplateCatalogEntry>();
  const distinct = [...new Set(slugs.filter((s): s is string => !!s))];
  if (distinct.length > 0) {
    const rows = await db
      .select({
        slug: cpCatalogCache.slug,
        version: cpCatalogCache.version,
        retiredAt: cpCatalogCache.retiredAt,
        replacedBySlug: cpCatalogCache.replacedBySlug,
        retiredReason: cpCatalogCache.retiredReason,
      })
      .from(cpCatalogCache)
      .where(
        and(
          eq(cpCatalogCache.kind, "template"),
          inArray(cpCatalogCache.slug, distinct)
        )
      );
    for (const row of rows) {
      const retired = row.retiredAt != null;
      // Two sources could cache the same slug: a live row wins over a tombstone.
      const prev = entryBySlug.get(row.slug);
      if (prev && !prev.retired) continue;
      entryBySlug.set(row.slug, {
        version: row.version,
        retired,
        replacedBy: retired ? row.replacedBySlug : null,
        retiredReason: retired ? row.retiredReason : null,
      });
      if (!retired && row.version) latestBySlug.set(row.slug, row.version);
    }
  }
  let complete = false;
  try {
    complete = isTemplateCatalogComplete(await getCatalogSyncStamps());
  } catch {
    complete = false; // a failed stamp read proves nothing → `unknown`
  }
  return { latestBySlug, entryBySlug, complete };
}

/** The TemplateHealth axes for one workspace's stamped template identity. */
export interface TemplateHealth {
  attached: boolean;
  stamped: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  drifted: boolean;
  /** Catalog standing of the attached template; `null` when not attached. */
  lifecycle: TemplateLifecycle | null;
  /** Retired only: the live slug the catalog names as its replacement. */
  replacedBy: string | null;
  /** Retired only: the catalog's one-sentence reason. */
  retiredReason: string | null;
  /** A plain sentence for `retired` / `unlisted`; `null` otherwise. */
  lifecycleWarning: string | null;
}

/** Classify one attached slug against the catalog view. */
export function classifyTemplateLifecycle(
  packageSlug: string,
  catalog: Pick<TemplateCatalogView, "entryBySlug" | "complete">
): {
  lifecycle: TemplateLifecycle;
  replacedBy: string | null;
  retiredReason: string | null;
} {
  const entry = catalog.entryBySlug.get(packageSlug);
  if (entry && entry.retired) {
    return {
      lifecycle: "retired",
      replacedBy: entry.replacedBy,
      retiredReason: entry.retiredReason,
    };
  }
  if (entry)
    return { lifecycle: "current", replacedBy: null, retiredReason: null };
  return {
    lifecycle: catalog.complete ? "unlisted" : "unknown",
    replacedBy: null,
    retiredReason: null,
  };
}

/** The plain sentence a person reads for a retired / unlisted template. */
export function templateLifecycleWarning(
  packageSlug: string,
  lifecycle: TemplateLifecycle,
  replacedBy: string | null,
  retiredReason: string | null
): string | null {
  if (lifecycle === "retired") {
    const why = retiredReason ? ` ${retiredReason.trim()}` : "";
    return replacedBy
      ? `The "${packageSlug}" template was retired.${why} It is replaced by "${replacedBy}"; you can move this space's data there.`
      : `The "${packageSlug}" template was retired.${why} It has no replacement; this space keeps working but gets no updates.`;
  }
  if (lifecycle === "unlisted") {
    return `The "${packageSlug}" template is no longer in the catalog. This space keeps working but gets no updates.`;
  }
  return null;
}

/**
 * Compose the axes from a workspace's slug/version + a resolved catalog view.
 *
 * `settings` is REQUIRED (the workspace's settings, or `null` where there are
 * none, e.g. an overlay) so no caller can forget it: a space whose last apply
 * did not finish (`templateApplyUnfinished`) reads DRIFTED whatever its stamp
 * says, so `synap templates update` offers it and the apply door finishes it
 * (`resumeIfFailed` already bypasses the stamp compare on `"failed"`). Founder
 * pod 2026-10-12: CRM carried `failed` AND the new stamp (layer 1 stamped
 * before layer 2 threw), so health read "current" and the update was skipped.
 */
export function templateHealthFor(
  packageSlug: string | null,
  installedVersion: string | null,
  catalog: TemplateCatalogView,
  settings: unknown
): TemplateHealth {
  const latestVersion = packageSlug
    ? (catalog.latestBySlug.get(packageSlug) ?? null)
    : null;
  const standing = packageSlug
    ? classifyTemplateLifecycle(packageSlug, catalog)
    : null;
  return {
    attached: packageSlug != null,
    stamped: installedVersion != null,
    installedVersion,
    latestVersion,
    drifted:
      isTemplateDrifted(installedVersion, latestVersion) ||
      (packageSlug != null && templateApplyUnfinished(settings)),
    lifecycle: standing?.lifecycle ?? null,
    replacedBy: standing?.replacedBy ?? null,
    retiredReason: standing?.retiredReason ?? null,
    lifecycleWarning:
      packageSlug && standing
        ? templateLifecycleWarning(
            packageSlug,
            standing.lifecycle,
            standing.replacedBy,
            standing.retiredReason
          )
        : null,
  };
}

/**
 * One OVERLAY composed onto a workspace (`settings.installedPacks`): a pack
 * layered onto the space's own template (business-developer on a CRM space).
 * Classified by the SAME `templateHealthFor` the workspace row uses — one
 * derivation — only the sentence differs, because the remedy differs: an
 * overlay is not a space, so there is nothing to retire-into.
 */
export interface OverlayTemplateHealth {
  slug: string;
  installedVersion: string | null;
  latestVersion: string | null;
  drifted: boolean;
  lifecycle: TemplateLifecycle;
  replacedBy: string | null;
  retiredReason: string | null;
  lifecycleWarning: string | null;
  /**
   * Retired, and its replacement is already on this space (the space's own
   * template, or another overlay on it): its fields stay, nothing to move.
   */
  replacementHere: boolean;
}

/**
 * The overlay ledger of a workspace, as health reads it: well-formed entries,
 * one per slug, never the space's own template (the same skip the overlay
 * reconcile makes). The ledger also records non-template packs a browser
 * installed (profile/view packs) — so an overlay absent from the template
 * catalog is NOT proof it was a template that left it.
 */
export function readOverlayLedger(
  settings: unknown
): Array<{ slug: string; version: string | null }> {
  const state = readTemplateState(settings);
  const identity = state?.slug ?? null;
  const seen = new Set<string>();
  const out: Array<{ slug: string; version: string | null }> = [];
  for (const p of state?.packs ?? []) {
    if (p.slug === identity || seen.has(p.slug)) continue;
    seen.add(p.slug);
    out.push({ slug: p.slug, version: p.version });
  }
  return out;
}

/** Every template slug a workspace's health needs from the catalog: its own + its overlays'. */
export function templateSlugsOf(settings: unknown): string[] {
  const slug = readTemplateState(settings)?.slug;
  return [
    ...(slug ? [slug] : []),
    ...readOverlayLedger(settings).map((o) => o.slug),
  ];
}

/**
 * The install-health fields the wire has always carried (Hub `GET
 * /workspaces`, `/installed`), derived from the ONE state — never read
 * from the legacy keys. `null` everywhere = nothing recorded.
 */
export function templateInstallWire(state: TemplateState | null): {
  provisioningStatus: "pending" | "active" | "failed" | null;
  failedStep: string | null;
  failedStepError: string | null;
} {
  if (!state)
    return {
      provisioningStatus: null,
      failedStep: null,
      failedStepError: null,
    };
  const failed = state.state === "failed";
  return {
    provisioningStatus:
      state.state === "building" ? "pending" : failed ? "failed" : "active",
    failedStep: failed ? (state.failedStep ?? null) : null,
    failedStepError: failed ? (state.error ?? null) : null,
  };
}

/** The plain sentence a person reads for an overlay that is not `current`. */
export function overlayLifecycleWarning(
  slug: string,
  lifecycle: TemplateLifecycle,
  replacedBy: string | null,
  retiredReason: string | null,
  replacementHere: boolean
): string | null {
  if (lifecycle === "retired") {
    const why = retiredReason ? ` ${retiredReason.trim()}` : "";
    if (replacedBy && replacementHere)
      return `The "${slug}" overlay on this space was retired.${why} It is replaced by "${replacedBy}", which this space already has. Its fields stay; there is nothing to move.`;
    return replacedBy
      ? `The "${slug}" overlay on this space was retired.${why} It is replaced by "${replacedBy}". Its fields stay, but they get no updates until "${replacedBy}" is installed.`
      : `The "${slug}" overlay on this space was retired.${why} It has no replacement. Its fields stay, but they get no updates.`;
  }
  if (lifecycle === "unlisted") {
    // Not "no longer": the ledger also holds non-template packs, which were
    // never in the template catalog.
    return `"${slug}" on this space is not in the template catalog, so it gets no template updates. What it added stays.`;
  }
  return null;
}

/** Health for every overlay a workspace carries, against one resolved catalog view. */
export function overlayHealthFor(
  settings: unknown,
  catalog: TemplateCatalogView
): OverlayTemplateHealth[] {
  const ledger = readOverlayLedger(settings);
  const identity = readTemplateState(settings)?.slug;
  const present = new Set<string>([
    ...(identity ? [identity] : []),
    ...ledger.map((o) => o.slug),
  ]);
  return ledger.map(({ slug, version }) => {
    // An overlay has no apply record of its own — the space's is the
    // workspace row's, not the pack's.
    const h = templateHealthFor(slug, version, catalog, null);
    const lifecycle = h.lifecycle!; // attached: `slug` is non-null
    const replacementHere =
      lifecycle === "retired" &&
      h.replacedBy != null &&
      h.replacedBy !== slug &&
      present.has(h.replacedBy);
    return {
      slug,
      installedVersion: h.installedVersion,
      latestVersion: h.latestVersion,
      drifted: h.drifted,
      lifecycle,
      replacedBy: h.replacedBy,
      retiredReason: h.retiredReason,
      lifecycleWarning: overlayLifecycleWarning(
        slug,
        lifecycle,
        h.replacedBy,
        h.retiredReason,
        replacementHere
      ),
      replacementHere,
    };
  });
}

/**
 * Per workspace whose last template apply is waiting on approval
 * (`settings.templateApply.state === "awaiting-approval"`, written by
 * `finishTemplateApply`): the ids of its proposals that are STILL PENDING —
 * read live, one query for the whole set, never trusted from the stored array.
 * Once they are approved or rejected the space drops out of this map and reads
 * as plain drift (the next `synap templates update` finishes it). A workspace
 * absent from the map has nothing waiting. Throws on a failed read: "could not
 * read" is never folded into "nothing waiting".
 */
export async function awaitingApprovalByWorkspace(
  rows: Array<{ id: string; settings: unknown }>
): Promise<Map<string, string[]>> {
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const recorded = rows.map((r) => {
    const t = readTemplateState(r.settings);
    const ids =
      t?.state === "awaiting-approval"
        ? (t.proposals ?? []).filter((p) => UUID.test(p))
        : [];
    return { id: r.id, ids };
  });
  const wanted = [...new Set(recorded.flatMap((r) => r.ids))];
  const out = new Map<string, string[]>();
  if (wanted.length === 0) return out;
  const pending = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        inArray(proposals.id, wanted),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
  const live = new Set(pending.map((p) => p.id));
  for (const r of recorded) {
    const still = r.ids.filter((id) => live.has(id));
    if (still.length > 0) out.set(r.id, still);
  }
  return out;
}

/**
 * THE wording for why a space's last template apply did not finish — ONE
 * function, served by every reader (MCP `template_health`, Hub `GET
 * /workspaces` → `synap templates`, the `/packages/apply` response → `synap
 * templates update`), so the CLI prints the pod's sentence and never words it
 * itself. `livePending` = the recorded proposals that are STILL pending
 * (`awaitingApprovalByWorkspace`): an awaiting-approval record whose proposals
 * were all decided returns `null` — the space then reads as a plain "update
 * available" (drifted), with nothing left to wait on. `null` = nothing to say.
 */
export function templateApplyWarning(
  slug: string,
  settings: unknown,
  livePending: string[]
): string | null {
  const state = readTemplateState(settings)?.state;
  const run = `\`synap templates update ${slug}\``;
  if (state === "failed")
    return `Not finished: the last update of ${slug} failed. Run ${run} to resume.`;
  switch (state) {
    case "awaiting-approval": {
      const n = livePending.length;
      if (n === 0) return null;
      return `Waiting on your approval of ${n} proposal${n === 1 ? "" : "s"} (${livePending.join(", ")}), then run ${run}.`;
    }
    case "partial":
      return `Not finished: part of ${slug} did not apply. Run ${run} to retry.`;
    case "layer-2-not-run":
      return `Not finished: run ${run} to apply the rest of ${slug}.`;
    default:
      return null;
  }
}

/**
 * `templateApplyWarning` for ONE space, read fresh (its settings + the live
 * status of the proposals it waits on) — what an apply door returns right
 * after its finisher, so the person reads the same sentence `synap templates`
 * will keep showing. `null` = nothing to say (or no template identity).
 */
export async function templateApplyWarningFor(
  workspaceId: string
): Promise<string | null> {
  const [row] = await db
    .select({ id: workspaces.id, settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const slug = readTemplateState(row?.settings)?.slug;
  if (!row || !slug) return null;
  const waiting = await awaitingApprovalByWorkspace([row]);
  return templateApplyWarning(slug, row.settings, waiting.get(row.id) ?? []);
}

/** One workspace's identity + its template health — the MCP `template_health` row shape. */
export interface WorkspaceTemplateHealth extends TemplateHealth {
  workspaceId: string;
  workspaceName: string;
  packageSlug: string | null;
  /** The overlays composed onto this space, each with its own standing. */
  overlays: OverlayTemplateHealth[];
  /**
   * The proposals this space's last template apply is waiting on, LIVE
   * (`awaitingApprovalByWorkspace`): still pending, by id. `[]` when nothing
   * waits — including once they were approved or rejected (plain drift then).
   */
  awaitingApproval: string[];
  /** Why the last template apply did not finish — `templateApplyWarning`. `null` = nothing to say. */
  applyWarning: string | null;
  /**
   * Non-fatal template problems in this space — a retired / unlisted template
   * (`lifecycleWarning`, first), then each overlay's warning, and an `always` skill whose body is over the
   * per-skill budget (it loads on demand instead). Empty when there are none.
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
  const catalog = await resolveTemplateCatalog(
    active.flatMap((r) => templateSlugsOf(r.settings))
  );
  const warningsByWs = await alwaysSkillWarningsByWorkspace(active);
  const waitingByWs = await awaitingApprovalByWorkspace(active);
  return active.map((r) => {
    const state = readTemplateState(r.settings);
    const pkgSlug = state?.slug ?? null;
    const installedVersion = state?.version ?? null;
    const health = templateHealthFor(
      pkgSlug,
      installedVersion,
      catalog,
      r.settings
    );
    const overlays = overlayHealthFor(r.settings, catalog);
    const awaitingApproval = waitingByWs.get(r.id) ?? [];
    const applyWarning = pkgSlug
      ? templateApplyWarning(pkgSlug, r.settings, awaitingApproval)
      : null;
    return {
      workspaceId: r.id,
      workspaceName: r.name,
      packageSlug: pkgSlug,
      ...health,
      overlays,
      awaitingApproval,
      applyWarning,
      warnings: [
        ...(applyWarning ? [applyWarning] : []),
        ...(health.lifecycleWarning ? [health.lifecycleWarning] : []),
        ...overlays.flatMap((o) =>
          o.lifecycleWarning ? [o.lifecycleWarning] : []
        ),
        ...(warningsByWs.get(r.id) ?? []),
      ],
    };
  });
}
