/**
 * grantLines — what an EXPLICIT ask may do, one line per thing, in people's
 * words: the pod-admin Review of a key a computer asked for by permissions
 * (2 Nov 2026) lists it instead of a template's name. Each case names the
 * wrong rule it rules out.
 */
import { describe, expect, it } from "vitest";
import {
  resolveObjectNounPlural,
  resolveActionLabel,
} from "../vocabulary/index.js";
import {
  GRANT_FULL_ACCESS_SENTENCE,
  grantLines,
  type GrantDraft,
} from "./index.js";

const draft = (...permissions: string[]): GrantDraft => ({ permissions });
const verb = (a: string) => resolveActionLabel(a, "imperative");

describe("grantLines", () => {
  // Rules out: the Sillage ask read as "+1 more" (facet is not a catalog
  // subject) or as raw patterns the person has to decode.
  it("the Sillage ingest ask: one line per kind, and the role write in words", () => {
    const lines = grantLines(
      draft(
        "entity.source.read",
        "entity.source.create",
        "entity.source.update",
        "entity.company.read",
        "entity.company.create",
        "entity.company.update",
        "facet.create"
      )
    );
    expect(lines).toEqual([
      // Kinds in the grant's canonical order (normalizeGrantPermissions).
      `Read, create and update ${resolveObjectNounPlural("company")}`,
      `Read, create and update ${resolveObjectNounPlural("source")}`,
      `${verb("create")} ${resolveObjectNounPlural("role")}`,
    ]);
    expect(lines.join(" ")).not.toMatch(/facet|entity\.|\+\d+ more/);
  });

  it("uses the pod's own name for a kind when it has one", () => {
    expect(
      grantLines(draft("entity.public-contract.read"), {
        kindNames: { "public-contract": "Public contracts" },
      })
    ).toEqual([`${verb("read")} Public contracts`]);
  });

  // Rules out: a bare subject read as only the boxes a catalog offers.
  it("a bare subject reads as all four verbs; a named gate verb is its own line", () => {
    expect(grantLines(draft("document", "proposal.approve"))).toEqual([
      `Read, create, update and delete ${resolveObjectNounPlural("document")}`,
      `${verb("approve")} ${resolveObjectNounPlural("proposal")}`,
    ]);
  });

  it("a pattern outside the catalog is worded too, never shown verbatim", () => {
    const [line] = grantLines(draft("vault.read"));
    expect(line).toBe(`${verb("read")} ${resolveObjectNounPlural("vault")}`);
  });

  it("full access is the one full-access sentence", () => {
    expect(grantLines(draft("*"))).toEqual([GRANT_FULL_ACCESS_SENTENCE]);
  });

  it("nothing granted is no line", () => {
    expect(grantLines(draft())).toEqual([]);
  });
});
