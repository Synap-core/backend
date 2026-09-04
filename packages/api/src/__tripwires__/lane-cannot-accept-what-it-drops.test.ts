/**
 * TRIPWIRE — a door may not ACCEPT a field the lane it routes to will DROP.
 *
 * ── The defect, found by dogfooding a green build ──────────────────────────
 * `synap_capture`'s structured `entities[]` lane declared `updateExisting` and
 * routed to `submitCaptureGraph`. That service rebuilds every op field-by-field
 * into a `CompositeProposalOperation`, a union with NO update arm — so the flag
 * was dropped, the entity was LINKED (its extracted properties discarded), and
 * the receipt reported `status: "applied"`.
 *
 * Verified live 2026-09-04: the target entity's `version` stayed 1 and no
 * property was written, for a call the agent had been told succeeded. EVERY
 * static gate was green — typecheck, unit tests, 573 tripwires. Only exercising
 * the deployed door found it.
 *
 * **A receipt that says `applied` for a write that dropped its payload is worse
 * than a refusal.** The rule: if the lane cannot honour a field, the door must
 * REFUSE it by name, never accept-and-discard.
 *
 * ── Why a source scan ──────────────────────────────────────────────────────
 * Nothing connects "this JSON-Schema property exists" to "the service this lane
 * calls reads it." Both sides typecheck perfectly while disagreeing. This scan
 * is the only mechanism that can see across that seam.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const API = join(__dirname, "..");

/**
 * Fields a lane's handler declares but its target service cannot honour.
 * Each entry pins a REAL severance that was found live — a new one belongs here
 * only with evidence, and the fix is a refusal in the handler, never a widening.
 */
const LANE_CONTRACTS = [
  {
    field: "updateExisting",
    handler: "routers/mcp/handlers/capture.ts",
    /** The service the structured entities[] lane materializes through. */
    target: "services/capture-agent/submit-capture-graph.ts",
    why: "CompositeProposalOperation has no update arm — it can create or link, never patch.",
  },
] as const;

describe("TRIPWIRE: a lane never accepts a field its target service drops", () => {
  it("scans a real, non-empty corpus", () => {
    expect(LANE_CONTRACTS.length).toBeGreaterThan(0);
    for (const c of LANE_CONTRACTS) {
      expect(
        readFileSync(join(API, c.handler), "utf8").length,
        `${c.handler} is empty or missing — this tripwire proves nothing`
      ).toBeGreaterThan(0);
    }
  });

  for (const c of LANE_CONTRACTS) {
    it(`${c.handler} refuses '${c.field}' while ${c.target.split("/").pop()} cannot honour it`, () => {
      const target = readFileSync(join(API, c.target), "utf8");
      const handler = readFileSync(join(API, c.handler), "utf8");

      const targetHonours = new RegExp(`\\b${c.field}\\b`).test(target);
      if (targetHonours) {
        // The service learned the field — the refusal is now the wrong answer.
        // This is a PASS-with-intent: remove the entry AND the handler guard.
        expect(
          true,
          `${c.target} now references '${c.field}'. If it genuinely honours it, delete this LANE_CONTRACTS entry and the handler's refusal — but verify END TO END on a live pod first: the original defect was a green build that silently discarded the write.`
        ).toBe(true);
        return;
      }

      // The service does NOT honour it ⇒ the handler must refuse it explicitly.
      // Look for a guard that both READS the field and returns a denial.
      const guarded =
        new RegExp(`${c.field}[\\s\\S]{0,400}?status:\\s*["']denied["']`).test(
          handler
        ) ||
        new RegExp(`status:\\s*["']denied["'][\\s\\S]{0,400}?${c.field}`).test(
          handler
        );

      expect(
        guarded,
        `${c.handler} declares/forwards '${c.field}' but ${c.target} cannot honour it (${c.why}). ` +
          "Accepting it means the write is silently dropped while the receipt says it succeeded — the exact defect this guards. " +
          "Refuse it by name in the handler, or teach the target service to honour it and update this entry."
      ).toBe(true);
    });
  }
});
