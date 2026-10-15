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
  desc,
  drizzleSql,
  eq,
  or,
  inArray,
  isNull,
  skills,
  workspaces,
  getCatalogSyncStamps,
  type CatalogSyncStamp,
  CONVERSION_MANIFEST,
  describeConversionOp,
  isTemplateApplyUnfinished,
  readTemplateState,
  type TemplateState,
  type TemplateApplyStateName,
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
import { createLogger } from "@synap-core/core";
import { candidateSlugs } from "./skills/template-skills.js";
import { isPodAdmin } from "../utils/workspace-role.js";
import { officialCatalogCondition } from "./capabilities/catalog-cache-query.js";
import { SOURCE_ID_PATTERN } from "@synap-core/types/marketplace-source";

const logger = createLogger({ module: "template-health" });

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
  /**
   * Source-qualified slugs (`acme/crm`, a space installed from a source a
   * person added) that are absent from that source's rows: the official
   * sync's completeness proves nothing about them, so they read `unknown`.
   */
  unprovable?: Set<string>;
}

/**
 * Split a stamped template slug: a space installed from an added source is
 * stamped `<sourceId>/<slug>` and is compared with THAT source's row — never
 * with Synap's same-named template. A bare slug is the official catalog's.
 */
export function splitTemplateSlug(
  stamped: string
): { source: string; slug: string } | null {
  const cut = stamped.indexOf("/");
  if (cut <= 0) return null;
  const source = stamped.slice(0, cut);
  return SOURCE_ID_PATTERN.test(source)
    ? { source, slug: stamped.slice(cut + 1) }
    : null;
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
  const bare = distinct.filter((s) => !splitTemplateSlug(s));
  const qualified = distinct.flatMap((s) => {
    const split = splitTemplateSlug(s);
    return split ? [{ stamped: s, ...split }] : [];
  });
  if (distinct.length > 0) {
    const rows = await db
      .select({
        source: cpCatalogCache.source,
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
          or(
            ...(bare.length > 0
              ? [
                  and(
                    officialCatalogCondition(),
                    inArray(cpCatalogCache.slug, bare)
                  ),
                ]
              : []),
            ...qualified.map((q) =>
              and(
                eq(cpCatalogCache.source, q.source),
                eq(cpCatalogCache.slug, q.slug)
              )
            )
          )
        )
      );
    const stampedFor = new Map(
      qualified.map((q) => [`${q.source}|${q.slug}`, q.stamped])
    );
    for (const row of rows) {
      const key = stampedFor.get(`${row.source}|${row.slug}`) ?? row.slug;
      const retired = row.retiredAt != null;
      entryBySlug.set(key, {
        version: row.version,
        retired,
        replacedBy: retired ? row.replacedBySlug : null,
        retiredReason: retired ? row.retiredReason : null,
      });
      if (!retired && row.version) latestBySlug.set(key, row.version);
    }
  }
  const unprovable = new Set(
    qualified.map((q) => q.stamped).filter((s) => !entryBySlug.has(s))
  );
  let complete = false;
  try {
    complete = isTemplateCatalogComplete(await getCatalogSyncStamps());
  } catch {
    complete = false; // a failed stamp read proves nothing → `unknown`
  }
  return { latestBySlug, entryBySlug, complete, unprovable };
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
  catalog: Pick<TemplateCatalogView, "entryBySlug" | "complete" | "unprovable">
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
    lifecycle:
      catalog.complete && !catalog.unprovable?.has(packageSlug)
        ? "unlisted"
        : "unknown",
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
 * did not finish reads DRIFTED whatever its stamp says, so `synap templates
 * update` offers it and the apply door finishes it (the plan re-syncs an
 * unfinished or failed space whatever its stamp). Founder pod 2026-10-12: CRM
 * carried `failed` AND the new stamp (layer 1 stamped before layer 2 threw),
 * so health read "current" and the update was skipped. "Did not finish" is
 * `healthApplyState`'s reading, so an abandoned build counts too.
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
      (packageSlug != null &&
        isTemplateApplyUnfinished({
          state: healthApplyState(readTemplateState(settings), []) ?? "active",
        })),
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
 *
 * `failedStepError` is a FIXED sentence, never the stored `error`: that is the
 * raw cause (DB / connector internals, up to 500 chars), operator data that
 * stays in `settings.template` and the log (review2 O5).
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
    failedStepError: failed ? failedApplySentence(state.slug) : null,
  };
}

