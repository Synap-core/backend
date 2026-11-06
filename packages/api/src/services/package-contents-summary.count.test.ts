/**
 * `packageObjectCount`: what makes a package a template (one object) or a
 * pack (several). MCP servers and `waitsOn` belong to a capability and are
 * not counted twice; a stored summary with missing lists counts what it has.
 */
import { describe, expect, it } from "vitest";
import { packageObjectCount } from "./package-contents-summary.js";

describe("packageObjectCount", () => {
  it("counts each object list once", () => {
    expect(
      packageObjectCount({
        spaces: [{ role: "self" }],
        kinds: [{ slug: "post" }, { slug: "idea" }],
        views: [{ name: "Calendar" }],
        playbooks: [],
        automations: [{ name: "Weekly" }],
        capabilities: [{ key: "publish" }],
        mcpServers: [{ slug: "x" }],
        waitsOn: [{ key: "publish" }],
      })
    ).toBe(6);
  });

  it("reads a partial or missing summary as what it holds", () => {
    expect(packageObjectCount({ playbooks: [{ name: "One" }] })).toBe(1);
    expect(packageObjectCount(undefined)).toBe(0);
    expect(packageObjectCount({ kinds: "not a list" })).toBe(0);
  });
});
