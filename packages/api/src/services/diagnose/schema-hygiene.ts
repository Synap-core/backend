/**
 * `synap_diagnose` — the SCHEMA HYGIENE section (pod hygiene P1, read-only).
 *
 * What the pod has accumulated and nothing retires, as numbers the reader can
 * act on through the cleanup pack (`services/pod-hygiene/cleanup-pack.ts`):
 *
 *   - zero-entity non-core kinds (per profile ROW, not per slug);
 *   - twins (read from the schema-contract signal already gathered — never a
 *     second query);
 *   - duplicate relation defs (one slug, several visible rows);
 *   - never-run automations;
 *   - stale WORK sessions older than STALE_SESSION_DAYS;
 *   - pending objectWork proposals older than OLD_PROPOSAL_DAYS.
 *
 * ── Floors (every count is the caller's) ─────────────────────────────────────
 *   kinds, relation defs  the schema-contract profile predicate: system/shared
 *                         rows, workspace rows in workspaces the caller can see
 *                         (`userVisibleWhere`), user rows the caller owns.
 *   automations           `ownerPrivateVisibleWhere` — pod-wide rows only when
 *                         the caller created them.
 *   sessions              the caller's own (`focus_sessions.user_id`), the same
 *                         floor the close door applies.
 *   proposals             `proposalUserFloor`, the review queue's own builder.
 *
 * The ZERO test for a kind is deliberately POD-WIDE (NOT EXISTS over every live
 * entity): a floored "zero" would call a kind unused while another member's
 * records use it — a false finding the cleanup pack would then act on. It only
 * reveals a boolean about a kind the caller can already see.
 */

import {
  db,
  and,
  eq,
  lt,
  or,
  ne,
  inArray,
  isNull,
  drizzleSql,
  profiles,
  entities,
  relationDefs,
  automations,
  focusSessions,
  proposals,
  ProposalStatus,
  ProfileScope,
} from "@synap/database";
import {
  userVisibleWhere,
  ownerPrivateVisibleWhere,
} from "../../utils/user-visible-where.js";
import { proposalUserFloor } from "../../routers/proposals/scope-conditions.js";
import { sessionKindWhere } from "../focus-sessions/session-kind.js";
import { classifyProposal } from "../proposals/proposal-class.js";
import {
  STALE_SESSION_DAYS,
  OLD_PROPOSAL_DAYS,
  cutoffIso,
} from "../pod-hygiene/cleanup-pack.js";
import { visibleProfileWhere, type TwinGroup } from "./schema-contract.js";
import type { HealthSection } from "./types.js";

const MAX_REPORTED = 50;
/** Bound on the pending-proposal class scan (classification is TS-side). */
const PROPOSAL_SCAN_LIMIT = 2000;

export interface SchemaHygieneSignal {
  zeroEntityKinds: Array<{
    profileId: string;
    slug: string;
    displayName: string;
    scope: string;
    workspaceId: string | null;
  }>;
  duplicateRelationDefs: Array<{ slug: string; rows: number }>;
  neverRunAutomations: Array<{ id: string; name: string; status: string }>;
  staleWorkSessions: { total: number; oldestUpdatedAt: string | null };
  oldObjectWorkProposals: {
    total: number;
    oldestCreatedAt: string | null;
    /** True when the scan hit PROPOSAL_SCAN_LIMIT — `total` is then a floor. */
    scanCapped: boolean;
  };
}

/** PURE: the section. `attention` when anything is found, never `degraded`. */
export function summarizeSchemaHygiene(
  signal: SchemaHygieneSignal,
  twins: readonly TwinGroup[] | undefined
): HealthSection {
  const parts: string[] = [];
  if (signal.zeroEntityKinds.length > 0)
    parts.push(`${signal.zeroEntityKinds.length} kind(s) with no records`);
  if (twins && twins.length > 0)
    parts.push(`${twins.length} kind slug(s) held by several rows`);
  if (signal.duplicateRelationDefs.length > 0)
    parts.push(
      `${signal.duplicateRelationDefs.length} relation type(s) defined more than once`
    );
  if (signal.neverRunAutomations.length > 0)
    parts.push(
      `${signal.neverRunAutomations.length} automation(s) that never ran`
    );
  if (signal.staleWorkSessions.total > 0)
    parts.push(
      `${signal.staleWorkSessions.total} work session(s) idle over ${STALE_SESSION_DAYS} days`
    );
  if (signal.oldObjectWorkProposals.total > 0)
    parts.push(
      `${signal.oldObjectWorkProposals.total}${signal.oldObjectWorkProposals.scanCapped ? "+" : ""} proposal(s) waiting over ${OLD_PROPOSAL_DAYS} days`
    );

  return {
    key: "schema_hygiene",
    status: parts.length > 0 ? "attention" : "ok",
    headline:
      parts.length > 0
        ? parts.join("; ")
        : "Nothing to tidy — every kind has records, no duplicate relation types, every automation has run, no long-idle work sessions or long-waiting proposals",
    detail: {
      zeroEntityKinds: signal.zeroEntityKinds.slice(0, MAX_REPORTED),
      zeroEntityKindsTotal: signal.zeroEntityKinds.length,
      twinsTotal: twins?.length ?? null,
      duplicateRelationDefs: signal.duplicateRelationDefs.slice(
        0,
        MAX_REPORTED
      ),
      duplicateRelationDefsTotal: signal.duplicateRelationDefs.length,
      neverRunAutomations: signal.neverRunAutomations.slice(0, MAX_REPORTED),
      neverRunAutomationsTotal: signal.neverRunAutomations.length,
      staleWorkSessions: signal.staleWorkSessions,
      oldObjectWorkProposals: signal.oldObjectWorkProposals,
      notes: {
        zeroEntityKinds:
          "active non-system kinds you can see with no live record anywhere in the pod",
        twins: "see the schema_contract section for the rows",
        lens: "kinds and relation types: rows you can see; automations: workspace rows you can see plus pod-wide ones you created; sessions: yours; proposals: your review queue floor",
        act: "the daily cleanup pack proposes closing, expiring, retiring and pausing these; nothing is applied without your approval",
      },
    },
  };
}

