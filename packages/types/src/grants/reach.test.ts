/**
 * parsePlace / parseRequestPlace — the ONE reading of where a grant reaches.
 * Each row names the wrong rule it rules out.
 */
import { describe, expect, it } from "vitest";
import {
  holderOfGrant,
  joinPlaces,
  meetPlaces,
  parsePlace,
  parseRequestPlace,
  placeCovers,
  placeKey,
  placeBeyondPodWideReads,
  PlaceError,
  placeProjectIds,
  placeSpaceIds,
  requestScopeOf,
  withAppRequestScope,
  spacesCoveredWhole,
  spacesOfScopeRows,
  type Place,
} from "./index.js";

const spaces = (...ids: string[]): Place => ({
  kind: "spaces",
  ids: ids as [string, ...string[]],
});
const projects = (...ids: string[]): Place => ({
  kind: "projects",
  ids: ids as [string, ...string[]],
});

describe("parsePlace", () => {
  // Rules out: the meaning of "no space" read without the holder.
  it("no space: a pod-wide read for an app, anywhere for a key or an AI", () => {
    const read = { permissions: ["entity.decision.read"], workspaceIds: null };
    expect(parsePlace(read, "app")).toEqual({ kind: "pod" });
    expect(parsePlace(read, "key")).toEqual({ kind: "unbounded" });
    expect(parsePlace(read, "agent")).toEqual({ kind: "unbounded" });
  });

  // Rules out: an app's write with no space read as a pod-wide read.
  it("an app part with no space that is not a pod-wide read is unbounded", () => {
    expect(parsePlace({ permissions: ["entity.note.update"] }, "app")).toEqual({
      kind: "unbounded",
    });
    // A project narrowing makes it no pod-wide read either: it is the
    // projects place (W2), for any holder.
    expect(
      parsePlace(
        { permissions: ["entity.note.read"], projectIds: ["p1"] },
        "app"
      )
    ).toEqual({ kind: "projects", ids: ["p1"] });
  });

  // Rules out: a project-pinned scope read as "anywhere" (W2: projects are a place).
  it("no space but named projects: the projects, whoever holds it", () => {
    for (const holder of ["app", "key", "agent"] as const)
      expect(
        parsePlace(
          {
            permissions: ["entity.note.update"],
            projectIds: ["p2", "p1", "p2"],
          },
          holder
        )
      ).toEqual({ kind: "projects", ids: ["p2", "p1"] });
    // Spaces AND projects stay the spaces (the projects narrow inside them).
    expect(
      parsePlace(
        { permissions: [], workspaceIds: ["a"], projectIds: ["p1"] },
        "key"
      )
    ).toEqual(spaces("a"));
    // An empty project list pins nothing here, as before (never a throw).
    expect(
      parsePlace({ permissions: ["entity.note.read"], projectIds: [] }, "app")
    ).toEqual({ kind: "pod" });
    expect(() =>
      parsePlace({ permissions: [], projectIds: [""] }, "key")
    ).toThrow(PlaceError);
    expect(
      placeBeyondPodWideReads({
        permissions: ["entity.note.read"],
        projectIds: ["p"],
      })
    ).toEqual({ kind: "projects", ids: ["p"] });
  });

  it("named spaces, deduplicated in order", () => {
    expect(
      parsePlace({ permissions: [], workspaceIds: ["b", "a", "b"] }, "key")
    ).toEqual(spaces("b", "a"));
  });

  // Rules out: `[]` as a fourth meaning (nowhere / narrowed / unpinned / anywhere).
  it("an empty list or a blank id is refused", () => {
    expect(() =>
      parsePlace({ permissions: [], workspaceIds: [] }, "app")
    ).toThrow(PlaceError);
    expect(() =>
      parsePlace({ permissions: [], workspaceIds: [""] }, "key")
    ).toThrow(PlaceError);
  });
});

