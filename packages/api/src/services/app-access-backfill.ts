/**
 * BACKFILL — every app connection's approval into its v2 form
 * (`apps.approved_access`, migration 0434; app permissions W2, decision
 * 51ad8d1e).
 *
 * The rule, generic (never a per-pod list), the same one `AppRepository`
 * applies on every approval write (`approvedAccessOf`):
 *   - a row whose `approved_requests` LIFT losslessly
 *     (`liftApprovedRequests`: the v2 form allows exactly the (permission,
 *     place) pairs the rows hold) gets that v2 access;
 *   - a row that would widen, narrow, or holds a pair no app may hold, is a
 *     RE-CONSENT: it is left alone (no v2; every reader keeps its pairs) and
 *     reported with why and an example;
 *   - a row with no approval, or whose v2 already says what its pairs say,
 *     is left alone.
 * Each write is guarded by the pairs it was lifted from (`approved_requests`
 * unchanged since the read), so an approval decided meanwhile is never
 * overwritten with a stale lift.
 *
 * DRY RUN by default: it reads and counts, and writes nothing. `apply: true`
 * writes. Idempotent: a lifted row is "already" on the next run.
 */
import { and, asc, db, drizzleSql, eq } from "@synap/database";
import { apps, type AppApprovedRequest } from "@synap/database/schema";
import {
  accessWhereKey,
  liftApprovedRequests,
  parseAppAccess,
  sameAppAccess,
  type AccessPair,
  type ReconsentReason,
} from "@synap-core/types/grants";

export interface AppAccessBackfillRow {
  appId: string;
  publicId: string;
  name: string;
  outcome: "lifted" | "would-lift" | "already" | "reconsent" | "changed";
  /** Why a re-consent (reconsent rows only). */
  reason?: ReconsentReason;
  /** One pair that shows it ("would allow entity.note.read in space:<id>"). */
  example?: string;
}

export interface AppAccessBackfillReport {
  apply: boolean;
  /** Apps with an approval (`approved_requests` not null). */
  apps: number;
  /** Lift losslessly (written when applying). */
  liftable: number;
  /** Written this run (apply only). */
  written: number;
  /** v2 already says what the pairs say. */
  already: number;
  /** Their approval changed between the read and the write: not written. */
  changed: number;
  /** Left on their pairs, by reason. */
  reconsent: Record<ReconsentReason, number> & { total: number };
  rows: AppAccessBackfillRow[];
}

const say = (verb: string, p: AccessPair) =>
  `${verb} ${p.permission} in ${accessWhereKey(p.where)}`;

export async function backfillAppAccess(opts: {
  apply: boolean;
}): Promise<AppAccessBackfillReport> {
  const rows = await db
    .select({
      id: apps.id,
      publicId: apps.publicId,
      name: apps.name,
      approvedRequests: apps.approvedRequests,
      approvedAccess: apps.approvedAccess,
    })
    .from(apps)
    .where(drizzleSql`${apps.approvedRequests} IS NOT NULL`)
    .orderBy(asc(apps.createdAt), asc(apps.id));

  const report: AppAccessBackfillReport = {
    apply: opts.apply,
    apps: rows.length,
    liftable: 0,
    written: 0,
    already: 0,
    changed: 0,
    reconsent: {
      total: 0,
      unplaceable: 0,
      widens: 0,
      narrows: 0,
      "too-large": 0,
    },
    rows: [],
  };

  for (const row of rows) {
    const pairs: AppApprovedRequest[] = row.approvedRequests ?? [];
    const base = { appId: row.id, publicId: row.publicId, name: row.name };
    const lifted = liftApprovedRequests(pairs);
    if ("reconsent" in lifted) {
      const { reason, widens, narrows } = lifted.reconsent;
      report.reconsent.total += 1;
      report.reconsent[reason] += 1;
      const example =
        reason === "widens" && widens[0]
          ? say("would allow", widens[0])
          : reason === "narrows" && narrows[0]
            ? say("would lose", narrows[0])
            : reason === "too-large"
              ? "too large to compare within the lift's budget (fail closed)"
              : "holds a pair no app may hold (a write with no space)";
      report.rows.push({ ...base, outcome: "reconsent", reason, example });
      continue;
    }
    report.liftable += 1;
    const stored = parseAppAccess(row.approvedAccess);
    if (stored && sameAppAccess(stored, lifted.access)) {
      report.already += 1;
      report.rows.push({ ...base, outcome: "already" });
      continue;
    }
    if (!opts.apply) {
      report.rows.push({ ...base, outcome: "would-lift" });
      continue;
    }
    const written = await db
      .update(apps)
      .set({ approvedAccess: lifted.access })
      .where(
        and(
          eq(apps.id, row.id),
          // Only over the pairs it was lifted from.
          drizzleSql`${apps.approvedRequests} = ${JSON.stringify(pairs)}::jsonb`
        )
      )
      .returning({ id: apps.id });
    if (written.length === 0) {
      report.changed += 1;
      report.rows.push({ ...base, outcome: "changed" });
      continue;
    }
    report.written += 1;
    report.rows.push({ ...base, outcome: "lifted" });
  }
  return report;
}
