/**
 * Workspace Creation Service
 *
 * Shared idempotent wrapper around `createWorkspaceFromDefinition`. Used by
 * both the tRPC `workspaces.createFromDefinition` mutation and the Hub
 * Protocol REST `/workspaces/from-definition` endpoint so external callers
 * (Eve, Coder) get the same idempotency guarantees as the in-app path.
 *
 * Two idempotency keys are supported:
 *   1. `packageSlug` — historic key used by the tRPC path (see workspaces router).
 *   2. `proposalId`  — caller-supplied stable key used by Hub REST (Eve / Coder
 *      generate this from a template id like "builder-workspace-v1").
 *
 * If a workspace already exists for the user with the given key, return it
 * with `created: false`. Otherwise create a new workspace and return
 * `created: true`.
 */
import {
  createWorkspaceFromDefinition,
  reconcileWorkspaceFromDefinition,
  db,
  drizzleSql,
  workspaceMembers,
  workspaces,
  and,
  eq,
  type ReconcileReport,
  type WorkspaceDefinitionInput,
  type WorkspaceSettings,
} from "@synap/database";
import { getBoss } from "@synap/jobs";
import { createLogger } from "@synap-core/core";
import {
  resolveWorkspaceTemplate,
  type ResolvedWorkspaceTemplate,
} from "./capabilities/resolve-workspace-template.js";

const logger = createLogger({ module: "workspace-creation-service" });

export interface ReconcileIfStaleResult {
  /** True iff an actual `reconcileWorkspaceFromDefinition` write happened. */
  reconciled: boolean;
  /**
   * True iff a version COMPARISON was possible (the resolved template carried
   * a version signal) — true even when up-to-date (no-op). Distinguishes
   * "checked, in sync" (caller should do nothing further) from "couldn't
   * check" (caller may fall back to its own legacy behavior).
   */
  checked: boolean;
  report?: ReconcileReport;
  version?: string;
  /**
   * The package definition this reconcile actually ran against — the FRESH
   * server-resolved template, NOT the caller's (possibly stale) copy.
   *
   * A caller that also syncs the post-workspace layers (capabilities /
   * playbooks / automations, via `applyPackagePostWorkspace`) MUST build its
   * body from THIS, not from its own `definition`: layer 1 reconciles against
   * the freshest template, so sourcing layer 2 from a stale caller copy would
   * silently skip a playbook the new template version just added (the workspace
   * would gain the new profile but not the playbook that uses it).
   * Undefined when the reconcile ran off `callerDefinition` (no resolved
   * template) — then the caller's own definition IS the right source.
   */
  packageDefinition?: ResolvedWorkspaceTemplate["packageDefinition"];
}

/**
 * Version-aware reconcile for an ALREADY-idempotent-hit workspace — the ONE
 * shared entry point BOTH install doors converge on:
 *   - Hub REST `POST /api/hub/packages/apply` → `materializeWorkspaceCore` →
 *     `createWorkspaceFromDefinitionIdempotent` (below), and
 *   - tRPC `workspaces.createFromDefinition`'s own idempotency pre-check
 *     (`reconcileExisting` in `routers/workspaces.ts`).
 * Neither reimplements the compare — both call this.
 *
 * Resolves the FRESHEST template via the cache-first `resolveWorkspaceTemplate`
 * (W2a). CP template versions are content-hash stamps (`"h-<hash>"`), not
 * semver, so a plain string mismatch IS the whole "is there an update" signal
 * (the CP only reissues a new hash when the template content actually
 * changed). Equal ⇒ genuinely nothing to do (skip, `checked:true,
 * reconciled:false`). Different ⇒ `reconcileWorkspaceFromDefinition`
 * (additive, non-destructive — never deletes/mutates existing data) +
 * re-stamp `settings.packageVersion` so the NEXT hit short-circuits clean.
 *
 * Never throws — `checked:false` (no `packageSlug`, template unresolvable, or
 * the resolved template carries no version signal, e.g. a bundle-fallback
 * template) lets the caller fall back to its own legacy behavior for that edge.
 *
 * Governance: reconciles under the SAME `userId` the caller was already
 * authorized as (Hub's agent-acting user, or the tRPC ctx user) — this widens
 * no permission floor beyond what the caller already enforced to reach this
 * idempotent-hit branch in the first place.
 */
