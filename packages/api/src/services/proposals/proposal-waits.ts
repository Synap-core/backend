/**
 * Does an agent WAIT on this proposal? (`ProposalWaits` from
 * `@synap-core/types/proposals/fate`.) The context card's "Waiting on it"
 * line reads it; it is OMITTED when nothing waits.
 *
 * Three reasons, in this order (the first that holds names it):
 *   `gate`       — an awaited plan/deploy gate (`AWAITED_GATE_PROPOSAL_TYPES`):
 *                  the session's next stage starts only on its approval.
 *   `owed_slot`  — it fills a slot its OPEN session still owes: the rule
 *                  `needsYouContextFromProposal` already draws as "Unblocks"
 *                  (`data.expectedKey`, else `data.expectedLabel`), read over
 *                  the session's unmet outcomes — reused, never restated.
 *   `parked_run` — its session's run is parked `waiting_on_you`.
 *
 * PENDING rows only: a decided proposal holds nobody. Batched per page — one
 * session read and one run read, whatever the page size — and the session
 * read goes through the ONE session read rule (`sessionReadableWhere`), so a
 * proposal from a session the reader may not open can only say `gate`, which
 * its own type already tells.
 *
 * A failed read THROWS: "nothing waits" and "could not tell" are different
 * facts, and the caller's read fails as a whole rather than draw the second as
 * the first.
 */

import {
  db,
  and,
  eq,
  inArray,
  focusSessions,
  playbookRuns,
  OPEN_SESSION_STATUSES,
} from "@synap/database";
import { AWAITED_GATE_PROPOSAL_TYPES } from "@synap/playbooks";
import type { ProposalWaits } from "@synap-core/types/proposals/fate";
import { needsYouContextFromProposal } from "@synap-core/types/needs-you";
import { projectSessionOutcomes } from "@synap-core/types/units";
import {
  sessionReadableWhere,
  type SessionReader,
} from "../../access/session-visibility.js";

export interface ProposalWaitsRow {
  id: string;
  proposalType: string;
  status: string;
  sessionId?: string | null;
  data?: unknown;
}

const NOTHING_WAITS: ProposalWaits = { waits: false };

const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function resolveProposalWaits(
  rows: readonly ProposalWaitsRow[],
  reader: SessionReader
): Promise<Map<string, ProposalWaits>> {
  const pending = rows.filter((r) => r.status === "pending");
  const sessionIds = [
    ...new Set(
      pending
        .map((r) => r.sessionId)
        .filter((id): id is string => !!id && isUuid(id))
    ),
  ];
  const [sessions, parked] = await Promise.all([
    sessionIds.length > 0
      ? db
          .select({
            id: focusSessions.id,
            status: focusSessions.status,
            expectedOutputs: focusSessions.expectedOutputs,
          })
          .from(focusSessions)
          .where(
            and(
              inArray(focusSessions.id, sessionIds),
              sessionReadableWhere(reader)
            )
          )
      : Promise.resolve([]),
    sessionIds.length > 0
      ? db
          .select({ sessionId: playbookRuns.sessionId })
          .from(playbookRuns)
          .where(
            and(
              inArray(playbookRuns.sessionId, sessionIds),
              eq(playbookRuns.status, "waiting_on_you")
            )
          )
      : Promise.resolve([]),
  ]);
  const openOutcomes = new Map(
    sessions
      .filter((s) =>
        (OPEN_SESSION_STATUSES as readonly string[]).includes(s.status)
      )
      .map((s) => [
        s.id,
        projectSessionOutcomes({
          expectedOutputs: s.expectedOutputs,
          sessionTerminal: false,
        }).outcomes.filter((o) => !o.met),
      ])
  );
  const readable = new Set(sessions.map((s) => s.id));
  const parkedIds = new Set(
    parked.map((r) => r.sessionId).filter((id): id is string => !!id)
  );

  const out = new Map<string, ProposalWaits>();
  for (const row of rows) {
    out.set(row.id, waitsOf(row, openOutcomes, readable, parkedIds));
  }
  return out;
}

function waitsOf(
  row: ProposalWaitsRow,
  openOutcomes: ReadonlyMap<
    string,
    ReturnType<typeof projectSessionOutcomes>["outcomes"]
  >,
  readable: ReadonlySet<string>,
  parked: ReadonlySet<string>
): ProposalWaits {
  if (row.status !== "pending") return NOTHING_WAITS;
  if (
    (AWAITED_GATE_PROPOSAL_TYPES as readonly string[]).includes(
      row.proposalType
    )
  ) {
    return { waits: true, reason: "gate" };
  }
  const sessionId = row.sessionId ?? null;
  if (!sessionId || !readable.has(sessionId)) return NOTHING_WAITS;
  const outcomes = openOutcomes.get(sessionId);
  if (
    outcomes &&
    needsYouContextFromProposal({
      proposal: { sessionId, data: row.data },
      outputs: { status: "ok", value: { outcomes } },
    }).unblocks
  ) {
    return { waits: true, reason: "owed_slot" };
  }
  if (parked.has(sessionId)) return { waits: true, reason: "parked_run" };
  return NOTHING_WAITS;
}

/** The `waits` field for one row (absent from the map ⇒ nothing waits). */
export function proposalWaitsFields(
  id: unknown,
  waits: ReadonlyMap<string, ProposalWaits>
): { waits: ProposalWaits } {
  return { waits: waits.get(String(id)) ?? NOTHING_WAITS };
}
