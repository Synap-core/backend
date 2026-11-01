/**
 * A stage worker in words and as a mark (moved with `playbookTriggerFact`
 * from browser's playbookTrigger.test.ts, surfaces W2.6).
 */
import { describe, expect, it } from "vitest";
import { resolveUnitState } from "../units/state.js";
import {
  goalRhythmWords,
  playbookTriggerFact,
  workerWhen,
  workerSentence,
  workerUnitInput,
  type SentenceWorker,
  type TriggerWorker,
} from "./words.js";

const worker = (over: Partial<TriggerWorker> = {}): TriggerWorker => ({
  state: "running",
  profileSlug: "post",
  activator: { on: "enters_status", status: "briefed" },
  ...over,
});

describe("playbookTriggerFact — the header says what starts it", () => {
  it('a live worker wins over the row having no trigger (never "Manual" over a running worker)', () => {
    const fact = playbookTriggerFact({
      workers: [worker()],
      workersFailed: false,
      schedule: null,
    });
    expect(fact).toEqual({
      state: "known",
      text: "When a post enters Briefed",
    });
  });

  it("a paused worker does not start anything: falls to the cron, then manual", () => {
    const paused = [worker({ state: "paused" })];
    expect(
      playbookTriggerFact({
        workers: paused,
        workersFailed: false,
        schedule: { cron: "0 9 * * 1", enabled: true },
      })
    ).toEqual({ state: "known", text: "Every Monday at 09:00 UTC" });
    expect(
      playbookTriggerFact({
        workers: paused,
        workersFailed: false,
        schedule: null,
      })
    ).toEqual({
      state: "known",
      text: "Manual / on demand",
    });
  });

  it("several workers name the first and count the rest; created reads as created", () => {
    const fact = playbookTriggerFact({
      workers: [worker({ activator: { on: "created" } }), worker()],
      workersFailed: false,
      schedule: null,
    });
    expect(fact).toEqual({
      state: "known",
      text: "When a post is created +1 more",
    });
  });

  it('in flight claims nothing; a failed read is failed, never "Manual"', () => {
    expect(
      playbookTriggerFact({
        workers: undefined,
        workersFailed: false,
        schedule: null,
      })
    ).toBeNull();
    expect(
      playbookTriggerFact({
        workers: undefined,
        workersFailed: true,
        schedule: null,
      })
    ).toEqual({ state: "failed" });
  });
});

describe("workerSentence + workerUnitInput — the worker row", () => {
  const w = (over: Partial<SentenceWorker> = {}): SentenceWorker => ({
    state: "running",
    profileSlug: "post",
    activator: { on: "enters_status", status: "briefed" },
    playbookName: "Produce Content",
    mode: "propose",
    pendingApprovals: 0,
    ...over,
  });

  it("reads as one sentence in its mode", () => {
    expect(workerSentence(w())).toEqual({
      when: "When a post enters Briefed",
      then: "propose running Produce Content",
    });
    expect(
      workerSentence(w({ mode: "run", activator: { on: "manual" } }))
    ).toEqual({ when: null, then: "run Produce Content" });
  });

  it("its mark is the shared state: waiting approvals outrank armed; paused is paused", () => {
    expect(resolveUnitState(workerUnitInput(w())).state).toBe("scheduled");
    expect(
      resolveUnitState(workerUnitInput(w({ pendingApprovals: 2 }))).state
    ).toBe("needs_review");
    expect(
      resolveUnitState(workerUnitInput(w({ state: "paused" }))).state
    ).toBe("paused");
  });
});

describe("workerWhen — a schedule is said in words (D3)", () => {
  it("reads a cron through cronWords, and an unphrasable one as a custom schedule", () => {
    expect(
      workerWhen(worker({ activator: { on: "schedule", cron: "0 9 * * 1" } }))
    ).toBe("Every Monday at 09:00 UTC");
    expect(
      workerWhen(
        worker({ activator: { on: "schedule", cron: "*/15 * * * *" } })
      )
    ).toBe("On a custom schedule");
    expect(workerWhen(worker({ activator: { on: "schedule" } }))).toBeNull();
  });
});

describe("goalRhythmWords — a goal's rhythm comes from its workers", () => {
  it("joins the running workers' triggers, schedule first as written", () => {
    expect(
      goalRhythmWords([
        worker({ activator: { on: "schedule", cron: "0 9 * * 1" } }),
        worker({ profileSlug: "issue", activator: { on: "created" } }),
      ])
    ).toBe("Every Monday at 09:00 UTC · when an issue is created");
  });

  it("leaves out paused and unsayable workers, says a repeat once, null when nothing wakes it", () => {
    const monday = worker({ activator: { on: "schedule", cron: "0 9 * * 1" } });
    expect(
      goalRhythmWords([
        monday,
        monday,
        worker({ state: "paused", activator: { on: "created" } }),
        worker({ activator: { on: "manual" } }),
      ])
    ).toBe("Every Monday at 09:00 UTC");
    expect(goalRhythmWords([])).toBeNull();
    expect(
      goalRhythmWords([
        worker({ state: "paused" }),
        worker({ activator: null }),
      ])
    ).toBeNull();
  });
});
