/**
 * backfillWorkspaceIdentity — REPORT FIRST, STAMP SECOND (opt-in).
 * ================================================================
 *
 * THE PROBLEM. `reconcile-workspaces-to-templates.ts` converges a workspace to
 * its canonical template only when it can resolve a template for it. A
 * workspace carrying no template identity therefore never converges — and the
 * field that identifies it is the field that is missing, so no amount of
 * template editing can reach it. Every template fix is forward-only, reaching
 * zero existing workspaces. On the pod measured on 2026-09-05, 11 of 14
 * workspaces were in that state, including the 901-entity Builder workspace,
 * which consequently fails all four tiers of `resolveWorkspaceForScope`.
 *
 * WHAT THIS DOES. A read-only pass infers a candidate identity from evidence
 * the workspace already carries (see `workspace-identity/fingerprint.ts` for
 * the evidence model and why each source was chosen or rejected), and an
 * opt-in second pass stamps ONLY the workspaces whose identity was earned
 * UNAMBIGUOUSLY.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It writes `packageSlug` and
 * `workspaceSubtype` — the IDENTITY — and nothing else. It does NOT write
 * `workspaceCapabilities` or `workspaceVisibility`: once the identity exists,
 * `reconcileWorkspacesToTemplates` owns convergence, and re-deriving those here
 * would be a second door onto the same fields, guaranteed to drift from the
 * first.
 *
 * GATING, because a wrong stamp is worse than no stamp:
 *  - report mode is the DEFAULT; the write needs an explicit opt-in
 *    (`WORKSPACE_IDENTITY_BACKFILL=stamp`, or `{ stamp: true }`), so it never
 *    runs automatically at boot;
 *  - only UNAMBIGUOUS verdicts are ever written;
 *  - a workspace that already has ANY identity (`settings.packageSlug`,
 *    `settings.workspaceSubtype`, or the `package_slug` column) is skipped
 *    before it is even scored — an existing value is never overwritten, which
 *    is also what makes a second run a no-op;
 *  - every stamp is logged with the evidence that earned it;
 *  - a failure on one workspace is logged and skipped, never fatal — the same
 *    stance as `backfill-team-person-bridge.ts` and the reconcile hook.
 */

import { createLogger } from "@synap-core/core";
import {
  getDb,
  workspaces,
  profiles,
  profileWorkspaceAccess,
  entities,
  ProfileScope,
  WorkspaceRepository,
  EventRepository,
  sql,
  eq,
  and,
  inArray,
  isNull,
  type WorkspaceSettings,
} from "@synap/database";
import { sql as drizzleSql } from "drizzle-orm";
import {
  buildTemplateFingerprints,
  existingTemplateIdentity,
  matchWorkspaceIdentity,
  type IdentityMatch,
} from "./workspace-identity/fingerprint.js";
import { bundledTemplateFingerprints } from "./workspace-identity/corpus.js";
export { formatIdentityReport } from "./workspace-identity/report.js";

const logger = createLogger({ module: "backfill-workspace-identity" });

export interface BackfillOptions {
  /** Write the earned stamps. Default false — report only. */
  stamp?: boolean;
}

export interface BackfillResult {
  /** Every workspace that lacked an identity, with its verdict and evidence. */
  matches: IdentityMatch[];
  /** Workspaces skipped because they already carry an identity. */
  alreadyIdentified: Array<{ id: string; name: string; identity: string }>;
  stamped: Array<{ id: string; name: string; slug: string; subtype?: string }>;
  failed: number;
  /** Whether writes were enabled for this run. */
  didStamp: boolean;
}

/**
 * Profiles BOUND to a workspace: WORKSPACE-scoped rows owned by it, plus SHARED
 * rows explicitly granted to it. SYSTEM and USER profiles are excluded on
 * purpose — they are pod-wide, identical for every workspace, and including
 * them would add the same noise to every candidate's numerator while telling us
 * nothing about which template this workspace came from.
 */
async function loadBoundProfileSlugs(
  db: Awaited<ReturnType<typeof getDb>>,
  workspaceIds: string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (workspaceIds.length === 0) return out;

  const owned = await db
    .select({ workspaceId: profiles.workspaceId, slug: profiles.slug })
    .from(profiles)
    .where(
      and(
        eq(profiles.isActive, true),
        eq(profiles.scope, ProfileScope.WORKSPACE),
        inArray(profiles.workspaceId, workspaceIds)
      )
    );

  const granted = await db
    .select({
      workspaceId: profileWorkspaceAccess.workspaceId,
      slug: profiles.slug,
    })
    .from(profileWorkspaceAccess)
    .innerJoin(profiles, eq(profiles.id, profileWorkspaceAccess.profileId))
    .where(
      and(
        eq(profiles.isActive, true),
        inArray(profileWorkspaceAccess.workspaceId, workspaceIds)
      )
    );

  for (const row of [...owned, ...granted]) {
    if (!row.workspaceId) continue;
    const list = out.get(row.workspaceId) ?? [];
    if (!list.includes(row.slug)) list.push(row.slug);
    out.set(row.workspaceId, list);
  }
  return out;
}