export async function reconcileWorkspaceIfStale(opts: {
  workspaceId: string;
  packageSlug: string | undefined;
  currentSettings: WorkspaceSettings | null | undefined;
  userId: string;
  /**
   * Caller-supplied version fallback for slugs the cache-first
   * `resolveWorkspaceTemplate` can't see — private templates never land in
   * the pod's anonymous `cp_catalog_cache`, so `resolved?.version` is always
   * empty for them and this function used to bail with `checked:false`,
   * never stamping `settings.packageVersion`. The CLI fetches a private
   * template's hash version from the authed CP `/mine` and passes it as
   * `_meta.version` (Hub) → `packageVersion` (this service).
   *
   * FALLBACK ONLY: when `resolveWorkspaceTemplate` DOES resolve a version
   * (public/cached templates), that value always wins over this one — a
   * stale caller-supplied version must never override a fresh cache hit.
   */
  callerVersion?: string;
  /** Paired fallback definition — used only when both `resolved` AND its
   * `workspaceDefinition` are unavailable, so a reconcile write has
   * something to apply. */
  callerDefinition?: WorkspaceDefinitionInput;
}): Promise<ReconcileIfStaleResult> {
  const {
    workspaceId,
    packageSlug,
    currentSettings,
    userId,
    callerVersion,
    callerDefinition,
  } = opts;
  if (!packageSlug) return { reconciled: false, checked: false };

  try {
    const resolved = await resolveWorkspaceTemplate(packageSlug);
    // Cache-first: the resolved version always wins when present. Fall back
    // to the caller-supplied version ONLY when the cache yields nothing
    // (private/uncached slug) — never the other way around.
    const version = resolved?.version ?? callerVersion;
    if (!version) return { reconciled: false, checked: false };

    if (version === currentSettings?.packageVersion) {
      return { reconciled: false, checked: true, version };
    }

    const workspaceDefinition = (resolved?.workspaceDefinition ??
      callerDefinition) as WorkspaceDefinitionInput | undefined;
    if (!workspaceDefinition) {
      // Have a version to compare (caller-supplied) but nothing to
      // reconcile with — report the drift without writing.
      return { reconciled: false, checked: true, version };
    }

    const report = await reconcileWorkspaceFromDefinition({
      workspaceId,
      userId,
      definition: workspaceDefinition,
    });

    // Stamp the new version so the NEXT idempotent hit short-circuits as
    // up to date instead of re-reconciling every time. Merge atomically from
    // the database's post-reconcile value: currentSettings is the snapshot
    // from before reconciliation and replacing the whole JSONB document here
    // would erase layout/settings changes the reconcile just persisted.
    try {
      await db
        .update(workspaces)
        .set({
          settings: drizzleSql`COALESCE(${workspaces.settings}, '{}'::jsonb) || ${JSON.stringify(
            { packageVersion: version }
          )}::jsonb`,
        })
        .where(eq(workspaces.id, workspaceId));
    } catch (err) {
      logger.warn(
        { err, workspaceId },
        "reconcileWorkspaceIfStale: failed to stamp reconciled packageVersion (non-fatal)"
      );
    }

    return {
      reconciled: true,
      checked: true,
      report,
      version,
      // Hand back the SAME source layer 1 reconciled against so a caller
      // syncing layer 2 stays in lockstep with it (see the field's doc).
      packageDefinition: resolved?.packageDefinition,
    };
  } catch (err) {
    logger.warn(
      { err, workspaceId, packageSlug },
      "reconcileWorkspaceIfStale: version check failed (non-fatal)"
    );
    return { reconciled: false, checked: false };
  }
}

