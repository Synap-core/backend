/**
 * The navigation leaf's kind rules: the one fold of a kind onto the route
 * tables' spelling, which views apply to which kinds, and the handoff kinds.
 */
import { describe, expect, it } from "vitest";
import { OBJECT_KIND_ALIASES } from "../vocabulary/object-kinds.js";
import {
  HANDOFF_KINDS,
  NAV_KIND_ALIASES,
  OBJECT_NAV_VIEWS,
  OBJECT_NAV_VIEW_KINDS,
  canonicalNavKind,
  isHandoffKind,
  objectNavViewApplies,
} from "./index.js";

describe("canonicalNavKind", () => {
  it("folds table and event spellings onto the route tables' kind", () => {
    expect(canonicalNavKind("focus_session")).toBe("session");
    expect(canonicalNavKind("Focus_Sessions")).toBe("session");
    expect(canonicalNavKind(" project_tracks ")).toBe("track");
    expect(canonicalNavKind("workspaces")).toBe("workspace");
    expect(canonicalNavKind("apiKey")).toBe("api_key");
    expect(canonicalNavKind("app")).toBe("application");
  });

  it("leaves a canonical or unknown kind as its trimmed lower-case self", () => {
    expect(canonicalNavKind("session")).toBe("session");
    expect(canonicalNavKind("Session")).toBe("session");
    expect(canonicalNavKind("no-such-kind")).toBe("no-such-kind");
  });

  it("never folds a label-only spelling that would redirect a route arm", () => {
    // The vocabulary folds `workflow` onto `automation` for its LABEL; the
    // browser routes `workflow` to the Processes home. Not a nav alias.
    expect(OBJECT_KIND_ALIASES.workflow).toBe("automation");
    expect(canonicalNavKind("workflow")).toBe("workflow");
  });

  it("agrees with the label vocabulary wherever both name a spelling", () => {
    const shared = Object.keys(NAV_KIND_ALIASES).filter((k) =>
      Object.prototype.hasOwnProperty.call(OBJECT_KIND_ALIASES, k)
    );
    expect(shared.length).toBeGreaterThanOrEqual(10);
    for (const k of shared) {
      expect([k, NAV_KIND_ALIASES[k]]).toEqual([k, OBJECT_KIND_ALIASES[k]]);
    }
  });
});

describe("object-nav views per kind", () => {
  it("every view names the kinds it applies to", () => {
    for (const view of OBJECT_NAV_VIEWS) {
      expect(OBJECT_NAV_VIEW_KINDS[view].length).toBeGreaterThan(0);
    }
  });

  it("room applies to a session, by any spelling, and to nothing else", () => {
    expect(objectNavViewApplies("session", "room")).toBe(true);
    expect(objectNavViewApplies("focus_session", "room")).toBe(true);
    expect(objectNavViewApplies("entity", "room")).toBe(false);
    expect(objectNavViewApplies("session", "thread")).toBe(false);
    expect(objectNavViewApplies("session", undefined)).toBe(false);
  });
});

describe("HANDOFF_KINDS", () => {
  it("is spelled canonically, so a client's fold lands on a member", () => {
    for (const kind of HANDOFF_KINDS) {
      expect(canonicalNavKind(kind)).toBe(kind);
      expect(isHandoffKind(kind)).toBe(true);
    }
  });

  it("refuses an alias or an unknown kind as is (fold first)", () => {
    expect(isHandoffKind("focus_session")).toBe(false);
    expect(isHandoffKind(canonicalNavKind("focus_session"))).toBe(true);
    expect(isHandoffKind("rule")).toBe(false);
    expect(isHandoffKind(42)).toBe(false);
  });
});
