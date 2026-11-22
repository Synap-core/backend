/**
 * The retired `schedule` → the `schedule` activator it says (or why none can).
 */
import { describe, expect, it } from "vitest";
import { scheduleActivatorOf } from "./playbook-schedule.js";

const free = { profileSlug: null, statusProperty: null, filter: undefined };

describe("scheduleActivatorOf", () => {
  it("no cron is no schedule", () => {
    expect(scheduleActivatorOf(null, free)).toBeNull();
    expect(scheduleActivatorOf({ enabled: true }, free)).toBeNull();
  });

  it("a subject-less run keeps its mode; disabled or paused installs paused", () => {
    expect(
      scheduleActivatorOf(
        { cron: "0 16 * * 5", enabled: false, mode: "appointment" },
        free
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
      scheduleActivatorOf({ cron: "0 8 * * *", enabled: true }, free, false)
    ).toEqual({
      activator: {
        on: "schedule",
        cron: "0 8 * * *",
        mode: "run",
        startsPaused: true,
      },
    });
  });

  it("a kind-bound schedule runs per thing; its filter becomes status + one only", () => {
    expect(
      scheduleActivatorOf(
        { cron: "0 8 1 * *", enabled: true },
        {
          profileSlug: "revenue-stream",
          statusProperty: "status",
          filter:
            '{"properties.status":"active","properties.billing-cadence":"monthly"}',
        }
      )
    ).toEqual({
      activator: {
        on: "schedule",
        cron: "0 8 1 * *",
        mode: "run",
        size: "per_thing",
        status: "active",
        only: { property: "billing-cadence", in: ["monthly"] },
      },
    });
  });

  it("refuses what no activator can say", () => {
    const kind = { profileSlug: "deal", statusProperty: null };
    expect(
      scheduleActivatorOf({ cron: "*/15 * * * *", enabled: true }, free)
    ).toEqual({ error: expect.stringContaining("cron") });
    expect(
      scheduleActivatorOf(
        { cron: "0 8 * * *", enabled: true },
        { ...kind, filter: '{"properties.a":"x","properties.b":"y"}' }
      )
    ).toEqual({ error: expect.stringContaining("more than one property") });
    expect(
      scheduleActivatorOf(
        { cron: "0 8 * * *", enabled: true },
        { ...kind, filter: "status = active" }
      )
    ).toEqual({ error: expect.stringContaining("not JSON") });
    expect(
      scheduleActivatorOf(
        { cron: "0 8 * * *", enabled: true, mode: "appointment" },
        { ...kind, filter: undefined }
      )
    ).toEqual({ error: expect.stringContaining("appointment") });
  });
});