/**
 * Editor+ roles gate for legacy-identity ADOPTION — mirrors `WRITE_ROLES` in
 * `package-dependency-resolver.ts:178`. Adopting a pre-stamped workspace's
 * identity is itself a governed write (it mutates `provisioning_proposal_id`
 * + `settings`), so it gets the same floor a compose overlay write gets.
 *
 * DELIBERATELY kept at owner/admin/editor — NOT relaxed to "any visible
 * membership" the way `findWorkspaceBySubtype(..., requireWrite: false)`
 * (the dependency `require` path) is in `package-dependency-resolver.ts`.
 * That path is safe to relax because REUSE writes nothing to the matched
 * workspace — presence alone satisfies a `require` dependency. This path is
 * different: on a hit, `createWorkspaceFromDefinitionIdempotent` immediately
 * stamps `provisioning_proposal_id` + `settings.proposalId` onto the matched
 * row (see the adopt block below) and may also run
 * `reconcileWorkspaceFromDefinition` onto it. Both are writes, so a
 * viewer-only member must not be able to trigger them by re-running an
 * install — that would let a read-only membership silently mutate a
 * workspace's identity/content. The union fix above (both tiers feed one
 * role-filtered pool) closes the gap that used to make this floor miss
 * legitimate owner/editor matches; it does not widen who may adopt.
 */
const ADOPT_WRITE_ROLES = new Set(["owner", "admin", "editor"]);

interface LegacyWorkspaceMatch {
  id: string;
  settings: WorkspaceSettings | null;
}

/**
 * Fallback identity match for workspaces installed BEFORE migration 0039
 * promoted `proposalId`/`packageSlug` to indexed columns. Those rows have
 * `provisioning_proposal_id = NULL`, so the primary predicate in step 1 below
 * misses them — and without this fallback, a reinstall DUPLICATES instead of
 * reconciling (the root cause this function fixes).
 *
 * Two tiers, UNIONED (both always run, deduped by workspace id) — NOT tried
 * in order with first-hit-wins, because that let tier 1 short-circuit tier 2:
 * if `package_slug = slug` found a row but that row was later dropped by the
 * `ADOPT_WRITE_ROLES` filter (e.g. a viewer-only membership on the packageSlug
 * row), tier 2 never even ran, so a role-eligible subtype match was missed and
 * the caller fell through to CREATE → duplicate workspace. Both tiers now feed
 * the same candidate pool, which the role filter + tie-break below is applied
 * to as one step:
 *   1. `workspaces.package_slug = slug` — the promoted column. Stamped OLDER
 *      than `provisioning_proposal_id` (dual-written from a later
 *      `settings.proposalId` follow-up merge), so it covers more legacy rows.
 *   2. `settings->>'workspaceSubtype' = slug` — every built-in template sets
 *      its subtype (24/24), so this covers rows the packageSlug tier misses.
 *
 * GUARDRAIL on tier 2: overlays deliberately set their subtype to their
 * BASE's slug (`package-dependency-resolver.ts:234-237` documents the
 * collision this caused before transitive compose was routed around this
 * function entirely — see that module's file-header comment). A naive
 * subtype match on an overlay's OWN slug would therefore silently adopt the
 * BASE workspace as if it were the overlay.
 *
 * This is safe here because `createWorkspaceFromDefinitionIdempotent` is
 * NEVER called for a compose-overlay package: `materializeWorkspaceCore`
 * intercepts a resolved `composeTargetWorkspaceId` and routes to
 * `composeOntoBaseWorkspace` before ever reaching this function, and the
 * resolver's own transitive-compose step (§4a) does the same for a nested
 * overlay. Every caller that reaches this fallback is therefore already a
 * top-level STANDALONE install, by construction — not by inference from the
 * input. If that invariant is ever violated, the `ADOPT_WRITE_ROLES` gate
 * below is a floor, not a full guarantee: when ambiguous, "no match" (fall
 * through to create) is the safe default, never a guess.
 *
 * Both tiers reuse the exact deterministic tie-break (prefer owned, then
 * most-recently-created) and write-role floor `findWorkspaceBySubtype` in
 * `package-dependency-resolver.ts` already established for the same
 * `workspaceSubtype` predicate — mirrored here rather than imported, since
 * that module imports `createWorkspaceFromDefinitionIdempotent` FROM this
 * file and importing back would create a circular dependency.
 */
