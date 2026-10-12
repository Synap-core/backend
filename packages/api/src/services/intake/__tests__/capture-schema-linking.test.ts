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
  grantedWorkspaceIdsOf,
  kindsWithinFloor,
  LINKED_KINDS_DESCRIBED,
  LINKED_KINDS_MAX,
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

  it("bounds the list: descriptions for the top kinds, names past them, nothing past the cap — and every kind keeps its first status", async () => {
    const many = Array.from({ length: LINKED_KINDS_MAX + 10 }, (_, i) =>
      kind(`kind${String(i).padStart(3, "0")}`, "Something", CONTENT)
    );
    const last = many[LINKED_KINDS_MAX - 1]!;
    const lifecyclesFor = vi.fn(
      async (ids: string[]) =>
        new Map(
          ids
            .filter((id) => id === last.id)
            .map((id) => [
              id,
              {
                propertySlug: "stage",
                options: [{ key: "idea" }, { key: "live" }],
              },
            ])
        )
    );
    const linked = await buildLinkedProfiles({
      profiles: many,
      propertyHintsFor: hintsFor,
      note: "unrelated words",
      workspaceNames: NAMES,
      lifecyclesFor,
    });
    expect(linked).toHaveLength(LINKED_KINDS_MAX);
    expect(linked[LINKED_KINDS_DESCRIBED - 1]).toMatchObject({
      description: "Something",
      spaces: ["Content"],
    });
    expect(linked[LINKED_KINDS_DESCRIBED]).toEqual({
      slug: many[LINKED_KINDS_DESCRIBED]!.slug,
      displayName: many[LINKED_KINDS_DESCRIBED]!.displayName,
    });
    expect(linked[LINKED_KINDS_MAX - 1]).toEqual({
      slug: last.slug,
      displayName: last.displayName,
      firstStatus: { property: "stage", value: "idea" },
    });
    expect(lifecyclesFor.mock.calls[0]![0]).toHaveLength(LINKED_KINDS_MAX);
  });
});

describe("the kind floor — live spaces, inside the request's grant", () => {
  const ARCHIVED = "ws-archived";
  const kinds = [
    kind("note", "x"),
    kind("task", "x", BUILDER),
    kind("post", "x", CONTENT),
    kind("old", "x", ARCHIVED),
  ];

  it("drops an archived space's kinds; pod-wide kinds always pass", () => {
    expect(
      kindsWithinFloor(kinds, {
        archivedWorkspaceIds: new Set([ARCHIVED]),
        grantedWorkspaceIds: null,
      }).map((k) => k.slug)
    ).toEqual(["note", "task", "post"]);
  });

  it("a grant on one space keeps that space's kinds only", () => {
    expect(
      kindsWithinFloor(kinds, {
        archivedWorkspaceIds: new Set(),
        grantedWorkspaceIds: new Set([CONTENT]),
      }).map((k) => k.slug)
    ).toEqual(["note", "post"]);
  });

  it("a grant narrows only when every scope names its spaces", () => {
    expect(grantedWorkspaceIdsOf(undefined)).toBeNull();
    expect(
      grantedWorkspaceIdsOf({
        scopes: [{ workspaceIds: [CONTENT] }, { workspaceIds: null }],
      })
    ).toBeNull();
    expect([
      ...grantedWorkspaceIdsOf({
        scopes: [{ workspaceIds: [CONTENT] }, { workspaceIds: [BUILDER] }],
      })!,
    ]).toEqual([CONTENT, BUILDER]);
  });
});
