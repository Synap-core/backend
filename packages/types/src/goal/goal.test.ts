import { describe, expect, it } from "vitest";
import type { GoalCriterionView, TrackParticipant } from "../units/index.js";
import {
  criterionMark,
  goalCounterAnswerChange,
  goalCriteriaCount,
  goalCriterionRows,
  goalHeader,
  goalParticipantRows,
  goalStatusMark,
  goalStatusMoves,
  goalVerdicts,
  holdLine,
  silenceMark,
  viewerMayDrop,
  waitingOnMarks,
  type GoalLike,
  type GoalViewer,
} from "./index.js";

const OWNER = "u-owner";
const JUDGE = "u-judge";
const AGENT = "u-agent";
const NOW = new Date("2026-10-23T12:00:00.000Z");

const crit = (
  key: string,
  mark: GoalCriterionView["mark"],
  extra: Partial<GoalCriterionView> = {}
): GoalCriterionView => ({
  key,
  statement: `${key} holds`,
  check: { kind: "human" },
  acceptance: null,
  mark,
  acceptanceState:
    mark === "claimed" ? "waiting" : mark === "met" ? "accepted" : null,
  meaning: "judged",
  currentValue: null,
  claim: null,
  ...extra,
});

const part = (
  id: string,
  principalId: string,
  role: TrackParticipant["role"],
  extra: Partial<TrackParticipant> = {}
): TrackParticipant => ({
  id,
  principalKind: "person",
  principalId,
  role,
  commitment: null,
  commitmentState: null,
  counterText: null,
  reportedReason: null,
  reportedAt: null,
  acknowledgedAt: null,
  decidedBy: OWNER,
  decidedAt: "2026-10-20T00:00:00.000Z",
  createdAt: "2026-10-20T00:00:00.000Z",
  silentSince: null,
  displayName: null,
  ...extra,
});

const goal = (over: Partial<GoalLike> = {}): GoalLike => ({
  id: "g1",
  name: "The devbox runs itself",
  status: "active",
  verdict: null,
  verdictReason: null,
  direction: "Every AI and person tests from one shared machine.",
  endState: null,
  criteria: [
    crit("a", "met"),
    crit("b", "met"),
    crit("c", "claimed"),
    crit("d", "under_way"),
    crit("e", "not_started"),
  ],
  dropConditions: [],
  workKind: "project",
  uncertainty: "complicated",
  kindConfirmedBy: OWNER,
  inReview: false,
  waitingOn: [],
  participants: [part("p1", OWNER, "owner"), part("p2", JUDGE, "judge")],
  ...over,
});

const person = (userId: string): GoalViewer => ({ userId, kind: "person" });
const agent: GoalViewer = { userId: AGENT, kind: "agent" };

