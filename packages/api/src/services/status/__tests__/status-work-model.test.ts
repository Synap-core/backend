/**
 * WHERE ITS WORK STANDS, one item (`status-work-model.ts`, PURE): a session,
 * its continuation packet and its newest run, projected onto the wire. The
 * packet's sections pass through renamed; only the stage list, the stop and
 * the Continue offer are composed here, from the predicates the next move and
 * the door share.
 */
import { describe, it, expect } from "vitest";
import {
  workItemOf,
  workStages,
  type WorkRunRow,
  type WorkSessionRow,
} from "../status-work-model.js";
import type { ContinuationPacket } from "../../focus-sessions/continuation-packet.js";

const S = "11111111-1111-4111-8111-111111111111";
const PRODUCE = [
  { key: "brief", name: "Brief" },
  { key: "script", name: "Script" },
  { key: "draft", name: "Draft" },
  { key: "publish", name: "Publish" },
];

const row = (over: Partial<WorkSessionRow> = {}): WorkSessionRow => ({
  id: S,
  title: "Make a film — Bees",
  goal: "Make a film",
  status: "failed",
  playbookId: "pb",
  channelId: "room",
  stages: PRODUCE,
  currentStage: "script",
  closedAt: "2026-11-16T10:00:00.000Z",
  ...over,
});
const run = (over: Partial<WorkRunRow> = {}): WorkRunRow => ({
  id: "run-1",
  status: "failed",
  stopReason: "stages_left",
  error: "Stopped at Script with 2 stages left",
  startedAt: "2026-11-16T09:00:00.000Z",
  completedAt: "2026-11-16T10:00:00.000Z",
  ...over,
});

const entry = (stageKey: string, status: string, attempt = 1) => ({
  id: `${stageKey}-${attempt}`,
  stageKey,
  attempt,
  status,
  agent: { id: "a", name: "Writer" },
  computer: null,
  childSessionId: null,
  startedAt: "2026-11-16T09:00:00.000Z",
  endedAt: status === "running" ? null : "2026-11-16T09:30:00.000Z",
});

/** The packet sections the item reads; the rest is never touched. */
const packet = (over: Partial<ContinuationPacket> = {}) =>
  ({
    stageRuns: {
      status: "ok",
      total: 3,
      items: [
        entry("brief", "done"),
        entry("script", "failed"),
        entry("script", "running", 2),
      ],
    },
    gates: {
      status: "ok",
      items: [
        {
          stageKey: "draft",
          stageName: "Draft",
          kind: "human",
          proposalType: "playbook.stage_gate",
          state: "pending",
          proposalId: "p-1",
          decidedByHuman: false,
          fromStage: "script",
          summary: "Approve stage: Draft for Bees",
        },
      ],
      deploy: null,
      ownerDeploys: [],
    },
    userMustDecide: {
      owedSlots: {
        status: "ok",
        total: 1,
        items: [
          {
            label: "Continue at Script?",
            kind: "decision",
            noun: "Decision",
            glyph: "◇",
            ask: { mode: "confirm", prompt: "Keep the run going at Script?" },
            owedSince: "2026-11-16T10:00:00.000Z",
          },
        ],
      },
      pendingProposals: { status: "ok", total: 0, items: [] },
    },
    holder: {
      status: "ok",
      holder: {
        kind: "nobody",
        waitKind: null,
        since: null,
        agent: null,
        source: "none",
        reason: "ended",
      },
    },
    live: {
      status: "ok",
      state: "idle",
      turnInFlight: false,
      since: null,
      lastActivityAt: "2026-11-16T10:00:00.000Z",
      measuredAt: "2026-11-17T10:00:00.000Z",
      windowMs: 300_000,
      runner: { status: "ok", state: null, since: null },
    },
    lastCompletion: { closedAt: "2026-11-16T10:00:00.000Z" },
    nextMove: {
      kind: "stopped_early",
      actor: "user",
      label: "Stopped at Script",
      reason: "The run ended (failed) at Script, with 2 stages left.",
    },
    ...over,
  }) as unknown as ContinuationPacket;

const item = (
  over: Partial<Parameters<typeof workItemOf>[0]> = {}
): ReturnType<typeof workItemOf> =>
  workItemOf({
    row: row(),
    on: "subject",
    kind: "run",
    packet: packet(),
    run: run(),
    link: "https://pod/open/x",
    ...over,
  });