/** The fixed sentence for a failed template apply — what the wire says instead of the raw cause. */
function failedApplySentence(slug: string | null): string {
  return slug
    ? `The last update of ${slug} failed. Run \`synap templates update ${slug}\` to resume.`
    : "The last template apply on this space failed.";
}

/**
 * The template state as a door serves it: the whole state object WITHOUT
 * `error` (the raw cause stays operator data — `templateInstallWire`).
 */
export function templateStateWire(
  state: TemplateState | null
): Omit<TemplateState, "error"> | null {
  if (!state) return null;
  const { error: _rawCause, ...wire } = state;
  void _rawCause;
  return wire;
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
 * (`settings.template.state === "awaiting-approval"`, written by the
 * finisher): the ids of its proposals that are STILL PENDING — read live, one
 * query for the whole set, never trusted from the stored array. Once they are
 * approved or rejected the space drops out of this map, and `healthApplyState`
 * reads it as `layer-2-not-run` (the next `synap templates update` finishes
 * it). A workspace absent from the map has nothing waiting. Throws on a failed
 * read: "could not read" is never folded into "nothing waiting".
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

/** A `building` record older than this is an abandoned build, not one in flight. */
export const STALE_BUILD_MS = 10 * 60 * 1000;

/**
 * THE state health serves for a space — the recorded machine state, read the
 * way a person must act on it. Two readings differ from the record, both so
 * every client draws ONE mark from `state` alone:
 *   - `awaiting-approval` with nothing left pending (`livePending` empty: every
 *     proposal was approved or rejected) → `layer-2-not-run`. Nothing is
 *     waiting any more; what is left is the rest of the apply, which is
 *     exactly what `layer-2-not-run` already means to every client ("Not
 *     finished · Finish update"). An existing state, not a new
 *     `ready-to-finish`, so no client needs a new case (review2 UX-M4).
 *   - `building` older than `STALE_BUILD_MS` (or of unknown age: a legacy
 *     record with no timestamp) → `failed`. An apply holds the build for
 *     seconds; one still "building" ten minutes later died, and the next
 *     apply re-syncs it (review2 Q9 / O4).
 * `null` = no template state recorded.
 */
export function healthApplyState(
  state: TemplateState | null,
  livePending: readonly string[],
  now: number = Date.now()
): TemplateApplyStateName | null {
  if (!state) return null;
  if (state.state === "awaiting-approval" && livePending.length === 0)
    return "layer-2-not-run";
  if (state.state === "building" && isStaleBuild(state.at, now))
    return "failed";
  return state.state;
}

function isStaleBuild(at: string, now: number): boolean {
  const started = Date.parse(at);
  return !Number.isFinite(started) || now - started > STALE_BUILD_MS;
}

/**
 * THE sentence a door answers when layer 2 as a whole failed (the space is in
 * place). Fixed on purpose: the raw cause can carry DB / connector internals,
 * so it goes to the operator log (`applyTemplate` logs it), never to the
 * caller (a CLI line, a browser toast, an approve refusal).
 */
export function layerTwoFailedSentence(slug?: string | null): string {
  return `The space is in place, but applying its package layers failed. Run \`synap templates update${slug ? ` ${slug}` : ""}\` to finish it.`;
}

/**
 * THE sentence for an update whose version stamp is held because it changes
 * existing data the person has not agreed to (Contract C). One wording for the
 * apply reply and every health reader.
 */
export function dataChangesHeldSentence(slug?: string | null): string {
  return `Not finished: this update of ${slug ?? "the template"} changes existing data, and waits for you to agree to it. Run \`synap templates update${slug ? ` ${slug}` : ""}\` to review the changes.`;
}

/**
 * THE wording for why a space's last template apply did not finish — ONE
 * function, served by every reader (MCP `template_health`, Hub `GET
 * /workspaces` → `synap templates`, `/installed`, the `/packages/apply`
 * response → `synap templates update`), so the CLI prints the pod's sentence
 * and never words it itself. Worded from `healthApplyState`, so the sentence
 * and the served `state` always agree. `livePending` = the recorded proposals
 * that are STILL pending (`awaitingApprovalByWorkspace`). `dataChangesHeld` =
 * the stamp waits on data changes the person has not agreed to
 * (`pendingDataChangesByWorkspace`); it speaks only when nothing else is
 * unfinished. `null` = nothing to say.
 */
export function templateApplyWarning(
  slug: string,
  settings: unknown,
  livePending: string[],
  opts: { dataChangesHeld?: boolean; now?: number } = {}
): string | null {
  const recorded = readTemplateState(settings);
  const state = healthApplyState(recorded, livePending, opts.now);
  const run = `\`synap templates update ${slug}\``;
  switch (state) {
    case "failed":
      return recorded?.state === "building"
        ? `Not finished: the last update of ${slug} stopped before it completed. Run ${run} to resume.`
        : `Not finished: the last update of ${slug} failed. Run ${run} to resume.`;
    case "awaiting-approval": {
      const n = livePending.length;
      return `Waiting on your approval of ${n} proposal${n === 1 ? "" : "s"} (${livePending.join(", ")}), then run ${run}.`;
    }
    case "partial":
      return `Not finished: part of ${slug} did not apply. Run ${run} to retry.`;
    case "layer-2-not-run":
      return `Not finished: run ${run} to apply the rest of ${slug}.`;
    default:
      return opts.dataChangesHeld ? dataChangesHeldSentence(slug) : null;
  }
}

/**
 * `templateApplyWarning` for ONE space, read fresh (its settings, the live
 * status of the proposals it waits on, the data changes it holds for) — what
 * an apply door returns right after its finisher, so the person reads the
 * same sentence `synap templates` will keep showing. `null` = nothing to say
 * (or no template identity).
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
  return templateApplyWarning(slug, row.settings, waiting.get(row.id) ?? [], {
    dataChangesHeld:
      heldDataChangeKeys(row.settings).length > 0 ||
      heldDataChangesUnreadable(row.settings),
  });
}

// ─── Data changes an update is held for ─────────────────────────────────────

/**
 * The data changes a space's update waits on, as a health row carries them.
 * `null` on the row = nothing held.
 */
export interface PendingDataChanges {
  /**
   * How many changes the update waits on. 0 only when `unreadable` (the hold
   * is known, its list is not); otherwise never 0 (nothing held is `null`).
   */
  count: number;
  /**
   * One plain sentence per change (`describeConversionOp`); when `unreadable`,
   * the one sentence saying the list could not be read.
   */
  sentences: string[];
  /**
   * The apply HELD its stamp because it could not read which data changes it
   * waits on (`settings.template.heldForDataChangesUnreadable`). Held all the
   * same — never folded into "nothing held".
   */
  unreadable: boolean;
  /**
   * Agreeing takes a pod owner or admin (an op rewrites every row of its kind,
   * pod-wide: the `/packages/apply` door answers 403
   * `DATA_CHANGES_NEED_POD_ADMIN` otherwise), and the reader is not one — so
   * the reader cannot agree themselves. `true` too when the reader is not
   * known (a caller that passed no viewer).
   */
  needsPodAdmin: boolean;
}

/**
 * The opKeys a space's update is held for — `settings.template.heldForDataChanges`,
 * written by the finisher when a pending data change held the version stamp
 * and cleared on the next stamp. Read defensively (JSONB): anything but an
 * array of strings is nothing held.
 */
export function heldDataChangeKeys(settings: unknown): string[] {
  const held = rawTemplateRecord(settings)?.heldForDataChanges;
  return Array.isArray(held)
    ? [
        ...new Set(
          held.filter((k): k is string => typeof k === "string" && !!k)
        ),
      ]
    : [];
}

/**
 * The finisher held the stamp WITHOUT knowing which data changes (the pending
 * list could not be read): `settings.template.heldForDataChangesUnreadable`.
 * Its `heldForDataChanges` is then `[]`, which alone would read as nothing held.
 */
export function heldDataChangesUnreadable(settings: unknown): boolean {
  return rawTemplateRecord(settings)?.heldForDataChangesUnreadable === true;
}

/** `settings.template` as raw JSON — the held fields are read defensively. */
function rawTemplateRecord(
  settings: unknown
): Record<string, unknown> | undefined {
  const template =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as { template?: unknown }).template
      : undefined;
  return template && typeof template === "object" && !Array.isArray(template)
    ? (template as Record<string, unknown>)
    : undefined;
}