describe("goal marks", () => {
  it('a closed goal wears how it ended, not its category: "Closed · Not met" is not a success', () => {
    expect(
      goalStatusMark({ status: "completed", verdict: "met" })
    ).toMatchObject({ tone: "success", label: "Closed · Met" });
    expect(
      goalStatusMark({ status: "completed", verdict: "not_met" })
    ).toMatchObject({ tone: "error", glyph: "x", label: "Closed · Not met" });
    expect(
      goalStatusMark({ status: "archived", verdict: "no_longer_needed" })
    ).toMatchObject({ tone: "textMuted", label: "Dropped · No longer needed" });
  });

  it("a live goal wears its lifecycle category tone, and a verdict on a live status is ignored", () => {
    expect(goalStatusMark({ status: "active", verdict: null })).toMatchObject({
      tone: "primary",
      glyph: "circle-dot",
      label: "Active",
    });
    expect(
      goalStatusMark({ status: "proposed", verdict: "met" })
    ).toMatchObject({ tone: "textSecondary", label: "Draft" });
  });

  it("an unknown status humanizes, never blank", () => {
    expect(goalStatusMark({ status: "on_hold", verdict: null })).toMatchObject({
      glyph: "question",
      label: "On hold",
    });
  });

  it('a criterion mark not read is unmeasured, never "Not started"', () => {
    expect(criterionMark(null).state).toBe("unmeasured");
    expect(criterionMark("not_started").label).toBe("Not started");
    expect(criterionMark("claimed")).toMatchObject({
      tone: "primary",
      glyph: "half",
    });
  });

  it("waiting-on: one mark per reason, the count only when more than one", () => {
    const marks = waitingOnMarks([
      { reason: "approval", count: 2 },
      { reason: "input", count: 1 },
    ]);
    expect(marks.map((m) => m.label)).toEqual([
      "Waiting on approval",
      "Waiting on input",
    ]);
    expect(marks.map((m) => m.count)).toEqual([2, undefined]);
    expect(waitingOnMarks(null)).toEqual([]);
  });

  it("waiting-on: the count rides `count`, never spelled into the label (the count slot draws it)", () => {
    const marks = waitingOnMarks([
      { reason: "approval", count: 12 },
      { reason: "input", count: 3 },
    ]);
    expect(marks.map((m) => m.count)).toEqual([12, 3]);
    for (const m of marks) expect(m.label).not.toMatch(/\d/);
  });

  it("waiting-on: what it waits on by name, each a door to its own page or an outside link", () => {
    const [mark] = waitingOnMarks([
      {
        reason: "another_work",
        count: 3,
        refs: [
          { kind: "session", id: "s1", label: "Build the import" },
          { kind: "slot", id: "s2", label: "Stripe key" },
          {
            kind: "pull_request",
            url: "https://github.com/Synap-core/backend/pull/47",
            label: "backend#47",
          },
          {
            kind: "pull_request",
            url: "javascript:alert(1)",
            label: "a bad link",
          },
          { kind: "something_new", id: "x", label: "Whatever it is" },
        ],
      },
    ]);
    expect(mark!.refs.map((r) => [r.label, r.door, r.url])).toEqual([
      ["Build the import", { kind: "session", id: "s1" }, null],
      // A slot has no page: it opens the session that declares it.
      ["Stripe key", { kind: "session", id: "s2" }, null],
      ["backend#47", null, "https://github.com/Synap-core/backend/pull/47"],
      // Only an http(s) link is a door; a kind this build does not know is said, not linked.
      ["a bad link", null, null],
      ["Whatever it is", null, null],
    ]);
  });

  it("waiting-on: an older pod names nothing — the mark keeps its reason and count, no refs", () => {
    const [mark] = waitingOnMarks([{ reason: "approval", count: 2 }]);
    expect(mark).toMatchObject({ reason: "approval", count: 2, refs: [] });
  });

  it("the hold line: why, for how long, what resumes it — or nothing when the hold says none", () => {
    const now = NOW.getTime();
    const since = new Date(now - 3 * 3_600_000).toISOString();
    expect(
      holdLine(
        {
          since,
          reason: "Review slot frees up",
          until: { date: new Date(now + 26 * 3_600_000).toISOString() },
        },
        now
      )
    ).toBe("Review slot frees up · for 3h · resumes tomorrow");
    expect(
      holdLine({ since, until: { moves: "focus_session:s1", to: "done" } }, now)
    ).toBe("for 3h · resumes when the session moves to done");
    expect(holdLine(null, now)).toBeNull();
    expect(holdLine({ since: "not a date", reason: "  " }, now)).toBeNull();
  });

  it("the hold line names the dev fact that resumes it, never 'the entity moves'", () => {
    const now = NOW.getTime();
    const since = new Date(now - 2 * 3_600_000).toISOString();
    const line = (moves: string, to?: string) =>
      holdLine({ since, until: { moves, ...(to ? { to } : {}) } }, now);
    expect(line("pr:synap-core/backend#539")).toBe(
      "for 2h · resumes when backend#539 merges"
    );
    expect(line("pr:synap-core/backend#539", "closed")).toBe(
      "for 2h · resumes when backend#539 is closed"
    );
    expect(line("main:synap-core/app-bases")).toBe(
      "for 2h · resumes when app-bases main is green"
    );
    expect(line("job:kit-h")).toBe("for 2h · resumes when job kit-h finishes");
    expect(line("job:kit-h", "failed")).toBe(
      "for 2h · resumes when job kit-h fails"
    );
  });

  it('silence starts at one hour and says "Silent", never "stale"', () => {
    expect(silenceMark("2026-10-23T11:30:00.000Z", NOW)).toBeNull();
    expect(silenceMark("2026-10-23T06:00:00.000Z", NOW)?.label).toBe(
      "Silent 6 h"
    );
  });
});

