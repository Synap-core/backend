/**
 * An Application's reach, read by the ONE holder reader (`appHolderAccess` →
 * `resolveHolderAccess`), so an app, a key and an AI are worded alike.
 *
 * The line that must never blur: a REVOKED app reads ended ("can touch
 * nothing"), an app nothing was approved for reads "No access yet". Revoke
 * killed its keys, so it has no live reach; "No access yet" would claim it
 * never had any, which is a different and false statement.
 */
import { describe, expect, it } from "vitest";
import { resolveObjectNounPlural } from "../vocabulary/index.js";
import { appHolderAccess, appMode, type AppHolderLike } from "./app-view.js";

const GRANT = {
  permissions: ["entity.person.create"],
  workspaceIds: ["ws-1"],
  projectIds: null,
  entityIds: null,
};

const app = (over: Partial<AppHolderLike> = {}): AppHolderLike => ({
  name: "synap.live",
  revoked_at: null,
  grants: [GRANT],
  ...over,
});

describe("appHolderAccess — an app read like any holder", () => {
  it("a revoked app is ended, NOT 'No access yet'", () => {
    const revoked = appHolderAccess(
      app({ revoked_at: "2026-10-06T13:00:00.000Z", grants: [] })
    );
    expect(revoked.state).toBe("ended");
    expect(revoked.sentence).not.toMatch(/No access yet/);
  });

  it("an app nothing was approved for reads 'No access yet'", () => {
    const empty = appHolderAccess(app({ grants: [] }));
    expect(empty.state).toBe("nothing");
    expect(empty.sentence).toBe("No access yet.");
  });

  it("a live grant is its ceiling, named by the space its request carried", () => {
    const h = appHolderAccess(
      app({
        pending_request: {
          proposal_id: "p1",
          requests: [
            {
              permission: "entity.person.create",
              workspaceId: "ws-1",
              workspaceName: "Sales",
            },
          ],
        },
      })
    );
    expect(h.state).toBe("limited");
    expect(h.tiers.change).toBe(resolveObjectNounPlural("person"));
    expect(h.where.spaces).toEqual([{ id: "ws-1", name: "Sales" }]);
    expect(h.lines).toHaveLength(1);
  });

  it("a revoked grant is not reach; an app grant never claims a key TTL", () => {
    const h = appHolderAccess(
      app({ grants: [{ ...GRANT, revokedAt: "2026-10-01T00:00:00.000Z" }] })
    );
    expect(h.state).toBe("nothing");
    expect(appHolderAccess(app()).lifetime.when).not.toMatch(/days/);
  });
});

describe("appMode", () => {
  it("names the one implemented mode in words", () => {
    expect(appMode("specific")).toBe("Specific access");
  });

  it("humanizes an unknown mode rather than leaking a raw token", () => {
    expect(appMode("some_new_mode")).not.toBe("some_new_mode");
  });
});
