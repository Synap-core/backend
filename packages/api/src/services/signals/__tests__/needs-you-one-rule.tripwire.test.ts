/**
 * TRIPWIRE — ONE needs-you rule for a session, on its row and in the Inbox
 * (review 459d5e5b M1, decision D-R1).
 *
 * A session's row, its project's tally and its own header count it with the
 * per-session rule (`needsYouItems` over the row's `unitFacts`,
 * `@synap-core/types/units`); the Inbox counts the pod's union
 * (`countNeedsYou`), whose terminal-wait population is decided by
 * `terminalWaitOf` (`permission-sessions.ts`) and whose review population is
 * the rows `needsYouReason` calls "review" (`project-needs-you.ts`). Before
 * this, an agent stopped on a permission dialog read "1 needs you" in the
 * Inbox and "Working" on its own header.
 *
 * DERIVED, never hand-listed: every runner word (`RUNNER_STATES`, plus none)
 * × every stored session status (`SESSION_STATUSES`) × owed / pending /
 * awaiting review, for an accepted session and for an agent's draft. For each,
 * the session's ONE row through the per-session rule must equal the union's
 * count of the same session, and "needs you" must agree with "count > 0".
 *
 * Scope stated: a draft is checked with nothing owed or pending. A draft's
 * owed ASKS reach the union through `draftAsks` (founder decision
 * 2026-10-22), which the row rule leaves out on purpose; that half is not
 * this tripwire's.
 *
 * Negative control: the per-session rule without its terminal-wait clause
 * (`needsYouItems` / `needsYouReason` before M1) turns every
 * `needs_permission` / `needs_answer` case red; the scan's old status
 * prefilter (`OPEN_SESSION_STATUSES`) turns the `stale` cases red.
 *
 * NO DATABASE: both sides are pure over the facts.
 */
import { describe, expect, it } from "vitest";
import {
  RUNNER_STATES,
  needsYouItems,
  needsYouReason,
  sessionNeedsYou,
  type NeedsYouFacts,
} from "@synap-core/types/units";
import { SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import {
  countNeedsYou,
  type OwedSlotSignalInput,
  type PermissionSessionSignalInput,
} from "../needs-you-union.js";
import {
  TERMINAL_WAIT_SESSION_STATUSES,
  terminalWaitOf,
} from "../permission-sessions.js";
import type { ProposalCluster } from "../../proposals/fingerprint.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const S = "session-1";

interface Case {
  status: string;
  runnerState: string | null;
  owed: number;
  decisions: number;
  awaitingReview: boolean;
  draft: boolean;
}

function cases(): Case[] {
  const out: Case[] = [];
  for (const status of SESSION_STATUSES)
    for (const runnerState of [...RUNNER_STATES, null])
      for (const draft of [false, true])
        for (const owed of draft ? [0] : [0, 2])
          for (const decisions of draft ? [0] : [0, 1])
            for (const awaitingReview of draft ? [false] : [false, true])
              out.push({
                status,
                runnerState,
                owed,
                decisions,
                awaitingReview,
                draft,
              });
  return out;
}

/** The row's `unitFacts`, as `attachPathSections` projects them. */
function rowFacts(c: Case): NeedsYouFacts {
  return {
    owedFromYou: c.owed,
    pendingDecisions: c.decisions,
    awaitingReview: c.awaitingReview,
    draft: c.draft,
    runnerWait: { status: c.status, runnerState: c.runnerState },
  };
}

function owedSlot(i: number): OwedSlotSignalInput {
  return {
    sessionId: S,
    label: `Ask ${i}`,
    owedSince: NOW.toISOString(),
    blockedReason: "decision",
    needsYouClass: "needs_you",
  };
}

function cluster(i: number): ProposalCluster {
  return {
    fingerprint: `fp-${i}`,
    proposalType: "update",
    targetType: "entity",
    targetLabel: `Thing ${i}`,
    count: 1,
    latestAt: NOW,
    sampleProposalIds: [`p-${i}`],
    class: "objectWork",
    lifetimeHours: null,
    reviewLater: false,
    needsYouClass: "needs_you",
  } as unknown as ProposalCluster;
}

/** The same session as the union's inputs: each population's own decider. */
function unionCount(c: Case): number {
  const facts = rowFacts(c);
  // `listSessionsWaitingForPermission`: the SQL prefilter, then the decider.
  const word = TERMINAL_WAIT_SESSION_STATUSES.includes(
    c.status as (typeof TERMINAL_WAIT_SESSION_STATUSES)[number]
  )
    ? terminalWaitOf({ status: c.status, state: c.runnerState })
    : null;
  const permissionSessions: PermissionSessionSignalInput[] = word
    ? [{ id: S, title: "S", goal: "S", runnerState: word, since: NOW }]
    : [];
  // The review scan keeps a row `needsYouReason` calls "review".
  const review = needsYouReason(facts) === "review" ? 1 : 0;
  const clusters = Array.from({ length: c.decisions }, (_, i) => cluster(i));
  return countNeedsYou({
    distinctClusters: clusters.length,
    clustersTruncated: false,
    notifications: [],
    clusters,
    notificationsTruncated: false,
    owedSlots: Array.from({ length: c.owed }, (_, i) => owedSlot(i)),
    owedTruncated: false,
    reviewSessions: review,
    reviewSessionIds: review ? [S] : [],
    permissionSessions,
    now: NOW,
  }).needsYou;
}

const label = (c: Case) =>
  `${c.draft ? "draft" : "accepted"} ${c.status} runner=${c.runnerState ?? "none"} owed=${c.owed} decisions=${c.decisions} review=${c.awaitingReview}`;

describe("needs you: the session's row and the Inbox count ONE number (M1)", () => {
  const all = cases();

  it("NON-VACUITY: the product reaches a terminal wait that needs you, on an open, a stale and a draft session, and one that does not", () => {
    const waiting = all.filter(
      (c) =>
        unionCount(c) > 0 &&
        c.owed === 0 &&
        c.decisions === 0 &&
        !c.awaitingReview
    );
    expect(waiting.some((c) => c.runnerState === "needs_permission")).toBe(
      true
    );
    expect(waiting.some((c) => c.runnerState === "needs_answer")).toBe(true);
    expect(waiting.some((c) => c.status === "stale")).toBe(true);
    expect(waiting.some((c) => c.draft)).toBe(true);
    expect(
      all.some(
        (c) => c.runnerState === "needs_permission" && unionCount(c) === 0
      )
    ).toBe(true);
  });

  for (const c of all) {
    it(label(c), () => {
      const union = unionCount(c);
      expect(needsYouItems(rowFacts(c))).toBe(union);
      expect(sessionNeedsYou(rowFacts(c))).toBe(union > 0);
    });
  }

  it("a failed runner read is not zero: the row's count is unknown", () => {
    expect(
      needsYouItems({ owedFromYou: 0, pendingDecisions: 0, runnerWait: null })
    ).toBeNull();
  });
});
