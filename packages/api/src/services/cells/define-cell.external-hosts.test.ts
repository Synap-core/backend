/**
 * `defineCell` and the one field on a cell that is a SECURITY GRANT.
 *
 * `external_hosts` is the origin allowlist the browser composes into the
 * sandboxed frame's `connect-src` (`buildFrameCsp`). Three properties have to
 * hold, and each of them has a corresponding way to ship a silent defect:
 *
 *  1. It is PERSISTED on insert — otherwise the whole publish→install chain
 *     ends in a column nobody wrote and the cell installs contained.
 *  2. OMIT IS SILENCE — a re-push that says nothing about egress must leave a
 *     stored grant untouched, or a source-only republish silently revokes it.
 *     An explicit `[]` is a real revocation and must land.
 *  3. CHANGING it DEMOTES `trust_level` back to `generated`. That column is
 *     what lets a frame cell's mutations skip the propose gate
 *     (`resolveViewTrust`), so re-pointing an APPROVED cell at a new origin
 *     while keeping its trust is exactly the ungated edit `allowedHostsChanged`
 *     exists to close on the skills side.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = { externalHosts: string[] | null };

/** Row the pre-read returns, or `[]` for "no existing row". */
let existingRows: Row[] = [];
let insertedValues: Record<string, unknown> | undefined;
let updatedSet: Record<string, unknown> | undefined;
/** Rows the UPDATE branch claims to have touched (drives created vs updated). */
let updateReturns: unknown[] = [];

const getDb = vi.fn(async () => ({
  select: () => ({
    from: () => ({
      where: () => ({ limit: async () => existingRows }),
    }),
  }),
  insert: () => ({
    values: (v: Record<string, unknown>) => {
      insertedValues = v;
      return {
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
          updatedSet = set;
          return { returning: async () => [{ id: "w1" }] };
        },
        then: (res: (v: unknown) => unknown) => res(undefined),
      };
    },
  }),
  update: () => ({
    set: (v: Record<string, unknown>) => {
      updatedSet = v;
      return { where: () => ({ returning: async () => updateReturns }) };
    },
  }),
}));

// PARTIAL mock — only `getDb` is faked. A total replacement dies at COLLECTION
// time the moment anything in the import graph reaches for an export the mock
// forgot, and takes the whole file dark with it (see the
// `database-mock-total-ratchet` tripwire). The real `eq`/`and`/`isNull` and the
// real `widgetDefinitions` table are used, so the pre-read below is built
// against the actual column set.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb };
});
vi.mock("../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: vi.fn(),
}));

const { defineCell } = await import("./define-cell.js");

const BASE = {
  name: "Vendor Panel",
  rendererSource: "export default () => null;",
  typeKey: "cell:vendor:panel",
  userId: "u-1",
};

beforeEach(() => {
  existingRows = [];
  insertedValues = undefined;
  updatedSet = undefined;
  updateReturns = [];
});

describe("defineCell — externalHosts", () => {
  it("persists the declared host list on insert", async () => {
    await defineCell({
      ...BASE,
      externalHosts: ["https://api.vendor.com", "wss://live.vendor.com"],
    });
    expect(insertedValues?.externalHosts).toEqual([
      "https://api.vendor.com",
      "wss://live.vendor.com",
    ]);
  });

  it("writes NULL — a contained frame — when nothing is declared", async () => {
    await defineCell(BASE);
    expect(insertedValues?.externalHosts).toBeNull();
  });

  it("OMIT IS SILENCE: an upsert that says nothing leaves the stored grant alone", async () => {
    existingRows = [{ externalHosts: ["https://api.vendor.com"] }];
    updateReturns = [{ id: "w1" }];
    await defineCell(BASE);
    expect(
      updatedSet && "externalHosts" in updatedSet,
      "a source-only re-push must not reach the egress column at all"
    ).toBe(false);
  });

  it("an EXPLICIT [] revokes — cleared to null, not left alone", async () => {
    existingRows = [{ externalHosts: ["https://api.vendor.com"] }];
    updateReturns = [{ id: "w1" }];
    await defineCell({ ...BASE, externalHosts: [] });
    expect(updatedSet?.externalHosts).toBeNull();
  });

  it("DEMOTES trust when the host list changes on an existing row", async () => {
    existingRows = [{ externalHosts: ["https://api.vendor.com"] }];
    updateReturns = [{ id: "w1" }];
    await defineCell({ ...BASE, externalHosts: ["https://evil.tld"] });
    expect(
      updatedSet?.trustLevel,
      "re-pointing an approved cell at a new origin must cost the approval"
    ).toBe("generated");
  });

  it("DEMOTES on a WIDENING that keeps the original host", async () => {
    existingRows = [{ externalHosts: ["https://api.vendor.com"] }];
    updateReturns = [{ id: "w1" }];
    await defineCell({
      ...BASE,
      externalHosts: ["https://api.vendor.com", "https://evil.tld"],
    });
    expect(updatedSet?.trustLevel).toBe("generated");
  });

  it("DEMOTES when an existing row had NO grant and now declares one", async () => {
    existingRows = [{ externalHosts: null }];
    updateReturns = [{ id: "w1" }];
    await defineCell({ ...BASE, externalHosts: ["https://evil.tld"] });
    expect(updatedSet?.trustLevel).toBe("generated");
  });

  it("does NOT demote when the same list is re-sent — value, not presence", async () => {
    // The regression the presence test caused on the skills door: a reconcile
    // that replays an unchanged allowlist would un-approve the row every pass.
    existingRows = [{ externalHosts: ["https://api.vendor.com"] }];
    updateReturns = [{ id: "w1" }];
    await defineCell({
      ...BASE,
      externalHosts: ["https://api.vendor.com"],
    });
    expect(updatedSet?.trustLevel).toBeUndefined();
  });

  it("demotes on the WORKSPACE-SCOPED branch too (onConflictDoUpdate)", async () => {
    // Two upsert branches exist because PostgreSQL treats NULL workspace_ids as
    // distinct in a unique index. A rule applied to only one of them is a rule
    // that holds for half the rows.
    existingRows = [{ externalHosts: ["https://api.vendor.com"] }];
    await defineCell({
      ...BASE,
      workspaceId: "ws-1",
      externalHosts: ["https://evil.tld"],
    });
    expect(updatedSet?.trustLevel).toBe("generated");
    expect(updatedSet?.externalHosts).toEqual(["https://evil.tld"]);
  });

  it("does not demote a re-send that differs only by whitespace/duplicates", async () => {
    existingRows = [{ externalHosts: ["https://api.vendor.com"] }];
    updateReturns = [{ id: "w1" }];
    await defineCell({
      ...BASE,
      externalHosts: [" https://api.vendor.com ", "https://api.vendor.com", ""],
    });
    expect(updatedSet?.trustLevel).toBeUndefined();
    expect(updatedSet?.externalHosts).toEqual(["https://api.vendor.com"]);
  });
});
