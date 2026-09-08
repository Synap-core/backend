/**
 * A GENERIC STORED SUMMARY MUST LOSE TO A DERIVATION THAT NAMES THE OBJECT.
 *
 * Two rows on the founder's live pod (2026-09-03) carry `summary: "Create
 * entity"` while their own `operations[]` carry the real title. `display.ts`
 * read `request.summary ?? buildFallbackTitle(...)`, so the stored string won
 * forever and the payload's name was never consulted.
 *
 * These tests pin the PROPERTY that decides it — `summaryNamesTheObject` — and
 * they are deliberately written against the vocabulary door's real output, not
 * against a list of strings: a blocklist would rot the moment a producer spells
 * one differently, and could only catch the two strings someone happened to see.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { summaryNamesTheObject } from "../display.js";
import { buildFallbackTitle } from "@synap-core/types/proposals";
import { labelFromOperations } from "../../../services/proposals/composite-summary.js";

describe("summaryNamesTheObject — identity, not a blocklist", () => {
  it("judges the founder's live row generic (verb + raw kind token)", () => {
    expect(
      summaryNamesTheObject("Create entity", {
        changeType: "create",
        proposalType: "create",
        targetType: "entity",
      })
    ).toBe(false);
  });

  it("judges every action×kind title the BUILDER itself produces generic", () => {
    // The strongest form of "derived from the builder, not restated": whatever
    // the fallback builder emits from metadata ALONE must be recognised as
    // carrying no identity. If the builder learns a new shape, this fails.
    for (const proposalType of [
      "create",
      "update",
      "delete",
      "run",
      "install",
    ]) {
      for (const targetType of [
        "entity",
        "document",
        "view",
        "focus_session",
        "property_def",
        "capability",
      ]) {
        const nameless = buildFallbackTitle({ proposalType, targetType });
        expect(
          summaryNamesTheObject(nameless, { proposalType, targetType }),
          `${nameless} (${proposalType}/${targetType})`
        ).toBe(false);
      }
    }
  });

  it("keeps the past mood generic too — producers wrote either", () => {
    expect(
      summaryNamesTheObject("Created document", {
        proposalType: "create",
        targetType: "document",
      })
    ).toBe(false);
  });

  it("keeps a summary that names the object", () => {
    expect(
      summaryNamesTheObject('Create Note "Raycast V1 focus lens"', {
        proposalType: "create",
        profileSlug: "note",
        targetType: "entity",
      })
    ).toBe(true);
  });

  it("keeps a human sentence a computed title would destroy", () => {
    // The workspace JOIN gate's summary, and a rule's own intent — both carry
    // words no metadata could produce, so neither may be overwritten.
    expect(
      summaryNamesTheObject(
        "Workspace access required — a workspace JOIN request is pending review",
        { proposalType: "join", targetType: "workspace" }
      )
    ).toBe(true);
    expect(
      summaryNamesTheObject('Add rule "when a deal closes, notify me"', {
        proposalType: "create",
        targetType: "rule",
      })
    ).toBe(true);
  });

  it("is not fooled by casing or punctuation", () => {
    expect(
      summaryNamesTheObject("  create  ENTITY!  ", {
        proposalType: "create",
        targetType: "entity",
      })
    ).toBe(false);
  });
});

describe("the end-to-end shape: generic stored summary + named operations", () => {
  it("derives a title that NAMES the object the composite plan creates", () => {
    // The exact live row: stored summary carries no identity, `operations[]`
    // carries the real title. This is the pair `display.ts` now resolves.
    const stored = "Create entity";
    const operations = [
      {
        op: "create_entity",
        profileSlug: "note",
        title: "Raycast V1 focus lens (product decision Focus A)",
      },
    ];
    const composite = labelFromOperations(operations);
    expect(composite?.objectName).toBe(
      "Raycast V1 focus lens (product decision Focus A)"
    );

    const parts = {
      changeType: "create",
      proposalType: "create",
      profileSlug: composite?.objectKind,
      targetType: "entity",
    };
    expect(summaryNamesTheObject(stored, parts)).toBe(false);

    const derived = buildFallbackTitle({
      ...parts,
      targetName: composite?.objectName,
    });
    expect(derived).toContain("Raycast V1 focus lens");
    expect(derived).not.toBe(stored);
  });

  it("never replaces a specific summary with a generic computed one", () => {
    // No name available anywhere → the stored string is kept even if generic,
    // because the derivation would say strictly less.
    const composite = labelFromOperations([
      { op: "create_relation", sourceRef: "a", targetRef: "b" },
    ]);
    expect(composite).toBeNull();
  });
});

describe("the wire — display.ts actually consults the derivation", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../display.ts"),
    "utf8"
  );

  it("no longer short-circuits on the stored summary", () => {
    // `request.summary ?? buildFallbackTitle(...)` is the defect itself: the
    // stored string wins before anything else is even computed.
    expect(src).not.toMatch(
      /const summary\s*=\s*\n?\s*request\.summary\s*\?\?/
    );
  });

  it("feeds the composite plan's own title into the derivation", () => {
    // The label must come from `operations[]` — the plan the executor applies —
    // so the preview and the apply read the same artifact.
    expect(src).toContain("labelFromOperations(");
    expect(src).toMatch(/summaryNamesTheObject\(\s*storedSummary/);
  });

  it("gives a document proposal a path to a title", () => {
    // `targetName` read the `entities` table only, so a `targetType: "document"`
    // proposal could never be named. Owner-floored batch join, per page.
    expect(src).toContain("documentTitleById.get(request.targetId)");
    expect(src).toMatch(/ownerPrivateVisibleWhere\(\s*documents\.workspaceId/);
  });
});
