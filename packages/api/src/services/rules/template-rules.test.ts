import { describe, it, expect } from "vitest";
import {
  decideTemplateRule,
  readTemplateRules,
  templateRuleHash,
} from "./template-rules.js";
import { buildRuleMetadata, readRuleMetadata } from "./index.js";

const DECL = { key: "assets-first", intent: "Use approved assets first." };
const seedOf = (d: { intent: string; sentence?: unknown }) => ({
  template: "brand-library",
  key: "assets-first",
  hash: templateRuleHash(d),
});

describe("template rules — three-way stamp", () => {
  it("absent, never offered → create", () => {
    expect(
      decideTemplateRule({
        decl: DECL,
        stored: null,
        ref: null,
        refRowExists: false,
      })
    ).toEqual({
      action: "create",
    });
  });

  it("untouched → update only when the template moved", () => {
    const stored = { ...DECL, seed: seedOf(DECL) };
    expect(
      decideTemplateRule({ decl: DECL, stored, ref: null, refRowExists: false })
    ).toEqual({
      action: "none",
      status: "unchanged",
    });
    expect(
      decideTemplateRule({
        decl: { ...DECL, intent: "Use approved assets and tokens first." },
        stored,
        ref: null,
        refRowExists: false,
      })
    ).toEqual({ action: "update" });
  });

  it("AN OWNER EDIT IS NEVER OVERWRITTEN — kept, conflict only when the template moved too", () => {
    const stored = {
      key: DECL.key,
      intent: "My own wording.",
      seed: seedOf(DECL),
    };
    expect(
      decideTemplateRule({ decl: DECL, stored, ref: null, refRowExists: false })
    ).toEqual({
      action: "none",
      status: "kept",
    });
    expect(
      decideTemplateRule({
        decl: { ...DECL, intent: "Template v2." },
        stored,
        ref: null,
        refRowExists: false,
      })
    ).toEqual({ action: "none", status: "conflict" });
  });

  it("a sentence is part of the stamp: editing only the WHEN/THEN is an edit", () => {
    const withSentence = { ...DECL, sentence: { when: "x" } };
    const stored = {
      ...DECL,
      sentence: { when: "y" },
      seed: seedOf(withSentence),
    };
    expect(
      decideTemplateRule({
        decl: { ...withSentence, intent: "v2" },
        stored,
        ref: null,
        refRowExists: false,
      })
    ).toEqual({ action: "none", status: "conflict" });
  });

  it("an owner DELETE is remembered through the brief ref; an earlier offer is not re-filed", () => {
    expect(
      decideTemplateRule({
        decl: DECL,
        stored: null,
        ref: { key: DECL.key, ruleId: "gone" },
        refRowExists: false,
      })
    ).toEqual({ action: "none", status: "deleted_by_owner" });
    expect(
      decideTemplateRule({
        decl: DECL,
        stored: null,
        ref: { key: DECL.key },
        refRowExists: false,
      })
    ).toEqual({ action: "none", status: "offered" });
  });
});

describe("template rules — plumbing", () => {
  it("readTemplateRules drops malformed and duplicate entries", () => {
    expect(
      readTemplateRules([
        DECL,
        { key: "assets-first", intent: "dup" },
        { key: "", intent: "x" },
        { key: "k2", intent: "  " },
        "junk",
        { key: "k3", intent: " With sentence ", sentence: { when: 1 } },
      ])
    ).toEqual([
      DECL,
      { key: "k3", intent: "With sentence", sentence: { when: 1 } },
    ]);
    expect(readTemplateRules(undefined)).toEqual([]);
  });

  it("the seed round-trips through the rule metadata writer and reader (the stamp is not dropped)", () => {
    const meta = buildRuleMetadata({
      intent: DECL.intent,
      scope: { kind: "workspace", workspaceId: "ws" },
      behaviours: [],
      seed: seedOf(DECL),
    });
    const read = readRuleMetadata({ rule: meta });
    expect(read?.seed).toEqual(seedOf(DECL));
    // And a hash over the READ row equals the seed — "untouched" is reachable.
    expect(templateRuleHash(read!)).toBe(read!.seed!.hash);
  });
});
