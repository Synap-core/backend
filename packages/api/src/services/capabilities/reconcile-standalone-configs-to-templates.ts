/**
 * reconcileStandaloneConfigsToTemplates
 * =====================================
 *
 * Boot-time (+ on-demand) convergence for the three LIGHTER config kinds a pod
 * can install standalone from a marketplace package — VIEWS, SKILLS and
 * AUTOMATIONS. This is the standalone-config counterpart to
 * `reconcileCapabilitiesToTemplates` (capability CONTAINERS) and
 * `reconcileWorkspacesToTemplates` (whole workspaces): same shape, same
 * "reported, never forced" guarantee, applied to a single installed row that
 * carries a `metadata.marketSource` source-link (see `market-source.ts`).
 *
 * WHY THIS EXISTS. A capability install carries its source-link in
 * `metadata.templateKey`; a workspace install carries it in a real
 * `package_slug` column — so both can self-heal when the published template is
 * fixed. The three lighter kinds had NO source-link, so a published fix never
 * reached an already-installed view/skill/automation. `market-source.ts` gave
 * them the same linkage in the existing `metadata` jsonb (no migration) and,
 * crucially, a FIELD-LEVEL 3-WAY MERGE so reconvergence can never silently
 * revert a field the user edited — the exact Salesforce-managed / naive-GitOps
 * disaster. This engine is the reconcile HALF of that contract.
 *
 * THE LOAD-BEARING SAFETY PROPERTY — never overwrite a user edit. For every
 * installed row that carries a `marketSource`, we resolve the source template's
 * CURRENT definition, build `desired` for exactly the baseline's managed field
 * keys, and hand (`live`, `baseline`, `desired`) to `threeWayMergeFields`. A
 * field advances to the template ONLY when the row's live value still equals the
 * value we last wrote (`baseline`). The moment they diverge the field is
 * OWNER-OWNED — left alone and REPORTED. Prune is OFF: a field the template
 * dropped is left on the row. We NEVER reimplement the merge — the util in
 * `market-source.ts` is the one door.
 *
 * Idempotent + additive + non-fatal, exactly like the capability reconcile:
 *  - The row is written ONLY through the GOVERNED per-kind router `.update`
 *    caller (`viewsRouter` / `skillsRouter` / `automationsRouter`) — never a raw
 *    SQL UPDATE — so governance, audit, side-effects and re-approval are
 *    identical to a manual edit.
 *  - A cache MISS for the source package (e.g. a PRIVATE package that never
 *    entered the public `cp_catalog_cache`) SKIPS that row (reported), never an
 *    error — private packages reconcile via the user-surface path, out of scope
 *    here.
 *  - A failure reconciling ONE row is caught, reported as a CONFLICT, and never
 *    blocks another row or boot.
 *  - `dryRun: true` computes the full report without writing anything.
 *
 * Lives in `@synap/api` (not apps/api/src/startup) for the same reason its
 * capability sibling does: TWO callers need the engine — the apps/api boot hook
 * AND the Hub REST `POST /configs/reconcile` trigger — and apps/api cannot be
 * imported back by packages/api.
 */

import { createLogger } from "@synap-core/core";
import { db, inArray } from "@synap/database";
import { views, skills, automations } from "@synap/database/schema";
import type { CatalogKind } from "@synap/jobs";

import {
  readMarketSource,
  threeWayMergeFields,
  detachMarketSource,
} from "./market-source.js";
import { lookupCatalogEntry } from "./marketplace-install.js";
import type { Context } from "../../types/context.js";

const logger = createLogger({
  module: "reconcile-standalone-configs-to-templates",
});

export type StandaloneKind = "view" | "skill" | "automation";

export interface StandaloneReconcileEntry {
  kind: StandaloneKind;
  id: string;
  name: string;
  packageSlug?: string;
  reason: string;
}