async function findLegacyWorkspaceMatch(
  slug: string,
  userId: string
): Promise<LegacyWorkspaceMatch | null> {
  const selectCols = {
    id: workspaces.id,
    ownerId: workspaces.ownerId,
    createdAt: workspaces.createdAt,
    settings: workspaces.settings,
    role: workspaceMembers.role,
  };

  const bySlug = await db
    .select(selectCols)
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.workspaceId, workspaces.id)
    )
    .where(
      and(eq(workspaceMembers.userId, userId), eq(workspaces.packageSlug, slug))
    );

  const bySubtype = await db
    .select(selectCols)
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.workspaceId, workspaces.id)
    )
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        drizzleSql`${workspaces.settings}->>'workspaceSubtype' = ${slug}`
      )
    );

  // UNION both tiers (deduped by workspace id) BEFORE the role filter below —
  // previously tier 2 (subtype) only ran when tier 1 (packageSlug) found ZERO
  // rows, so a packageSlug row that the role filter would later drop (e.g. a
  // viewer-only membership) silently suppressed a legitimate, role-eligible
  // subtype match instead of falling through to it. Running both and merging
  // first means the role filter + tie-break below sees every candidate from
  // either predicate, never just whichever tier happened to hit first.
  const byId = new Map<string, (typeof bySlug)[number]>();
  for (const r of [...bySlug, ...bySubtype]) byId.set(r.id, r);
  const rows = [...byId.values()];

  const matches = rows.filter((r) => ADOPT_WRITE_ROLES.has(r.role));
  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    const aOwner = a.ownerId === userId ? 1 : 0;
    const bOwner = b.ownerId === userId ? 1 : 0;
    if (aOwner !== bOwner) return bOwner - aOwner;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  if (matches.length > 1) {
    logger.warn(
      {
        slug,
        userId,
        count: matches.length,
        chosen: matches[0].id,
        candidates: matches.map((w) => w.id),
      },
      "findLegacyWorkspaceMatch: multiple legacy workspaces match fallback identity — chose deterministically (owner, then most-recent)"
    );
  }

  const chosen = matches[0];
  return {
    id: chosen.id,
    settings: (chosen.settings ?? null) as WorkspaceSettings | null,
  };
}

export interface CreateWorkspaceFromDefinitionInput {
  /** WorkspaceProposal-shaped definition (profiles, views, bento, etc.). */
  definition: WorkspaceDefinitionInput;
  /** Owning user — workspace becomes member-owned by this user. */
  userId: string;
  /**
   * Stable caller-supplied idempotency key. If present and a workspace with
   * this `proposalId` already exists for the user → return it untouched.
   */
  proposalId?: string;
  /** Optional human-friendly workspace name override (defaults to definition.workspaceName). */
  workspaceName?: string;
  /** Optional template provenance — stored in settings, not used for idempotency. */
  templateId?: string;
  templateName?: string;
  /** Optional CP package slug. Tracked separately from proposalId for the in-app path. */
  packageSlug?: string;
  packageVersion?: string;
  workspaceType?: "personal" | "agent" | "project" | "operational";
  linkedAgentId?: string;
  /** Audit field — who/what triggered this creation. */
  createdBy?: "user" | "provisioning" | "plugin";
}

