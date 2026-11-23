/**
 * THE writer of `automations.status` once an automation exists (tripwire
 * `automation-status-one-writer`). A compare-and-set: only rows standing in
 * one of `from` that `AUTOMATION_TRANSITIONS` lets reach `to` move, so a
 * concurrent pause, archive or fix is never overwritten. A row is BORN with
 * its status (`statusAtCreate`), which is not a move.
 */
import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  AUTOMATION_TRANSITIONS,
  canTransition,
  type AutomationStatusValue,
} from "@synap-core/types/units";
import type * as schema from "../../schema/index.js";
import { automations } from "../../schema/automations.js";

type Db = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type AutomationStatusWriter = Pick<Db, "update"> | Pick<Tx, "update">;

/** An automation's other columns, written in the same statement. */
export type AutomationColumnsPatch = Omit<
  PgUpdateSetSource<typeof automations>,
  "status" | "id"
>;

export interface SetAutomationStatusInput {
  id?: string;
  /** A set-based predicate, ANDed with `id` when both are given. */
  where?: SQL;
  /** The status(es) the caller read: the compare-and-set. */
  from: AutomationStatusValue | readonly AutomationStatusValue[];
  to: AutomationStatusValue;
  set?: AutomationColumnsPatch;
}

/** A row the move wrote. */
export interface MovedAutomation {
  id: string;
  name: string;
  status: AutomationStatusValue;
}

/** Moves the matching rows; returns the rows it wrote (none when they moved meanwhile). */
export async function setAutomationStatus(
  db: AutomationStatusWriter,
  input: SetAutomationStatusInput
): Promise<MovedAutomation[]> {
  if (!input.id && !input.where) {
    throw new Error("setAutomationStatus needs an id or a where");
  }
  const read: readonly AutomationStatusValue[] =
    typeof input.from === "string" ? [input.from] : input.from;
  const from = read.filter((s) =>
    canTransition(AUTOMATION_TRANSITIONS, s, input.to)
  );
  if (from.length === 0) return [];
  return (db as Pick<Db, "update">)
    .update(automations)
    .set({ updatedAt: new Date(), ...input.set, status: input.to })
    .where(
      and(
        input.id ? eq(automations.id, input.id) : undefined,
        input.where,
        inArray(automations.status, from)
      )
    )
    .returning({
      id: automations.id,
      name: automations.name,
      status: automations.status,
    });
}
