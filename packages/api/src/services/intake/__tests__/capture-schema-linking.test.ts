/**
 * Schema linking (D1): the structurer is offered every visible kind, ranked
 * for the note, with property hints only for the best-ranked few.
 *
 * The founder's failing case drives it: "idea of content for synap" captured
 * from Builder must be able to become a `post`, a kind that lives in Content.
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildLinkedProfiles,
  LINKED_KINDS_WITH_HINTS,
  rankKindsForNote,
  type LinkableProfile,
} from "../capture-schema-linking.js";

const BUILDER = "ws-builder";
const CONTENT = "ws-content";

const kind = (
  slug: string,
  description: string,
  workspaceId: string | null = null,
  extra: Partial<LinkableProfile> = {}
): LinkableProfile => ({
  id: `p-${slug}-${workspaceId ?? "pod"}`,
  slug,
  displayName: slug[0]!.toUpperCase() + slug.slice(1),
  uiHints: { description },
  workspaceId,
  ...extra,
});

const CATALOG: LinkableProfile[] = [
  kind("task", "A unit of work to do", BUILDER),
  kind("note", "Freeform text"),
  kind("bug", "A defect in the product", BUILDER),
  kind(
    "post",
    "A piece of content to publish, from idea to published",
    CONTENT
  ),
  kind("person", "Someone you know"),
];

const NAMES = new Map([
  [BUILDER, "Builder"],
  [CONTENT, "Content"],
]);

describe("rankKindsForNote", () => {
  it("ranks a kind of ANOTHER space above the starting space's kinds when the note is about it", () => {
    const ranked = rankKindsForNote(
      "idea of content for synap",
      CATALOG,
      BUILDER
    ).map((k) => k.slug);
    expect(ranked.indexOf("post")).toBeLessThan(ranked.indexOf("task"));
    expect(ranked.indexOf("post")).toBeLessThan(ranked.indexOf("bug"));
  });

  it("an unscored note keeps the catalog order, nudged toward the starting space", () => {
    const ranked = rankKindsForNote("zzz", CATALOG, BUILDER).map((k) => k.slug);
    expect(ranked).toEqual(["task", "bug", "note", "post", "person"]);
  });
});

describe("buildLinkedProfiles", () => {
  const hintsFor = vi.fn(async (row: LinkableProfile) => `${row.slug}:hint`);

  it("offers every kind with its one-line description and the space that holds it", async () => {
    const linked = await buildLinkedProfiles({
      profiles: CATALOG,
      propertyHintsFor: hintsFor,
      note: "idea of content for synap",
      workspaceId: BUILDER,
      workspaceNames: NAMES,
    });
    expect(linked.map((k) => k.slug).sort()).toEqual(
      ["bug", "note", "person", "post", "task"].sort()
    );
    expect(linked.find((k) => k.slug === "post")).toEqual({
      slug: "post",
      displayName: "Post",
      description: "A piece of content to publish, from idea to published",
      propertyHints: "post:hint",
      spaces: ["Content"],
    });
  });

  it("property hints only for the best-ranked kinds; the rest are names + descriptions", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      kind(`kind${i}`, `kind number ${i}`)
    );
    const linked = await buildLinkedProfiles({
      profiles: many,
      propertyHintsFor: hintsFor,
      note: "nothing in particular",
      workspaceId: null,
      workspaceNames: NAMES,
    });
    expect(linked).toHaveLength(30);
    expect(linked.filter((k) => k.propertyHints)).toHaveLength(
      LINKED_KINDS_WITH_HINTS
    );
    expect(linked.every((k) => k.description)).toBe(true);
  });

  it("one entry per slug, naming every space that holds it; hidden kinds are not offered", async () => {
    const linked = await buildLinkedProfiles({
      profiles: [
        kind("deal", "A sale", BUILDER),
        kind("deal", "A sale", CONTENT),
        kind("secret", "x", null, { uiHints: { hideFromCreate: true } }),
      ],
      propertyHintsFor: hintsFor,
      note: "a deal",
      workspaceId: BUILDER,
      workspaceNames: NAMES,
    });
    expect(linked).toHaveLength(1);
    expect(linked[0]!.spaces).toEqual(["Builder", "Content"]);
  });

  it("cuts a long description to one bounded line", async () => {
    const [only] = await buildLinkedProfiles({
      profiles: [kind("essay", `first line\n${"word ".repeat(80)}`)],
      propertyHintsFor: hintsFor,
      note: "x",
      workspaceNames: NAMES,
    });
    expect(only!.description).not.toContain("\n");
    expect(only!.description!.length).toBeLessThanOrEqual(160);
  });
});
