/**
 * The ONE store-write for gov-config — the unified settings door's executor core.
 *
 * `applyGovConfigChange` writes (set) or soft-deletes (revoke) a row in exactly
 * one of the three gov-config stores — `governance_rules`, `governance_ceilings`,
 * `config_settings` — using the SAME insert/revoke shapes the legacy B4a–B4g
 * executors and B5 once hand-rolled inline. Consolidating them here is the
 * "cleaner, easier to extend" fix: a new settings change adds a case HERE, not a
 * new proposal type + executor branch + recommender.
 *
 * `SettingsUpdateProposalData` is the unified flat payload (moved from
 * apply-approval.ts so the executor, the recommenders, and the human tRPC door
 * all import ONE definition — the "two copies drift" smell is the bug this ends).
 */

import { TRPCError } from "@trpc/server";
import { nonWidenableFloorFor } from "@synap/governance-policy";
import {
  db,
  and,
  eq,
  isNull,
  governanceRules,
  governanceCeilings,
  createGuideline,
  revokeGuideline,
  type GovernanceCeilingAxis,
  type ConfigScopeKind,
} from "@synap/database";

/**
 * The unified gov-config settings payload — the ONE door for AI/cron/human to
 * propose a change to `governance_rules` / `governance_ceilings` /
 * `config_settings`. Sensitivity is enforced at the GATE (a loosening change
 * always proposes — see `isLooseningSettingsChange` in permission-check.ts);
 * on approval the change is applied here, dispatched on `store` + `op`.
 */
export interface SettingsUpdateProposalData {
  store: "governance_rules" | "governance_ceilings" | "config_settings";
  op: "set" | "revoke";
  // governance_rules / governance_ceilings (flat, mirrors the legacy B4b/B4d):
  principalKind?: "agent" | "any";
  agentUserId?: string | null;
  scopeKind?: "pod" | "workspace";
  workspaceId?: string | null;
  targetKind?: "action" | "profile" | "capability";
  targetPattern?: string;
  targetProfile?: string | null;
  verdict?: "auto" | "propose";
  axis?: "daily_write_count" | "pending_proposal_cap";
  limitValue?: number;
  // config_settings:
  configScopeKind?: ConfigScopeKind;
  scopeRef?: string | null;
  capabilityId?: string | null;
  text?: string;
  posture?: "auto" | "propose";
  // revoke: the id of the row to soft-delete.
  targetId?: string;
  // DISPLAY-ONLY evidence, written by `recommend-raise-proposal-cap.ts` and read
  // ONLY by the review card (`useProposalPresentation`). `applyGovConfigChange`
  // never reads these — a settings proposal that omits them applies identically.
  // Declared here so the fields are a stated part of the payload rather than
  // untyped drift a future reader has to discover from a cast.
  agentName?: string | null;
  currentLimit?: number;
  pendingCount?: number;
}

/** The store-specific fields, sans the `store`/`op` discriminator. */
export type GovConfigSpec = Omit<SettingsUpdateProposalData, "store" | "op">;

export interface ApplyGovConfigChangeInput {
  store: SettingsUpdateProposalData["store"];
  op: SettingsUpdateProposalData["op"];
  spec: GovConfigSpec;
  sourceProposalId?: string | null;
  createdBy: string;
}

export interface ApplyGovConfigChangeResult {
  rows: number;
  ids: string[];
  subject: SettingsUpdateProposalData["store"];
}

/**
 * Apply ONE gov-config change. `set` inserts (and, for a pod-scoped ceiling,
 * supersedes the prior active row on that axis); `revoke` soft-deletes by
 * `spec.targetId`. Throws `TRPCError` on a revoke with no target.
 */
