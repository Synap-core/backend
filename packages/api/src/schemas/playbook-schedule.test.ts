/**
 * The retired `schedule` → the `schedule` activator it says, or why none can,
 * and the door's refusal of one that could never fire.
 */
import { describe, expect, it } from "vitest";
import {
  retiredScheduleRefusal,
  scheduleActivatorOf,
} from "./playbook-schedule.js";

describe("scheduleActivatorOf", () => {
  it("no cron is no schedule", () => {
    expect(scheduleActivatorOf(null, null)).toBeNull();
    expect(scheduleActivatorOf({ enabled: true }, null)).toBeNull();
  });

  it("a subject-less run keeps its mode; disabled or paused installs paused", () => {
    expect(
      scheduleActivatorOf(
        { cron: "0 16 * * 5", enabled: false, mode: "appointment" },
        null
      )
    ).toEqual({
      activator: {
        on: "schedule",
        cron: "0 16 * * 5",
        mode: "appointment",
        startsPaused: true,
      },
    });
    expect(
      scheduleActivatorOf({ cron: "0 8 * * *", enabled: true }, null, false)
    ).toEqual({
      activator: {
        on: "schedule",
        cron: "0 8 * * *",
        mode: "run",
        startsPaused: true,
      },
    });
  });

  it("a kind-bound schedule runs once per thing", () => {
    expect(
      scheduleActivatorOf(
        { cron: "0 8 1 * *", enabled: true },
        "revenue-stream"
      )
    ).toEqual({
      activator: {
        on: "schedule",
        cron: "0 8 1 * *",
        mode: "run",
        size: "per_thing",
      },
    });
  });

  it("refuses what no activator can say", () => {
    expect(
      scheduleActivatorOf({ cron: "*/15 * * * *", enabled: true }, null)
    ).toEqual({ error: expect.stringContaining("cron") });
    expect(
      scheduleActivatorOf(
        { cron: "0 8 * * *", enabled: true, mode: "appointment" },
        "deal"
      )
    ).toEqual({ error: expect.stringContaining("appointment") });
  });
});

describe("retiredScheduleRefusal", () => {
  it("passes a schedule the pass folds, and the one already declared", () => {
    expect(
      retiredScheduleRefusal({ cron: "0 8 * * *", enabled: true }, null)
    ).toBeNull();
    expect(
      retiredScheduleRefusal(
        { cron: "0 8 * * *", enabled: true },
        { activators: [{ on: "schedule", cron: "0 8 * * *", mode: "run" }] }
      )
    ).toBeNull();
  });

  it("refuses a second clock beside a declared schedule activator", () => {
    expect(
      retiredScheduleRefusal(
        { cron: "0 9 * * *", enabled: true },
        { activators: [{ on: "schedule", cron: "0 8 * * *", mode: "run" }] }
      )
    ).toContain("schedule activator");
  });
});
