/**
 * `session --spawned_from--> session` — the ONE producer for the detour stack.
 *
 * `links.spawned_from` has existed in the link vocabulary (and been pinned by
 * `__tripwires__/linktype-unions-in-lockstep.test.ts`) since the Playbooks
 * substrate landed, with ZERO writers. This is the writer.
 *
 * The shape it records is a PUSH: you were working on the parent, something
 * blocked you, and you opened a child to clear the blocker. The edge points
 * child → parent ("forked from that one"), matching the comment on the
 * `spawned_from` union member in `schema/links.ts`. There is deliberately no
 * `merged_into` twin — fan-in is a SUMMARY, not a merge.
 *
 * Two invariants this door exists to hold:
 *
 * 1. **Owner floor.** `focus_sessions` is owner-private and (today) carries no
 *    `VisibilityRule`, so the parent is loaded with an explicit `userId` floor
 *    here. A caller may only fork from a session they own; an unowned or
 *    missing parent DROPS the edge (and the suspend note) rather than throwing —
 *    a bad parent handle must never fail the child's creation.
 *
 * 2. **Governance is NEVER inherited.** This function reads NOTHING off the
 *    parent's `metadata` and writes nothing onto the child.
 *    `deriveSessionForceProposeGovernance` (api `utils/permission-check.ts`)
 *    force-proposes every AI write in a session carrying
 *    `metadata.governance.forceProposeWrites`; copying that bag down a detour
 *    would silently change policy for unrelated work. The edge is lineage, not
 *    policy.
 *
 * Lives in `@synap/database` (not `@synap/api`) for the same reason
 * `openRunSession` does: the jobs layer and the database-level run door cannot
 * import `@synap/api`, and both need this producer.
 */

import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { db } from "../client-pg.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { links } from "../schema/links.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecordSessionSpawnInput {
  /** The newly-opened (child / detour) session. */
  childSessionId: string;
  /** The session the work was pushed FROM. */
  parentSessionId: string;
  /** Owner floor — the parent must belong to this user. */
  userId: string;
  /** Workspace stamped on the edge row (the child's workspace). */
  workspaceId?: string | null;
  /**
   * "What were you about to do" — captured at SUSPENSION, on the PARENT, so the
   * pop can restate the goal instead of asking the operator to remember it.
   * Shallow-merged as `metadata.suspended` (one slot, last push wins).
   */
  suspendedIntent?: string | null;
}

export type RecordSessionSpawnResult =
  | { linked: true; suspendedIntentRecorded: boolean }
  | { linked: false; reason: "parent_not_found" | "self_parent" };

/**
 * Record that `childSessionId` was spawned from `parentSessionId`.
 *
 * Idempotent: the edge insert conflicts on `idx_links_unique_edge` and is a
 * no-op on repeat. Returns what it actually did — callers surface it, they never
 * infer it.
 */
export async function recordSessionSpawn(
  input: RecordSessionSpawnInput
): Promise<RecordSessionSpawnResult> {
  if (input.childSessionId === input.parentSessionId) {
    return { linked: false, reason: "self_parent" };
  }

  // Shape floor BEFORE the query. `focus_sessions.id` is a `uuid` column, so a
  // malformed handle reaches Postgres as `22P02 invalid input syntax for type
  // uuid` — a THROW, from a door whose whole contract is that a bad parent
  // handle drops the edge instead of failing the child's creation.
  if (!UUID_RE.test(input.parentSessionId)) {
    return { linked: false, reason: "parent_not_found" };
  }

  // Owner floor on the PARENT — never `scopedDb`/`userVisibleWhere`, which have
  // an owner-blind NULL-workspace branch on this table.
  const [parent] = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, input.parentSessionId),
        eq(focusSessions.userId, input.userId)
      )
    )
    .limit(1);
  if (!parent) return { linked: false, reason: "parent_not_found" };

  await db
    .insert(links)
    .values({
      workspaceId: input.workspaceId ?? null,
      fromType: "session",
      fromId: input.childSessionId,
      toType: "session",
      toId: input.parentSessionId,
      linkType: "spawned_from",
      createdBy: input.userId,
      metadata: {},
    })
    .onConflictDoNothing({
      target: [
        links.fromType,
        links.fromId,
        links.toType,
        links.toId,
        links.linkType,
      ],
    });

  const intent = input.suspendedIntent?.trim();
  if (!intent) return { linked: true, suspendedIntentRecorded: false };

  // Shallow-merge onto the PARENT. `||` on jsonb replaces the `suspended` key
  // wholesale, which is what we want — the note describes the CURRENT push.
  await db
    .update(focusSessions)
    .set({
      metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(
        {
          suspended: {
            intent,
            childSessionId: input.childSessionId,
            at: new Date().toISOString(),
          },
        }
      )}::jsonb`,
    })
    .where(eq(focusSessions.id, input.parentSessionId));

  return { linked: true, suspendedIntentRecorded: true };
}

/**
 * The parent session id of `sessionId`, DERIVED from the `spawned_from` edge.
 *
 * Deliberately a derived read and never a column: the edge is the store, and a
 * `focus_sessions.parent_session_id` column would be a second copy of the same
 * fact. Returns null when the session was not spawned from anything.
 *
 * NO OWNER FLOOR HERE, and that is safe for exactly one reason: **every
 * producer floors the parent on the CHILD's owner** — `recordSessionSpawn`
 * above requires `focusSessions.userId === input.userId`, `createFocusSession`
 * passes the creating user, `openRunSession` passes `input.userId`, and the
 * approve executor passes the approver, who is also the row's `userId`. A
 * `spawned_from` edge can therefore only ever connect two sessions with the
 * SAME owner, so handing the parent id back to a caller who has already loaded
 * the child through an owner-floored query discloses nothing new.
 *
 * That is a property of the WRITE side. A future producer that floors
 * differently (or does not floor at all) silently turns this read into a
 * cross-user disclosure — add the floor here before adding such a producer.
 */
export async function getParentSessionId(
  sessionId: string
): Promise<string | null> {
  const [row] = await db
    .select({ toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.fromId, sessionId),
        eq(links.toType, "session"),
        eq(links.linkType, "spawned_from")
      )
    )
    .limit(1);
  return row?.toId ?? null;
}

/** Batch form of {@link getParentSessionId} — one query for a session list. */
export async function getParentSessionIds(
  sessionIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (sessionIds.length === 0) return out;
  const rows = await db
    .select({ fromId: links.fromId, toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.toType, "session"),
        eq(links.linkType, "spawned_from"),
        inArray(links.fromId, sessionIds)
      )
    );
  for (const r of rows) if (!out.has(r.fromId)) out.set(r.fromId, r.toId);
  return out;
}
