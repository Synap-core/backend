/**
 * Write-door contract for the RETIRED `schedule` input: still parsed (older
 * producers keep their schedule), its `mode` intact, and the activator it
 * folds into refuses what no schedule activator can say. What the fold
 * produces is `schemas/playbook-schedule.test.ts`.
 *
 * No DB — pure zod input schemas.
 */
import { describe, expect, it } from "vitest";
import { createInputSchema, updateInputSchema } from "./playbooks.js";
import { retiredScheduleRefusal } from "../schemas/playbook-schedule.js";

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

  it("handToAgentId survives a run schedule; its fold REFUSES it beside an appointment", () => {
    const AGENT = "22222222-2222-4222-8222-222222222222";
    const run = updateInputSchema.safeParse({
      id: PLAYBOOK_ID,
      schedule: { cron: "0 9 * * MON", enabled: true, handToAgentId: AGENT },
    });
    expect(run.success).toBe(true);
    expect(run.data?.schedule?.handToAgentId).toBe(AGENT);
    // An appointment waits for the person: handing it to an agent cannot
    // become an activator, so the door refuses it.
    expect(
      retiredScheduleRefusal(
        {
          cron: "0 9 * * 1",
          enabled: true,
          mode: "appointment",
          handToAgentId: AGENT,
        },
        null
      )
    ).toContain("handToAgentId");
    // A blank id is not an agent.
    expect(
      updateInputSchema.safeParse({
        id: PLAYBOOK_ID,
        schedule: { cron: "0 9 * * MON", enabled: true, handToAgentId: "  " },
      }).success
    ).toBe(false);
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
