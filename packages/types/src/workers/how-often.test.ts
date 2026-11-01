/** The New goal flows' "How often?" answer → what `workers.enable` takes. */
import { describe, expect, it } from "vitest";
import {
  howOftenActivator,
  howOftenEnable,
  howOftenEvents,
} from "./how-often.js";
import { workerActivatorKey, type WorkerActivator } from "./index.js";
import { cronWords } from "../automations/cron-recurrence.js";

const DECLARED: WorkerActivator[] = [
  { on: "schedule", cron: "0  9 * * 1" },
  { on: "schedule", cron: "30 7 * * *" },
  { on: "enters_status", status: "briefed" },
  { on: "created" },
  { on: "count", status: "idea", min: 5 },
  { on: "manual" },
];

describe("howOftenActivator", () => {
  it("builds the clock through the rule grammar, in the words the pages say", () => {
    const daily = howOftenActivator({ kind: "daily", time: "07:30" })!;
    expect(daily).toEqual({ on: "schedule", cron: "30 7 * * *" });
    expect(cronWords(daily.cron)).toMatch(/^Every day at 07:30/);
    const weekly = howOftenActivator({
      kind: "weekly",
      day: 1,
      time: "09:00",
    })!;
    expect(weekly.cron).toBe("0 9 * * 1");
    expect(cronWords(weekly.cron)).toMatch(/^Every Monday at 09:00/);
  });

  it("is null for no clock, and for a time or day that is not one", () => {
    expect(howOftenActivator({ kind: "until_done" })).toBeNull();
    expect(
      howOftenActivator({ kind: "event", activatorKey: "created" })
    ).toBeNull();
    expect(howOftenActivator({ kind: "daily", time: "24:00" })).toBeNull();
    expect(howOftenActivator({ kind: "daily", time: "9:00" })).toBeNull();
    expect(
      howOftenActivator({ kind: "weekly", day: 7, time: "09:00" })
    ).toBeNull();
  });
});

describe("howOftenEvents", () => {
  it("offers only the declared 'something happens' workers, keyed as enable takes them", () => {
    expect(howOftenEvents(DECLARED).map((e) => e.activatorKey)).toEqual([
      "enters_status:briefed",
      "created",
      "count:idea",
    ]);
  });
});

describe("howOftenEnable", () => {
  it("until it's done enables nothing", () => {
    expect(howOftenEnable({ kind: "until_done" }, DECLARED)).toEqual({
      status: "no_worker",
    });
  });

  it("a clock finds the declared schedule on its compiled key, whatever its spacing", () => {
    const res = howOftenEnable(
      { kind: "weekly", day: 1, time: "09:00" },
      DECLARED
    );
    expect(res).toEqual({
      status: "enable",
      activatorKey: "schedule:0 9 * * 1",
      activator: DECLARED[0],
    });
    expect(res.status === "enable" && res.activatorKey).toBe(
      workerActivatorKey(DECLARED[0]!)
    );
    expect(
      howOftenEnable({ kind: "daily", time: "07:30" }, DECLARED)
    ).toMatchObject({
      status: "enable",
      activatorKey: "schedule:30 7 * * *",
    });
  });

  it("a clock or an event the playbook does not declare is said, never enabled", () => {
    expect(howOftenEnable({ kind: "daily", time: "08:00" }, DECLARED)).toEqual({
      status: "not_declared",
      activatorKey: "schedule:0 8 * * *",
    });
    expect(
      howOftenEnable(
        { kind: "event", activatorKey: "enters_status:done" },
        DECLARED
      )
    ).toEqual({ status: "not_declared", activatorKey: "enters_status:done" });
    // A manual worker is not "something happens".
    expect(
      howOftenEnable({ kind: "event", activatorKey: "manual" }, DECLARED).status
    ).toBe("not_declared");
  });

  it("an event answer enables the declared worker", () => {
    expect(
      howOftenEnable({ kind: "event", activatorKey: "count:idea" }, DECLARED)
    ).toEqual({
      status: "enable",
      activatorKey: "count:idea",
      activator: DECLARED[4],
    });
  });

  it("a time that is not one is invalid", () => {
    expect(howOftenEnable({ kind: "daily", time: "25:00" }, DECLARED)).toEqual({
      status: "invalid",
    });
  });
});
