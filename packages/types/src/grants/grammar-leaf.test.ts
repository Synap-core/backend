/**
 * The grammar LEAF (`grammar.data.ts`, public as `@synap-core/types/grants/grammar`).
 *
 * The SDK vendors this file, so what it accepts and refuses is a contract.
 * The rows below are the ones where the seven hand copies elsewhere (SDK
 * `assertAppPermission`, flow `PERMISSION_RE`, mock pod `patternMatches`, …)
 * disagree with the pod today; each names the copy behaviour it rules out.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as barrel from "./grammar.js";
import * as leaf from "./grammar.data.js";
import {
  parsePermission,
  patternMatches,
  type GrantRequest,
} from "./grammar.data.js";

const accepts = (p: string): boolean => {
  try {
    parsePermission(p);
    return true;
  } catch {
    return false;
  }
};

describe("leaf: which permission strings are valid", () => {
  it.each([
    // Rules out: a copy whose qualified subjects are only `entity` (the stale
    // npm 1.12.11 grammar) refusing a family-qualified activity grant.
    ["event.dev.read", true],
    ["event.ci.create", true],
    ["event.create", true],
    // The qualifier of `capability` is an INTENT, three-segment only.
    ["capability.publish_post.run", true],
    ["capability.x.attach", true],
    ["capability.run", true],
    // Two segments, subject + kind: a kind pattern (read/create/update/delete).
    ["entity.note", true],
    ["entity.note.read", true],
    ["entity.*.read", true],
    ["document.read", true],
    ["*", true],
    // Rules out: a case-insensitive regex (flow PERMISSION_RE accepts these).
    ["Entity.Note.Read", false],
    ["entity.Note.read", false],
    // Rules out: a segment-count regex with no upper bound.
    ["a.b.c.d", false],
    ["entity.note.read.extra", false],
    // Rules out: a qualifier on a subject that has none.
    ["document.note.read", false],
    ["a.b.c", false],
    // A leading * stands alone; empty segments and spaces are not segments.
    ["*.read", false],
    ["entity..read", false],
    ["entity.note.", false],
    ["", false],
  ] as const)("%j accepted=%s", (pattern, ok) => {
    expect(accepts(pattern)).toBe(ok);
  });
});

describe("leaf: which requests a pattern covers", () => {
  const ev = (family: string | null, action: string): GrantRequest => ({
    subject: "event",
    qualifier: family,
    action,
  });
  const cap = (intent: string | null, action: string): GrantRequest => ({
    subject: "capability",
    qualifier: intent,
    action,
  });
  const ent = (kind: string | null, action: string): GrantRequest => ({
    subject: "entity",
    qualifier: kind,
    action,
  });

  it.each([
    // Rules out: a matcher with no event families (mock pod patternMatches).
    ["event.create", ev("dev", "create"), true],
    ["event.create", ev(null, "create"), true],
    ["event.dev.create", ev("dev", "create"), true],
    ["event.dev.create", ev("ci", "create"), false],
    ["event.dev.read", ev("dev", "read"), true],
    ["event.dev.read", ev("dev", "create"), false],
    ["event", ev("ci", "read"), true],
    // Rules out: an exact-string `can()`: the pod covers by prefix and `*`.
    ["entity", ent("note", "read"), true],
    ["entity.note", ent("note", "update"), true],
    ["entity.note", ent("task", "update"), false],
    ["entity.read", ent("task", "read"), true],
    ["entity.read", ent("task", "create"), false],
    // A kind-specific pattern never covers an object of unknown kind.
    ["entity.note.read", ent(null, "read"), false],
    // Gate verbs: only a pattern naming them (or `*`) covers them.
    ["entity.note", ent("note", "merge"), false],
    ["entity.merge", ent("note", "merge"), true],
    ["entity", ent("note", "archive"), false],
    ["*", ent("note", "archive"), true],
    // capability: an intent grant never opens the raw (intent-less) proxy.
    ["capability.publish_post.run", cap("publish_post", "run"), true],
    ["capability.publish_post.run", cap(null, "run"), false],
    ["capability.run", cap("anything", "run"), true],
    ["capability.x.attach", cap("x", "attach"), true],
    ["capability.x.attach", cap("y", "attach"), false],
  ] as const)("%s covers %j: %s", (pattern, req, expected) => {
    expect(patternMatches(pattern, req)).toBe(expected);
  });
});

describe("leaf and grammar.ts are ONE source", () => {
  // Rules out: a second declaration in grammar.ts that drifts from the leaf.
  it("grammar.ts re-exports exactly the leaf's exports, by identity", () => {
    expect(Object.keys(barrel).sort()).toEqual(Object.keys(leaf).sort());
    for (const key of Object.keys(leaf))
      expect(
        (barrel as Record<string, unknown>)[key],
        `${key} must be the leaf's own`
      ).toBe((leaf as Record<string, unknown>)[key]);
  });

  // Rules out: an import creeping into the leaf, which would break the SDK's
  // byte-for-byte vendoring (and the "no dependency" promise).
  it("the leaf has no import and no require", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "grammar.data.ts"), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\bfrom\s+["']/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });
});