describe("parseRequestPlace", () => {
  it("derives the place of a request with no explicit scope", () => {
    expect(
      parseRequestPlace(
        { permission: "entity.decision.read", workspaceId: null },
        "app"
      )
    ).toEqual({ kind: "pod" });
    expect(
      parseRequestPlace(
        { permission: "entity.decision.read", workspaceId: null },
        "agent"
      )
    ).toEqual({ kind: "unbounded" });
    expect(
      parseRequestPlace({ permission: "entity.note", workspaceId: "ws" }, "app")
    ).toEqual(spaces("ws"));
  });

  // Rules out: an explicit scope that contradicts the space it carries.
  it("an explicit scope must agree with its space and permission", () => {
    expect(
      parseRequestPlace(
        { permission: "entity.decision.read", workspaceId: null, scope: "pod" },
        "app"
      )
    ).toEqual({ kind: "pod" });
    expect(() =>
      parseRequestPlace(
        { permission: "entity.decision.read", workspaceId: "ws", scope: "pod" },
        "app"
      )
    ).toThrow(PlaceError);
    expect(() =>
      parseRequestPlace(
        { permission: "entity.note.update", workspaceId: null, scope: "pod" },
        "app"
      )
    ).toThrow(/pod-wide/);
    expect(() =>
      parseRequestPlace(
        { permission: "entity.note.read", workspaceId: null, scope: "space" },
        "app"
      )
    ).toThrow(PlaceError);
    // A blank id is no space, never "no space".
    expect(() =>
      parseRequestPlace(
        { permission: "entity.note.read", workspaceId: "" },
        "app"
      )
    ).toThrow(PlaceError);
  });

  it("the wire's scope of a place", () => {
    expect(requestScopeOf({ kind: "pod" })).toBe("pod");
    expect(requestScopeOf(spaces("a"))).toBe("space");
    expect(requestScopeOf({ kind: "unbounded" })).toBeNull();
    expect(requestScopeOf(projects("p"))).toBeNull();
  });

  it("a request pinned to a project (no space, no scope) is the projects place", () => {
    expect(
      parseRequestPlace(
        { permission: "entity.note.update", workspaceId: null, projectId: "p" },
        "app"
      )
    ).toEqual(projects("p"));
    expect(() =>
      parseRequestPlace(
        { permission: "entity.note.read", workspaceId: "ws", projectId: "p" },
        "app"
      )
    ).toThrow(PlaceError);
    expect(() =>
      parseRequestPlace(
        {
          permission: "entity.note.read",
          workspaceId: null,
          projectId: "p",
          scope: "pod",
        },
        "app"
      )
    ).toThrow(PlaceError);
    // An app's PAIR never holds a project: its projects are its v2 access.
    expect(() =>
      withAppRequestScope({
        permission: "entity.note.read",
        workspaceId: null,
        projectId: "p",
      })
    ).toThrow(PlaceError);
  });
});

describe("place algebra", () => {
  it("spaces ⊂ the pod ⊆ anywhere; spaces cover their subsets", () => {
    expect(placeCovers({ kind: "pod" }, spaces("a"))).toBe(true);
    expect(placeCovers({ kind: "unbounded" }, { kind: "pod" })).toBe(true);
    expect(placeCovers({ kind: "pod" }, { kind: "unbounded" })).toBe(false);
    expect(placeCovers(spaces("a", "b"), spaces("b"))).toBe(true);
    expect(placeCovers(spaces("a"), spaces("a", "b"))).toBe(false);
  });

  it("join widens, meet narrows (nowhere = null)", () => {
    expect(joinPlaces(spaces("a"), spaces("b", "a"))).toEqual(spaces("a", "b"));
    expect(joinPlaces(spaces("a"), { kind: "pod" })).toEqual({ kind: "pod" });
    expect(meetPlaces({ kind: "unbounded" }, spaces("a"))).toEqual(spaces("a"));
    expect(meetPlaces({ kind: "pod" }, spaces("a"))).toEqual(spaces("a"));
    expect(meetPlaces(spaces("a", "b"), spaces("b", "c"))).toEqual(spaces("b"));
    expect(meetPlaces(spaces("a"), spaces("b"))).toBeNull();
  });

  // Rules out: a project read as inside (or around) a space (F3: a union).
  it("projects: covered by the pod and anywhere, never by spaces, and never covering them", () => {
    expect(placeCovers({ kind: "pod" }, projects("p"))).toBe(true);
    expect(placeCovers({ kind: "unbounded" }, projects("p"))).toBe(true);
    expect(placeCovers(projects("p", "q"), projects("q"))).toBe(true);
    expect(placeCovers(projects("p"), projects("p", "q"))).toBe(false);
    expect(placeCovers(spaces("a"), projects("a"))).toBe(false);
    expect(placeCovers(projects("a"), spaces("a"))).toBe(false);
    expect(placeCovers(projects("p"), { kind: "pod" })).toBe(false);
  });

  it("projects join and meet like spaces; with spaces, the join is the pod and the meet the projects", () => {
    expect(joinPlaces(projects("p"), projects("q", "p"))).toEqual(
      projects("p", "q")
    );
    expect(joinPlaces(spaces("a"), projects("p"))).toEqual({ kind: "pod" });
    expect(joinPlaces(projects("p"), { kind: "unbounded" })).toEqual({
      kind: "unbounded",
    });
    expect(meetPlaces(projects("p", "q"), projects("q"))).toEqual(
      projects("q")
    );
    expect(meetPlaces(projects("p"), projects("q"))).toBeNull();
    expect(meetPlaces(spaces("a"), projects("p"))).toEqual(projects("p"));
    expect(meetPlaces({ kind: "pod" }, projects("p"))).toEqual(projects("p"));
    expect(placeKey(projects("q", "p"))).toBe(placeKey(projects("p", "q")));
    expect(placeKey(projects("a"))).not.toBe(placeKey(spaces("a")));
    expect(placeSpaceIds(projects("p"))).toEqual([]);
    expect(placeProjectIds(projects("p"))).toEqual(["p"]);
    expect(placeProjectIds(spaces("a"))).toEqual([]);
  });

  it("a place key ignores the order of its spaces", () => {
    expect(placeKey(spaces("b", "a"))).toBe(placeKey(spaces("a", "b")));
    expect(placeKey({ kind: "pod" })).not.toBe(placeKey({ kind: "unbounded" }));
  });
});