export async function applyGovConfigChange(
  input: ApplyGovConfigChangeInput
): Promise<ApplyGovConfigChangeResult> {
  const { store, op, spec, sourceProposalId, createdBy } = input;
  let rows = 0;
  let ids: string[] = [];

  if (store === "governance_ceilings") {
    if (op === "revoke") {
      if (!spec.targetId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "gov-config: revoke requires targetId.",
        });
      }
      const revoked = await db
        .update(governanceCeilings)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(governanceCeilings.id, spec.targetId),
            isNull(governanceCeilings.revokedAt)
          )
        )
        .returning({ id: governanceCeilings.id });
      ids = revoked.map((r) => r.id);
      rows = revoked.length;
    } else {
      const axis = (spec.axis ?? "daily_write_count") as GovernanceCeilingAxis;
      const agentUserId = spec.agentUserId ?? null;
      // Supersede the prior active pod-scoped ceiling on this axis so the new
      // one is the single effective row (mirrors the legacy raise_ceiling).
      await db
        .update(governanceCeilings)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(governanceCeilings.axis, axis),
            eq(governanceCeilings.principalKind, agentUserId ? "agent" : "any"),
            agentUserId
              ? eq(governanceCeilings.agentUserId, agentUserId)
              : isNull(governanceCeilings.agentUserId),
            eq(governanceCeilings.scopeKind, "pod"),
            isNull(governanceCeilings.revokedAt)
          )
        );
      const inserted = await db
        .insert(governanceCeilings)
        .values({
          axis,
          principalKind: agentUserId ? "agent" : "any",
          agentUserId,
          scopeKind: "pod",
          workspaceId: null,
          limitValue: typeof spec.limitValue === "number" ? spec.limitValue : 0,
          sourceProposalId: sourceProposalId ?? null,
          createdBy,
        })
        .returning({ id: governanceCeilings.id });
      ids = inserted.map((r) => r.id);
      rows = inserted.length;
    }
  } else if (store === "governance_rules") {
    if (op === "revoke") {
      if (!spec.targetId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "gov-config: revoke requires targetId.",
        });
      }
      const revoked = await db
        .update(governanceRules)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(governanceRules.id, spec.targetId),
            isNull(governanceRules.revokedAt)
          )
        )
        .returning({ id: governanceRules.id });
      ids = revoked.map((r) => r.id);
      rows = revoked.length;
    } else {
      const targetKind = spec.targetKind ?? "action";
      const targetPattern = spec.targetPattern ?? "*";
      const verdict = spec.verdict ?? "propose";
      // A rule that can never fire is refused, not stored — the SAME refusal
      // `governanceRules.create` (B3) and the legacy `governance.widen_lane`
      // approval branch give. The unified door is now the ONE every recommender
      // files through, so the check has to live HERE: an exact action key behind
      // a non-widenable floor resolves ABOVE the rule store (rung 2.8), so an
      // `auto` row there is a success receipt for a grant that does nothing.
      if (verdict === "auto" && targetKind === "action") {
        const floor = nonWidenableFloorFor(targetPattern);
        if (floor) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `NON_WIDENABLE_FLOOR (${floor}): "${targetPattern}" always needs review — no governance rule can auto-approve it.`,
          });
        }
      }
      const inserted = await db
        .insert(governanceRules)
        .values({
          principalKind: spec.principalKind ?? "agent",
          agentUserId: spec.agentUserId ?? null,
          scopeKind: spec.scopeKind ?? "pod",
          workspaceId:
            spec.scopeKind === "workspace" ? (spec.workspaceId ?? null) : null,
          targetKind,
          targetPattern,
          targetProfile: spec.targetProfile ?? null,
          verdict,
          sourceProposalId: sourceProposalId ?? null,
          createdBy,
        })
        .returning({ id: governanceRules.id });
      ids = inserted.map((r) => r.id);
      rows = inserted.length;
    }
  } else {
    // config_settings
    if (op === "revoke") {
      if (!spec.targetId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "gov-config: revoke requires targetId.",
        });
      }
      const revoked = await revokeGuideline({ db, id: spec.targetId });
      ids = revoked ? [revoked.id] : [];
      rows = revoked ? 1 : 0;
    } else {
      const created = await createGuideline({
        db,
        text: typeof spec.text === "string" ? spec.text : "",
        ...(spec.posture ? { posture: spec.posture } : {}),
        scopeKind: spec.configScopeKind ?? "default",
        scopeRef: spec.scopeRef ?? null,
        capabilityId: spec.capabilityId ?? null,
        workspaceId: spec.workspaceId ?? null,
        createdBy,
      });
      ids = [created.id];
      rows = 1;
    }
  }

  return { rows, ids, subject: store };
}
