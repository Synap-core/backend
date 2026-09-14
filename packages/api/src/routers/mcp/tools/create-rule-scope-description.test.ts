/**
 * `synap_create_rule` tells agents which WHEN events can carry a `projectId`
 * limit — derived from `PROJECT_SCOPE_EVENT_PREFIXES` (the api mirror of
 * `RULE_SCOPE_EVENT_PREFIXES.projectId`), never a hand-copied list, so a new
 * enforceable family reaches the description by existing.
 */

import { describe, it, expect } from "vitest";
import { tools } from "./index.js";
import { PROJECT_SCOPE_EVENT_PREFIXES } from "../../../services/rules/scope.js";

describe("synap_create_rule scope description", () => {
  it("names every project-enforceable event family and says other triggers are refused", async () => {
    const defs = await tools.list();
    const desc =
      defs.find((t) => t.name === "synap_create_rule")?.description ?? "";
    // Non-vacuity: the mirror is populated.
    expect(PROJECT_SCOPE_EVENT_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of PROJECT_SCOPE_EVENT_PREFIXES) {
      expect(desc).toContain(`${prefix}*`);
    }
    expect(desc).toMatch(/REFUSED[^.]*other trigger/);
  });
});
