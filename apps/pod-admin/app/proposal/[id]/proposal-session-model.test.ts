/**
 * The session context a proposal's review shows, at the seam: the WIRE shapes
 * `focusSessions.get` and `signals.list` return, through the real
 * `reviewRows` (the rows Review itself draws), into what the reader sees.
 * Ids and names invented.
 */
import { describe, expect, it } from "vitest";
import { reviewRows } from "../../(admin)/review/_lib/review-rows";
import {
  criteriaMark,
  nextWaitingProposal,
  othersWaiting,
  readOf,
  sessionContext,
  sessionGoalLine,
  sessionReviewHref,
  waitingLabel,
  type SessionReadLike,
} from "./proposal-session-model";

const THIS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";

const NO_FACTS = new Map();

/** A needs-you proposal cluster as `signals.list` sends it. */
function cluster(
  id: string,
  title: string,
  members: string[],
  sample = members[0]!
) {
  return {
    id: `proposal-cluster:${id}`,
    kind: "proposal-cluster",
    title,
    count: members.length,
    groupKey: `proposal-cluster:${id}`,
    ageBucket: "today",
    repeatCount: 1,
    target: { kind: "proposal", id: sample },
    proposalIds: members,
  };
}

/** An agent's question on a slot of the session (`owed-slot`). */
function ask(id: string) {
  return {
    id: `owed:${id}`,
    kind: "owed-slot",
    title: "Which tone for the launch post?",
    count: 1,
    groupKey: `session:${SESSION}`,
    ageBucket: "today",
    repeatCount: 1,
    target: { kind: "session", id: SESSION },
  };
}

const rows = (signals: unknown[]) =>
  reviewRows(signals as Parameters<typeof reviewRows>[0], NO_FACTS);

function session(over: Partial<SessionReadLike> = {}): SessionReadLike {
  return {
    title: "Launch week",
    goal: "Ship the launch post and the changelog by Friday.\nThen measure.",
    trackId: null,
    continuation: {
      evaluation: {
        status: "ok",
        verdict: { passed: 2, total: 3, state: "incomplete" },
      },
      project: { status: "ok", project: { id: PROJECT, name: "Synap" } },
    },
    ...over,
  };
}

describe("readOf — empty, not-yours and failed are different facts", () => {
  it("a read the floor refuses is absent, never a failure", () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN"]) {
      expect(
        readOf({ isLoading: false, error: { data: { code } }, data: undefined })
      ).toEqual({ state: "absent" });
    }
  });

  it("any other error is failed — never folded into nothing", () => {
    expect(
      readOf({
        isLoading: false,
        error: { data: { code: "INTERNAL_SERVER_ERROR" } },
        data: undefined,
      })
    ).toEqual({ state: "failed" });
    expect(
      readOf({ isLoading: false, error: new Error("network"), data: undefined })
    ).toEqual({ state: "failed" });
  });

  it("loading, data, and a read that was never made", () => {
    expect(readOf({ isLoading: true, error: null, data: undefined })).toEqual({
      state: "loading",
    });
    expect(readOf({ isLoading: false, error: null, data: 1 })).toEqual({
      state: "ok",
      value: 1,
    });
    expect(
      readOf({ isLoading: true, error: null, data: undefined }, false)
    ).toEqual({ state: "absent" });
  });
});