export interface StandaloneReconcileReport {
  checked: number;
  dryRun: boolean;
  /** Rows whose untouched-since-install fields advanced to the template. */
  updated: StandaloneReconcileEntry[];
  /** Rows carrying at least one field the user EDITED since install — left
   *  alone, never overwritten, surfaced so the divergence is visible. */
  ownerOwnedSkipped: StandaloneReconcileEntry[];
  /** Nothing to do — no source-link, cache miss, unresolved definition, no
   *  matching element in the package, or already up to date. */
  skipped: StandaloneReconcileEntry[];
  /** Reconcile of ONE row failed (non-fatal) — reported, never forced. */
  conflicts: StandaloneReconcileEntry[];
}

const FETCH_TIMEOUT_MS = 8000;

/**
 * Fetch ONE package's full install payload from its catalog source. Mirrors
 * marketplace-install's private `fetchFullPackageDefinition` (the list-view
 * `cp_catalog_cache` omits the definition body for view/skill/automation, so it
 * must be fetched per-slug). Resilient by design: returns `null` on ANY failure
 * so the reconcile SKIPS that row instead of aborting boot — never throws.
 * (When marketplace-install.ts is next opened, this and its private twin should
 * be lifted into ONE exported helper — kept a small local mirror here so this
 * wave never edits that file.)
 */
