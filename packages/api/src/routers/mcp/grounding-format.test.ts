/**
 * MCP `instructions` grounding — formatting rules.
 *
 * Regression cover for a live dogfood failure (2026-07-24): grounding used to
 * emit workspace NAMES only and collapse to a bare count above 8, so a pod with
 * 15 workspaces told the model "15 workspaces (operational domains)" — no names,
 * no ids. A connected agent therefore could not aim a write at a workspace and
 * had to RETRY to land data in "CRM".
 *
 * The DB half of buildGrounding is not exercised here; `formatGrounding` is the
 * pure part and holds every rule that actually broke.
 */

import { describe, it, expect } from "vitest";
import { formatGrounding } from "./http-handler.js";

const ws = (id: string, name: string, n: number) => ({ id, name, n });

describe("formatGrounding", () => {
  it("emits the workspace ID next to each name (the model must be able to pass it)", () => {
    const out = formatGrounding("", [ws("ws-crm-uuid", "CRM", 412)]);
    expect(out).toContain("CRM (ws-crm-uuid, 412 entities)");
  });

  it("ranks busiest first so empty scaffolds never bury the live workspaces", () => {
    const out = formatGrounding("", [
      ws("a", "Empty", 0),
      ws("b", "CRM", 412),
      ws("c", "Builder", 30),
    ]);
    expect(out.indexOf("CRM")).toBeLessThan(out.indexOf("Builder"));
    expect(out.indexOf("Builder")).toBeLessThan(out.indexOf("Empty"));
  });

  it("still NAMES workspaces well past the old 8-workspace cliff", () => {
    // The exact shape of the real pod that exposed the bug: 15 workspaces.
    const many = Array.from({ length: 15 }, (_, i) =>
      ws(`id-${i}`, `WS${i}`, 15 - i)
    );
    const out = formatGrounding("", many);
    // Previously this produced "15 workspaces (operational domains)" and nothing else.
    expect(out).not.toMatch(/^\s*15 workspaces/);
    expect(out).toContain("WS0 (id-0, 15 entities)");
    // Capped, but the overflow is disclosed rather than silently dropped.
    expect(out).toContain("…and 3 more");
  });

  it("flags empty workspaces only when at least one exists", () => {
    const withEmpty = formatGrounding("", [ws("a", "A", 0), ws("b", "B", 5)]);
    expect(withEmpty).toContain("empty scaffolds");
    const noEmpty = formatGrounding("", [ws("b", "B", 5)]);
    expect(noEmpty).not.toContain("empty scaffolds");
  });

  it("states the WRITE rule explicitly, not just the read rule", () => {
    const out = formatGrounding("", [ws("b", "CRM", 5)]);
    // The WRITE rule inverted in 609b4946: placement is DERIVED from installed
    // profile metadata, so the model passes kind/profile and omits workspaceId
    // unless it deliberately pins one domain. The old assertion ("always pass
    // the workspaceId") pinned the pre-inversion prose and went red at that
    // commit — unnoticed, because the full suite is rarely run. Assert the rule
    // that ships today, and keep asserting BOTH halves so a future one-sided
    // reword can't quietly drop the write guidance again.
    expect(out).toMatch(/For WRITES pass kind\/profile/);
    expect(out).toMatch(
      /omit workspaceId unless you deliberately pin one domain/
    );
    expect(out).toMatch(/For READS omit workspaceId/);
  });

  it("keeps the projects preamble, but never re-teaches the lens concept", () => {
    const out = formatGrounding("Projects (companies/initiatives): Acme. ", [
      ws("b", "CRM", 5),
    ]);
    expect(out.startsWith("Projects (companies/initiatives): Acme. ")).toBe(
      true
    );
    expect(out).not.toContain("Projects organize; workspaces hold the data.");
  });

  it("fits a byte budget by dropping WHOLE workspace entries, busiest kept, overflow disclosed", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      ws(
        `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        `W${i}`,
        100 - i
      )
    );
    const unbounded = formatGrounding("", many);
    const budget = Math.floor(Buffer.byteLength(unbounded) / 2);
    const out = formatGrounding("", many, budget);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(budget);
    // Non-vacuity: the budget actually forced a cut.
    expect(Buffer.byteLength(unbounded)).toBeGreaterThan(budget);
    expect(out).toContain(
      "W0 (00000000-0000-4000-8000-000000000000, 100 entities)"
    );
    // Every id that appears is whole — never cut mid-way.
    const ids = out.match(/00000000-0000-4000-8000-\d{0,12}/g) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.length === 36)).toBe(true);
    expect(out).toMatch(/…and \d+ more/);
    // The write rule survives the cut — it is what the model applies to the ids.
    expect(out).toMatch(/For WRITES pass kind\/profile/);
  });

  it("returns empty (dropped, not truncated) when not even the rules fit", () => {
    expect(formatGrounding("", [ws("b", "CRM", 5)], 40)).toBe("");
  });
});
