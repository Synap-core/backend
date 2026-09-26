/**
 * TRIPWIRE — a slot cannot be BORN carrying a receipt it never earned.
 *
 * THE BUG THIS EXISTS FOR. The write-authority floor
 * (`expected-output-write-authority.test.ts`) was built on the UPDATE path and
 * is enforced by `mergeExpectedOutputs`, which strips every server-stamped
 * field off an incoming item. `startFocusSession` did not go through that
 * merge — there is no stored array to merge against at create — and ran the
 * caller's slots through `reconcileOwedSince` ALONE. That reconciler touches
 * `owedSince` and nothing else.
 *
 * So the door the floor closed on update stood open on create:
 *   - `attestedBy` / `attestedAt` — a forged confirmation receipt, saying a
 *     human signed off work no human saw. `attestExpectedOutput` is supposed to
 *     be the only writer.
 *   - `retiredAt` — `owedSlotWhere()` floors on `retiredAt IS NULL`, so a slot
 *     declared with one is invisible to the owed board from birth.
 *   - `status: "done"` — the very shape the sibling tripwire's header opens with,
 *     arriving one door to the left.
 *
 * WHAT MAKES THIS A GUARD AND NOT A TEST.
 *   - The field set is DERIVED from `SERVER_STAMPED_OUTPUT_FIELDS`, the same
 *     constant the production strip iterates and which a compile-time floor
 *     (`_ServerStampedCoversEveryField`) already ties to `keyof ExpectedOutput`.
 *     A newly stamped field joins this scan BY EXISTING.
 *   - Every assertion is BEHAVIOURAL — the forged value goes through the real
 *     `sanitizeDeclaredOutputs` and the outcome is read off the result.
 *   - Non-vacuity: the derived set is floored, and a named sample is asserted
 *     present, so a derivation that silently yields nothing cannot read green.
 *
 * WHAT IT DOES NOT COVER, measured: this exercises the shared rule, not the
 * `db.insert` in `create-session.ts`. The seam is `sanitizeDeclaredOutputs`
 * being the value that reaches `.values({ expectedOutputs })` — the last test
 * below reads the create door's source for exactly that call, which catches the
 * door reverting to the bare reconciler but not a future THIRD create path.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sanitizeDeclaredOutputs,
  SERVER_STAMPED_OUTPUT_FIELDS,
} from "../services/focus-sessions/update-session.js";

/** A forged value for each stamped field, typed loosely on purpose. */
const FORGED: Record<string, unknown> = {
  status: "done",
  claimedDone: true,
  satisfiedByProposalId: "prop-forged",
  delegatedTo: "someone-else",
  delegatedAt: "2020-01-01T00:00:00.000Z",
  returnedReason: "forged",
  returnedAt: "2020-01-01T00:00:00.000Z",
  owedSince: "1999-01-01T00:00:00.000Z",
  attestedBy: "Antoine",
  attestedAt: "2020-01-01T00:00:00.000Z",
  retiredAt: "2020-01-01T00:00:00.000Z",
  retiredReason: "session_cancelled",
  criterionKey: "forged-key",
  answer: {
    text: "forged",
    messageId: null,
    answeredBy: "Antoine",
    answeredAt: "2020-01-01T00:00:00.000Z",
  },
};

