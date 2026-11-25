/**
 * DID THE TURN DO ANYTHING? The pod's own judgment of a run turn the IS
 * reported `completed`, on the write-receipt rule (`write-receipt.ts`): the
 * turn is `applied` when what it did reached the pod, `no_effect` when
 * nothing did. The IS's word says only that the turn did not fail.
 *
 * What counts, since the turn started, attributed to the run's session:
 *   - a playbook that DECLARES outputs: its writes only
 *     (`sessionLastAgentWriteSql`: proposals, applied or pending, and events,
 *     declared outputs included). Its reply is narration;
 *   - a playbook that declares none: its writes or a message in its room
 *     (`sessionLastAgentMarkSql`). Its reply IS the product.
 * Attribution is the session: a dispatched turn carries it on every Hub call
 * (`X-Session-Id`, forwarded with the turn), so its writes are stamped. Writes
 * are never matched by the agent and a time window: Synap AI's agent works
 * every session of its person at once, so that would credit one run with
 * another's work.
 *
 * `pending`: the reply counts and is not saved yet (the IS reports the turn's
 * end before the A2AI worker saves its reply). The caller
 * judges again once it is (`settleRunTurnPersisted`).
 *
 * The turn started when its triggering message was posted (`turnKey`), else
 * at the end of the turn before it, else at the run's start. A failed read
 * answers `applied`: an unread turn is never taken for an empty one.
 */
import {
  chatTurns,
  db,
  drizzleSql,
  focusSessions,
  messages,
  sessionLastAgentMarkSql,
  sessionLastAgentWriteSql,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { isUuid } from "@synap-core/types/property-render";
import { rowsOf } from "../../utils/execute-rows.js";

const logger = createLogger({ module: "turn-effect" });

export type TurnEffect = "applied" | "no_effect" | "pending";

/** The run declares outputs: its frozen definition lists some. */
export function runDeclaresOutputs(definitionSnapshot: unknown): boolean {
  const outputs = (definitionSnapshot as { expectedOutputs?: unknown } | null)
    ?.expectedOutputs;
  return Array.isArray(outputs) && outputs.length > 0;
}

export async function judgeTurnEffect(p: {
  runId: string;
  sessionId: string;
  definitionSnapshot: unknown;
  turnKey?: string | null;
  /** The end of the turn before this one, else the run's start. */
  since: Date | null;
}): Promise<TurnEffect> {
  const replyCounts = !runDeclaresOutputs(p.definitionSnapshot);
  const key = p.turnKey && isUuid(p.turnKey) ? p.turnKey : null;
  const fallback = p.since
    ? drizzleSql`${p.since.toISOString()}::timestamptz`
    : drizzleSql`'-infinity'::timestamptz`;
  const since = key
    ? drizzleSql`coalesce((SELECT ${messages.timestamp} FROM ${messages} WHERE ${messages.id} = ${key}::uuid), ${fallback})`
    : fallback;
  const marks = replyCounts
    ? sessionLastAgentMarkSql("fs")
    : sessionLastAgentWriteSql("fs");
  const replyUnsaved =
    replyCounts && key
      ? drizzleSql`EXISTS (SELECT 1 FROM ${chatTurns} WHERE ${chatTurns.userMessageId} = ${key}::uuid AND ${chatTurns.status} = 'running')`
      : drizzleSql`false`;
  try {
    const [row] = rowsOf<{ effect: boolean; unsaved: boolean }>(
      await db.execute(drizzleSql`
        SELECT coalesce(${marks} >= ${since}, false) AS effect,
               ${replyUnsaved} AS unsaved
        FROM ${focusSessions} fs
        WHERE fs.id = ${p.sessionId}::uuid
      `)
    );
    if (row?.effect) return "applied";
    return row?.unsaved ? "pending" : "no_effect";
  } catch (err) {
    logger.warn(
      { err, runId: p.runId, sessionId: p.sessionId },
      "the turn's effect could not be read; its completion stands"
    );
    return "applied";
  }
}