describe("goal header", () => {
  it("names owner and judge apart when they differ", () => {
    const h = goalHeader(goal(), (id) =>
      id === OWNER ? "Antoine" : id === JUDGE ? "Léa" : null
    );
    expect(h.owner).toMatchObject({
      id: OWNER,
      name: "Antoine",
      role: "Owner",
      label: "Owner: Antoine",
    });
    expect(h.judge).toMatchObject({
      id: JUDGE,
      name: "Léa",
      role: "Judge",
      label: "Judge: Léa",
    });
    expect(h.kind?.mark.label).toBe("Build");
    expect(h.uncertainty).toMatchObject({
      level: 2,
      label: "Complicated",
      confirmed: true,
    });
  });

  it('the owner judges when no judge is named — one fact, "Owner and judge: …" (UX-30)', () => {
    const h = goalHeader(goal({ participants: [part("p1", OWNER, "owner")] }));
    expect(h.ownerJudges).toBe(true);
    expect(h.owner?.role).toBe("Owner and judge");
    expect(h.owner?.label).toBeNull();
    expect(
      goalHeader(
        goal({
          participants: [
            part("p1", OWNER, "owner", { displayName: "Camille Laurent" }),
          ],
        })
      ).owner?.label
    ).toBe("Owner and judge: Camille Laurent");
    expect(h.judge).toBeNull();
    expect(h.owner?.name).toBeNull();
  });

  it("in review and waiting on are marks beside the status", () => {
    const h = goalHeader(
      goal({ inReview: true, waitingOn: [{ reason: "access", count: 1 }] })
    );
    expect(h.marks.map((m) => m.state)).toEqual([
      "in_review",
      "waiting_on_access",
    ]);
  });
});