describe("a declared slot carries no receipt it did not earn", () => {
  it("the derivation is not vacuous, and covers the fields the hole was about", () => {
    expect(SERVER_STAMPED_OUTPUT_FIELDS.length).toBeGreaterThanOrEqual(10);
    // Named samples: if the constant is ever narrowed past these, the scan is
    // no longer looking at the fields this tripwire was written for.
    expect(SERVER_STAMPED_OUTPUT_FIELDS).toContain("attestedBy");
    expect(SERVER_STAMPED_OUTPUT_FIELDS).toContain("retiredAt");
    expect(SERVER_STAMPED_OUTPUT_FIELDS).toContain("status");
    // Every stamped field must have a forged sample, or the loop below would
    // silently skip it — the "scan stopped looking" failure mode.
    for (const field of SERVER_STAMPED_OUTPUT_FIELDS) {
      expect(FORGED).toHaveProperty(field);
    }
  });

  it.each(SERVER_STAMPED_OUTPUT_FIELDS.filter((f) => f !== "owedSince"))(
    "an agent-owned slot declaring `%s` has it dropped",
    (field) => {
      const [out] = sanitizeDeclaredOutputs([
        { kind: "doc", label: "Spec", [field]: FORGED[field] } as never,
      ]);
      expect(out).not.toHaveProperty(field);
    }
  );

  it("`owedSince` is the server's observation, never the caller's claim", () => {
    // Not in the loop above because this is the ONE field the server re-adds:
    // the caller's value must not survive, and a fresh stamp must replace it.
    const now = new Date("2026-09-09T12:00:00.000Z");
    const [out] = sanitizeDeclaredOutputs(
      [
        {
          kind: "doc",
          label: "Spec",
          owner: "human",
          owedSince: FORGED.owedSince,
        } as never,
      ],
      now
    );
    expect(out.owedSince).toBe(now.toISOString());
    expect(out.owedSince).not.toBe(FORGED.owedSince);
  });

  it("an agent-owned slot gets no `owedSince` at all", () => {
    const [out] = sanitizeDeclaredOutputs([
      { kind: "doc", label: "Spec", owedSince: FORGED.owedSince } as never,
    ]);
    expect(out).not.toHaveProperty("owedSince");
  });

  it("what the caller MAY author survives untouched", () => {
    // The mirror assertion. A strip that removed everything would pass every
    // test above and destroy the feature.
    const [out] = sanitizeDeclaredOutputs([
      {
        kind: "doc",
        label: "Spec",
        icon: "file",
        owner: "human",
        blockedReason: "needs_decision",
        why: "which vendor",
      } as never,
    ]);
    expect(out).toMatchObject({
      kind: "doc",
      label: "Spec",
      icon: "file",
      owner: "human",
      blockedReason: "needs_decision",
      why: "which vendor",
    });
  });

  it("EVERY create door routes its slots through this rule", () => {
    /**
     * The SEAM — and it now names all of them, because the first version of
     * this test scanned ONE file for ONE call and was fully satisfied by the
     * branch that was already fixed.
     *
     * `startFocusSession` has TWO exits. The direct insert was floored; the
     * PROPOSED exit was not — and a proposal is precisely what an AI caller
     * gets, so the threat this file is named for still landed, one approval
     * later, through the door the threat actually uses. Two independent review
     * passes found it; this assertion is what would have.
     */
    const doors: Array<[string, string, RegExp[]]> = [
      [
        "create-session.ts (direct insert + proposed payload)",
        "../services/focus-sessions/create-session.ts",
        [
          /expectedOutputs:\s*sanitizeDeclaredOutputs\(expectedOutputs\)/,
          /expectedOutputs:\s*sanitizeDeclaredOutputs\(expectedOutputs\)\s*\}/,
        ],
      ],
      [
        "the approval executor (the write an AI caller reaches)",
        "../routers/proposals/executors/focus-session.ts",
        [/expectedOutputs:\s*sanitizeDeclaredOutputs\(/],
      ],
    ];

    for (const [label, rel, patterns] of doors) {
      const src = readFileSync(join(__dirname, rel), "utf8");
      for (const pattern of patterns) {
        expect(pattern.test(src), `${label} must sanitize: ${pattern}`).toBe(
          true
        );
      }
    }
  });

  it("no create door writes expectedOutputs RAW", () => {
    /**
     * The mirror of the test above, and the half that catches a THIRD door.
     * Scanning for the presence of a call cannot see an insert that never had
     * one; this scans for the shape of a raw write instead.
     */
    for (const rel of [
      "../services/focus-sessions/create-session.ts",
      "../routers/proposals/executors/focus-session.ts",
    ]) {
      const src = readFileSync(join(__dirname, rel), "utf8");
      // A cast straight into the column, with no floor in the expression.
      expect(
        /expectedOutputs:\s*\(innerData\.expectedOutputs as[^)]*\)\s*\?\?\s*\[\]/.test(
          src
        ),
        `${rel} inserts the caller's array verbatim`
      ).toBe(false);
      expect(
        /expectedOutputs:\s*expectedOutputs\s*[,}]/.test(src),
        `${rel} passes the caller's array through unsanitized`
      ).toBe(false);
    }
  });
});
