/**
 * `readCriteria` / `collectPlaybookCriteria` — the tolerant readers of a
 * criteria bag. Malformed entries are DROPPED, never thrown on; keys stay unique.
 */

import { describe, it, expect } from "vitest";
import {
  collectPlaybookCriteria,
  MAX_SESSION_CRITERIA,
  readCriteria,
  resolveStageGate,
} from "./index.js";

const ok = {
  key: "tsc",
  statement: "Typecheck passes",
  check: { kind: "evidence", evidenceKey: "tsc" },
};

describe("readCriteria", () => {
  it("a non-array reads as no criteria", () => {
    for (const bad of [null, undefined, {}, "x", 3])
      expect(readCriteria(bad)).toEqual([]);
  });

  it("drops malformed entries instead of throwing", () => {
    const out = readCriteria([
      ok,
      null,
      "string",
      { statement: "no key", check: { kind: "judge" } },
      { key: "nostmt", check: { kind: "judge" } },
      { key: "badkind", statement: "x", check: { kind: "vibes" } },
      { key: "nocheck", statement: "x" },
    ]);
    expect(out.map((c) => c.key)).toEqual(["tsc"]);
  });

  it("keeps the first of a duplicate key", () => {
    const out = readCriteria([ok, { ...ok, statement: "second" }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.statement).toBe("Typecheck passes");
  });

  it("truncates at MAX_SESSION_CRITERIA", () => {
    const many = Array.from({ length: MAX_SESSION_CRITERIA + 3 }, (_, i) => ({
      ...ok,
      key: `k${i}`,
    }));
    expect(readCriteria(many)).toHaveLength(MAX_SESSION_CRITERIA);
  });

  it("keeps required:false and drops non-string optional fields", () => {
    const [c] = readCriteria([
      { ...ok, required: false, check: { kind: "judge", hint: 7 } },
    ]);
    expect(c).toEqual({
      key: "tsc",
      statement: "Typecheck passes",
      required: false,
      check: { kind: "judge" },
    });
  });
});

describe("collectPlaybookCriteria", () => {
  it("playbook-level first, then each stage's with stageKey stamped", () => {
    const out = collectPlaybookCriteria({
      criteria: [ok],
      stages: [
        {
          key: "build",
          criteria: [
            { key: "lint", statement: "Lint clean", check: { kind: "judge" } },
          ],
        },
        { key: "ship", criteria: [{ ...ok, statement: "dup key dropped" }] },
        { key: "empty" },
      ],
    });
    expect(out.map((c) => [c.key, c.stageKey])).toEqual([
      ["tsc", undefined],
      ["lint", "build"],
    ]);
  });

  it("an empty playbook has no criteria", () => {
    expect(collectPlaybookCriteria({})).toEqual([]);
  });
});

describe("resolveStageGate — check", () => {
  it("reads a check gate (and never gives it a proposal type)", () => {
    expect(
      resolveStageGate({
        gate: { kind: "check", proposalType: "playbook.stage_gate" },
      })
    ).toEqual({ kind: "check" });
  });
});
