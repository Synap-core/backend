/**
 * reconcileInstalledPacks — boot convergence for the OVERLAY packs a workspace
 * carries in `settings.installedPacks` (composed packs, `--onto` attaches onto
 * an identified workspace, D8 packs layered onto their primary domain).
 *
 * The boot pass reconciles ONE template per workspace — its identity
 * (`packageSlug`). A pack layered onto that workspace (business-model on
 * Foundation, grants on Operations, enterprise-os on its primary domain) was
 * invisible to it: no update to the pack could ever reach the workspace, and
 * nothing claimed otherwise only because nothing was recorded. This pass
 * re-syncs each recorded pack the same way the compose door installed it:
 *   - layer 1 ADDITIVELY through `reconcileWorkspaceFromDefinition` with the
 *     base's shell stripped (`overlayDefinitionForIdentifiedBase`) — never the
 *     pack's identity;
 *   - its playbooks through `reconcileWorkspacePlaybooksToTemplate` (source-
 *     linked 3-way merge; owner edits reported, never overwritten);
 *   - then — and ONLY when both converged — the ledger entry's `version`
 *     advances to the version just reconciled (invariant 1: the stamp asserts
 *     only what was checked).
 *
 * Non-fatal per pack. A pack whose template cannot be resolved (retired,
 * private, cache miss, a profile/view pack recorded by the browser) is skipped,
 * its ledger untouched — and the skip SAYS WHY, through the same catalog
 * standing template health reports (`classifyTemplateLifecycle`): retired
 * (and by what), not in the catalog, or catalog unknown. A catalog that could
 * not be read is `unknown`, never "not there".
 */

import { unfilteredAiFanoutError } from "@synap-core/types/automations";
import {
  db,
  eventRepository,
  WorkspaceRepository,
  reconcileWorkspaceFromDefinition,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import {
  overlayDefinitionForIdentifiedBase,
  upsertInstalledPack,
  type InstalledPackEntry,
} from "./compose-overlay.js";
import {
  playbookReportConverged,
  reconcileWorkspacePlaybooksToTemplate,
} from "./playbooks/reconcile-installed-playbooks.js";
import type { ResolvedWorkspaceTemplate } from "./capabilities/resolve-workspace-template.js";
import {
  classifyTemplateLifecycle,
  type TemplateCatalogView,
  type TemplateLifecycle,
} from "./template-health.js";

export interface InstalledPackReconcileOutcome {
  slug: string;
  status: "reconciled" | "skipped" | "partial" | "failed";
  version?: string;
  reason?: string;
  /** Skipped only: the overlay's catalog standing, the same one template health shows. */
  lifecycle?: TemplateLifecycle;
  /** Skipped + retired only: the live slug the catalog names as its replacement. */
  replacedBy?: string | null;
  playbooks?: {
    missing: string[];
    failed: number;
    /** Changes queued for review, not applied — withhold the stamp. */
    proposed: number;
    ownerOwned: string[];
  };
}

export async function reconcileInstalledPacks(opts: {
  workspaceId: string;
  ownerId: string;
  settings: Record<string, unknown> | null;
  /** The cache-first resolver (injected so boot can share its per-slug memo). */
  resolve: (slug: string) => Promise<ResolvedWorkspaceTemplate | null>;
  /**
   * The template catalog view (`resolveTemplateCatalog`) used to say WHY an
   * overlay did not resolve. `null` = the caller's read of it FAILED — every
   * skip then reads "catalog unknown", never "not in the catalog".
   */
  catalog: TemplateCatalogView | null;
  now?: string;
}): Promise<InstalledPackReconcileOutcome[]> {
  const ledger = opts.settings?.installedPacks;
  if (!Array.isArray(ledger) || ledger.length === 0) return [];
  const now = opts.now ?? new Date().toISOString();
  const identity =
    typeof opts.settings?.packageSlug === "string"
      ? opts.settings.packageSlug
      : null;
  const out: InstalledPackReconcileOutcome[] = [];
  let nextLedger: InstalledPackEntry[] | unknown = ledger;
  let ledgerMoved = false;

  for (const entry of ledger as Array<Partial<InstalledPackEntry>>) {
    const slug = entry?.slug;
    if (typeof slug !== "string" || slug === identity) continue;
    try {
      const resolved = await opts.resolve(slug);
      if (!resolved) {
        out.push(unresolvedOverlay(slug, opts.catalog));
        continue;
      }
      await reconcileWorkspaceFromDefinition({
        validateFlow: unfilteredAiFanoutError,
        workspaceId: opts.workspaceId,
        userId: opts.ownerId,
        definition: overlayDefinitionForIdentifiedBase(
          resolved.workspaceDefinition as unknown as WorkspaceDefinitionInput
        ),
        mergeCapabilities: true,
      });
      const pb = await reconcileWorkspacePlaybooksToTemplate({
        workspaceId: opts.workspaceId,
        userId: opts.ownerId,
        templatePlaybooks:
          (resolved.packageDefinition.playbooks as unknown[] | undefined) ?? [],
        packageSlug: slug,
        packageVersion: resolved.version ?? null,
        installedAt: now,
      });
      const playbooks = {
        missing: pb.missing,
        failed: pb.failed.length,
        proposed: pb.results.filter((r) => r.kind === "proposed").length,
        ownerOwned: pb.results.flatMap((r) =>
          r.ownerOwned.map((f) => `${r.name}.${f}`)
        ),
      };
      if (!playbookReportConverged(pb)) {
        out.push({ slug, status: "partial", playbooks });
        continue; // stamp withheld — failed, or only PROPOSED (not applied)
      }
      if (resolved.version && resolved.version !== entry.version) {
        nextLedger = upsertInstalledPack(
          nextLedger,
          { slug, version: resolved.version },
          now
        );
        ledgerMoved = true;
      }
      out.push({
        slug,
        status: "reconciled",
        version: resolved.version,
        playbooks,
      });
    } catch (err) {
      out.push({
        slug,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (ledgerMoved) {
    const repo = new WorkspaceRepository(db, eventRepository);
    await repo.mergeSettings(
      opts.workspaceId,
      { installedPacks: nextLedger as InstalledPackEntry[] },
      opts.ownerId
    );
  }
  return out;
}

/** A skipped overlay, with WHY it did not resolve — from the catalog standing. */
export function unresolvedOverlay(
  slug: string,
  catalog: TemplateCatalogView | null
): InstalledPackReconcileOutcome {
  if (!catalog) {
    return {
      slug,
      status: "skipped",
      lifecycle: "unknown",
      replacedBy: null,
      reason: "catalog unknown: the template catalog could not be read",
    };
  }
  const { lifecycle, replacedBy } = classifyTemplateLifecycle(slug, catalog);
  const reason =
    lifecycle === "retired"
      ? replacedBy
        ? `retired, replaced by "${replacedBy}"`
        : "retired, no replacement"
      : lifecycle === "unlisted"
        ? "not in the template catalog"
        : lifecycle === "unknown"
          ? "catalog unknown: the last template sync was not provably complete"
          : "in the catalog, but its definition could not be fetched";
  return { slug, status: "skipped", lifecycle, replacedBy, reason };
}
