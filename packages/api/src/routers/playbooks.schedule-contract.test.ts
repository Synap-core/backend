/**
 * Write-door contract test for a playbook's `schedule`.
 *
 * `schedule` was `z.unknown()` at both doors, so `PlaybookSchedule.mode`
 * ("run" | "appointment") — the one input that makes a schedule materialize an
 * APPOINTMENT (a `scheduled` session waiting for the human) instead of an agent
 * run — had no declared writer, and a misspelled mode was stored silently and
 * then read back as "run".
 *
 * Asserts the DOORS (not just the schema module): the parsed input IS what the
 * router stores (`set.schedule = input.schedule` / `schedule: input.schedule`),
 * so `mode` surviving the parse is `mode` surviving the write.
 *
 * Does NOT cover: that the stored mode reaches the flow node — that seam is
 * `cron-automation.test.ts` ("appointment mode") + `normalizePlaybookScheduleMode`.
 *
 * No DB — these are pure zod input schemas.
 */
import { describe, expect, it } from "vitest";
import { createInputSchema, updateInputSchema } from "./playbooks.js";

const PLAYBOOK_ID = "00000000-0000-4000-8000-000000000001";
const CREATE_BASE = { name: "Weekly review", goalTemplate: "Review the week" };

describe("playbooks doors — schedule.mode survives the write", () => {
  it("update: an appointment schedule parses with mode intact", () => {
    const result = updateInputSchema.safeParse({
      id: PLAYBOOK_ID,
      schedule: { cron: "0 9 * * MON", enabled: true, mode: "appointment" },
    });
    expect(result.success).toBe(true);
    expect(result.data?.schedule).toEqual({
      cron: "0 9 * * MON",
      enabled: true,
      mode: "appointment",
    });
  });

  it("create: an appointment schedule parses with mode intact", () => {
    const result = createInputSchema.safeParse({
      ...CREATE_BASE,
      schedule: { cron: "0 9 * * MON", enabled: true, mode: "appointment" },
    });
    expect(result.success).toBe(true);
    expect(result.data?.schedule?.mode).toBe("appointment");
  });

  it("REJECTS a mode outside the closed set (a typo must not store silently)", () => {
    for (const mode of ["Appointment", "appointments", "meeting", 1]) {
      expect(
        updateInputSchema.safeParse({
          id: PLAYBOOK_ID,
          schedule: { cron: "0 9 * * MON", enabled: true, mode },
        }).success
      ).toBe(false);
    }
  });

  it("keeps unknown schedule keys (jsonb round-trip must not strip fields)", () => {
    const result = updateInputSchema.safeParse({
      id: PLAYBOOK_ID,
      schedule: { cron: "0 9 * * *", enabled: false, timezone: "Europe/Paris" },
    });
    expect(result.success).toBe(true);
    expect(result.data?.schedule).toEqual({
      cron: "0 9 * * *",
      enabled: false,
      timezone: "Europe/Paris",
    });
  });

  it("still accepts null (clears the schedule) and an omitted schedule", () => {
    expect(
      updateInputSchema.safeParse({ id: PLAYBOOK_ID, schedule: null }).success
    ).toBe(true);
    expect(
      updateInputSchema.safeParse({ id: PLAYBOOK_ID, name: "Renamed" }).success
    ).toBe(true);
  });
});
