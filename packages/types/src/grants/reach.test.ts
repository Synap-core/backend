/**
 * parsePlace / parseRequestPlace — the ONE reading of where a grant reaches.
 * Each row names the wrong rule it rules out.
 */
import { describe, expect, it } from "vitest";
import {
  joinPlaces,
  meetPlaces,
  parsePlace,
  parseRequestPlace,
  placeCovers,
  placeKey,
  PlaceError,
  requestScopeOf,
  type Place,
} from "./index.js";

const spaces = (...ids: string[]): Place => ({
  kind: "spaces",
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
    // A project narrowing makes it no pod-wide read either.
    expect(
      parsePlace(
        { permissions: ["entity.note.read"], projectIds: ["p1"] },
        "app"
      )
    ).toEqual({ kind: "unbounded" });
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

  it("a place key ignores the order of its spaces", () => {
    expect(placeKey(spaces("b", "a"))).toBe(placeKey(spaces("a", "b")));
    expect(placeKey({ kind: "pod" })).not.toBe(placeKey({ kind: "unbounded" }));
  });
});