export interface CreateWorkspaceFromDefinitionResult {
  workspaceId: string;
  /** True iff a new workspace was provisioned. False on idempotent re-hit. */
  created: boolean;
  /**
   * Set on an idempotent re-hit (`created:false`) that was additively synced
   * to a newer template via `reconcileWorkspaceIfStale` — W2b's version-aware
   * re-install, shared by BOTH doors (see that function's doc).
   */
  reconciled?: ReconcileReport;
  /**
   * Explicit discriminator so a caller never has to infer intent from
   * `created`/`reconciled` alone — the E4 fix: `created:true` used to be
   * returned for BOTH a genuine new workspace AND (before this field existed)
   * could be misread as covering a reused-but-stale one, since the two were
   * distinguishable only by also checking `reconciled`.
   *   - `"created"`    — a new workspace was materialized just now.
   *   - `"reconciled"` — the workspace already existed and drifted from the
   *     resolved template, so `reconcileWorkspaceIfStale` wrote additive
   *     changes onto it (see `reconciled` for the report).
   *   - `"unchanged"`  — the workspace already existed and was already
   *     current (or no version comparison was possible) — no write happened.
   */
  outcome: "created" | "reconciled" | "unchanged";
}

/**
 * Run `fn` while holding a per-(userId, proposalId) advisory lock. Used by
 * both the Hub REST and tRPC `createFromDefinition` paths to serialise
 * concurrent calls with the same idempotency key. The lock auto-releases on
 * session close, so a crashed handler can't deadlock future calls.
 *
 * If `proposalId` is missing, `fn` runs without locking — no idempotency to
 * protect.
 */
export async function withWorkspaceProposalIdLock<T>(
  userId: string,
  proposalId: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!proposalId) return fn();
  await db.execute(
    drizzleSql`SELECT pg_advisory_lock(
      hashtext('synap:workspace-from-definition:' || ${userId}),
      hashtext(${proposalId})
    )`
  );
  try {
    return await fn();
  } finally {
    await db.execute(
      drizzleSql`SELECT pg_advisory_unlock(
        hashtext('synap:workspace-from-definition:' || ${userId}),
        hashtext(${proposalId})
      )`
    );
  }
}

/**
 * Idempotently create a workspace from a definition.
 *
 * Idempotency check (in order):
 *   1. If `proposalId` is provided, look for an existing workspace whose
 *      settings.proposalId matches AND the caller is a member.
 *
 * On hit → return existing { workspaceId, created: false }.
 * On miss → run `createWorkspaceFromDefinition` and stamp `proposalId` into
 * settings so subsequent calls hit.
 */