describe("sessionContext — what the session is for", () => {
  it("goal (one line), criteria progress, project; track id to read", () => {
    expect(sessionContext(session({ trackId: OTHER }))).toEqual({
      goal: "Ship the launch post and the changelog by Friday. Then measure.",
      criteria: {
        kind: "progress",
        label: "2 of 3 criteria met",
        tone: "default",
      },
      project: { kind: "named", id: PROJECT, name: "Synap" },
      trackId: OTHER,
    });
  });

  it("a session NAMED by its goal does not draw the goal twice", () => {
    expect(sessionGoalLine({ title: null, goal: "Ship it" })).toBeNull();
    expect(sessionGoalLine({ title: "  ", goal: "Ship it" })).toBeNull();
    expect(sessionGoalLine({ title: "Launch", goal: "Ship it" })).toBe(
      "Ship it"
    );
    expect(sessionGoalLine({ title: "Launch", goal: null })).toBeNull();
  });

  it("no criteria declared: no mark; one: singular", () => {
    expect(
      criteriaMark({
        status: "ok",
        verdict: { passed: 0, total: 0, state: "none" },
      })
    ).toBeNull();
    expect(
      criteriaMark({
        status: "ok",
        verdict: { passed: 1, total: 1, state: "passing" },
      })
    ).toEqual({
      kind: "progress",
      label: "1 of 1 criterion met",
      tone: "success",
    });
  });

  it("toned by the pod's verdict, never recounted", () => {
    expect(
      criteriaMark({
        status: "ok",
        verdict: { passed: 2, total: 3, state: "failing" },
      })
    ).toMatchObject({ tone: "warning" });
  });

  it("a failed evaluation or project read is UNREADABLE, not none", () => {
    const ctx = sessionContext(
      session({
        continuation: {
          evaluation: { status: "unavailable" },
          project: { status: "unavailable" },
        },
      })
    );
    expect(ctx.criteria).toEqual({ kind: "unreadable" });
    expect(ctx.project).toEqual({ kind: "unreadable" });
  });

  it("no project (or one the reader cannot see) is nothing", () => {
    expect(
      sessionContext(
        session({
          continuation: {
            evaluation: {
              status: "ok",
              verdict: { passed: 0, total: 0, state: "none" },
            },
            project: { status: "ok", project: null },
          },
        })
      ).project
    ).toBeNull();
  });
});

describe("othersWaiting — counted in Review's own rows", () => {
  it("every OTHER row of the session, this proposal's own row excepted", () => {
    expect(
      othersWaiting(
        rows([
          cluster("a", "Create Ada", [THIS]),
          cluster("b", "Update Grace", [OTHER]),
          ask("x"),
        ]),
        THIS
      )
    ).toBe(2);
  });

  it("a cluster holding this proposal AND others still waits", () => {
    expect(
      othersWaiting(
        rows([cluster("a", "Create 2 people", [THIS, OTHER])]),
        THIS
      )
    ).toBe(1);
  });

  it("decided already (not in the list): every row counts", () => {
    expect(
      othersWaiting(rows([cluster("b", "Update Grace", [OTHER])]), THIS)
    ).toBe(1);
  });

  it("words: none is nothing; one waits; a capped read says so", () => {
    expect(waitingLabel(0, false)).toBeNull();
    expect(waitingLabel(1, false)).toBe(
      "1 more from this session waits for you"
    );
    expect(waitingLabel(4, false)).toBe(
      "4 more from this session wait for you"
    );
    expect(waitingLabel(99, true)).toBe(
      "99+ more from this session wait for you"
    );
  });

  it("the door is Review narrowed to the session", () => {
    expect(sessionReviewHref(SESSION)).toBe(`/review?session=${SESSION}`);
  });
});

describe("nextWaitingProposal — Review's order, this one skipped", () => {
  it("the FIRST proposal row Review lists, asks passed over", () => {
    expect(
      nextWaitingProposal(
        rows([
          ask("x"),
          cluster("b", "Update Grace", [OTHER]),
          cluster("c", "Create Linus", [THIRD]),
        ]),
        THIS
      )
    ).toEqual({ proposalId: OTHER, title: "Update Grace" });
  });

  it("skips this proposal when the list still holds it", () => {
    expect(
      nextWaitingProposal(
        rows([
          cluster("a", "Create Ada", [THIS]),
          cluster("b", "Update Grace", [OTHER]),
        ]),
        THIS
      )?.proposalId
    ).toBe(OTHER);
  });

  it("a cluster whose sample is this one offers another member", () => {
    expect(
      nextWaitingProposal(
        rows([cluster("a", "Create 2 people", [THIS, THIRD], THIS)]),
        THIS
      )?.proposalId
    ).toBe(THIRD);
  });

  it("nothing else waits: null (the page says so calmly)", () => {
    expect(
      nextWaitingProposal(
        rows([cluster("a", "Create Ada", [THIS]), ask("x")]),
        THIS
      )
    ).toBeNull();
  });
});
