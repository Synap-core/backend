/**
 * NEGATIVE CONTROL for scripts/ci/read-patterns.tripwire.test.ts: one NEW
 * site per pattern, in a file no allowlist entry names. Never merged.
 */
import { db, drizzleSql, eq } from "@synap/database";
import { events, proposals } from "@synap/database/schema";

export function negctlReads(id: string) {
  return [
    db.select().from(events).where(eq(events.subjectId, id)),
    db
      .select({ status: proposals.status, data: proposals.data })
      .from(proposals)
      .where(eq(proposals.status, "pending")),
    drizzleSql`SELECT 1 FROM automation_runs ar WHERE ar.id::text = ${id}`,
  ];
}
