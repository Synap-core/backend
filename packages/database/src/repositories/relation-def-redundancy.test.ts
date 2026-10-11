/**
 * `isRedundantRelationDefCopy` / `classifyRelationDefCopies` — the ONE
 * discriminator the `dedupeRelationDefs` conversion op and the diagnose
 * `duplicateRelationDefs` counter share. Each row below rules out a looser
 * rule: "same slug ⇒ duplicate" fails the customization rows, "byte-identical
 * ⇒ duplicate" fails the bare-mint rows.
 */

import { describe, it, expect } from "vitest";
import {
  isRedundantRelationDefCopy,
  classifyRelationDefCopies,
  type RelationDefMeaning,
} from "./relation-def-repository.js";

const BASE: RelationDefMeaning = {
  slug: "depends_on",
  workspaceId: null,
  displayName: "Depends On",
  description: "This item depends on the target",
  uiHints: { icon: "link", inverseLabel: "Blocks" },
  isDirectional: true,
};
const copy = (over: Partial<RelationDefMeaning>): RelationDefMeaning => ({
  ...BASE,
  workspaceId: "ws-1",
  ...over,
});

describe("isRedundantRelationDefCopy", () => {
  it.each<[string, Partial<RelationDefMeaning>, boolean]>([
    ["a byte-identical legacy seeder copy", {}, true],
    [
      "a bare entityLinks mint (humanized slug, no description, no hints)",
      { displayName: "depends on", description: null, uiHints: {} },
      true,
    ],
    [
      "a copy holding only a subset of the base's hints",
      { uiHints: { inverseLabel: "Blocks" } },
      true,
    ],
    ["a different label", { displayName: "Waits for" }, false],
    ["its own description", { description: "Needs sign-off first" }, false],
    [
      "its own inverse label",
      { uiHints: { icon: "link", inverseLabel: "Holds up" } },
      false,
    ],
    ["a hint the base lacks", { uiHints: { color: "#f00" } }, false],
    ["a stated non-directional flag", { isDirectional: false }, false],
  ])("%s → %s", (_label, over, expected) => {
    expect(isRedundantRelationDefCopy(copy(over), BASE)).toBe(expected);
  });

  it("a bare mint's default `directional` asserts nothing against a non-directional base", () => {
    const base = { ...BASE, slug: "relates_to", isDirectional: false };
    const bare = copy({
      slug: "relates_to",
      displayName: "relates to",
      description: null,
      uiHints: {},
      isDirectional: true,
    });
    expect(isRedundantRelationDefCopy(bare, base)).toBe(true);
    // …but a described copy that states directional is a customization.
    expect(
      isRedundantRelationDefCopy({ ...bare, description: "One-way here" }, base)
    ).toBe(false);
  });

  it("never pairs two workspace rows, or a row with another slug", () => {
    expect(isRedundantRelationDefCopy(copy({}), copy({}))).toBe(false);
    expect(isRedundantRelationDefCopy(copy({ slug: "blocks" }), BASE)).toBe(
      false
    );
  });
});

describe("classifyRelationDefCopies", () => {
  it("groups by the pod-wide row; a slug with none is never classified", () => {
    const groups = classifyRelationDefCopies([
      BASE,
      copy({ workspaceId: "ws-a" }),
      copy({ workspaceId: "ws-b", description: "Ours" }),
      { ...BASE, slug: "supports", workspaceId: "ws-a" },
      { ...BASE, slug: "supports", workspaceId: "ws-b" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].base).toBe(BASE);
    expect(groups[0].redundant.map((r) => r.workspaceId)).toEqual(["ws-a"]);
    expect(groups[0].kept.map((r) => r.workspaceId)).toEqual(["ws-b"]);
  });
});
