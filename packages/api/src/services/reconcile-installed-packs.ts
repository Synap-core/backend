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
 * Non-fatal per pack. A pack whose template cannot be resolved (private, cache
 * miss, a profile/view pack recorded by the browser) is skipped, its ledger
 * untouched.
 */

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
import { reconcileWorkspacePlaybooksToTemplate } from "./playbooks/reconcile-installed-playbooks.js";
import type { ResolvedWorkspaceTemplate } from "./capabilities/resolve-workspace-template.js";

export interface InstalledPackReconcileOutcome {
  slug: string;
  status: "reconciled" | "skipped" | "partial" | "failed";
  version?: string;
  reason?: string;
  playbooks?: { missing: string[]; failed: number; ownerOwned: string[] };
}

export async function reconcileInstalledPacks(opts: {
  workspaceId: string;
  ownerId: string;
  settings: Record<string, unknown> | null;
  /** The cache-first resolver (injected so boot can share its per-slug memo). */
  resolve: (slug: string) => Promise<ResolvedWorkspaceTemplate | null>;
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
        out.push({ slug, status: "skipped", reason: "template unresolved" });
        continue;
      }
      await reconcileWorkspaceFromDefinition({
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
        ownerOwned: pb.results.flatMap((r) =>
          r.ownerOwned.map((f) => `${r.name}.${f}`)
        ),
      };
      if (pb.failed.length > 0) {
        out.push({ slug, status: "partial", playbooks });
        continue; // stamp withheld — the playbook layer did not converge
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
