/**
 * The structure progress bus — sequencing, honesty bounds and expiry.
 *
 * Driven through the public reporter/subscriber API with an injected clock.
 * The procedure wiring (parity, privacy against the real procedure, disconnect
 * through the real tail, no-fake-stage) lives in
 * `routers/__tests__/capture.structure-progress.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { StructureProgressEvent } from "@synap-core/types/capture";
import {
  __structureProgressBusForTests as bus,
  attachStructureProgressReporter,
  subscribeStructureProgress,
  STRUCTURE_PROGRESS_BUFFER_MAX,
  STRUCTURE_PROGRESS_DONE_TTL_MS,
} from "../structure-progress-bus.js";

const RUN = "5f0c6a53-1b1e-4c8e-9a53-6c1f5b0f0001";
let clock = 1_000_000;

function collect(userId: string, runId = RUN) {
  const frames: StructureProgressEvent[] = [];
  const sub = subscribeStructureProgress(userId, runId, 0, (f) =>
    frames.push(f)
  );
  return { frames, sub };
}

const stage = (
  stageName: "understanding" | "reading",
  attempt: number
): StructureProgressEvent => ({
  v: 1,
  seq: 99,
  kind: "stage",
  stage: stageName,
  attempt,
  at: "x",
});
const draft = (attempt: number, titles: string[]): StructureProgressEvent => ({
  v: 1,
  seq: 99,
  kind: "draft",
  attempt,
  rev: 0,
  entities: titles.map((title) => ({ title, profileSlug: "note" })),
});

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
  bus.reset();
  bus.setNow(() => clock);
});
afterEach(() => {
  bus.reset();
  vi.useRealTimers();
});

describe("structure progress bus", () => {
  it("appends a stage only on a real transition, with pod-owned monotonic seq", () => {
    const { frames } = collect("u1");
    const r = attachStructureProgressReporter("u1", RUN);
    r.stage("reading");
    r.stage("reading");
    r.forward(stage("understanding", 1));
    r.forward(stage("understanding", 1));
    r.stage("placing");
    expect(frames.map((f) => (f.kind === "stage" ? f.stage : f.kind))).toEqual([
      "reading",
      "understanding",
      "placing",
    ]);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it("sends a draft only when the settled set changed, at most 4 per second, keeping the latest", () => {
    const { frames } = collect("u1");
    const r = attachStructureProgressReporter("u1", RUN);
    r.forward(draft(1, ["A"]));
    r.forward(draft(1, ["A"])); // unchanged → nothing
    clock += 50;
    r.forward(draft(1, ["A", "B"])); // inside the 250ms window → deferred
    clock += 50;
    r.forward(draft(1, ["A", "B", "C"])); // replaces the deferred one
    expect(frames.filter((f) => f.kind === "draft")).toHaveLength(1);
    // The deferred draft was scheduled at +50ms for the end of the 250ms window.
    clock += 150;
    vi.advanceTimersByTime(199);
    expect(frames.filter((f) => f.kind === "draft")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const drafts = frames.filter((f) => f.kind === "draft");
    expect(drafts).toHaveLength(2);
    expect(
      drafts[1]!.kind === "draft" && drafts[1]!.entities.map((e) => e.title)
    ).toEqual(["A", "B", "C"]);
  });

  it("offsets IS attempts across pod retries, resets a visible draft, and drops a stale attempt's draft", () => {
    const { frames } = collect("u1");
    const r = attachStructureProgressReporter("u1", RUN);
    r.forward(stage("understanding", 1));
    r.forward(draft(1, ["A"]));
    r.retry();
    // The second IS call starts its own attempts at 1 → the pod reads 2.
    r.forward(stage("understanding", 1));
    clock += 1000;
    r.forward(draft(0, ["stale"])); // below the current attempt → dropped
    const tail = frames.slice(2);
    expect(tail).toMatchObject([
      { kind: "draft", attempt: 2, entities: [] },
      { kind: "stage", stage: "understanding", attempt: 2 },
    ]);
    expect(
      frames.some(
        (f) => f.kind === "draft" && f.entities.some((e) => e.title === "stale")
      )
    ).toBe(false);
  });

  it("bounds a draft: 12 entities, 80-character titles", () => {
    const { frames } = collect("u1");
    const r = attachStructureProgressReporter("u1", RUN);
    r.forward(
      draft(
        1,
        Array.from({ length: 20 }, (_, i) => `${"x".repeat(100)}${i}`)
      )
    );
    const d = frames.find((f) => f.kind === "draft");
    expect(d?.kind === "draft" && d.entities.length).toBe(12);
    expect(d?.kind === "draft" && Array.from(d.entities[0]!.title).length).toBe(
      80
    );
  });

  it("keeps the last 64 frames and replays only after the given seq", () => {
    const r = attachStructureProgressReporter("u1", RUN);
    for (let i = 0; i < 70; i++) {
      r.stage(i % 2 ? "placing" : "matching");
    }
    const all = subscribeStructureProgress("u1", RUN, 0, () => {});
    expect(all.replay).toHaveLength(STRUCTURE_PROGRESS_BUFFER_MAX);
    expect(all.replay[0]!.seq).toBe(7);
    const after = subscribeStructureProgress("u1", RUN, 68, () => {});
    expect(after.replay.map((f) => f.seq)).toEqual([69, 70]);
  });

  it("closes on done, ignores later frames, and expires 60s after done", () => {
    const r = attachStructureProgressReporter("u1", RUN);
    r.stage("reading");
    r.done("plan");
    r.stage("matching");
    const sub = subscribeStructureProgress("u1", RUN, 0, () => {});
    expect(sub.done).toBe(true);
    expect(sub.replay.map((f) => f.kind)).toEqual(["stage", "done"]);
    sub.unsubscribe();
    clock += STRUCTURE_PROGRESS_DONE_TTL_MS + 1;
    const late = subscribeStructureProgress("u1", RUN, 0, () => {});
    expect(late.replay).toEqual([]);
    expect(late.done).toBe(false);
  });

  it("keys a run by the server user: another user's subscription to the same run id sees nothing", () => {
    const b = collect("user-b");
    const a = collect("user-a");
    const r = attachStructureProgressReporter("user-a", RUN);
    r.stage("reading");
    r.done("plan");
    expect(a.frames).toHaveLength(2);
    expect(b.frames).toEqual([]);
    expect(
      subscribeStructureProgress("user-b", RUN, 0, () => {}).replay
    ).toEqual([]);
  });
});
