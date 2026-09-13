/**
 * The WHERE clause for a `focus_sessions` list — ONE function for every door.
 *
 * Lifted out of `routers/focus-sessions.ts` so the Hub REST list door stops
 * hand-writing its own copy. That copy (status via a single-value `eq`, triage,
 * kind, flow) was the hand-mirrored twin of the tRPC door's predicate. It could
 * already not express a status SET or a recency window, and every future lens
 * added to one door would have silently missed the other.
 *
 * The doors still differ where they SHOULD, and those differences are the
 * caller's arguments, never a fork of this logic:
 *   - DEFAULTS. tRPC (a person's work surface) defaults to `lens: "default"`
 *     and `kind: "work"`. Hub REST (the agent door) passes `"all"` for both,
 *     because an agent looking for the session it just opened wants exactly
 *     the rows a person's default lens hides.
 *   - EXTRA narrowing a door owns alone (Hub REST's `subjectEntityId`) is pushed
 *     by that door on top of what this returns.
 *   - ORDERING and PAGING belong to the door: this returns conditions, not a
 *     query.
 *
 * Every narrowing here is a WHERE clause applied before the `limit`. Filtering
 * a fetched page is the defect this table has shipped twice.
 */

import { eq, ilike, focusSessions } from "@synap/database";
import type { SQL } from "@synap/database";
import type { ResolvedScope } from "../../utils/scope-filter.js";
import { requireUserId } from "../../utils/user-scoped.js";
import { escapeLikePattern } from "../../utils/like-pattern.js";
import { sessionScopeConditions } from "./session-scope.js";
import {
  sessionStatusConditions,
  type StatusSinceWindows,
} from "./session-status-filter.js";
import { triagePendingWhere, notTriagePendingWhere } from "./triage.js";
import {
  sessionKindWhere,
  sessionAutomationWhere,
  type SessionKind,
} from "./session-kind.js";
import type { SessionStatus } from "./session-statuses.js";

/** Triage lens: `default` hides undecided agent drafts, `triage` shows only them. */
export type SessionLens = "default" | "triage" | "all";
/** Population lens (`session-kind.ts`), plus the `all` filter sentinel. */
export type SessionKindFilter = SessionKind | "all";

/** Everything that decides WHICH sessions a list door returns. */
export interface SessionListQuery {
  userId: string | null | undefined;
  scope: ResolvedScope;
  status: SessionStatus | "all" | readonly SessionStatus[];
  lens?: SessionLens;
  kind?: SessionKindFilter;
  flow?: { playbookId?: string; automationId?: string };
  statusSince?: StatusSinceWindows;
  /** Case-insensitive substring match on the session goal. */
  q?: string;
}

export function sessionListConditions({
  userId,
  scope: { workspaceLens, projectLens },
  status,
  lens = "default",
  kind = "work",
  flow = {},
  statusSince,
  q,
}: SessionListQuery): SQL[] {
  const conditions: SQL[] = [eq(focusSessions.userId, requireUserId(userId))];

  // Both lenses narrow within the user's own rows (the floor is userId above).
  // The APPLICATION lives in `sessionScopeConditions`, shared with the owed-slot
  // read, so the doors cannot drift into two answers about what a lens means.
  conditions.push(...sessionScopeConditions({ workspaceLens, projectLens }));

  // STATUS and its recency windows. See `session-status-filter.ts` for why a
  // time window is a WHERE clause too.
  conditions.push(...sessionStatusConditions(status, statusSince));

  // TRIAGE LENS. A page is `limit`-capped in SQL, so filtering after the fact
  // would let unaccepted agent drafts consume the slots and push real work off
  // the end. That is the whole reason the lens exists.
  if (lens === "triage") {
    conditions.push(triagePendingWhere());
  } else if (lens === "default") {
    conditions.push(notTriagePendingWhere());
  }
  // lens === "all" adds nothing.

  // KIND LENS. Automation runs are the highest-volume population in this table,
  // so a post-filter would let them eat the page.
  if (kind !== "all") {
    conditions.push(sessionKindWhere(kind));
  }

  // FLOW-DEFINITION filters, so a playbook or automation detail page lists its
  // OWN run sessions in SQL instead of paging and filtering, which silently
  // under-reports once the flow has run more than `limit` times. Both name a
  // DEFINITION, never one execution.
  if (flow.playbookId) {
    conditions.push(eq(focusSessions.playbookId, flow.playbookId));
  }
  if (flow.automationId) {
    conditions.push(sessionAutomationWhere(flow.automationId));
  }

  // SEARCH. Searching the rows of an already-limited page would miss every
  // match past the limit.
  const term = q?.trim();
  if (term) {
    conditions.push(ilike(focusSessions.goal, `%${escapeLikePattern(term)}%`));
  }

  return conditions;
}
