/**
 * A view payload must be REFUSED at propose time, not at approve time.
 *
 * The defect: `views.create`'s three payload checks (scopeProfileIds, canvas
 * content, config schema) sat BELOW `checkPermissionOrPropose`, which RETURNS
 * on the propose branch. For an agent they therefore never ran — the proposal
 * was filed, the caller was told "proposed", and the payload was first
 * validated when a HUMAN pressed approve, where it threw and the row went
 * APPROVAL_FAILED. Three live proposals died this way on 2026-09-22
 * (73af3b54, a75b63d1: "Invalid view config"; b919206e: "scopeProfileIds is
 * required for structured views").
 *
 * WHAT IS ASSERTED: source order — every payload check appears BEFORE the
 * `checkPermissionOrPropose(gateOpts)` call site, and nothing validating is
 * left below it. Order is the defect; a behavioural test would need a live
 * governance decision to reach the propose branch at all.
 *
 * WHAT THIS CANNOT SEE: whether a FOURTH check gets added below the gate in
 * some other procedure. Scoped to `views.create` by construction — it slices
 * that procedure only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describeViewConfigErrors } from "./views.js";
import { missingFieldsFromMessage } from "./proposals/failure-classification.js";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "views.ts"),
  "utf8"
);

/** The `create` procedure's body, up to the next top-level procedure. */
const createBody = (() => {
  const start = src.indexOf("  create: ");
  expect(start, "views.create not found").toBeGreaterThan(-1);
  const gate = src.indexOf("checkPermissionOrPropose(gateOpts)", start);
  expect(gate, "propose gate not found in views.create").toBeGreaterThan(-1);
  // Everything from the procedure start to ~2k chars past the gate covers the
  // hoisted block and the branch that returns "proposed".
  return { start, gate, text: src.slice(start, gate + 4000) };
})();

describe("views.create validates the payload BEFORE the propose gate", () => {
  const checks: Array<[string, string]> = [
    [
      "scopeProfileIds",
      'message: "scopeProfileIds is required for structured views"',
    ],
    ["canvas content", 'message: "Invalid view content structure"'],
    ["config schema", "describeViewConfigErrors(validation.errors)"],
  ];

  it.each(checks)("the %s check sits above the gate", (_label, needle) => {
    const at = src.indexOf(needle, createBody.start);
    expect(at, `${needle} not found`).toBeGreaterThan(-1);
    expect(at).toBeLessThan(createBody.gate);
  });

  it("no payload check is left BELOW the gate in create", () => {
    // From the gate to the end of the procedure's validation region.
    const below = src.slice(createBody.gate, createBody.gate + 4000);
    expect(below).not.toContain(
      'message: "scopeProfileIds is required for structured views"'
    );
    expect(below).not.toContain('message: "Invalid view content structure"');
  });
});

describe("describeViewConfigErrors names the failing fields", () => {
  it("phrases a missing key so the missing-field classifier can parse it", () => {
    // Shape of a ZodError issue for an absent required key.
    const out = describeViewConfigErrors({
      issues: [
        {
          path: ["blocks"],
          code: "invalid_type",
          received: "undefined",
          message: "Required",
        },
      ],
    });
    expect(out).toContain('"blocks" is required');
    expect(out).not.toBe("Invalid view config");
    // The payoff: the in-house phrasing is what the failure classifier parses,
    // so this message yields `missingFields` with no extra plumbing.
    expect(missingFieldsFromMessage(out)).toEqual(["blocks"]);
  });

  it("names a non-missing issue with its path", () => {
    const out = describeViewConfigErrors({
      issues: [
        { path: ["groupBy"], code: "invalid_type", message: "Expected string" },
      ],
    });
    expect(out).toContain("groupBy: Expected string");
  });

  it("falls back to the constant when there are no issues", () => {
    expect(describeViewConfigErrors(undefined)).toBe("Invalid view config");
    expect(describeViewConfigErrors({ issues: [] })).toBe(
      "Invalid view config"
    );
  });
});
