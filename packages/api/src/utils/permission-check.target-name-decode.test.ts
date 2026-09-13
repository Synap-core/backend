/**
 * BACKSTOP: a proposal's display name never carries an XML escape.
 *
 * Doors decode titles at their own seam; `resolveProposalTargetName` (the name
 * every proposal summary is built from) decodes the inline fields again, so a
 * door that forgot still cannot put `&amp;` in front of a reviewer.
 */

import { describe, expect, it } from "vitest";
import { resolveProposalTargetName } from "./permission-check.js";

describe("resolveProposalTargetName decodes HTML entities", () => {
  it("decodes an inline title", async () => {
    await expect(
      resolveProposalTargetName("project", "not-a-uuid", { name: "A &amp; B" })
    ).resolves.toBe("A & B");
  });

  it("decodes a session goal used as the name", async () => {
    await expect(
      resolveProposalTargetName("focus_session", "not-a-uuid", {
        goal: "Ship R&amp;D",
      })
    ).resolves.toBe("Ship R&D");
  });
});
