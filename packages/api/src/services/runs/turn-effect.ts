/**
 * DID THE TURN DO ANYTHING? The pod's own judgment at a run turn's end
 * (founder, 20 Nov 2026), on the write-receipt rule (`write-receipt.ts`):
 * a turn is `applied` when something it did reached the pod, `no_effect`
 * when nothing did. The IS's word that its turn `completed` says only that it
 * did not fail; a turn that wrote nothing completes no run.
 *
 * Something reached the pod = an agent's MARK on the run's session since the
 * turn started (`sessionLastAgentMarkSql`, the needs-you evidence minus the
 * turns themselves): a room message, a write filed in the session (a
 * proposal applied at once or pending the person, an output, any event).
 *
 * The turn started when its triggering message was posted (`turnKey`, when
 * it names one), else at `fallbackSince`.
 *
 * THROWS on a failed read: the caller must not take an unread turn for an
 * empty one.
 */
import {
  db,
  drizzleSql,
  focusSessions,
  messages,
  sessionLastAgentMarkSql,
} from "@synap/database";
import { isUuid } from "@synap-core/types/property-render";
import { rowsOf } from "../../utils/execute-rows.js";

export async function turnHadEffect(p: {
  sessionId: string;
  turnKey?: string | null;
  fallbackSince: Date;
}): Promise<boolean> {
  const fallback = drizzleSql`${p.fallbackSince.toISOString()}::timestamptz`;
  const key = p.turnKey && isUuid(p.turnKey) ? p.turnKey : null;
  const since = key
    ? drizzleSql`coalesce((SELECT ${messages.timestamp} FROM ${messages} WHERE ${messages.id} = ${key}::uuid), ${fallback})`
    : fallback;
  const result = await db.execute(drizzleSql`
    SELECT coalesce(${sessionLastAgentMarkSql("fs")} >= ${since}, false) AS effect
    FROM ${focusSessions} fs
    WHERE fs.id = ${p.sessionId}::uuid
  `);
  return rowsOf<{ effect: boolean }>(result)[0]?.effect === true;
}