export async function createWorkspaceFromDefinitionIdempotent(
  input: CreateWorkspaceFromDefinitionInput
): Promise<CreateWorkspaceFromDefinitionResult> {
  const {
    definition,
    userId,
    proposalId,
    workspaceName,
    templateId,
    templateName,
    packageSlug,
    packageVersion,
    workspaceType,
    linkedAgentId,
    createdBy = "user",
  } = input;

  // Recovery: a workspace whose last provisioning attempt FAILED must be
  // RESUMED from its completed steps, not reconciled. `reconcileWorkspaceIfStale`
  // short-circuits when the version stamp is unchanged, so a same-version CLI/Hub
  // reinstall of a failed workspace is otherwise a complete no-op that never
  // advances the stuck workspace. This mirrors the tRPC door's failed-status
  // resume (routers/workspaces.ts) — it triggers on STATUS not version, so it
  // bypasses the stale-version short-circuit with no version-stamp change.
  // Resume is step-granular idempotent (steps enter completedSteps only after
  // fully done). Returns a result to return directly, or null when the workspace
  // is not in a failed state (fall through to the normal reconcile path).
  const resumeIfFailed = async (
    workspaceId: string,
    settings: WorkspaceSettings | null | undefined
  ): Promise<CreateWorkspaceFromDefinitionResult | null> => {
    if (settings?.provisioningStatus !== "failed") return null;
    logger.warn(
      {
        userId,
        workspaceId,
        proposalId,
        packageSlug,
        failedStep: settings.failedStep,
        completedSteps: settings.completedSteps,
      },
      "createFromDefinition (Hub): resuming failed workspace from completed steps"
    );
    const resumeResult = await createWorkspaceFromDefinition({
      definition,
      userId,
      packageSlug,
      packageVersion,
      templateId,
      templateName,
      workspaceName,
      workspaceType,
      linkedAgentId,
      createdBy,
      resumeFrom: {
        workspaceId,
        completedSteps: settings.completedSteps ?? [],
      },
    });
    return {
      workspaceId: resumeResult.workspaceId,
      created: true,
      outcome: "created",
    };
  };

  // Serialise concurrent calls with the same (userId, proposalId) so a hung
  // retry can't race the original and double-create. No-op when proposalId
  // is missing.
  return withWorkspaceProposalIdLock(userId, proposalId, async () => {
    // ── 1. Idempotency by proposalId ────────────────────────────────────────────
    if (proposalId) {
      const existingMembership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.userId, userId),
          // Match the JSONB proposalId via SQL — avoids loading every workspace
          // row for the user. The composite (workspace_id, proposalId) check
          // happens server-side; we then verify membership via the join.
          drizzleSql`EXISTS (
          SELECT 1 FROM workspaces w
          WHERE w.id = ${workspaceMembers.workspaceId}
            AND w.provisioning_proposal_id = ${proposalId}
        )`
        ),
        with: { workspace: true },
      });
      if (existingMembership?.workspace) {
        const ws = existingMembership.workspace;
        const currentSettings = (ws.settings ??
          null) as WorkspaceSettings | null;
        // Failed prior attempt → resume from completed steps instead of
        // reconciling (a same-version reconcile would short-circuit to no-op).
        const resumed = await resumeIfFailed(ws.id, currentSettings);
        if (resumed) return resumed;
        // W2b: bring an already-present workspace up to the FRESHEST template
        // (cache-first, hash-compared) instead of silently no-op-ing — this is
        // the Hub-door gap the tRPC door already had a (now-shared) fix for.
        const { reconciled, report } = await reconcileWorkspaceIfStale({
          workspaceId: ws.id,
          packageSlug,
          currentSettings,
          userId,
          callerVersion: packageVersion,
          callerDefinition: definition,
        });
        logger.info(
          {
            userId,
            proposalId,
            workspaceId: ws.id,
            reconciled,
          },
          "createFromDefinition (Hub): returning existing workspace by proposalId"
        );
        return {
          workspaceId: ws.id,
          created: false,
          outcome: reconciled ? "reconciled" : "unchanged",
          ...(reconciled && report ? { reconciled: report } : {}),
        };
      }
    }

    // ── 1b. Fallback match for PRE-version-stamping legacy workspaces ──────────
    // Step 1 misses any workspace whose `provisioning_proposal_id` is NULL
    // (installed before migration 0039's column promotion, or created via a
    // door that never passed `proposalId`). Without this, such a workspace
    // duplicates on every reinstall instead of reconciling. See
    // `findLegacyWorkspaceMatch` for the two-tier predicate + overlay guardrail.
    if (packageSlug) {
      const fallback = await findLegacyWorkspaceMatch(packageSlug, userId);
      if (fallback) {
        const currentSettings = fallback.settings;
        // Failed prior attempt → resume from completed steps instead of
        // reconciling (a same-version reconcile would short-circuit to no-op).
        const resumed = await resumeIfFailed(fallback.id, currentSettings);
        if (resumed) return resumed;
        const { reconciled, report } = await reconcileWorkspaceIfStale({
          workspaceId: fallback.id,
          packageSlug,
          currentSettings,
          userId,
          callerVersion: packageVersion,
          callerDefinition: definition,
        });

        // Adopt the identity so the NEXT call hits the fast path (step 1)
        // instead of re-running this fallback — mirrors the existing
        // "stamp so next hit short-circuits" pattern used for packageVersion
        // in `reconcileWorkspaceIfStale` above.
        try {
          await db
            .update(workspaces)
            .set({
              provisioningProposalId: packageSlug,
              settings: {
                ...(currentSettings ?? {}),
                proposalId: packageSlug,
              } satisfies WorkspaceSettings,
            })
            .where(eq(workspaces.id, fallback.id));
        } catch (err) {
          logger.warn(
            { err, workspaceId: fallback.id, packageSlug },
            "createWorkspaceFromDefinitionIdempotent: failed to adopt legacy workspace identity (non-fatal)"
          );
        }

        logger.info(
          {
            userId,
            packageSlug,
            workspaceId: fallback.id,
            reconciled,
          },
          "createFromDefinition: adopted legacy workspace via fallback identity match"
        );

        return {
          workspaceId: fallback.id,
          created: false,
          outcome: reconciled ? "reconciled" : "unchanged",
          ...(reconciled && report ? { reconciled: report } : {}),
        };
      }
    }

    // ── 2. Create new workspace ────────────────────────────────────────────────
    // Resolve the version to stamp: prefer an explicit caller-supplied
    // `packageVersion`; otherwise, when `packageSlug` is known, resolve the
    // CP's freshest hash via `resolveWorkspaceTemplate` (W2a) so a Hub-door
    // create records the same hash the tRPC door's `input.packageVersion`
    // passthrough already recorded — closing the "only tRPC stamps it" gap.
    let versionToStamp = packageVersion;
    if (!versionToStamp && packageSlug) {
      try {
        const resolved = await resolveWorkspaceTemplate(packageSlug);
        versionToStamp = resolved?.version;
      } catch {
        // Best-effort — a failed resolve here must never block workspace creation.
      }
    }
    const result = await createWorkspaceFromDefinition({
      definition,
      userId,
      packageSlug,
      packageVersion: versionToStamp,
      templateId,
      templateName,
      workspaceName,
      workspaceType,
      linkedAgentId,
      createdBy,
    });

    // ── 3. Persist proposalId into settings so future calls are idempotent ─────
    // Done as a follow-up merge instead of being passed through
    // CreateFromDefinitionOptions to avoid widening that public type for a
    // Hub-REST-only concern. The merge is best-effort: a transient failure
    // here just means the next call will create a duplicate (acceptable for
    // a setup endpoint).
    if (proposalId) {
      try {
        const ws = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, result.workspaceId),
          columns: { settings: true },
        });
        const existingSettings = (ws?.settings ?? {}) as WorkspaceSettings;
        await db
          .update(workspaces)
          .set({
            provisioningProposalId: proposalId,
            settings: {
              ...existingSettings,
              proposalId,
            } satisfies WorkspaceSettings,
          })
          .where(eq(workspaces.id, result.workspaceId));
      } catch (err) {
        logger.warn(
          { err, workspaceId: result.workspaceId, proposalId },
          "Failed to stamp proposalId into workspace settings (non-fatal)"
        );
      }
    }

    // ── 4. Enqueue workspace-init for default whiteboard/commands ──────────────
    // Mirrors the tRPC path so the Hub-created workspace has the same defaults.
    try {
      const boss = getBoss();
      await boss.send("workspace-init", {
        workspaceId: result.workspaceId,
        userId,
        packageSlug,
      });
    } catch (err) {
      logger.warn(
        { err, workspaceId: result.workspaceId },
        "Failed to enqueue workspace-init from Hub path (non-fatal)"
      );
    }

    return {
      workspaceId: result.workspaceId,
      created: true,
      outcome: "created",
    };
  });
}

/**
 * Allow-list of agentTypes that may call the Hub Protocol REST workspace
 * creation endpoint. Other agentTypes get 403. Easy to extend by adding
 * a new entry below.
 */
export const WORKSPACE_CREATE_AGENT_TYPE_ALLOWLIST: ReadonlyArray<string> = [
  "eve",
  "coder",
];

export function isAgentTypeAllowedToCreateWorkspaces(
  agentType: string | null | undefined
): boolean {
  if (!agentType) return false;
  return WORKSPACE_CREATE_AGENT_TYPE_ALLOWLIST.includes(agentType);
}