/** DB tier. `workspaceId` narrows to one lens, like the sibling sections. */
export async function gatherSchemaHygieneSignal(params: {
  userId: string;
  workspaceId: string | null;
  now?: Date;
}): Promise<SchemaHygieneSignal> {
  const { userId, workspaceId: ws } = params;
  const now = params.now ?? new Date();
  const staleCutoff = cutoffIso(now, STALE_SESSION_DAYS);
  const proposalCutoff = cutoffIso(now, OLD_PROPOSAL_DAYS);

  const [kinds, relDupes, neverRun, stale, oldProposals] = await Promise.all([
    db
      .select({
        profileId: profiles.id,
        slug: profiles.slug,
        displayName: profiles.displayName,
        scope: profiles.scope,
        workspaceId: profiles.workspaceId,
      })
      .from(profiles)
      .where(
        and(
          eq(profiles.isActive, true),
          ne(profiles.scope, ProfileScope.SYSTEM),
          eq(profiles.profileKind, "kind"),
          visibleProfileWhere(userId),
          ws ? eq(profiles.workspaceId, ws) : undefined,
          drizzleSql`NOT EXISTS (SELECT 1 FROM ${entities} e WHERE e.profile_id = ${profiles.id} AND e.deleted_at IS NULL)`
        )
      ),
    db
      .select({
        slug: relationDefs.slug,
        rows: drizzleSql<number>`cast(count(*) as integer)`,
      })
      .from(relationDefs)
      .where(
        and(
          userVisibleWhere(relationDefs.workspaceId, userId),
          ws
            ? or(
                isNull(relationDefs.workspaceId),
                eq(relationDefs.workspaceId, ws)
              )
            : undefined
        )
      )
      .groupBy(relationDefs.slug)
      .having(drizzleSql`count(*) > 1`),
    db
      .select({
        id: automations.id,
        name: automations.name,
        status: automations.status,
      })
      .from(automations)
      .where(
        and(
          ownerPrivateVisibleWhere(
            automations.workspaceId,
            automations.createdBy,
            userId
          ),
          inArray(automations.status, ["active", "draft"]),
          eq(automations.runCount, 0),
          isNull(automations.lastRunAt),
          ws
            ? or(
                isNull(automations.workspaceId),
                eq(automations.workspaceId, ws)
              )
            : undefined
        )
      ),
    db
      .select({
        total: drizzleSql<number>`cast(count(*) as integer)`,
        oldest: drizzleSql<string | null>`min(${focusSessions.updatedAt})`,
      })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, userId),
          eq(focusSessions.status, "stale"),
          lt(focusSessions.updatedAt, drizzleSql`${staleCutoff}::timestamptz`),
          sessionKindWhere("work"),
          ws ? eq(focusSessions.workspaceId, ws) : undefined
        )
      ),
    db
      .select({
        proposalType: proposals.proposalType,
        targetType: proposals.targetType,
        createdAt: proposals.createdAt,
      })
      .from(proposals)
      .where(
        and(
          proposalUserFloor(userId),
          eq(proposals.status, ProposalStatus.PENDING),
          lt(proposals.createdAt, drizzleSql`${proposalCutoff}::timestamptz`),
          ws ? eq(proposals.workspaceId, ws) : undefined
        )
      )
      .limit(PROPOSAL_SCAN_LIMIT),
  ]);

  const objectWork = oldProposals.filter(
    (p) => classifyProposal(p.proposalType, p.targetType) === "objectWork"
  );
  const oldest = objectWork.reduce<Date | null>((acc, p) => {
    const d = new Date(p.createdAt);
    return !acc || d < acc ? d : acc;
  }, null);

  return {
    zeroEntityKinds: kinds,
    duplicateRelationDefs: relDupes.map((r) => ({
      slug: r.slug,
      rows: Number(r.rows),
    })),
    neverRunAutomations: neverRun,
    staleWorkSessions: {
      total: Number(stale[0]?.total ?? 0),
      oldestUpdatedAt: stale[0]?.oldest
        ? new Date(stale[0].oldest).toISOString()
        : null,
    },
    oldObjectWorkProposals: {
      total: objectWork.length,
      oldestCreatedAt: oldest ? oldest.toISOString() : null,
      scanCapped: oldProposals.length >= PROPOSAL_SCAN_LIMIT,
    },
  };
}
