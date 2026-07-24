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
    const out = formatGrounding("", [ws("ws-crm-uuid", "CRM", 412)], false);
    expect(out).toContain("CRM (ws-crm-uuid, 412 entities)");
  });

  it("ranks busiest first so empty scaffolds never bury the live workspaces", () => {
    const out = formatGrounding(
      "",
      [ws("a", "Empty", 0), ws("b", "CRM", 412), ws("c", "Builder", 30)],
      false
    );
    expect(out.indexOf("CRM")).toBeLessThan(out.indexOf("Builder"));
    expect(out.indexOf("Builder")).toBeLessThan(out.indexOf("Empty"));
  });

  it("still NAMES workspaces well past the old 8-workspace cliff", () => {
    // The exact shape of the real pod that exposed the bug: 15 workspaces.
    const many = Array.from({ length: 15 }, (_, i) =>
      ws(`id-${i}`, `WS${i}`, 15 - i)
    );
    const out = formatGrounding("", many, false);
    // Previously this produced "15 workspaces (operational domains)" and nothing else.
    expect(out).not.toMatch(/^\s*15 workspaces/);
    expect(out).toContain("WS0 (id-0, 15 entities)");
    // Capped, but the overflow is disclosed rather than silently dropped.
    expect(out).toContain("…and 3 more");
  });

  it("flags empty workspaces only when at least one exists", () => {
    const withEmpty = formatGrounding(
      "",
      [ws("a", "A", 0), ws("b", "B", 5)],
      false
    );
    expect(withEmpty).toContain("empty scaffolds");
    const noEmpty = formatGrounding("", [ws("b", "B", 5)], false);
    expect(noEmpty).not.toContain("empty scaffolds");
  });

  it("states the WRITE rule explicitly, not just the read rule", () => {
    const out = formatGrounding("", [ws("b", "CRM", 5)], false);
    expect(out).toMatch(/For WRITES always pass the workspaceId/);
    expect(out).toMatch(/For READS omit workspaceId/);
  });

  it("keeps the projects preamble and the compose hint when projects exist", () => {
    const out = formatGrounding(
      "Projects (companies/initiatives): Acme. ",
      [ws("b", "CRM", 5)],
      true
    );
    expect(out.startsWith("Projects (companies/initiatives): Acme. ")).toBe(
      true
    );
    expect(out).toContain("Projects organize; workspaces hold the data.");
  });
});
