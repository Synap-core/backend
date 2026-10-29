/**
 * The grant grammar. Every row below names the rule it rules OUT — a table of
 * "looks representative" rows would pass a matcher that ignores the qualifier,
 * treats patterns as globs, or skips the resource sets.
 */
import { describe, expect, it } from "vitest";
import { OBJECT_KINDS } from "../vocabulary/object-kinds.js";
import { OBJECT_NOUNS } from "../vocabulary/index.js";
import {
  allowedQualifiers,
  assertPermissions,
  canonicalPermission,
  GRANT_GATE_ACTIONS,
  InvalidPermissionError,
  parsePermission,
  patternMatches,
  permits,
  resolveKeyExpiry,
  type GrantRequest,
} from "./grammar.js";

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
const mergeNote: GrantRequest = {
  subject: "entity",
  qualifier: "note",
  action: "merge",
};
const mergeTask: GrantRequest = { ...mergeNote, qualifier: "task" };
const readProposal: GrantRequest = { subject: "proposal", action: "read" };
const approveProposal: GrantRequest = {
  subject: "proposal",
  action: "approve",
};
const runPlaybook: GrantRequest = { subject: "playbook", action: "run" };

describe("parsePermission", () => {
  it("normalises the governance spelling entity.read to entity.*.read", () => {
    expect(parsePermission("entity.read")).toEqual(["entity", "*", "read"]);
  });
  // Rules out: `entity.merge` read as the kind "merge" (a grant on nothing).
  it("reads entity.<gate verb> as that verb on every kind", () => {
    expect(parsePermission("entity.merge")).toEqual(["entity", "*", "merge"]);
    expect(parsePermission("entity.archive")).toEqual([
      "entity",
      "*",
      "archive",
    ]);
  });
  // Rules out: a gate-verb list that swallows real kinds (`grant`, `place`).
  it("keeps a kind whose slug is not a gate verb", () => {
    expect(parsePermission("entity.grant")).toEqual(["entity", "grant"]);
    expect(parsePermission("entity.place")).toEqual(["entity", "place"]);
  });
  it("no gate verb is a known kind", () => {
    for (const verb of GRANT_GATE_ACTIONS) {
      expect(OBJECT_KINDS[verb], verb).toBeUndefined();
      expect(OBJECT_NOUNS[verb], verb).toBeUndefined();
    }
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
    ["entity.knowledge", readKnowledge, true], // prefix covers the four actions
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
    // A bare subject / kind / action wildcard covers read/create/update/delete
    // ONLY; a gate verb must be named. Rules out "prefix covers every verb".
    ["proposal", readProposal, true],
    ["proposal", approveProposal, false],
    ["proposal.*", approveProposal, false],
    ["proposal.approve", approveProposal, true],
    ["proposal.approve", readProposal, false],
    ["*", approveProposal, true], // only full access approves unnamed
    ["playbook", runPlaybook, false],
    ["playbook.run", runPlaybook, true],
    ["entity", mergeNote, false],
    ["entity.*", mergeNote, false],
    ["entity.note", mergeNote, false],
    ["entity.note.*", mergeNote, false],
    ["entity.note.merge", mergeNote, true],
    ["entity.note.merge", mergeTask, false], // the named verb keeps its kind
    ["entity.*.merge", mergeTask, true],
    ["entity.merge", mergeTask, true], // entity.merge = every kind
    ["*", mergeNote, true],
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
  it.each([
    [["*"], "all"],
    [["entity.merge"], "all"],
    [["entity.*.merge"], "all"],
    [["entity"], []], // a bare subject never merges
    [["entity.*"], []],
    [["entity.note", "entity.task.merge"], ["task"]],
  ] as const)("%j → %j for entity.merge", (perms, expected) => {
    const got = allowedQualifiers({ permissions: perms }, "entity", "merge");
    expect(Array.isArray(got) ? [...got].sort() : got).toEqual(expected);
  });
});

describe("capability — qualified by the INTENT a run serves", () => {
  const runPost: GrantRequest = {
    subject: "capability",
    qualifier: "publish_post",
    action: "run",
  };
  const runSend: GrantRequest = { ...runPost, qualifier: "send_message" };
  // A run with no intent (the raw provider proxy, `/connectors/tool-execute`).
  const runAny: GrantRequest = { subject: "capability", action: "run" };
  const attach: GrantRequest = { subject: "capability", action: "attach" };
  const create: GrantRequest = { subject: "capability", action: "create" };

  it("parses the intent spelling capability.<intent>.run", () => {
    expect(parsePermission("capability.publish_post.run")).toEqual([
      "capability",
      "publish_post",
      "run",
    ]);
  });
  // Rules out: `capability.attach` / `capability.renderer_set` (held by EVERY
  // AI-preset key) read as the intents "attach" / "renderer_set" — a grant on
  // nothing. A two-segment capability pattern always names a verb.
  it.each(["run", "attach", "renderer_set", "create", "read", "install"])(
    "keeps capability.%s a verb on every intent",
    (verb) => {
      expect(parsePermission(`capability.${verb}`)).toEqual([
        "capability",
        "*",
        verb,
      ]);
    }
  );
  it.each([
    ["capability.publish_post.run", runPost, true],
    ["capability.publish_post.run", runSend, false], // rules out "ignore intent"
    ["capability.publish_post.run", runAny, false], // an intent grant never opens the raw proxy
    ["capability.publish_post.run", attach, false],
    ["capability.*.run", runPost, true],
    ["capability.*.run", runAny, true],
    // An existing capability.run grant still matches, with or without intent.
    ["capability.run", runPost, true],
    ["capability.run", runSend, true],
    ["capability.run", runAny, true],
    ["capability.run", attach, false],
    ["capability.attach", attach, true],
    ["capability.create", create, true],
    ["capability", create, true],
    // A bare subject / intent never runs: a gate verb must be named.
    ["capability", runPost, false],
    ["capability.*", runPost, false],
    ["capability.publish_post", runPost, false],
    ["*", runPost, true],
  ] as const)("%s vs %j → %s", (pattern, req, expected) => {
    expect(patternMatches(pattern, req)).toBe(expected);
  });
  it("permits an intent run only in the grant's workspaces", () => {
    const g = {
      permissions: ["capability.publish_post.run"],
      workspaceIds: ["ws-a"],
    };
    expect(permits(g, { ...runPost, workspaceId: "ws-a" })).toBe(true);
    expect(permits(g, { ...runPost, workspaceId: "ws-b" })).toBe(false);
    expect(permits(g, runPost)).toBe(false);
  });
  it.each([
    [["capability.publish_post.run"], ["publish_post"]],
    [
      ["capability.publish_post.run", "capability.send_message.run"],
      ["publish_post", "send_message"],
    ],
    [["capability.run"], "all"],
    [["capability"], []],
    [["entity.note.read"], []],
  ] as const)("%j → %j intents for capability.run", (perms, expected) => {
    const got = allowedQualifiers({ permissions: perms }, "capability", "run");
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

describe("event — qualified by the activity FAMILY (dev, ci)", () => {
  const post = (family: string | null): GrantRequest => ({
    subject: "event",
    qualifier: family,
    action: "create",
  });

  // Rules out: the grammar refusing `event.dev.create` (finding 2ed74472:
  // "event" had no qualifier, so a key could not be limited to dev events).
  it("parses the family spelling event.<family>.<verb>", () => {
    expect(parsePermission("event.dev.create")).toEqual([
      "event",
      "dev",
      "create",
    ]);
    expect(() => assertPermissions(["event.ci.create"])).not.toThrow();
  });

  // Rules out: a two-segment `event.create` being read as the FAMILY "create"
  // (it would then post nothing): every poster key minted since D5 holds it.
  it("event.create still posts every family, and a request with no family", () => {
    expect(parsePermission("event.create")).toEqual(["event", "*", "create"]);
    for (const family of ["dev", "ci", null])
      expect(permits({ permissions: ["event.create"] }, post(family))).toBe(
        true
      );
    expect(permits({ permissions: ["event"] }, post("ci"))).toBe(true);
  });

  // Rules out: a family pattern that is not a real limit.
  it("a family key posts its family only, and never an unknown one", () => {
    const dev = { permissions: ["event.dev.create"] };
    expect(permits(dev, post("dev"))).toBe(true);
    expect(permits(dev, post("ci"))).toBe(false);
    expect(permits(dev, post(null))).toBe(false);
    expect(permits(dev, { subject: "event", action: "read" })).toBe(false);
  });

  it("allowedQualifiers lists the families a key may post", () => {
    expect(
      allowedQualifiers(
        { permissions: ["event.dev.create", "event.ci.create"] },
        "event",
        "create"
      )
    ).toEqual(["dev", "ci"]);
    expect(
      allowedQualifiers({ permissions: ["event.create"] }, "event", "create")
    ).toBe("all");
  });

  it("spells an every-family pattern short, as every stored key holds it", () => {
    expect(canonicalPermission(parsePermission("event.create"))).toBe(
      "event.create"
    );
    expect(canonicalPermission(parsePermission("event.ci.create"))).toBe(
      "event.ci.create"
    );
    // Only `event` is short-spelled: the other qualified subjects keep `*`.
    expect(canonicalPermission(parsePermission("entity.read"))).toBe(
      "entity.*.read"
    );
    expect(canonicalPermission(parsePermission("capability.run"))).toBe(
      "capability.*.run"
    );
  });
});