describe("Done when", () => {
  it("offers Accept / Send back only to the judge, only on a claimed criterion", () => {
    const rows = goalCriterionRows(goal(), person(JUDGE));
    expect(rows.filter((r) => r.judgeable).map((r) => r.key)).toEqual(["c"]);
    expect(
      goalCriterionRows(goal(), person(OWNER)).some((r) => r.judgeable)
    ).toBe(false);
  });

  it("the judge may accept an outside / certified criterion nobody claimed, with its source; nobody else", () => {
    const g = goal({
      criteria: [
        crit("cert", "not_started", { meaning: "certified" }),
        crit("out", "under_way", { meaning: "decided_outside" }),
        crit("judged", "not_started"),
        crit("claimed", "claimed", { meaning: "certified" }),
      ],
    });
    expect(
      goalCriterionRows(g, person(JUDGE)).map((r) => r.acceptWithSource)
    ).toEqual([true, true, false, false]);
    expect(
      goalCriterionRows(g, person(OWNER)).some((r) => r.acceptWithSource)
    ).toBe(false);
  });

  it("an agent holding the judge id is still never offered a judgement (R9)", () => {
    const g = goal({
      participants: [part("p1", OWNER, "owner"), part("p2", AGENT, "judge")],
    });
    expect(
      goalCriterionRows(g, { userId: AGENT, kind: "agent" }).some(
        (r) => r.judgeable
      )
    ).toBe(false);
  });

  it("carries the measured value and the method flag", () => {
    const rows = goalCriterionRows(
      goal({
        criteria: [
          crit("m", "under_way", {
            meaning: "measured",
            currentValue: " 9 of 12 held ",
          }),
          crit("l", "not_started", { meaning: "learning", about: "method" }),
        ],
      }),
      person(OWNER)
    );
    expect(rows[0]).toMatchObject({
      currentValue: "9 of 12 held",
      aboutMethod: false,
    });
    expect(rows[0]!.meaning.label).toBe("Measured");
    expect(rows[1]!.aboutMethod).toBe(true);
  });

  it("shows the judge's decision only when the mark does not already say it: sent back, rejected", () => {
    const rows = goalCriterionRows(
      goal({
        criteria: [
          crit("ok", "met"),
          crit("wait", "claimed"),
          crit("back", "under_way", {
            acceptanceState: "changes_asked",
            acceptance: {
              decision: "changes_asked",
              by: JUDGE,
              at: "2026-10-22T00:00:00.000Z",
              note: " Run it on the phone ",
            },
          }),
        ],
      }),
      person(OWNER)
    );
    expect(rows.map((r) => r.acceptance?.state ?? null)).toEqual([
      null,
      null,
      "changes_asked",
    ]);
    expect(rows[2]!.acceptance).toMatchObject({
      label: "Changes asked",
      note: "Run it on the phone",
    });
  });

  it("a claim says who claimed it, from which run (a door) and the evidence bag's own words — nothing when the pod sends none", () => {
    const claimed = crit("c", "claimed", {
      claim: {
        by: AGENT,
        byName: "Claude Code",
        sessionId: "s1",
        sessionTitle: "Pin restart check",
        evidence: {
          log: { detail: " log: 3 restarts kept the pin " },
          restarts: 3,
        },
        note: null,
        at: "2026-10-23T09:00:00.000Z",
      },
    } as Partial<GoalCriterionView>);
    const [row] = goalCriterionRows(
      goal({ criteria: [claimed, crit("d", "met")] }),
      person(JUDGE)
    );
    expect(row!.claim).toEqual({
      by: "Claimed by Claude Code",
      session: { id: "s1", title: "Pin restart check" },
      evidence: "log: 3 restarts kept the pin",
      note: null,
      at: "2026-10-23T09:00:00.000Z",
    });
    expect(
      goalCriterionRows(goal(), person(JUDGE)).every((r) => r.claim === null)
    ).toBe(true);
    // A bag with no human line says nothing rather than dumping its keys.
    const bare = crit("e", "claimed", {
      claim: {
        by: AGENT,
        byName: null,
        sessionId: "s2",
        sessionTitle: null,
        evidence: { restarts: 3 },
        note: null,
        at: "2026-10-23T09:00:00.000Z",
      },
    } as Partial<GoalCriterionView>);
    expect(
      goalCriterionRows(goal({ criteria: [bare] }), person(JUDGE))[0]!.claim
    ).toMatchObject({
      by: "Claimed by someone",
      session: { id: "s2", title: "Session" },
      evidence: null,
    });
  });

  it('counts in text — "2 of 5 met · 1 claimed" — and claims nothing when marks were not read', () => {
    expect(goalCriteriaCount(goal()).label).toBe("2 of 5 met · 1 claimed");
    expect(goalCriteriaCount(goal({ criteria: [] })).label).toBeNull();
    const unread = goalCriteriaCount(
      goal({ criteria: [crit("a", null), crit("b", "met")] })
    );
    expect(unread).toMatchObject({ unread: true, label: null });
  });
});

