/**
 * The activator wire schema, stage-worker shapes (work model L4). Each row
 * names the refusal it pins — a worker declaration the compiler could only
 * turn into a rule that fires on the wrong thing, or never.
 */
import { describe, expect, it } from "vitest";
import {
  activatorKey,
  playbookActivatorSchema,
  playbookActivatorsSchema,
} from "./playbook-process.js";

const ok = (a: unknown) => playbookActivatorSchema.safeParse(a).success;

describe("playbookActivatorSchema — workers", () => {
  it("a count needs its status AND a threshold ≥ 2, and runs once for the set", () => {
    expect(ok({ on: "count", status: "review", min: 3 })).toBe(true);
    expect(ok({ on: "count", status: "review" })).toBe(false); // no min
    expect(ok({ on: "count", min: 3 })).toBe(false); // no status
    expect(ok({ on: "count", status: "review", min: 1 })).toBe(false);
    expect(
      ok({ on: "count", status: "review", min: 3, size: "per_thing" })
    ).toBe(false);
    expect(ok({ on: "enters_status", status: "review", min: 3 })).toBe(false);
  });

  it("a schedule needs a cron the rule grammar can spell, and only a schedule takes one", () => {
    expect(ok({ on: "schedule", cron: "0 9 * * 1" })).toBe(true);
    expect(ok({ on: "schedule", cron: "0 9 * * 1", status: "review" })).toBe(
      true
    );
    expect(ok({ on: "schedule" })).toBe(false);
    expect(ok({ on: "schedule", cron: "*/15 * * * *" })).toBe(false);
    expect(ok({ on: "created", cron: "0 9 * * 1" })).toBe(false);
  });

  it("a schedule runs once for the set, or once per thing — and an appointment never per thing", () => {
    const tick = { on: "schedule", cron: "0 9 * * 1" };
    expect(ok({ ...tick, size: "per_thing" })).toBe(true);
    expect(ok({ ...tick, mode: "appointment" })).toBe(true);
    expect(ok({ ...tick, mode: "appointment", size: "per_thing" })).toBe(false);
  });

  it("a schedule takes a status LIST, a zone the clock reads, startsPaused, and a hand-off in run mode only", () => {
    const tick = { on: "schedule", cron: "0 9 * * 1" };
    expect(ok({ ...tick, status: ["scoree", "retenue"] })).toBe(true);
    expect(ok({ on: "enters_status", status: ["a", "b"] })).toBe(false);
    expect(ok({ ...tick, timezone: "Europe/Paris" })).toBe(true);
    expect(ok({ ...tick, timezone: "Mars/Olympus" })).toBe(false);
    expect(ok({ on: "created", timezone: "Europe/Paris" })).toBe(false);
    expect(ok({ ...tick, startsPaused: true })).toBe(true);
    expect(ok({ on: "created", startsPaused: true })).toBe(false);
    expect(ok({ ...tick, mode: "run", handToAgentId: "agent-1" })).toBe(true);
    expect(ok({ ...tick, mode: "propose", handToAgentId: "agent-1" })).toBe(
      false
    );
    expect(ok({ on: "created", mode: "appointment" })).toBe(false);
  });

  it("only / unless read one thing: a per_thing schedule takes them, a per_moment one does not", () => {
    const only = { property: "billing", in: ["monthly"] };
    expect(
      ok({ on: "schedule", cron: "0 9 * * 1", size: "per_thing", only })
    ).toBe(true);
    expect(ok({ on: "schedule", cron: "0 9 * * 1", only })).toBe(false);
  });

  it("manual takes no status; the backlog limit is bounded", () => {
    expect(ok({ on: "manual" })).toBe(true);
    expect(ok({ on: "manual", status: "review" })).toBe(false);
    expect(
      ok({ on: "enters_status", status: "a", maxPendingApprovals: 201 })
    ).toBe(false);
    expect(
      ok({ on: "enters_status", status: "a", maxPendingApprovals: 200 })
    ).toBe(true);
  });

  it("an activator declared before workers parses to the SAME object (no hash moves)", () => {
    expect(
      playbookActivatorSchema.parse({ on: "enters_status", status: "a" })
    ).toEqual({ on: "enters_status", status: "a", mode: "propose" });
  });

  it("keys: count and schedule are their own; size / mode stay out of the key", () => {
    expect(activatorKey({ on: "count", status: "review" })).toBe(
      "count:review"
    );
    expect(activatorKey({ on: "schedule", cron: " 0  9 * * 1 " })).toBe(
      "schedule:0 9 * * 1"
    );
    // A count and an enters_status on one status are two workers.
    expect(
      playbookActivatorsSchema.safeParse([
        { on: "enters_status", status: "review" },
        { on: "count", status: "review", min: 2 },
      ]).success
    ).toBe(true);
  });
});