async function loadEntityCounts(
  db: Awaited<ReturnType<typeof getDb>>,
  workspaceIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workspaceIds.length === 0) return out;
  const rows = await db
    .select({
      workspaceId: entities.workspaceId,
      count: drizzleSql<number>`count(*)::int`,
    })
    .from(entities)
    .where(inArray(entities.workspaceId, workspaceIds))
    .groupBy(entities.workspaceId);
  for (const r of rows) if (r.workspaceId) out.set(r.workspaceId, r.count);
  return out;
}

/**
 * The one pass. Read-only unless `stamp` is explicitly enabled.
 */
export async function backfillWorkspaceIdentity(
  opts: BackfillOptions = {}
): Promise<BackfillResult> {
  const didStamp = opts.stamp === true;
  const db = await getDb();

  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      ownerId: workspaces.ownerId,
      settings: workspaces.settings,
      systemSlug: workspaces.systemSlug,
      packageSlug: workspaces.packageSlug,
    })
    .from(workspaces)
    .where(isNull(workspaces.archivedAt));

  const alreadyIdentified: BackfillResult["alreadyIdentified"] = [];
  const orphans: typeof rows = [];

  for (const ws of rows) {
    const settings = (ws.settings ?? {}) as WorkspaceSettings;
    // ANY existing identity wins — the never-overwrite guard, applied BEFORE
    // scoring so an identified workspace is not even a candidate. It is a pure,
    // separately-tested predicate (`existingTemplateIdentity`) rather than an
    // inline expression, so the idempotency guarantee is provable without a DB.
    const identity = existingTemplateIdentity({
      settings,
      packageSlug: ws.packageSlug,
    });
    if (identity) {
      alreadyIdentified.push({ id: ws.id, name: ws.name, identity });
      continue;
    }
    orphans.push(ws);
  }

  const orphanIds = orphans.map((o) => o.id);
  const [profileSlugs, entityCounts] = await Promise.all([
    loadBoundProfileSlugs(db, orphanIds),
    loadEntityCounts(db, orphanIds),
  ]);

  const corpus = buildTemplateFingerprints(bundledTemplateFingerprints());

  const matches: IdentityMatch[] = orphans.map((ws) => {
    const settings = (ws.settings ?? {}) as WorkspaceSettings;
    return matchWorkspaceIdentity(
      {
        id: ws.id,
        name: ws.name,
        profileSlugs: profileSlugs.get(ws.id) ?? [],
        sourceRoles: settings.sourceRoles as Record<string, string> | undefined,
        systemSlug: ws.systemSlug ?? settings.systemSlug ?? undefined,
        entityCount: entityCounts.get(ws.id) ?? 0,
      },
      corpus
    );
  });

  const stamped: BackfillResult["stamped"] = [];
  let failed = 0;

  if (didStamp) {
    const eventRepo = new EventRepository(sql);
    const workspaceRepo = new WorkspaceRepository(db, eventRepo);
    const ownerById = new Map(orphans.map((o) => [o.id, o.ownerId]));

    for (const m of matches) {
      if (m.verdict !== "UNAMBIGUOUS" || !m.match) continue;
      try {
        // The one settings door — it also lifts `packageSlug` into its promoted
        // column (migration 0039), so the JSONB and the column can never
        // disagree. `packageSlug` is the TEMPLATE SLUG: the key both
        // `resolveWorkspaceTemplate` and `cp_catalog_cache` are indexed by.
        // `workspaceSubtype` is the template's own declared subtype, which is
        // NOT injective across the corpus and so is written as a category, not
        // as the resolution key.
        await workspaceRepo.mergeSettings(
          m.workspaceId,
          {
            packageSlug: m.match.slug,
            ...(m.match.subtype ? { workspaceSubtype: m.match.subtype } : {}),
          },
          ownerById.get(m.workspaceId) ?? "system"
        );
        stamped.push({
          id: m.workspaceId,
          name: m.workspaceName,
          slug: m.match.slug,
          subtype: m.match.subtype,
        });
        logger.info(
          {
            workspaceId: m.workspaceId,
            workspaceName: m.workspaceName,
            packageSlug: m.match.slug,
            workspaceSubtype: m.match.subtype,
            evidence: m.reason,
            candidates: m.candidates.map((c) => ({
              slug: c.slug,
              coverage: Number(c.coverage.toFixed(2)),
              distinctive: c.distinctiveMatched.length,
              strong: c.strong,
            })),
          },
          "Workspace identity stamped (UNAMBIGUOUS match)"
        );
      } catch (err) {
        failed++;
        logger.warn(
          { err, workspaceId: m.workspaceId },
          "Workspace identity stamp failed (non-fatal)"
        );
      }
    }
  }

  logger.info(
    {
      total: rows.length,
      alreadyIdentified: alreadyIdentified.length,
      orphans: orphans.length,
      unambiguous: matches.filter((m) => m.verdict === "UNAMBIGUOUS").length,
      ambiguous: matches.filter((m) => m.verdict === "AMBIGUOUS").length,
      unknown: matches.filter((m) => m.verdict === "UNKNOWN").length,
      stamped: stamped.length,
      failed,
      mode: didStamp ? "stamp" : "report",
    },
    "Workspace identity pass complete"
  );

  return { matches, alreadyIdentified, stamped, failed, didStamp };
}
