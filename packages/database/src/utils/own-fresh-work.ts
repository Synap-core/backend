/**
 * "Is this the acting agent's OWN FRESH work?" — the I/O half of the B3
 * governance class "organising its own fresh work" (FB1020, founder
 * 2026-10-21; engine side: `OWN_ORGANISE_CLASS_PATTERN` in
 * @synap/governance-policy).
 *
 * ONE answer, derived from the pod's own records and never from the caller's
 * input. A subject qualifies only when ALL hold:
 *
 *  1. SAME KEY — made through the very key this request authenticated with
 *     (B7: one agent user serves every computer, the key names one).
 *     - a record: its `entity.create.completed` event names this agent and
 *       the proposal (receipt) it went through records this key
 *       (`proposals.api_key_id`);
 *     - a session: it is bound to this key (`metadata.clientKey`
 *       `key:<id>[|conv:…]`, stamped when the client opened it).
 *  2. FRESH — created in the last {@link OWN_WORK_FRESH_HOURS} hours.
 *  3. UNTOUCHED BY A PERSON — no completed write on it since that a person
 *     made (an event with no agent, from a person's door — not the system,
 *     an automation, a sync or a migration).
 *
 * Fail-closed: a subject that is missing, deleted, unattributed, made before
 * key attribution existed (0346), or unreadable answers `false` — the write
 * then proposes exactly as it did before the class existed. An EMPTY subject
 * list is `false` (nothing proven), never a vacuous `true`.
 *
 * What it does NOT read: a person editing a record's body DOCUMENT (its events
 * are on the document), or reading it. The B3 doors add their own checks
 * (the project the person named; a `done` option of a task).
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createLogger } from "@synap-core/core";
import { entities } from "../schema/entities.js";
import { events } from "../schema/events.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { proposals } from "../schema/proposals.js";

type DbHandle = typeof import("../client-pg.js").db;

const logger = createLogger({ module: "own-fresh-work" });

/** How long an agent's work stays "fresh" (founder B3b: 24 hours). */
export const OWN_WORK_FRESH_HOURS = 24;

/** Event sources that are never a person (`auditLog`'s `source`). */
const NON_PERSON_SOURCES = ["system", "automation", "sync", "migration"];

export interface OwnFreshWorkInput {
  /** The acting agent (the key's principal). */
  agentUserId: string | null | undefined;
  /** The key this request authenticated with (`getRequestApiKeyId()`). */
  apiKeyId: string | null | undefined;
  subjectType: "entity" | "focus_session";
  subjectIds: readonly string[];
  /** Test seam. */
  now?: Date;
}

/** The api key a session's `metadata.clientKey` binds it to, or undefined. */
export function sessionClientApiKeyId(metadata: unknown): string | undefined {
  const clientKey = (metadata as { clientKey?: unknown } | null)?.clientKey;
  if (typeof clientKey !== "string") return undefined;
  return /^key:([^|]+)/.exec(clientKey)?.[1];
}

export async function isOwnFreshWork(
  db: DbHandle,
  input: OwnFreshWorkInput
): Promise<boolean> {
  const { agentUserId, apiKeyId } = input;
  const ids = [...new Set(input.subjectIds)];
  if (!agentUserId || !apiKeyId || ids.length === 0) return false;
  const since = new Date(
    (input.now ?? new Date()).getTime() - OWN_WORK_FRESH_HOURS * 3_600_000
  );

  try {
    if (input.subjectType === "entity") {
      const rows = await db
        .select({ id: entities.id, createdAt: entities.createdAt })
        .from(entities)
        .where(and(inArray(entities.id, ids), isNull(entities.deletedAt)));
      if (rows.length !== ids.length) return false;
      if (rows.some((r) => !r.createdAt || r.createdAt < since)) return false;

      // 1. Made by THIS agent through THIS key: the create event's governed
      // proposal records the key.
      const made = await db
        .selectDistinct({ id: events.subjectId })
        .from(events)
        .innerJoin(proposals, eq(proposals.id, events.proposalId))
        .where(
          and(
            inArray(events.subjectId, ids),
            eq(events.type, "entity.create.completed"),
            eq(events.agentUserId, agentUserId),
            eq(proposals.apiKeyId, apiKeyId)
          )
        );
      if (new Set(made.map((r) => r.id)).size !== ids.length) return false;
    } else {
      const rows = await db
        .select({
          id: focusSessions.id,
          createdAt: focusSessions.createdAt,
          metadata: focusSessions.metadata,
        })
        .from(focusSessions)
        .where(inArray(focusSessions.id, ids));
      if (rows.length !== ids.length) return false;
      if (
        rows.some(
          (r) =>
            !r.createdAt ||
            r.createdAt < since ||
            sessionClientApiKeyId(r.metadata) !== apiKeyId
        )
      ) {
        return false;
      }
    }

    // 3. Untouched by a person since.
    const touched = await db
      .select({ id: events.subjectId })
      .from(events)
      .where(
        and(
          inArray(events.subjectId, ids),
          sql`${events.type} LIKE ${`${input.subjectType}.%.completed`}`,
          sql`COALESCE(${events.isAgent}, false) = false`,
          isNull(events.agentUserId),
          sql`COALESCE(${events.source}, 'api') NOT IN (${sql.join(
            NON_PERSON_SOURCES.map((s) => sql`${s}`),
            sql`, `
          )})`
        )
      )
      .limit(1);
    return touched.length === 0;
  } catch (err) {
    // A failed read proves nothing: the write proposes, as it did before the
    // class existed — never applied on a guess. Logged, not swallowed.
    logger.warn(
      { err, subjectType: input.subjectType, count: ids.length },
      "own-fresh-work read failed; the write will propose"
    );
    return false;
  }
}