describe("Who's on it", () => {
  const silentAgent = part("p3", AGENT, "delegate", {
    principalKind: "agent",
    commitment: "Baseline per main commit",
    commitmentState: "accepted",
    silentSince: "2026-10-23T06:00:00.000Z",
  });

  it("names: the pod's displayName first, then the host's nameOf, else the role word", () => {
    const g = goal({
      participants: [
        part("p1", OWNER, "owner", { displayName: "Antoine S." }),
        part("p2", JUDGE, "judge"),
        silentAgent,
      ],
    });
    const host = (id: string) =>
      id === OWNER ? "host-owner" : id === JUDGE ? "Léa" : null;
    const h = goalHeader(g, host);
    expect(h.owner?.name).toBe("Antoine S.");
    expect(h.judge?.name).toBe("Léa");
    const rows = goalParticipantRows(g, person(OWNER), host, NOW)!;
    expect(rows.map((r) => r.name)).toEqual(["Antoine S.", "Léa", null]);
  });

  it('one row per principal, in role order: an owner who judges is "Owner and judge" — the header\'s words', () => {
    const rows = goalParticipantRows(
      goal({
        participants: [
          silentAgent,
          part("p2", OWNER, "judge"),
          part("p1", OWNER, "owner"),
        ],
      }),
      person(OWNER),
      undefined,
      NOW
    )!;
    expect(rows.map((r) => r.roles)).toEqual(["Owner and judge", "Delegate"]);
    expect(rows[0]!.roles).toBe(
      goalHeader(goal({ participants: [part("p1", OWNER, "owner")] })).owner
        ?.role
    );
    expect(rows[1]).toMatchObject({
      commitment: "Baseline per main commit",
      name: null,
    });
    expect(rows[1]!.silence?.label).toBe("Silent 6 h");
    expect(rows[1]!.row.door).toEqual({ kind: "agent", id: AGENT });
    expect(rows[0]!.row.door).toBeNull();
  });

  it("a delegate answers their own commitment; nobody else is offered it", () => {
    const asked = part("p3", AGENT, "delegate", {
      principalKind: "agent",
      commitment: "Size the market",
      commitmentState: "proposed",
    });
    const g = goal({ participants: [part("p1", OWNER, "owner"), asked] });
    const mine = goalParticipantRows(g, agent, undefined, NOW)!.find(
      (r) => r.principalId === AGENT
    )!;
    expect(mine.verbs.map((v) => v.op)).toEqual([
      "accept",
      "counter",
      "decline",
    ]);
    expect(mine.verbs.find((v) => v.op === "counter")?.needsText).toBe(true);
    expect(mine.row.cls).toBe("blocking");
    const theirs = goalParticipantRows(g, person(OWNER), undefined, NOW)!.find(
      (r) => r.principalId === AGENT
    )!;
    expect(theirs.verbs).toEqual([]);
  });

  it('an unacknowledged "impossible" waits on the owner or judge (R10), and stops once acknowledged', () => {
    const reported = part("p3", AGENT, "delegate", {
      principalKind: "agent",
      commitment: "Baseline per main commit",
      commitmentState: "reported_impossible",
      reportedReason: "No baseline runner",
    });
    const owner = goalParticipantRows(
      goal({ participants: [part("p1", OWNER, "owner"), reported] }),
      person(OWNER),
      undefined,
      NOW
    )!;
    expect(owner[1]!.verbs.map((v) => v.op)).toEqual(["acknowledge"]);
    expect(owner[1]!.reportUnacknowledged).toBe(true);
    const acked = { ...reported, acknowledgedAt: "2026-10-23T08:00:00.000Z" };
    const after = goalParticipantRows(
      goal({ participants: [part("p1", OWNER, "owner"), acked] }),
      person(OWNER),
      undefined,
      NOW
    )!;
    expect(after[1]!.verbs).toEqual([]);
  });

  it("a counter-offer waits on the owner or judge: Take their offer / Keep my ask, each the pod's re-ask of that delegate", () => {
    const countered = part("p3", AGENT, "delegate", {
      principalKind: "agent",
      commitment: "Review every post",
      commitmentState: "countered",
      counterText: "Review the newsletter",
    });
    const g = goal({
      participants: [
        part("p1", OWNER, "owner"),
        part("p2", JUDGE, "judge"),
        countered,
      ],
    });
    for (const who of [OWNER, JUDGE]) {
      const row = goalParticipantRows(g, person(who), undefined, NOW)!.find(
        (r) => r.principalId === AGENT
      )!;
      expect(row.verbs.map((v) => [v.op, v.label])).toEqual([
        ["take_offer", "Take their offer"],
        ["keep_ask", "Keep my ask"],
      ]);
      expect(row.row.cls).toBe("blocking");
      expect(row.verbs.map(goalCounterAnswerChange)).toEqual([
        {
          op: "add",
          principalId: AGENT,
          role: "delegate",
          commitment: "Review the newsletter",
        },
        {
          op: "add",
          principalId: AGENT,
          role: "delegate",
          commitment: "Review every post",
        },
      ]);
    }
    // Not the delegate's own answer, not another person's, never an agent's, never on a closed goal.
    expect(
      goalParticipantRows(g, person("u-other"), undefined, NOW)!.find(
        (r) => r.principalId === AGENT
      )!.verbs
    ).toEqual([]);
    // The countering delegate (an agent here) keeps its own answers, never the owner's.
    expect(
      goalParticipantRows(g, agent, undefined, NOW)!
        .find((r) => r.principalId === AGENT)!
        .verbs.map((v) => v.op)
    ).not.toContain("take_offer");
    expect(
      goalParticipantRows(
        g,
        { userId: "u-other-agent", kind: "agent" },
        undefined,
        NOW
      )!.find((r) => r.principalId === AGENT)!.verbs
    ).toEqual([]);
    expect(
      goalParticipantRows(
        { ...g, status: "completed", verdict: "met" },
        person(OWNER),
        undefined,
        NOW
      )!.find((r) => r.principalId === AGENT)!.verbs
    ).toEqual([]);
    // A counter with no words offers only the ask kept.
    const bare = { ...countered, counterText: null };
    expect(
      goalParticipantRows(
        goal({ participants: [part("p1", OWNER, "owner"), bare] }),
        person(OWNER),
        undefined,
        NOW
      )![1]!.verbs.map((v) => v.op)
    ).toEqual(["keep_ask"]);
  });

  it("an agent draws as an agent and a person as a person, named or not, whoever looks (D-1)", () => {
    const g = goal({
      participants: [
        part("p1", OWNER, "owner", { displayName: "Antoine S." }),
        part("p2", JUDGE, "judge"),
        { ...silentAgent, displayName: "Scout" },
        part("p4", "u-agent-2", "integrator", { principalKind: "agent" }),
      ],
    });
    for (const viewer of [person(OWNER), agent]) {
      const rows = goalParticipantRows(g, viewer, undefined, NOW)!;
      expect(rows.map((r) => [r.principalId, r.actorKind])).toEqual([
        [OWNER, "human"],
        [JUDGE, "human"],
        [AGENT, "agent"],
        ["u-agent-2", "agent"],
      ]);
    }
  });

  it("participants not read is null — not an empty goal", () => {
    expect(
      goalParticipantRows(goal({ participants: undefined }), person(OWNER))
    ).toBeNull();
  });
});