describe("the doors' helpers", () => {
  it("an OAuth client's grant is an app's; any other a key's", () => {
    expect(holderOfGrant({ clientId: "app_x" })).toBe("app");
    expect(holderOfGrant({ clientId: null })).toBe("key");
    expect(holderOfGrant({})).toBe("key");
  });

  // Rules out: a read of named kinds with no space counted as "every space"
  // by a write door (#546, #636).
  it("beyond pod-wide reads: a read-only no-space scope reaches no space", () => {
    expect(
      placeBeyondPodWideReads({ permissions: ["entity.decision.read"] })
    ).toBeNull();
    expect(
      placeBeyondPodWideReads({ permissions: ["entity.decision.update"] })
    ).toEqual({ kind: "unbounded" });
    expect(
      placeBeyondPodWideReads({
        permissions: ["entity.decision.read"],
        workspaceIds: ["a"],
      })
    ).toEqual(spaces("a"));
    expect(placeSpaceIds(spaces("a", "b"))).toEqual(["a", "b"]);
    expect(placeSpaceIds({ kind: "pod" })).toEqual([]);
  });

  // Rules out: a project or object pin read as "anywhere" by the doors that
  // bound by space (role rows, capture routing), and a deny-all scope read as
  // unpinned.
  it("rows by space: a project or object pin with no space names none", () => {
    const rows = spacesOfScopeRows;
    expect(rows({ permissions: ["*"] })).toBe("anywhere");
    expect(rows({ permissions: ["*"], workspaceIds: ["a", "b"] })).toEqual([
      "a",
      "b",
    ]);
    // A project pin beside spaces narrows inside them: its rows sit there.
    expect(
      rows({ permissions: ["*"], workspaceIds: ["a"], projectIds: ["p"] })
    ).toEqual(["a"]);
    expect(rows({ permissions: ["*"], projectIds: ["p"] })).toEqual([]);
    expect(
      rows({ permissions: ["entity.note.update"], projectIds: ["p", "q"] })
    ).toEqual([]);
    expect(rows({ permissions: ["*"], entityIds: ["e"] })).toEqual([]);
    // An empty project list permits nothing (`permits`): never anywhere.
    expect(rows({ permissions: ["*"], projectIds: [] })).toEqual([]);
    // The deny-all scope (`narrowKeyGrant`): never anywhere.
    expect(rows({ permissions: [] })).toEqual([]);
    expect(rows({ permissions: ["entity.decision.read"] })).toBeNull();
  });

  // Rules out: a door that hands out a whole space (join, add an AI) reading
  // a pinned scope as covering it.
  it("whole spaces: any project or object pin covers none, beside spaces or not", () => {
    const whole = spacesCoveredWhole;
    expect(whole({ permissions: ["*"] })).toBe("anywhere");
    expect(whole({ permissions: ["*"], workspaceIds: ["a"] })).toEqual(["a"]);
    expect(
      whole({ permissions: ["*"], workspaceIds: ["a"], projectIds: ["p"] })
    ).toEqual([]);
    expect(
      whole({ permissions: ["*"], workspaceIds: ["a"], entityIds: ["e"] })
    ).toEqual([]);
    expect(whole({ permissions: ["*"], projectIds: ["p"] })).toEqual([]);
    expect(whole({ permissions: ["*"], projectIds: [] })).toEqual([]);
    expect(whole({ permissions: [] })).toEqual([]);
    expect(whole({ permissions: ["entity.decision.read"] })).toBeNull();
  });

  it("an app request carries its explicit scope; a write with no space is refused", () => {
    expect(
      withAppRequestScope({ permission: "entity.note", workspaceId: "w" })
    ).toEqual({ permission: "entity.note", workspaceId: "w", scope: "space" });
    expect(
      withAppRequestScope({
        permission: "entity.decision.read",
        workspaceId: null,
      }).scope
    ).toBe("pod");
    expect(() =>
      withAppRequestScope({ permission: "entity.note", workspaceId: null })
    ).toThrow(PlaceError);
  });
});
