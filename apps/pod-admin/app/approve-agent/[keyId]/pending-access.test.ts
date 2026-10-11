import { describe, expect, it } from "vitest";
import { KEY_ACCESS_UNGRANTED_SENTENCE } from "@synap-core/types/grants";
import {
  approveLabel,
  hasAccessFacts,
  viewPendingAccess,
} from "./pending-access";

const WS = "2aaaaaaa-0000-4000-8000-000000000001";
const base = {
  scopes: ["hub-protocol.read", "mcp.write"],
  expiresAt: "2099-01-12T00:00:00.000Z",
};

describe("viewPendingAccess", () => {
  // P5 — deny by default. Rules out the legacy reading of a never-granted
  // key as full access (and an "Approve full access" button over nothing).
  it("an ungranted key touches nothing, with its real expiry", () => {
    const v = viewPendingAccess({ ...base, grants: null });
    expect(v.full).toBe(false);
    expect(v.fullLabel).toBeNull();
    expect(v.lines).toEqual([KEY_ACCESS_UNGRANTED_SENTENCE]);
    expect(v.when).toBe("Until 12 Jan 2099");
    expect(approveLabel(v.full)).toBe("Approve");
  });

  it("one sentence per grant scope — every scope, and a bare subject names its four actions", () => {
    const v = viewPendingAccess({
      ...base,
      grants: [
        { permissions: ["entity.note.create"], workspaceIds: [WS] },
        { permissions: ["proposal"] },
      ],
    });
    expect(v.full).toBe(false);
    expect(v.lines).toHaveLength(2);
    expect(v.lines[0]).toContain("1 ");
    expect(v.lines[1]).toContain("Read, create, update and delete");
    expect(v.lines[1]).not.toContain("approving");
    expect(approveLabel(v.full)).toBe("Approve");
  });

  it("an un-narrowed * grant is full access; a narrowed one is not", () => {
    expect(
      viewPendingAccess({ ...base, grants: [{ permissions: ["*"] }] }).full
    ).toBe(true);
    expect(
      viewPendingAccess({
        ...base,
        grants: [{ permissions: ["*"], workspaceIds: [WS] }],
      }).full
    ).toBe(false);
  });

  it("a past expiry reads expired; scopes are words, never raw tokens", () => {
    const v = viewPendingAccess({
      ...base,
      expiresAt: "2001-01-01T00:00:00.000Z",
      grants: null,
    });
    expect(v.expired).toBe(true);
    expect(v.scopeLabels).not.toContain("hub-protocol.read");
  });

  it("a lookup row without access facts (older pod) is not approvable", () => {
    expect(hasAccessFacts({ scopes: [], grants: null, expiresAt: null })).toBe(
      true
    );
    expect(hasAccessFacts({})).toBe(false);
  });
});