/** The one sentence when the held list itself could not be read. */
export const DATA_CHANGES_UNREADABLE_SENTENCE =
  "This update changes existing data, but which changes could not be read. Run `synap templates update` to review them.";

/** The plain sentence for one held opKey. */
function heldChangeSentence(opKey: string): string {
  const op = CONVERSION_MANIFEST.ops.find((o) => o.opKey === opKey);
  return op
    ? describeConversionOp(op)
    : "A data change this version of the pod does not describe.";
}

/** The row warning when the ledger could not be read. */
export const DATA_CHANGES_UNCHECKED_WARNING =
  "Could not check which of this update's data changes already ran, so some listed may be done already.";

/** Successfully applied op keys (the `_conversions` ledger). Throws on a failed read. */
async function ledgeredOpKeys(): Promise<Set<string>> {
  const res = (await db.execute(
    drizzleSql`SELECT op_key FROM "_conversions" WHERE error IS NULL AND dry_run = false`
  )) as Array<{ op_key: string }> | { rows: Array<{ op_key: string }> };
  // postgres.js returns the rows; the PGlite driver (tests) wraps them.
  return new Set((Array.isArray(res) ? res : res.rows).map((r) => r.op_key));
}

/**
 * Per workspace: the data changes its update is held for, minus those the
 * ledger says already ran (an operator may have run one by hand — the record
 * is only cleared on the next stamp). One ledger read for the whole set, and
 * only when something is held. A FAILED ledger read is never "nothing held":
 * the recorded list is served unfiltered and `unchecked` says so (the row
 * carries `DATA_CHANGES_UNCHECKED_WARNING`).
 */
