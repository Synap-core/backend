/**
 * CONTINUE AT <STAGE> (`continue-run.ts`): a PERSON resumes
 * a run that ended or stopped before its last stage, in the SAME session, at
 * the stage it stopped on, with a new run turn. The stopped run keeps its
 * verdict; an ended session is reopened through the one status write.
 *
 * Drives the REAL door (`continueStoppedRun`) and its REAL predicate
 * (`continueAt`). DB-FREE: `@synap/database` is partially mocked (real
 * tables and operators kept, the connection and the status write replaced),
 * as `focus-sessions.reopen-cancelled.test.ts` does; the run dispatch, the
 * live-run read and the room post are recorded.
 *
 * NEGATIVE CONTROLS: an agent key, a run still live, a cancelled session, a
 * run at its last stage and another live run on the record each write
 * NOTHING (no status move, no dispatch, no room line).
 *
 * THE LIVE-RUN GUARD (`continueAt`: nothing live, no draft) is pinned on the
 * one case only it refuses: a session that ENDED (so `stoppedEarly` holds on
 * the session's status alone) while its newest run is still live or a draft.
 * Remove the guard and those tests fail: the door would reopen the session
 * and dispatch a second turn beside the live one.
 *
 * `continueCheck` is the door's check the read asks too (`statusOf` work →
 * `continue.canAct`): its rungs are pinned here once, for both.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const NEW_RUN = "55555555-5555-4555-8555-555555555555";
const ROOM = "44444444-4444-4444-8444-444444444444";
const FILM = "66666666-6666-4666-8666-666666666666";
const PLAYBOOK = "77777777-7777-4777-8777-777777777777";
const OTHER_SESSION = "88888888-8888-4888-8888-888888888888";

const PRODUCE = [
  { key: "brief", name: "Brief" },
  { key: "script", name: "Script" },
  { key: "draft", name: "Draft" },
  { key: "publish", name: "Publish" },
];

const h = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  run: null as Record<string, unknown> | null,
  live: null as { session: { id: string } } | null,
  statusMoves: [] as Array<Record<string, unknown>>,
  rowWrites: [] as Array<{ table: unknown; patch: unknown }>,
  dispatched: [] as Array<Record<string, unknown>>,
  posted: [] as Array<Record<string, unknown>>,
  moveFinds: true,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const select = () => {
    let table: unknown;
    const result = () => {
      if (table === actual.focusSessions) return h.session ? [h.session] : [];
      if (table === actual.playbookRuns) return h.run ? [h.run] : [];
      if (table === actual.users) return [{ name: "Ada" }];
      return [];
    };
    const chain: Record<string, unknown> = {
      from: (t: unknown) => ((table = t), chain),
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      for: () => chain,
      then: (resolve: (v: unknown) => void) => resolve(result()),
    };
    return chain;
  };
  const update = (table: unknown) => ({
    set: (patch: unknown) => {
      h.rowWrites.push({ table, patch });
      return { where: () => ({ returning: async () => [] }) };
    },
  });
  return {
    ...actual,
    setSessionStatus: async (_db: unknown, input: Record<string, unknown>) => {
      h.statusMoves.push(input);
      return {
        rows: h.moveFinds ? [{ ...h.session, status: input.to }] : [],
        transitions: [],
      };
    },
    db: { select, update },
  };
});

vi.mock("../../playbooks/live-run-of-subject.js", () => ({
  findLiveRunOfSubject: async () => h.live,
}));
vi.mock("../../messaging/post-message.js", () => ({
  postChannelMessage: async (p: Record<string, unknown>) => {
    h.posted.push(p);
    return { id: "m1" };
  },
}));
vi.mock("../../playbooks/playbook-lifecycle.js", () => ({
  resolveRunnablePlaybook: async (p: { playbookId: string }) => ({
    id: p.playbookId,
    executor: "is-agent",
    stages: PRODUCE,
  }),
}));
vi.mock("../../playbooks/run-playbook.js", () => ({
  resolveRunChoice: async () => ({ handOff: null, runOn: null, persona: null }),
  dispatchRunOnSession: async (p: Record<string, unknown>) => {
    h.dispatched.push(p);
    return { id: NEW_RUN, status: "running" };
  },
}));

const { continueStoppedRun, continueAt, continueCheck, stoppedEarly } =
  await import("../continue-run.js");
const { playbookRuns } = await import("@synap/database");

function session(over: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    userId: "user-1",
    workspaceId: null,
    goal: "Make a film",
    title: "Make a film",
    status: "failed",
    channelId: ROOM,
    playbookId: PLAYBOOK,
    subjectEntityId: FILM,
    stages: PRODUCE,
    currentStage: "script",
    metadata: {},
    ...over,
  };
}
function run(over: Record<string, unknown> = {}) {
  return {
    id: RUN,
    sessionId: SESSION,
    status: "failed",
    stopReason: "stages_left",
    input: { topic: "Bees", runId: RUN, stageRunners: { draft: "self" } },
    ...over,
  };
}

const nothingWritten = () => {
  expect(h.statusMoves).toEqual([]);
  expect(h.dispatched).toEqual([]);
  expect(h.posted).toEqual([]);
  expect(h.rowWrites).toEqual([]);
};

beforeEach(() => {
  h.session = session();
  h.run = run();
  h.live = null;
  h.statusMoves.length = 0;
  h.rowWrites.length = 0;
  h.dispatched.length = 0;
  h.posted.length = 0;
  h.moveFinds = true;
});

describe("continueAt — the one predicate the read and the door share", () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    status: "failed",
    playbookId: PLAYBOOK,
    stages: PRODUCE,
    currentStage: "script",
    runStatus: "failed",
    ...over,
  });

  it("a run that ended at Script with stages left continues at Script", () => {
    const left = continueAt(facts());
    expect(left?.at).toEqual({ key: "script", name: "Script" });
    expect(left?.left.map((s) => s.key)).toEqual(["draft", "publish"]);
  });

  it("a session swept closed after a run 'completed' early stopped too", () => {
    expect(
      continueAt(facts({ status: "closed", runStatus: "completed" }))?.at?.key
    ).toBe("script");
  });

  it("nothing to continue: live, a draft, cancelled, at the last stage, no playbook", () => {
    for (const runStatus of [
      "running",
      "waiting_on_you",
      "stale",
      "proposed",
    ]) {
      expect(continueAt(facts({ status: "active", runStatus }))).toBeNull();
    }
    expect(continueAt(facts({ status: "cancelled" }))).toBeNull();
    expect(continueAt(facts({ runStatus: "cancelled" }))).toBeNull();
    expect(continueAt(facts({ currentStage: "publish" }))).toBeNull();
    expect(continueAt(facts({ playbookId: null }))).toBeNull();
  });

  it("NEGATIVE CONTROL (live-run guard): an ENDED session whose run is still live or a draft is not continued", () => {
    for (const status of ["closed", "failed"]) {
      for (const runStatus of ["running", "waiting_on_you", "proposed"]) {
        // The session's status alone reads it as stopped early …
        expect(stoppedEarly(facts({ status, runStatus }))?.at?.key).toBe(
          "script"
        );
        // … and only the live-run guard keeps Continue off.
        expect(continueAt(facts({ status, runStatus }))).toBeNull();
      }
    }
  });

  it("an open session whose run is live has not stopped early", () => {
    expect(
      stoppedEarly(facts({ status: "active", runStatus: "running" }))
    ).toBeNull();
    expect(
      stoppedEarly(facts({ status: "active", runStatus: "failed" }))?.at?.key
    ).toBe("script");
  });
});

describe("continueStoppedRun — a person continues a stopped run", () => {
  it("reopens the ended session, dispatches a new run turn at Script, keeps the old verdict", async () => {
    const result = await continueStoppedRun({
      sessionId: SESSION,
      userId: "user-1",
    });

    expect(result).toMatchObject({
      ok: true,
      sessionId: SESSION,
      runId: NEW_RUN,
      runStatus: "running",
      at: { key: "script", name: "Script" },
      reopenedFrom: "failed",
    });
    expect(h.statusMoves).toHaveLength(1);
    expect(h.statusMoves[0]).toMatchObject({
      sessionId: SESSION,
      from: "failed",
      to: "active",
      actor: { kind: "human", userId: "user-1" },
    });
    expect((h.statusMoves[0]!.set as Record<string, unknown>).closedAt).toBe(
      null
    );
    // The new turn runs on the SAME session, with the stopped run's params
    // and step runners, never the ids the dispatch stamps itself.
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({
      sessionId: SESSION,
      channelId: ROOM,
      subjectId: FILM,
      params: { topic: "Bees" },
      stageRunners: { draft: "self" },
    });
    expect(h.dispatched[0]!.params).not.toHaveProperty("runId");
    // The stopped run's status is never written here (plan §4.3).
    expect(h.rowWrites.filter((w) => w.table === playbookRuns)).toEqual([]);
    // The room says who continued it and where; the next turn reads it.
    expect(h.posted).toHaveLength(1);
    expect(String(h.posted[0]!.content)).toMatch(
      /^Ada continued this run at Script, with 2 stages left: Draft, Publish\./
    );
  });

  it("an open session whose run failed: no reopen, a new turn", async () => {
    h.session = session({ status: "active" });
    const result = await continueStoppedRun({
      sessionId: SESSION,
      userId: "user-1",
    });
    expect(result).toMatchObject({ ok: true, reopenedFrom: null });
    expect(h.statusMoves).toEqual([]);
    expect(h.dispatched).toHaveLength(1);
  });

  it("NEGATIVE: an agent key is refused by name, nothing written", async () => {
    const result = await continueStoppedRun({
      sessionId: SESSION,
      userId: "user-1",
      agentUserId: "agent-1",
    });
    expect(result).toMatchObject({ ok: false, reason: "person_only" });
    nothingWritten();
  });

  it("NEGATIVE: a run still live is not continued", async () => {
    h.session = session({ status: "active" });
    h.run = run({ status: "waiting_on_you", stopReason: null });
    const result = await continueStoppedRun({
      sessionId: SESSION,
      userId: "user-1",
    });
    expect(result).toMatchObject({ ok: false, reason: "nothing_to_continue" });
    nothingWritten();
  });

  it("NEGATIVE CONTROL (live-run guard): an ended session whose run is still running is not continued, nothing written", async () => {
    h.session = session({ status: "closed" });
    h.run = run({ status: "running", stopReason: null });
    const result = await continueStoppedRun({
      sessionId: SESSION,
      userId: "user-1",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "nothing_to_continue",
      message: "This run is still going: nothing to continue.",
    });
    nothingWritten();
  });

  it("NEGATIVE: a cancelled session, or a run at its last stage, has nothing to continue", async () => {
    h.session = session({ status: "cancelled" });
    expect(
      await continueStoppedRun({ sessionId: SESSION, userId: "user-1" })
    ).toMatchObject({ ok: false, reason: "nothing_to_continue" });
    h.session = session({ status: "closed", currentStage: "publish" });
    h.run = run({ status: "completed", stopReason: null });
    expect(
      await continueStoppedRun({ sessionId: SESSION, userId: "user-1" })
    ).toMatchObject({ ok: false, reason: "nothing_to_continue" });
    nothingWritten();
  });

  it("NEGATIVE: another live run of the playbook on the record refuses it", async () => {
    h.live = { session: { id: OTHER_SESSION } };
    const result = await continueStoppedRun({
      sessionId: SESSION,
      userId: "user-1",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "already_running",
      liveSessionId: OTHER_SESSION,
    });
    nothingWritten();
  });

  it("a session that moved meanwhile is a conflict, and no turn is dispatched", async () => {
    h.moveFinds = false;
    const result = await continueStoppedRun({
      sessionId: SESSION,
      userId: "user-1",
    });
    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    expect(h.dispatched).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it("a session that is not the person's is not found", async () => {
    h.session = null;
    expect(
      await continueStoppedRun({ sessionId: SESSION, userId: "user-1" })
    ).toMatchObject({ ok: false, reason: "not_found" });
    nothingWritten();
  });
});

describe("continueCheck — the door's check, asked by the read (continue.canAct)", () => {
  const check = (over: Partial<Parameters<typeof continueCheck>[0]> = {}) =>
    continueCheck({
      session: session() as never,
      run: run(),
      userId: "user-1",
      grantDenial: async () => null,
      ...over,
    });

  it("the owner, no grant in the way, a stopped run: may continue at Script", async () => {
    const c = await check();
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.left.at?.key).toBe("script");
  });

  it("an agent may not (person_only), before the grant is even asked", async () => {
    let asked = false;
    const c = await check({
      agentUserId: "agent-1",
      grantDenial: async () => ((asked = true), null),
    });
    expect(c).toMatchObject({ ok: false, reason: "person_only" });
    expect(asked).toBe(false);
  });

  it("someone who can read but does not own the session may not (not_found)", async () => {
    expect(
      await check({ session: session({ userId: "user-2" }) as never })
    ).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("a key whose grant refuses a session update may not (denied), asked as a session update", async () => {
    const asked: unknown[] = [];
    const c = await check({
      grantDenial: async (w: unknown) => (asked.push(w), "denied"),
    });
    expect(c).toMatchObject({ ok: false, reason: "denied" });
    expect(asked).toEqual([
      {
        subjectType: "focus_session",
        action: "update",
        workspaceId: null,
        projectId: null,
      },
    ]);
  });

  it("another live run of the playbook on the record: may not (already_running)", async () => {
    h.live = { session: { id: OTHER_SESSION } };
    expect(await check()).toMatchObject({
      ok: false,
      reason: "already_running",
      liveSessionId: OTHER_SESSION,
    });
  });

  it("no run, or no room for the new turn: nothing to continue", async () => {
    expect(await check({ run: null })).toMatchObject({
      ok: false,
      reason: "nothing_to_continue",
    });
    expect(
      await check({ session: session({ channelId: null }) as never })
    ).toMatchObject({ ok: false, reason: "nothing_to_continue" });
  });
});
