/**
 * The `gate` field at the WRITE boundary.
 *
 * The surrounding stage object is deliberately LOOSE (dropping an unknown stage
 * field on a round-trip would lose data). The gate is the exception: it is a
 * CONTROL, and a misspelled key inside a control that survives validation is how
 * "the stage looked gated and wasn't" ships. These tests pin that asymmetry.
 */

import { describe, it, expect } from "vitest";
import { playbookStageSchema } from "./playbook-stage.js";

const base = { key: "review", name: "Review", category: "started" as const };

describe("playbookStageSchema — gate", () => {
  it("accepts a stage with no gate (every stage stored before gates existed)", () => {
    const parsed = playbookStageSchema.parse(base);
    expect(parsed.gate).toBeUndefined();
  });

  it("accepts a bare human gate", () => {
    const parsed = playbookStageSchema.parse({
      ...base,
      gate: { kind: "human" },
    });
    expect(parsed.gate).toEqual({ kind: "human" });
  });

  it("accepts a registered proposalType", () => {
    expect(
      playbookStageSchema.safeParse({
        ...base,
        gate: { kind: "human", proposalType: "playbook.stage_gate" },
      }).success
    ).toBe(true);
  });

  it("rejects a proposalType with no executor behind it", () => {
    // Not a taste call: an unregistered type falls to the `*​/*` catch-all on
    // approve, which flips the row green without resuming the paused session.
    expect(
      playbookStageSchema.safeParse({
        ...base,
        gate: { kind: "human", proposalType: "playbook.made_up" },
      }).success
    ).toBe(false);
  });

  it("rejects an unknown gate kind", () => {
    expect(
      playbookStageSchema.safeParse({ ...base, gate: { kind: "timer" } })
        .success
    ).toBe(false);
  });

  it("rejects a non-object gate", () => {
    expect(playbookStageSchema.safeParse({ ...base, gate: true }).success).toBe(
      false
    );
    expect(
      playbookStageSchema.safeParse({ ...base, gate: "human" }).success
    ).toBe(false);
  });

  it("rejects an unknown key INSIDE the gate — a typo must not pass silently", () => {
    expect(
      playbookStageSchema.safeParse({
        ...base,
        gate: { kind: "human", propsalType: "playbook.stage_gate" },
      }).success
    ).toBe(false);
  });

  it("still preserves unknown keys on the STAGE — the loose object is unchanged", () => {
    const parsed = playbookStageSchema.parse({ ...base, someFutureField: 7 });
    expect((parsed as Record<string, unknown>).someFutureField).toBe(7);
  });
});
