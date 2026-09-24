/**
 * `projects.colorSlot` (migration 0271) — the wire contract of the project's
 * colour, driven through the REAL `projects.update` input schema (reached via
 * `_def.inputs[0]`, never a rebuilt copy).
 *
 * The colour is a SLOT 1–12 in the identity palette, never a hex: the palette
 * has a light and a dark value per slot, so only a slot is right on both
 * themes. The DB carries a CHECK (1–12) too; this pins that the door refuses
 * first, with a validation error instead of a constraint violation.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { projectsRouter } from "./projects.js";

const PROJECT_ID = "00000000-0000-4000-8000-0000000000a1";

function updateSchema(): z.ZodTypeAny {
  const schema = (
    projectsRouter as unknown as {
      _def: {
        procedures: Record<string, { _def: { inputs: z.ZodTypeAny[] } }>;
      };
    }
  )._def.procedures.update?._def?.inputs?.[0];
  if (!schema || typeof (schema as { parse?: unknown }).parse !== "function") {
    throw new Error(
      "projects.update input schema not reachable via _def.inputs[0]"
    );
  }
  return schema;
}

const parse = (v: Record<string, unknown>) =>
  updateSchema().safeParse({ id: PROJECT_ID, ...v });

describe("projects.update — colorSlot", () => {
  it("accepts every slot of the 12-slot identity palette", () => {
    for (let slot = 1; slot <= 12; slot++) {
      const r = parse({ colorSlot: slot });
      expect(r.success, `slot ${slot}`).toBe(true);
      expect(r.success && (r.data as { colorSlot: number }).colorSlot).toBe(
        slot
      );
    }
  });

  it("refuses anything that is not a slot: 0, 13, a fraction, a hex", () => {
    for (const bad of [0, 13, 2.5, "#c28a4a", "5"]) {
      expect(parse({ colorSlot: bad }).success, String(bad)).toBe(false);
    }
  });

  it("null clears the choice; omitted leaves it untouched", () => {
    const cleared = parse({ colorSlot: null });
    expect(
      cleared.success && (cleared.data as { colorSlot: null }).colorSlot
    ).toBeNull();
    const omitted = parse({ name: "Synap" });
    expect(omitted.success && "colorSlot" in (omitted.data as object)).toBe(
      false
    );
  });
});
