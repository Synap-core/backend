/**
 * The two bounding helpers every key-minted key goes through
 * (`/setup/service`, `/setup/agent` Path 4, `/setup/external-user`).
 * Pure — the cases are the ones where a looser rule would WIDEN.
 */
import { describe, expect, it } from "vitest";
import {
  grantWithinLive,
  scopesWithinLive,
  type LiveGrantScope,
} from "./key-grant.js";

const WS = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const D1 = new Date("2030-01-01");
const D2 = new Date("2030-06-01");
const live = (
  permissions: string[],
  more: Partial<LiveGrantScope> = {}
): LiveGrantScope => ({
  permissions,
  workspaceIds: null,
  projectIds: null,
  entityIds: null,
  expiresAt: null,
  ...more,
});

describe("scopesWithinLive", () => {
  it("`*` wanted against a narrow live grant → the live grant, never `*`", () => {
    expect(
      scopesWithinLive(
        [{ permissions: ["*"] }],
        [live(["entity.note.read"])],
        null
      )
    ).toEqual([{ permissions: ["entity.note.read"], expiresAt: null }]);
  });

  it("keeps a wanted permission the live grant covers, narrows one it does not", () => {
    const [g] = scopesWithinLive(
      [{ permissions: ["entity.note.read", "entity.delete"] }],
      [live(["entity.read", "entity.note.delete"])],
      null
    );
    expect(g!.permissions.sort()).toEqual([
      "entity.note.delete",
      "entity.note.read",
    ]);
  });

  it("places intersect; disjoint places drop the grant", () => {
    expect(
      scopesWithinLive(
        [{ permissions: ["*"], workspaceIds: [WS] }],
        [live(["*"], { workspaceIds: [WS2] })],
        null
      )
    ).toEqual([]);
    expect(
      scopesWithinLive(
        [{ permissions: ["*"], workspaceIds: [WS] }],
        [live(["*"], { projectIds: [P] })],
        null
      )
    ).toEqual([
      {
        permissions: ["*"],
        workspaceIds: [WS],
        projectIds: [P],
        expiresAt: null,
      },
    ]);
  });

  it("ends at the earlier of the live grant's end and the key's", () => {
    expect(
      scopesWithinLive(
        [{ permissions: ["*"] }],
        [live(["*"], { expiresAt: D2 })],
        D1
      )[0]!.expiresAt
    ).toEqual(D1);
    expect(
      scopesWithinLive(
        [{ permissions: ["*"] }],
        [live(["*"], { expiresAt: D1 })],
        null
      )[0]!.expiresAt
    ).toEqual(D1);
  });
});

describe("grantWithinLive", () => {
  it("refuses a grant wider than every live one", () => {
    expect(
      grantWithinLive({ permissions: ["entity.delete"] }, [
        live(["entity.read"]),
      ])
    ).toBeNull();
    expect(
      grantWithinLive({ permissions: ["*"] }, [live(["entity.read"])])
    ).toBeNull();
  });

  it("refuses an unpinned grant against a space-pinned live one", () => {
    expect(
      grantWithinLive({ permissions: ["entity.read"] }, [
        live(["*"], { workspaceIds: [WS] }),
      ])
    ).toBeNull();
    expect(
      grantWithinLive({ permissions: ["entity.read"], workspaceIds: [WS] }, [
        live(["*"], { workspaceIds: [WS] }),
      ])
    ).toEqual({ endsAt: null });
  });

  it("refuses dropping a live grant's project pinning", () => {
    expect(
      grantWithinLive({ permissions: ["entity.read"] }, [
        live(["*"], { projectIds: [P] }),
      ])
    ).toBeNull();
    expect(
      grantWithinLive({ permissions: ["entity.read"], projectIds: [P] }, [
        live(["*"], { projectIds: [P] }),
      ])
    ).toEqual({ endsAt: null });
  });

  it("ends when its cover ends — the latest cover per permission, earliest overall", () => {
    expect(
      grantWithinLive(
        { permissions: ["entity.note.read", "entity.task.read"] },
        [
          live(["entity.read"], { expiresAt: D1 }),
          live(["entity.note.read"], { expiresAt: D2 }),
        ]
      )
    ).toEqual({ endsAt: D1 });
  });
});
