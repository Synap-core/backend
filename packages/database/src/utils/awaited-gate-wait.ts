/**
 * "The session waits on its GATE" — a pending plan/deploy approval filed in
 * the session. The third arm of the waits-on-the-person rule
 * (`open-room-question.ts`): a dev-loop agent files `dev.plan_approval` and
 * STOPS until the person decides, which owes no slot and asks no room
 * question, so the reapers read that session as idle and failed its run.
 *
 * The types are `AWAITED_GATE_PROPOSAL_TYPES` (@synap/playbooks), mirrored:
 * this package does not import playbooks (it mirrors it, like the schema
 * comments say). `awaited-gate-types.parity.test.ts` (@synap/api) pins the
 * mirror to the source.
 */

import { sql as drizzleSql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const AWAITED_GATE_PROPOSAL_TYPES_MIRROR = [
  "dev.plan_approval",
  "dev.deploy_approval",
] as const;

const GATE_TYPES_SQL = drizzleSql.raw(
  AWAITED_GATE_PROPOSAL_TYPES_MIRROR.map((t) => `'${t}'`).join(", ")
);

/** SQL: a pending awaited-gate proposal was filed in the session `sessionId`. */
export function awaitedGatePendingIn(sessionId: AnyPgColumn | SQL): SQL {
  return drizzleSql`EXISTS (
    SELECT 1 FROM proposals gate
    WHERE gate.session_id = ${sessionId}
      AND gate.status = 'pending'
      AND gate.proposal_type IN (${GATE_TYPES_SQL})
  )`;
}
