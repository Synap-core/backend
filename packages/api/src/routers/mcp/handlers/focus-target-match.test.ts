/**
 * Pure unit tests for the focus-tool target resolver — the two guards
 * `synap_set_project_focus` depends on, provable WITHOUT a database (the
 * DB-backed MCP suites cannot run in every environment, so a DB-only test
 * would prove nothing here).
 *
 *   Guard 1 — ambiguity is REPORTED, never silently picked.
 *   Guard 2 — the visible-row set IS the existence + visibility check: an id
 *             that is not in it must NOT resolve.
 */
import { describe, it, expect } from "vitest";
import { matchFocusTarget, isClearFocusArg } from "./focus-target-match.js";

const A = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Apollo" };
const B = { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Apollo" };
const C = {
  id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  name: "Beta migration",
};

describe("matchFocusTarget — guard 2: existence + visibility", () => {
  it("an id that is NOT among the visible rows does not resolve", () => {
    // The whole point: `relations.target_entity_id` has no FK to `projects`, so
    // trusting a bare id writes a ghost edge the project lens never resolves.
    const r = matchFocusTarget("dddddddd-dddd-dddd-dddd-dddddddddddd", [A, C]);
    expect(r.kind).toBe("not_found");
  });

  it("an id that IS among the visible rows resolves to that row", () => {
    const r = matchFocusTarget(C.id, [A, C]);
    expect(r).toEqual({ kind: "resolved", target: C });
  });

  it("an empty visible set can never resolve anything", () => {
    expect(matchFocusTarget(A.id, []).kind).toBe("not_found");
    expect(matchFocusTarget("Apollo", []).kind).toBe("not_found");
  });
});

describe("matchFocusTarget — guard 1: never a silent pick", () => {
  it("two projects with the SAME name return candidates, not a pick", () => {
    const r = matchFocusTarget("Apollo", [A, B, C]);
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") throw new Error("unreachable");
    expect(r.matchedBy).toBe("name");
    expect(r.candidates.map((c) => c.id).sort()).toEqual([A.id, B.id].sort());
  });

  it("an ambiguous SUBSTRING returns candidates too", () => {
    const r = matchFocusTarget("a", [A, C]);
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") throw new Error("unreachable");
    expect(r.matchedBy).toBe("substring");
    expect(r.candidates).toHaveLength(2);
  });

  it("a unique exact name resolves (case-insensitively)", () => {
    const r = matchFocusTarget("apollo", [A, C]);
    expect(r).toEqual({ kind: "resolved", target: A });
  });

  it("a unique substring resolves", () => {
    const r = matchFocusTarget("migra", [A, C]);
    expect(r).toEqual({ kind: "resolved", target: C });
  });

  it("an exact-name match wins over a wider substring match", () => {
    const exact = { id: "e1", name: "Beta" };
    const wider = { id: "e2", name: "Beta migration" };
    const r = matchFocusTarget("Beta", [exact, wider]);
    // Without the exact-name branch this would be an ambiguous substring.
    expect(r).toEqual({ kind: "resolved", target: exact });
  });

  it("an unknown name does not resolve", () => {
    expect(matchFocusTarget("Nowhere", [A, C]).kind).toBe("not_found");
  });
});

describe("isClearFocusArg", () => {
  it.each(["", "   ", "none", "None", "clear", "CLEAR", "null"])(
    "%j means clear",
    (v) => {
      expect(isClearFocusArg(v)).toBe(true);
    }
  );

  it("a real name is not a clear", () => {
    expect(isClearFocusArg("Apollo")).toBe(false);
  });

  it("a missing / non-string argument means clear (the tool's `project` is optional)", () => {
    expect(isClearFocusArg(undefined)).toBe(true);
    expect(isClearFocusArg(null)).toBe(true);
  });
});