async function fetchPackageDefinition(
  source: string,
  slug: string,
  version?: string | null
): Promise<Record<string, unknown> | null> {
  const url = version
    ? `${source}/api/packages/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`
    : `${source}/api/packages/${encodeURIComponent(slug)}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      package?: { definition?: Record<string, unknown> };
    } | null;
    return body?.package?.definition ?? null;
  } catch {
    return null;
  }
}

/** The template element's display name — the key we match an installed row by. */
function elementName(el: Record<string, unknown>): string | undefined {
  return (
    (el.name as string | undefined) ??
    (el.displayName as string | undefined) ??
    (el.slug as string | undefined)
  );
}

/**
 * Read one managed field from a template element by the row's field-key name.
 * `name` resolves through the same fallback the install applier used
 * (name → displayName → slug); every other key reads straight through, since
 * `market-source.ts`'s baseline is keyed by the row field name the applier
 * wrote FROM the definition (same-named: `description`, `config`, `query`,
 * `flowDefinition`, `triggerConfig`, `status`, `body`, `code`, `parameters`, …).
 */
function pickField(el: Record<string, unknown>, key: string): unknown {
  if (key === "name") return elementName(el);
  return el[key];
}

interface KindAdapter {
  kind: StandaloneKind;
  /** The `cp_catalog_cache` / CP package kind — identical string here. */
  catalogKind: CatalogKind;
  /** All installed rows (optionally narrowed to `ids`). */
  loadRows(ids?: string[]): Promise<Record<string, unknown>[]>;
  /** The row's creator user-id — attribution for the governed write. */
  creatorOf(row: Record<string, unknown>): string;
  /** Find the row's element within a fetched package definition (by name). */
  findElement(
    def: Record<string, unknown>,
    rowName: string
  ): Record<string, unknown> | null;
  /** Persist `merged` fields + advanced `metadata` through the GOVERNED router
   *  `.update` caller. Returns whether the write LANDED or was PROPOSED for
   *  review (a governed skill update can propose). */
  applyUpdate(args: {
    ctx: Context;
    id: string;
    merged: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<"updated" | "proposed">;
}

/** Match a row to its element: exact name, else the sole element in the pack. */
function matchByName(
  elements: Record<string, unknown>[],
  rowName: string
): Record<string, unknown> | null {
  const hit = elements.find((e) => elementName(e) === rowName);
  if (hit) return hit;
  return elements.length === 1 ? elements[0]! : null;
}

const ADAPTERS: KindAdapter[] = [
  {
    kind: "view",
    catalogKind: "view",
    async loadRows(ids) {
      const q = db.select().from(views);
      return (ids && ids.length > 0
        ? await q.where(inArray(views.id, ids))
        : await q) as unknown as Record<string, unknown>[];
    },
    creatorOf: (row) => row.userId as string,
    findElement(def, rowName) {
      // A view package ships `views: PackageViewDefinition[]`, or a legacy
      // single top-level view (has its own `type`).
      const list = Array.isArray(def.views)
        ? (def.views as Record<string, unknown>[])
        : def.type
          ? [def]
          : [];
      return matchByName(list, rowName);
    },
    async applyUpdate({ ctx, id, merged, metadata }) {
      const { viewsRouter } = await import("../../routers/views.js");
      const res = (await viewsRouter
        .createCaller(ctx)
        // `metadata` LAST so it wins over any `metadata` carried in `merged`;
        // extra keys are stripped by the door's zod input.
        .update({ id, ...merged, metadata } as Parameters<
          ReturnType<typeof viewsRouter.createCaller>["update"]
        >[0])) as { status?: string } | unknown;
      return (res as { status?: string })?.status === "proposed"
        ? "proposed"
        : "updated";
    },
  },
  {
    kind: "skill",
    catalogKind: "skill",
    async loadRows(ids) {
      const q = db.select().from(skills);
      return (ids && ids.length > 0
        ? await q.where(inArray(skills.id, ids))
        : await q) as unknown as Record<string, unknown>[];
    },
    creatorOf: (row) => row.userId as string,
    findElement(def, rowName) {
      // A skill package IS a single skill (marketplace-install reads top-level
      // definition fields). Return it when the name matches, else return it
      // anyway for a single-skill package (the common case).
      const name = elementName(def);
      if (name === undefined || name === rowName) return def;
      return def;
    },
    async applyUpdate({ ctx, id, merged, metadata }) {
      const { skillsRouter } = await import("../../routers/skills.js");
      // `skillsRouter.update` threads a `metadata` patch (shallow-merged onto the
      // row bag — same as views/automations), so the advanced `marketSource`
      // baseline we pass here PERSISTS and a skill's baseline advances across
      // successive template changes. (This closed a cross-kind gap where only
      // skills.update lacked the field.)
      const res = (await skillsRouter.createCaller(ctx).update({
        id,
        ...merged,
        metadata,
      } as Parameters<
        ReturnType<typeof skillsRouter.createCaller>["update"]
      >[0])) as { status?: string };
      return res?.status === "proposed" ? "proposed" : "updated";
    },
  },
  {
    kind: "automation",
    catalogKind: "automation",
    async loadRows(ids) {
      const q = db.select().from(automations);
      return (ids && ids.length > 0
        ? await q.where(inArray(automations.id, ids))
        : await q) as unknown as Record<string, unknown>[];
    },
    creatorOf: (row) => row.createdBy as string,
    findElement(def, rowName) {
      const list = Array.isArray(def.automations)
        ? (def.automations as Record<string, unknown>[])
        : [];
      return matchByName(list, rowName);
    },
    async applyUpdate({ ctx, id, merged, metadata }) {
      const { automationsRouter } =
        await import("../../routers/automations.js");
      const res = (await automationsRouter.createCaller(ctx).update({
        id,
        ...merged,
        metadata,
      } as Parameters<
        ReturnType<typeof automationsRouter.createCaller>["update"]
      >[0])) as { status?: string };
      return res?.status === "proposed" ? "proposed" : "updated";
    },
  },
];

/** Governed-write acting context — attribute to the row's own creator, scoped
 *  to its own workspace (null = pod-wide). Mirrors the capability reconcile's
 *  `buildContainerCtx`. */
function buildRowCtx(
  creatorUserId: string,
  workspaceId: string | null
): Context {
  return {
    db,
    authenticated: true,
    userId: creatorUserId,
    workspaceId,
    workspaceRole: "owner",
  } as unknown as Context;
}

export async function reconcileStandaloneConfigsToTemplates(
  opts: {
    dryRun?: boolean;
    /** NARROW to specific row ids across all three kinds. */
    ids?: string[];
  } = {}
): Promise<StandaloneReconcileReport> {
  const dryRun = !!opts.dryRun;
  const report: StandaloneReconcileReport = {
    checked: 0,
    dryRun,
    updated: [],
    ownerOwnedSkipped: [],
    skipped: [],
    conflicts: [],
  };

  // An explicit empty `ids` means "reconcile NOTHING" — distinct from `undefined`
  // ("reconcile everything"). Return the empty report rather than silently
  // falling through to a full pod-wide reconcile (the same landmine the
  // capability reconcile guards, for a future "apply selected" caller).
  if (opts.ids && opts.ids.length === 0) {
    return report;
  }

  for (const adapter of ADAPTERS) {
    let rows: Record<string, unknown>[];
    try {
      rows = await adapter.loadRows(opts.ids);
    } catch (err) {
      logger.warn(
        { err, kind: adapter.kind },
        "Standalone reconcile: failed to load rows for this kind (non-fatal)"
      );
      continue;
    }

    for (const row of rows) {
      const source = readMarketSource(
        row.metadata as Record<string, unknown> | null | undefined
      );
      // Not a marketplace-installed config — not our concern, not "checked".
      if (!source) continue;

      report.checked++;
      const id = row.id as string;
      const name = (row.name as string) ?? "";
      const base = {
        kind: adapter.kind,
        id,
        name,
        packageSlug: source.packageSlug,
      };

      try {
        // Resolve the source package's CURRENT definition. Cache row first (for
        // its `source`/`version`); a MISS (private package not in the public
        // cache) SKIPS — reported, never an error.
        const cacheRow = await lookupCatalogEntry(
          adapter.catalogKind,
          source.packageSlug
        );
        if (!cacheRow) {
          report.skipped.push({
            ...base,
            reason: `source package "${source.packageSlug}" not in the catalog cache (private/unsynced — reconciles via the user surface, not boot)`,
          });
          continue;
        }

        const def =
          cacheRow.definition ??
          (await fetchPackageDefinition(
            cacheRow.source,
            source.packageSlug,
            cacheRow.version
          ));
        if (!def) {
          report.skipped.push({
            ...base,
            reason: `could not resolve the definition for "${source.packageSlug}" (source unreachable or no payload)`,
          });
          continue;
        }

        const element = adapter.findElement(def, name);
        if (!element) {
          report.skipped.push({
            ...base,
            reason: `no matching "${name}" element in package "${source.packageSlug}" (renamed or removed upstream)`,
          });
          continue;
        }

        // desired = the template's current values for EXACTLY the baseline's
        // managed keys (the fields the install-side applier stamped). A key the
        // template no longer provides is omitted (prune OFF → left on the row,
        // never blanked).
        //
        // KNOWN LIMITATION (v1, by design): the reconciled field SET is fixed at
        // install time. A brand-new TOP-LEVEL field a template adds AFTER install
        // won't reach an already-installed row — it isn't in `baseline`, so it
        // never enters `desired`. This is deliberately conservative and low-impact:
        // a change WITHIN an existing managed field DOES propagate (a flow's
        // `flowDefinition` is one managed key, so e.g. a retry policy nested inside
        // it reconciles as a whole-field replace). A config that must adopt a new
        // top-level field re-installs. `threeWayMergeFields`' newly-managed-field
        // branch stays correct (and unit-tested) for the day this scope widens to
        // `union(baselineKeys, template-managed keys)`.
        const baselineKeys = Object.keys(source.baseline);
        const desired: Record<string, unknown> = {};
        const live: Record<string, unknown> = {};
        for (const k of baselineKeys) {
          const v = pickField(element, k);
          if (v !== undefined) desired[k] = v;
          live[k] = (row as Record<string, unknown>)[k];
        }

        const r = threeWayMergeFields(live, source.baseline, desired);

        // A user-edited field is reported (never overwritten) whether or not any
        // OTHER field advanced.
        if (r.ownerOwned.length > 0) {
          report.ownerOwnedSkipped.push({
            ...base,
            reason: `owner-owned (left alone): [${r.ownerOwned.join(",")}]`,
          });
        }

        if (!r.changed) {
          // Nothing advanced. Only record a plain "no drift" skip when there was
          // also no owner-owned divergence (already reported above).
          if (r.ownerOwned.length === 0) {
            report.skipped.push({ ...base, reason: "up to date (no drift)" });
          }
          continue;
        }

        if (dryRun) {
          report.updated.push({
            ...base,
            reason: `would update: [${r.applied.join(",")}]`,
          });
          continue;
        }

        // Advance the baseline for the fields that moved (owner-owned fields keep
        // their old base so their divergence stays detected next pass), preserving
        // packageSlug / packageVersion / installedAt.
        const nextMetadata: Record<string, unknown> = {
          ...((row.metadata as Record<string, unknown> | null) ?? {}),
          marketSource: { ...source, baseline: r.nextBaseline },
        };
        const ctx = buildRowCtx(
          adapter.creatorOf(row),
          (row.workspaceId as string | null) ?? null
        );
        const outcome = await adapter.applyUpdate({
          ctx,
          id,
          merged: r.merged,
          metadata: nextMetadata,
        });

        if (outcome === "proposed") {
          report.skipped.push({
            ...base,
            reason: `update proposed for review: [${r.applied.join(",")}]`,
          });
        } else {
          report.updated.push({
            ...base,
            reason: `updated: [${r.applied.join(",")}]`,
          });
        }
      } catch (err) {
        report.conflicts.push({
          ...base,
          reason: err instanceof Error ? err.message : "unknown error",
        });
        logger.warn(
          { err, kind: adapter.kind, id, name },
          "Standalone reconcile failed for this row (non-fatal)"
        );
      }
    }
  }

  logger.info(
    {
      dryRun,
      checked: report.checked,
      updated: report.updated.length,
      ownerOwnedSkipped: report.ownerOwnedSkipped.length,
      skipped: report.skipped.length,
      conflicts: report.conflicts.length,
    },
    "Standalone-config→template reconcile pass complete"
  );

  return report;
}

export interface DetachResult {
  detached: boolean;
  kind: StandaloneKind;
  id: string;
  outcome?: "updated" | "proposed";
  reason?: string;
}

/**
 * DETACH — sever a standalone config's source-link so it stops reconciling.
 *
 * The canonical key-removal is `detachMarketSource` (returns the metadata bag
 * WITHOUT the `marketSource` key). But the GOVERNED per-kind `.update` doors
 * MERGE the metadata patch onto the existing bag — they cannot DELETE a jsonb
 * key — so we set `marketSource` to `null` through the merge. `readMarketSource`
 * treats a null link as ABSENT, so the reconcile engine above skips the row
 * exactly as if the key were gone. (Written the moment a REPLACE-capable door
 * exists, this becomes a true key removal; the functional contract — "stops
 * reconciling" — holds either way.)
 *
 * Attributed to the ACTING user (a user action, unlike the system-attributed
 * reconcile) so the governed door authorizes against the caller's real write
 * access to the row's workspace.
 *
 * NOTE (same gap as the skill reconcile above): `skillsRouter.update` carries
 * no `metadata` field, so a skill detach does NOT yet persist — it will the
 * moment that door threads `metadata`. Views and automations detach today.
 */
export async function detachStandaloneConfigSource(args: {
  kind: StandaloneKind;
  id: string;
  userId: string;
}): Promise<DetachResult> {
  const adapter = ADAPTERS.find((a) => a.kind === args.kind);
  if (!adapter) {
    return {
      detached: false,
      kind: args.kind,
      id: args.id,
      reason: `unknown kind "${args.kind}"`,
    };
  }

  const rows = await adapter.loadRows([args.id]);
  const row = rows[0];
  if (!row) {
    return {
      detached: false,
      kind: args.kind,
      id: args.id,
      reason: "config not found",
    };
  }

  const metadata =
    (row.metadata as Record<string, unknown> | null | undefined) ?? {};
  const source = readMarketSource(metadata);
  if (!source) {
    return {
      detached: false,
      kind: args.kind,
      id: args.id,
      reason: "no marketSource source-link to detach",
    };
  }

  // Canonical detach → null through the merge door (see the doc comment).
  const patch = { ...detachMarketSource(metadata), marketSource: null };
  const ctx = buildRowCtx(
    args.userId,
    (row.workspaceId as string | null) ?? null
  );
  const outcome = await adapter.applyUpdate({
    ctx,
    id: args.id,
    merged: {},
    metadata: patch,
  });

  return {
    detached: outcome === "updated",
    kind: args.kind,
    id: args.id,
    outcome,
  };
}