export async function pendingDataChangesByWorkspace(
  rows: Array<{ id: string; settings: unknown }>,
  viewerUserId: string | null
): Promise<{
  byWorkspace: Map<string, PendingDataChanges>;
  unchecked: boolean;
}> {
  const held = rows
    .map((r) => ({
      id: r.id,
      keys: heldDataChangeKeys(r.settings),
      unreadable: heldDataChangesUnreadable(r.settings),
    }))
    .filter((r) => r.keys.length > 0 || r.unreadable);
  const byWorkspace = new Map<string, PendingDataChanges>();
  if (held.length === 0) return { byWorkspace, unchecked: false };
  let applied: Set<string> | null = null;
  try {
    applied = await ledgeredOpKeys();
  } catch (err) {
    logger.warn(
      { err },
      "template health: the conversions ledger could not be read — held data changes served unfiltered"
    );
  }
  const needsPodAdmin = viewerUserId ? !(await isPodAdmin(viewerUserId)) : true;
  for (const r of held) {
    const keys = applied ? r.keys.filter((k) => !applied.has(k)) : r.keys;
    if (r.unreadable) {
      // Held, list unknown: never "nothing held" — the person reviews it at
      // the update door, which reads the list afresh.
      byWorkspace.set(r.id, {
        count: keys.length,
        sentences: [
          ...keys.map(heldChangeSentence),
          DATA_CHANGES_UNREADABLE_SENTENCE,
        ],
        unreadable: true,
        needsPodAdmin,
      });
      continue;
    }
    if (keys.length === 0) continue;
    byWorkspace.set(r.id, {
      count: keys.length,
      sentences: keys.map(heldChangeSentence),
      unreadable: false,
      needsPodAdmin,
    });
  }
  return { byWorkspace, unchecked: applied === null };
}

// ─── An agent's pending update of the space ─────────────────────────────────

/** An agent's pending "update this space to its template" proposal. */
export interface TemplateUpdateProposal {
  id: string;
}

/**
 * Per workspace: the newest PENDING template-update proposal targeting it —
 * `workspace/update` with `operation: "template_update"`, what `/packages/apply`
 * files when an agent updates a space that holds the template. One query for
 * the whole set. Throws on a failed read (never "no proposal").
 */
export async function updateProposalByWorkspace(
  workspaceIds: string[]
): Promise<Map<string, TemplateUpdateProposal>> {
  const out = new Map<string, TemplateUpdateProposal>();
  if (workspaceIds.length === 0) return out;
  const rows = await db
    .select({ id: proposals.id, targetId: proposals.targetId })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, ProposalStatus.PENDING),
        eq(proposals.targetType, "workspace"),
        eq(proposals.proposalType, "update"),
        inArray(proposals.targetId, workspaceIds),
        // The gate data rides request-shaped (`data.data`); a flat row is read too.
        drizzleSql`coalesce(${proposals.data}->'data'->>'operation', ${proposals.data}->>'operation') = 'template_update'`
      )
    )
    .orderBy(desc(proposals.createdAt));
  for (const r of rows)
    if (!out.has(r.targetId)) out.set(r.targetId, { id: r.id });
  return out;
}

// ─── The step fields, ONE derivation for every door ─────────────────────────

