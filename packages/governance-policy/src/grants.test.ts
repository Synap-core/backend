/**
 * The grant grammar. Every row below names the rule it rules OUT — a table of
 * "looks representative" rows would pass a matcher that ignores the qualifier,
 * treats patterns as globs, or skips the resource sets.
 */
import { describe, expect, it } from "vitest";
import {
  allowedQualifiers,
  assertPermissions,
  InvalidPermissionError,
  parsePermission,
  patternMatches,
  permits,
  resolveKeyExpiry,
  type GrantRequest,
} from "./grants.js";

const readKnowledge: GrantRequest = {
  subject: "entity",
  qualifier: "knowledge",
  action: "read",
};
const readTask: GrantRequest = {
  subject: "entity",
  qualifier: "task",
  action: "read",
};
const createKnowledge: GrantRequest = { ...readKnowledge, action: "create" };
const readUnknownKind: GrantRequest = { subject: "entity", action: "read" };
const readDocument: GrantRequest = { subject: "document", action: "read" };

describe("parsePermission", () => {
  it("normalises the governance spelling entity.read to entity.*.read", () => {
    expect(parsePermission("entity.read")).toEqual(["entity", "*", "read"]);
  });
  it("keeps a kind segment that is not an action", () => {
    expect(parsePermission("entity.knowledge")).toEqual([
      "entity",
      "knowledge",
    ]);
  });
  it.each([
    "",
    "Entity.read",
    "entity..read",
    "a.b.c.d",
    "*.read",
    "entity.know*",
    "document.note.read",
  ])("refuses %j", (p) => {
    expect(() => parsePermission(p)).toThrow(InvalidPermissionError);
  });
});

describe("patternMatches", () => {
  it.each([
    ["*", readKnowledge, true],
    ["entity", readKnowledge, true],
    ["entity.knowledge", readKnowledge, true], // prefix covers every action
    ["entity.knowledge", createKnowledge, true],
    ["entity.knowledge.read", readKnowledge, true],
    ["entity.knowledge.read", createKnowledge, false], // rules out "ignore action"
    ["entity.knowledge.read", readTask, false], // rules out "ignore qualifier"
    ["entity.*.read", readTask, true],
    ["entity.read", readTask, true],
    ["entity.read", createKnowledge, false],
    ["entity.knowledge", readUnknownKind, false], // unknown kind is never a specific kind
    ["entity.*.read", readUnknownKind, true],
    ["document.read", readDocument, true],
    ["document", readDocument, true],
    ["entity", readDocument, false], // rules out "subject ignored"
  ] as const)("%s vs %j → %s", (pattern, req, expected) => {
    expect(patternMatches(pattern, req)).toBe(expected);
  });
});

describe("permits — permission AND every resource set", () => {
  const base = { permissions: ["entity.knowledge.read"] };

  it("a workspace set refuses another workspace and an unknown one", () => {
    const g = { ...base, workspaceIds: ["ws-a"] };
    expect(permits(g, { ...readKnowledge, workspaceId: "ws-a" })).toBe(true);
    expect(permits(g, { ...readKnowledge, workspaceId: "ws-b" })).toBe(false);
    expect(permits(g, readKnowledge)).toBe(false);
  });

  it("an entity pin refuses every other object (and a create, which has none)", () => {
    const g = { permissions: ["entity.knowledge"], entityIds: ["e1"] };
    expect(permits(g, { ...readKnowledge, entityId: "e1" })).toBe(true);
    expect(permits(g, { ...readKnowledge, entityId: "e2" })).toBe(false);
    expect(permits(g, createKnowledge)).toBe(false);
  });

  it("a project set fails closed when the object's projects are unknown", () => {
    const g = { ...base, projectIds: ["p1"] };
    expect(permits(g, { ...readKnowledge, projectIds: ["p0", "p1"] })).toBe(
      true
    );
    expect(permits(g, { ...readKnowledge, projectIds: ["p2"] })).toBe(false);
    expect(permits(g, readKnowledge)).toBe(false);
  });

  it("no matching permission means no access, whatever the sets", () => {
    expect(permits({ permissions: ["document.read"] }, readKnowledge)).toBe(
      false
    );
  });
});

describe("allowedQualifiers — the SQL kind clause", () => {
  it.each([
    [["*"], "all"],
    [["entity"], "all"],
    [["entity.read"], "all"],
    [
      ["entity.knowledge.read", "entity.task"],
      ["knowledge", "task"],
    ],
    [["entity.knowledge.create"], []], // a create permission grants no read
    [["document.read"], []],
  ] as const)("%j → %j for entity.read", (perms, expected) => {
    const got = allowedQualifiers({ permissions: perms }, "entity", "read");
    expect(Array.isArray(got) ? [...got].sort() : got).toEqual(expected);
  });
});

describe("assertPermissions", () => {
  it("refuses an empty grant (a key with nothing is not a key)", () => {
    expect(() => assertPermissions([])).toThrow(InvalidPermissionError);
  });
});

describe("resolveKeyExpiry — 90 days by default, custom, or never", () => {
  const now = Date.UTC(2026, 9, 6);
  it("defaults to 90 days", () => {
    expect(resolveKeyExpiry(undefined, now)?.getTime()).toBe(
      now + 90 * 86_400_000
    );
  });
  it("honours a custom number of days", () => {
    expect(resolveKeyExpiry(7, now)?.getTime()).toBe(now + 7 * 86_400_000);
  });
  it("null means never", () => {
    expect(resolveKeyExpiry(null, now)).toBeNull();
  });
});