describe("status moves", () => {
  it("the judge closes with a verdict; the owner may drop but not close", () => {
    const judge = goalStatusMoves(goal(), person(JUDGE));
    const close = judge.find((m) => m.kind === "verdict" && m.verb === "close");
    expect(close).toMatchObject({
      label: "Close",
      verdicts: ["met", "partly_met", "not_met"],
    });
    const owner = goalStatusMoves(goal(), person(OWNER));
    expect(owner.some((m) => m.kind === "verdict" && m.verb === "close")).toBe(
      false
    );
    expect(owner.some((m) => m.kind === "verdict" && m.verb === "drop")).toBe(
      true
    );
  });

  it('a move between open states names where it goes — never a bare "Move"', () => {
    const draft = goalStatusMoves(
      goal({ status: "proposed" }),
      person(OWNER)
    ).filter((m) => m.kind === "move");
    expect(draft.map((m) => m.label)).toEqual([
      "Move to agreed",
      "Move to ready",
      "Start",
      "Pause",
    ]);
    expect(
      goalStatusMoves(goal({ status: "paused" }), person(OWNER)).find(
        (m) => m.kind === "move" && m.to === "active"
      )
    ).toMatchObject({ label: "Resume" });
  });

  it("the open stage is offered forward only — an active goal never moves back to draft (D-2)", () => {
    const active = goalStatusMoves(goal(), person(OWNER)).filter(
      (m) => m.kind === "move"
    );
    expect(active.map((m) => m.label)).toEqual(["Pause"]);
    const ready = goalStatusMoves(
      goal({ status: "ready" }),
      person(OWNER)
    ).filter((m) => m.kind === "move");
    expect(ready.map((m) => m.label)).toEqual(["Start", "Pause"]);
    const paused = goalStatusMoves(
      goal({ status: "paused" }),
      person(OWNER)
    ).filter((m) => m.kind === "move");
    expect(paused.map((m) => m.label)).toEqual(["Resume"]);
  });

  it('an operation offers only "Retire"', () => {
    const moves = goalStatusMoves(
      goal({ workKind: "operation" }),
      person(JUDGE)
    );
    expect(
      moves.find((m) => m.kind === "verdict" && m.verb === "close")
    ).toMatchObject({ label: "Retire", verdicts: ["retired"] });
  });

  it("who may drop is ONE function, read by the moves and the verdict bar alike", () => {
    const g = goal({
      participants: [
        part("p1", OWNER, "owner"),
        part("p2", JUDGE, "judge"),
        part("p3", "u-del", "delegate"),
      ],
    });
    for (const [viewer, may] of [
      [person(OWNER), true],
      [person(JUDGE), true],
      [person("u-del"), false],
      [{ userId: OWNER, kind: "agent" } as GoalViewer, false],
    ] as const) {
      expect(viewerMayDrop(g, viewer)).toBe(may);
      expect(
        goalStatusMoves(g, viewer).some(
          (m) => m.kind === "verdict" && m.verb === "drop"
        )
      ).toBe(may);
      expect(goalVerdicts(g, viewer).mayDrop).toBe(may);
    }
  });

  it("never offers a close or a drop to an agent", () => {
    const g = goal({ participants: [part("p1", AGENT, "owner")] });
    expect(goalStatusMoves(g, agent).some((m) => m.kind === "verdict")).toBe(
      false
    );
  });

  it('a closed goal offers only "Open a new version", to a person', () => {
    const closed = goal({ status: "completed", verdict: "met" });
    expect(goalStatusMoves(closed, person(OWNER))).toEqual([
      { kind: "reopen", label: "Open a new version" },
    ]);
    expect(goalStatusMoves(closed, agent)).toEqual([]);
  });
});