describe("workItemOf — a run that stopped at Script", () => {
  it("says where it stopped, offers Continue, and never reads 'Nothing waiting'", () => {
    const w = item();
    expect(w.stopped).toEqual({
      at: { key: "script", name: "Script" },
      left: [
        { key: "draft", name: "Draft" },
        { key: "publish", name: "Publish" },
      ],
      label: "Stopped at Script",
    });
    expect(w.continue?.label).toBe("Continue at Script");
    expect(w.nextMove.label).toBe("Stopped at Script");
    expect(w.nextMove.label).not.toBe("Nothing waiting");
    expect(w.run).toMatchObject({
      id: "run-1",
      status: "failed",
      stopReason: "stages_left",
    });
  });

  it("places the stages around Script, each with its NEWEST ledger entry", () => {
    const { stages } = item();
    expect(stages.status).toBe("ok");
    if (stages.status !== "ok") return;
    expect(stages.current).toBe("script");
    expect(stages.items.map((s) => [s.key, s.position])).toEqual([
      ["brief", "done"],
      ["script", "current"],
      ["draft", "left"],
      ["publish", "left"],
    ]);
    expect(stages.items[1]!.entry).toMatchObject({
      status: "running",
      attempt: 2,
      agentName: "Writer",
    });
    expect(stages.items[2]!.entry).toBeNull();
  });

  it("passes the packet's gates, asks and holder through", () => {
    const w = item();
    expect(w.gates).toEqual({
      status: "ok",
      items: [
        {
          stageKey: "draft",
          stageName: "Draft",
          kind: "human",
          state: "pending",
          proposalId: "p-1",
          decidedByHuman: false,
          fromStage: "script",
          summary: "Approve stage: Draft for Bees",
        },
      ],
    });
    expect(w.roomId).toBe("room");
    expect(w.asks).toEqual({
      status: "ok",
      total: 1,
      items: [
        {
          label: "Continue at Script?",
          kind: "decision",
          noun: "Decision",
          owedSince: "2026-11-16T10:00:00.000Z",
          askMode: "confirm",
          prompt: "Keep the run going at Script?",
        },
      ],
    });
    expect(w.holder).toMatchObject({ kind: "nobody", reason: "ended" });
  });
});

describe("workItemOf — no Continue where the door would refuse", () => {
  it("a live run (asking 'Continue at Script?') has not stopped", () => {
    const w = item({
      row: row({ status: "active", closedAt: null }),
      run: run({ status: "waiting_on_you", stopReason: null }),
    });
    expect(w.stopped).toBeNull();
    expect(w.continue).toBeUndefined();
  });

  it("a cancelled session is the person's stop, not a stop early", () => {
    const w = item({ row: row({ status: "cancelled" }) });
    expect(w.stopped).toBeNull();
    expect(w.continue).toBeUndefined();
  });

  it("a run with no room cannot continue (the dispatch needs one)", () => {
    const w = item({ row: row({ channelId: null }) });
    expect(w.stopped?.label).toBe("Stopped at Script");
    expect(w.continue).toBeUndefined();
  });

  it("a run that finished at its last stage reads every stage done", () => {
    const w = item({
      row: row({ status: "closed", currentStage: "publish" }),
      run: run({ status: "completed", stopReason: null }),
    });
    expect(w.stopped).toBeNull();
    expect(w.continue).toBeUndefined();
    expect(
      w.stages.status === "ok" && w.stages.items.map((s) => s.position)
    ).toEqual(["done", "done", "done", "done"]);
  });
});

describe("workItemOf — a failed read is its own state, never empty", () => {
  it("a packet that could not be built: every section unavailable, next move unknown", () => {
    const w = item({ packet: { failed: "could not read" } });
    for (const part of [
      w.stages,
      w.gates,
      w.asks,
      w.proposals,
      w.holder,
      w.live,
    ]) {
      expect(part).toEqual({ status: "unavailable", reason: "could not read" });
    }
    expect(w.nextMove).toMatchObject({ kind: "unknown", actor: "none" });
    // The stop is read off the row and the run, not the packet.
    expect(w.stopped?.label).toBe("Stopped at Script");
  });

  it("a run read that failed: the run unavailable, and no stop or Continue claimed", () => {
    const w = item({ run: { failed: "run read failed" } });
    expect(w.run).toEqual({ status: "unavailable", reason: "run read failed" });
    expect(w.continue).toBeUndefined();
    expect(w.stopped).toBeNull();
  });

  it("a stage ledger that could not be read leaves the stages unavailable", () => {
    expect(
      workStages({
        stages: PRODUCE,
        currentStage: "script",
        stageRuns: { status: "unavailable", reason: "ledger down" },
        finished: false,
      })
    ).toEqual({ status: "unavailable", reason: "ledger down" });
  });
});
