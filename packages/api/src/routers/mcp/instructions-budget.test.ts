/**
 * TRIPWIRE — the MCP `instructions` field (reflexes + grounding) fits
 * `INSTRUCTIONS_BUDGET_BYTES`. The reflexes are the real reflexes.md; the
 * grounding is the real `formatGrounding` on a deliberately hostile pod, and
 * the instructions are read back off a real `createMCPServer`, the object the
 * `initialize` response is built from. The DB half of `buildGrounding` is
 * driven on PGlite in `services/discover/usage-aggregate.pglite.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";

// index.ts registers handlers whose modules import the database lazily; the
// composition itself never touches it. Keep module init DB-free.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: {} };
});

import {
  composeInstructions,
  createMCPServer,
  groundingBudgetBytes,
  INSTRUCTIONS_BUDGET_BYTES,
  SYNAP_INSTRUCTIONS,
} from "./index.js";
import { formatGrounding } from "./http-handler.js";

const bytes = (s: string) => Buffer.byteLength(s);

/** The field the SDK returns from `initialize` (`Server#_instructions`). */
const liveInstructions = (grounding?: string): string => {
  const server = createMCPServer(undefined, "u1", grounding) as unknown as {
    _instructions?: string;
  };
  if (typeof server._instructions !== "string") {
    throw new Error(
      "SDK Server no longer exposes _instructions — update this seam"
    );
  }
  return server._instructions;
};

const worstCasePod = Array.from({ length: 40 }, (_, i) => ({
  id: `${String(i).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd`,
  name: `Operations and Revenue Workspace Number ${i} — Émeraude`,
  n: 10_000 - i,
}));
const projPart = `Projects (companies/initiatives): ${Array.from(
  { length: 6 },
  (_, i) => `Initiative with a long name ${i}`
).join(", ")}. `;

describe("MCP instructions budget", () => {
  it("the static reflexes are the real reflexes.md, not the fallback (non-vacuity)", () => {
    // The fallback is one sentence; the real file carries the numbered reflexes
    // and ends on the concepts-glossary pointer (W1: it replaced lenses).
    expect(SYNAP_INSTRUCTIONS).toMatch(/1\. \*\*Recall first/);
    expect(SYNAP_INSTRUCTIONS).toContain("system/synap/concepts");
    expect(bytes(SYNAP_INSTRUCTIONS)).toBeGreaterThan(600);
  });

  it(`reflexes alone fit in ${INSTRUCTIONS_BUDGET_BYTES} bytes with room left for grounding`, () => {
    expect(bytes(SYNAP_INSTRUCTIONS)).toBeLessThanOrEqual(
      INSTRUCTIONS_BUDGET_BYTES
    );
    // A reflexes file that eats the whole budget would starve grounding to
    // nothing while this test stayed green — keep a real grounding window.
    expect(groundingBudgetBytes()).toBeGreaterThanOrEqual(500);
  });

  it("the LIVE server's instructions (what initialize returns) fit, with worst-case grounding", () => {
    const unbounded = formatGrounding(projPart, worstCasePod);
    // Non-vacuity: this pod genuinely overflows, so the fitter is exercised.
    expect(bytes(unbounded)).toBeGreaterThan(groundingBudgetBytes());

    const fitted = formatGrounding(
      projPart,
      worstCasePod,
      groundingBudgetBytes()
    );
    const live = liveInstructions(fitted || undefined);
    expect(bytes(live)).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET_BYTES);
    // …and the grounding actually made it in (a fitter that always returns ""
    // would pass the size check).
    expect(live).toContain("Domains, busiest first:");
    expect(live).toContain(worstCasePod[0]!.id);
  });

  it("the LIVE server drops a grounding handed to it over budget", () => {
    expect(liveInstructions("x".repeat(INSTRUCTIONS_BUDGET_BYTES))).toBe(
      SYNAP_INSTRUCTIONS
    );
  });

  it("most important first: the reflexes lead, grounding follows", () => {
    const composed = composeInstructions(
      "Domains, busiest first: X (id, 1 entities)."
    );
    expect(composed.indexOf("Recall first")).toBeLessThan(
      composed.indexOf("Domains, busiest first")
    );
  });

  it("an over-budget grounding is DROPPED, never truncated into the field", () => {
    const huge = "x".repeat(INSTRUCTIONS_BUDGET_BYTES);
    expect(composeInstructions(huge)).toBe(SYNAP_INSTRUCTIONS);
  });
});