/** Where a space stands with its last template apply — the fields every health door serves. */
export interface TemplateStepFields {
  /** `healthApplyState`: the state a client draws its mark from. */
  state: TemplateApplyStateName | null;
  /** `templateApplyWarning`. `null` = nothing to say. */
  applyWarning: string | null;
  /** Live pending ids the last apply waits on (`awaitingApprovalByWorkspace`). */
  awaitingApproval: string[];
  /** The data changes the update is held for. `null` = nothing held. */
  pendingDataChanges: PendingDataChanges | null;
  /** An agent's pending update of this space. `null` = none. */
  updateProposal: TemplateUpdateProposal | null;
  /** Row warnings about the step itself (a read that could not be checked). */
  stepWarnings: string[];
}

/**
 * The step fields for a set of spaces, from their settings — one read per
 * concern for the whole set. Shared by `listWorkspaceTemplateHealth` (tRPC +
 * MCP) and Hub `GET /workspaces` (the CLI), so the three doors serve the same
 * `state`, sentence and fields. `viewerUserId` decides `needsPodAdmin`.
 */
export async function templateStepsByWorkspace(
  rows: Array<{ id: string; settings: unknown }>,
  viewerUserId: string | null
): Promise<Map<string, TemplateStepFields>> {
  const [waitingByWs, dataChanges, proposalByWs] = await Promise.all([
    awaitingApprovalByWorkspace(rows),
    pendingDataChangesByWorkspace(rows, viewerUserId),
    updateProposalByWorkspace(rows.map((r) => r.id)),
  ]);
  const now = Date.now();
  const out = new Map<string, TemplateStepFields>();
  for (const r of rows) {
    const recorded = readTemplateState(r.settings);
    const awaitingApproval = waitingByWs.get(r.id) ?? [];
    const pendingDataChanges = dataChanges.byWorkspace.get(r.id) ?? null;
    out.set(r.id, {
      state: healthApplyState(recorded, awaitingApproval, now),
      applyWarning: recorded?.slug
        ? templateApplyWarning(recorded.slug, r.settings, awaitingApproval, {
            dataChangesHeld: pendingDataChanges != null,
            now,
          })
        : null,
      awaitingApproval,
      pendingDataChanges,
      updateProposal: proposalByWs.get(r.id) ?? null,
      stepWarnings:
        dataChanges.unchecked && pendingDataChanges
          ? [DATA_CHANGES_UNCHECKED_WARNING]
          : [],
    });
  }
  return out;
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
   * waits — including once they were approved or rejected (`state` then
   * reads `layer-2-not-run`).
   */
  awaitingApproval: string[];
  /**
   * Where the last template apply on this space stands, as health reads it
   * (`healthApplyState`: the recorded state, except an awaiting-approval
   * with nothing left pending reads `layer-2-not-run` and an abandoned
   * build reads `failed`) — the one state a client draws its mark from,
   * never re-derived from the sentence. `null` = no template state recorded.
   */
  state: TemplateApplyStateName | null;
  /** Why the last template apply did not finish — `templateApplyWarning`. `null` = nothing to say. */
  applyWarning: string | null;
  /**
   * The data changes this space's update waits on the person to agree to
   * (the version stamp is held until then). `null` = nothing held.
   */
  pendingDataChanges: PendingDataChanges | null;
  /** An agent's pending "update this space" proposal — its door. `null` = none. */
  updateProposal: TemplateUpdateProposal | null;
  /**
   * Non-fatal template problems in this space — the apply warning, a retired /
   * unlisted template (`lifecycleWarning`), each overlay's warning, a read
   * that could not be checked, and an `always` skill whose body is over the
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
  wsIds: string[],
  /** The reader — decides `pendingDataChanges.needsPodAdmin`. `null` = unknown. */
  viewerUserId: string | null = null
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
  const stepsByWs = await templateStepsByWorkspace(active, viewerUserId);
  return active.map((r) => {
    const recorded = readTemplateState(r.settings);
    const pkgSlug = recorded?.slug ?? null;
    const health = templateHealthFor(
      pkgSlug,
      recorded?.version ?? null,
      catalog,
      r.settings
    );
    const overlays = overlayHealthFor(r.settings, catalog);
    const { stepWarnings, ...step } = stepsByWs.get(r.id)!;
    return {
      workspaceId: r.id,
      workspaceName: r.name,
      packageSlug: pkgSlug,
      ...health,
      overlays,
      ...step,
      warnings: [
        ...(step.applyWarning ? [step.applyWarning] : []),
        ...stepWarnings,
        ...(health.lifecycleWarning ? [health.lifecycleWarning] : []),
        ...overlays.flatMap((o) =>
          o.lifecycleWarning ? [o.lifecycleWarning] : []
        ),
        ...(warningsByWs.get(r.id) ?? []),
      ],
    };
  });
}