describe("verdicts", () => {
  it('"Met" waits until every required criterion is met; the reason is said for a person', () => {
    const v = goalVerdicts(goal(), person(JUDGE));
    const met = v.close.find((c) => c.verdict === "met")!;
    expect(met.unavailable).toBe("3 criteria are not met yet");
    expect(
      v.close.find((c) => c.verdict === "partly_met")!.unavailable
    ).toBeNull();
  });

  it('all met: "Met" opens and "Partly met" closes', () => {
    const v = goalVerdicts(
      goal({ criteria: [crit("a", "met"), crit("b", "met")] }),
      person(JUDGE)
    );
    expect(v.close.find((c) => c.verdict === "met")!.unavailable).toBeNull();
    expect(v.close.find((c) => c.verdict === "partly_met")!.unavailable).toBe(
      "Every criterion is met"
    );
  });

  it("a lasting goal (no criteria) closes on its judge’s word", () => {
    const v = goalVerdicts(goal({ criteria: [] }), person(JUDGE));
    expect(v.close.every((c) => c.unavailable === null)).toBe(true);
  });

  it("impossible and replaced ask for the closer’s words", () => {
    const v = goalVerdicts(goal(), person(OWNER));
    expect(v.drop.filter((c) => c.needsReason).map((c) => c.verdict)).toEqual([
      "impossible",
      "replaced",
    ]);
    expect(v.close).toEqual([]);
    expect(v.mayDrop).toBe(true);
  });

  it("an agent is refused with a reason, and offered nothing", () => {
    const v = goalVerdicts(
      goal({ participants: [part("p1", AGENT, "owner")] }),
      agent
    );
    expect(v).toMatchObject({
      mayClose: false,
      mayDrop: false,
      close: [],
      drop: [],
    });
    expect(v.refusal).toMatch(/agent/i);
  });
});
