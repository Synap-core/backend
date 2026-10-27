import { describe, expect, it } from "vitest";
import {
  KEY_SCOPES_NOT_DERIVED,
  KEY_USE_SCOPES,
  KEY_USES,
  grantHoldsWrite,
  permissionWrites,
  scopesForKey,
  unknownKeyUses,
} from "./key-uses.js";
import { KEY_USE_LABELS } from "../vocabulary/index.js";

describe("permissionWrites — does a pattern open a write door", () => {
  // Each row rules out a rule: "only CRUD writes", "bare subject = read",
  // "gate verbs don't count", "qualified read is a write".
  it.each([
    ["*", true],
    ["entity", true],
    ["entity.note", true],
    ["entity.*", true],
    ["entity.note.create", true],
    ["document.update", true],
    ["view.delete", true],
    ["proposal.approve", true],
    ["entity.merge", true],
    ["event.create", true],
    ["entity.read", false],
    ["entity.*.read", false],
    ["entity.note.read", false],
    ["document.read", false],
    ["not a pattern", false],
  ])("%s → %s", (pattern, writes) => {
    expect(permissionWrites(pattern)).toBe(writes);
  });

  it("a grant writes when any one pattern does", () => {
    expect(grantHoldsWrite(["entity.*.read", "document.read"])).toBe(false);
    expect(grantHoldsWrite(["entity.*.read", "event.create"])).toBe(true);
    expect(grantHoldsWrite([])).toBe(false);
  });
});

describe("scopesForKey — the scopes a key's uses derive", () => {
  it("a read-only grant never gets a write door", () => {
    expect(
      scopesForKey({
        uses: ["hub", "mcp"],
        permissions: ["entity.*.read", "document.read"],
      })
    ).toEqual(["hub-protocol.read", "mcp.read"]);
  });

  it("a grant that writes opens each use's write door", () => {
    expect(
      scopesForKey({ uses: ["hub"], permissions: ["event.create"] })
    ).toEqual(["hub-protocol.read", "hub-protocol.write"]);
    expect(
      scopesForKey({ uses: ["mcp", "n8n"], permissions: ["*"] })
    ).toEqual(["mcp.read", "mcp.write", "read:entities", "write:entities"]);
  });

  it("a read-only door stays read-only whatever the grant", () => {
    expect(
      scopesForKey({
        uses: ["realtime", "chat", "skills", "n8n-analyze"],
        permissions: ["*"],
      })
    ).toEqual(["ai:analyze", "realtime:observe", "chat.stream", "skills.invoke"]);
  });

  it("follows KEY_USES order, without duplicates; unknown uses add nothing", () => {
    expect(
      scopesForKey({
        uses: ["chat", "hub", "hub", "bogus"],
        permissions: ["entity.*.read"],
      })
    ).toEqual(["hub-protocol.read", "chat.stream"]);
    expect(scopesForKey({ uses: [], permissions: ["*"] })).toEqual([]);
    expect(unknownKeyUses(["hub", "bogus"])).toEqual(["bogus"]);
  });

  it("never derives the MCP-only data.* aliases or a privileged scope", () => {
    const all = scopesForKey({
      uses: KEY_USES.map((u) => u.id),
      permissions: ["*"],
    });
    expect(all.length).toBe(KEY_USE_SCOPES.length);
    for (const s of [
      "data.read",
      "data.write",
      "setup.agent",
      "providers.write",
      "hub-protocol.admin",
      "box.runner",
      "probe",
    ])
      expect(all, s).not.toContain(s);
  });
});

describe("the classification every scope gets", () => {
  it("derived and not-derived are disjoint, and each reason is a sentence", () => {
    const derived = new Set(KEY_USE_SCOPES);
    expect(derived.size).toBe(KEY_USE_SCOPES.length);
    for (const [scope, why] of Object.entries(KEY_SCOPES_NOT_DERIVED)) {
      expect(derived.has(scope), scope).toBe(false);
      expect(why.trim().length, scope).toBeGreaterThan(10);
    }
  });

  it("every use has its words in the vocabulary", () => {
    expect(KEY_USES.map((u) => u.id)).toEqual(Object.keys(KEY_USE_LABELS));
  });
});
