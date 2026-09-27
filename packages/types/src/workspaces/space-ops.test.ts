/**
 * FX-F3: the ONE space-op rule. Fixture rows are chosen where the rules the
 * three old copies used would DISAGREE (a settings update that carries a name,
 * an entity update without a destination, a grant with no other signal).
 */
import { describe, expect, it } from "vitest";
import {
  SPACE_MANAGE_ROLES,
  SPACE_WRITE_ROLES,
  classifySpaceOperation,
  isSpaceManageRole,
  isSpaceWriteRole,
} from "./index.js";

describe("classifySpaceOperation", () => {
  const rows: Array<[string, string, Record<string, unknown>, string | null]> =
    [
      ["workspace", "archive", { id: "w", name: "Radar" }, "archive"],
      ["workspace", "restore", { id: "w", name: "Radar" }, "restore"],
      [
        "profile",
        "grant_access",
        { profileId: "p", targetWorkspaceId: "w" },
        "share",
      ],
      ["entity", "update", { id: "e", toWorkspaceId: "w" }, "move"],
      ["entity", "update", { id: "e", title: "x" }, null],
      ["workspace", "update", { id: "w", name: "Radar 2" }, "rename"],
      [
        "workspace",
        "update",
        { id: "w", name: "Radar", settings: { a: 1 } },
        null,
      ],
      ["workspace", "update", { id: "w", name: "  " }, null],
      ["workspace", "delete", { id: "w" }, null],
      ["entity", "archive", { id: "e" }, null],
    ];
  for (const [t, c, d, want] of rows) {
    it(`${t} × ${c} ${JSON.stringify(d)} → ${want}`, () => {
      expect(classifySpaceOperation(t, c, d)).toBe(want);
    });
  }
});

describe("space role sets", () => {
  it("manage ⊂ write; editor writes but does not manage; viewer does neither", () => {
    for (const r of SPACE_MANAGE_ROLES) expect(SPACE_WRITE_ROLES).toContain(r);
    expect(isSpaceWriteRole("editor")).toBe(true);
    expect(isSpaceManageRole("editor")).toBe(false);
    expect(isSpaceWriteRole("viewer")).toBe(false);
    expect(isSpaceManageRole(undefined)).toBe(false);
  });
});
