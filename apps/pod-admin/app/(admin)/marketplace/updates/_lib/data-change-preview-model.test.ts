/**
 * The words of the before → after block (finding 4e4b2858) for the founder's
 * real case: posts at Idea become ideas, some kept for a campaign, some for a
 * date, a series and a campaign. Labels come from the pod's preview, never a
 * slug; a kind with no label reads its key, as the pod sent it.
 */
import { describe, expect, it } from "vitest";
import { createT } from "@synap-core/types/i18n";
import type { DataChangePreview } from "./contract";
import { en, fr } from "./copy";
import { previewWords } from "./data-change-preview-model";

const t = createT("en", { en, fr });
const andList = (w: string[]) =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(w);

const POSTS: DataChangePreview = {
  change: "rekind",
  from: {
    kind: { key: "post", label: "Post", plural: "Posts" },
    detail: { as: "status", label: { key: "Idea", label: "Idea" } },
    count: 25,
  },
  to: {
    kind: { key: "idea", label: "Idea", plural: "Ideas" },
    detail: { as: "status", label: { key: "New", label: "New" } },
    count: 25,
  },
  samples: { titles: ["Fewer agents, less randomness"], more: 24 },
  kept: {
    count: 6,
    groups: [
      {
        reason: "fieldsSet",
        fields: [{ key: "post-campaign", label: "Campaign" }],
        count: 2,
        samples: { titles: ["Carousel: three scales"], more: 1 },
      },
      {
        reason: "fieldsSet",
        fields: [
          { key: "publish-date", label: "Publish date" },
          { key: "post-series", label: "Series" },
          { key: "post-campaign", label: "Campaign" },
        ],
        count: 4,
        samples: { titles: ["Post 08"], more: 0 },
      },
    ],
  },
};

describe("previewWords", () => {
  it("tells a rekind in labels: title, scope, the two boxes, kept groups by why", () => {
    const w = previewWords(t, POSTS, andList);
    expect(w.title).toBe("Posts at Idea become Ideas");
    expect(w.scope).toBe("31 Posts looked at");
    expect(w.from).toEqual({ kind: "Post", detail: "Idea", count: 25 });
    expect(w.to).toEqual({ kind: "Idea", detail: "New", count: 25 });
    expect(w.notes).toEqual([
      "Same records: content, links and history are kept.",
    ]);
    expect(w.see).toBe("See the 25 Ideas");
    expect(w.list).toEqual({
      titles: ["Fewer agents, less randomness"],
      more: "and 24 more",
    });
    expect(w.kept?.title).toBe("Stay as Posts");
    expect(w.kept?.count).toBe(6);
    expect(w.kept?.groups.map((g) => [g.reason, g.count, g.see])).toEqual([
      ["Campaign already set", 2, "See the 2"],
      ["Publish date, Series, and Campaign already set", 4, "See the 4"],
    ]);
    expect(w.kept?.groups[1]?.list.more).toBeNull();
    expect(JSON.stringify(w)).not.toMatch(/post-campaign|publish-date|"post"/);
  });

  it("names a field on a rename, and each value on a translation", () => {
    const deal = { key: "deal", label: "Deal", plural: "Deals" };
    const renamed = previewWords(
      t,
      {
        change: "renameField",
        from: {
          kind: deal,
          detail: {
            as: "field",
            label: { key: "dealStage", label: "Deal stage" },
          },
          count: 412,
        },
        to: {
          kind: deal,
          detail: {
            as: "field",
            label: { key: "commercialStage", label: "Commercial stage" },
          },
          count: 412,
        },
        samples: { titles: [], more: 412 },
        kept: null,
      },
      andList
    );
    expect(renamed.title).toBe("A field is renamed on Deals");
    expect(renamed.from.detail).toBe("field “Deal stage”");
    expect(renamed.to.detail).toBe("field “Commercial stage”");
    expect(renamed.notes).toEqual(["Every value moves as it is."]);
    expect(renamed.kept).toBeNull();

    const task = { key: "task", label: "Task", plural: "Tasks" };
    const priority = { key: "priority", label: "Priority" };
    const translated = previewWords(
      t,
      {
        change: "translateValues",
        from: {
          kind: task,
          detail: { as: "field", label: priority },
          count: 65,
        },
        to: { kind: task, detail: { as: "field", label: priority }, count: 65 },
        samples: { titles: [], more: 65 },
        values: [
          {
            from: { key: "P1", label: "P1" },
            to: { key: "high", label: "High" },
            count: 14,
          },
          {
            from: { key: "P2", label: "P2" },
            to: { key: "medium", label: "Medium" },
            count: 51,
          },
        ],
        kept: null,
      },
      andList
    );
    expect(translated.title).toBe(
      "The values of Priority on Tasks are translated"
    );
    expect(translated.notes).toEqual([
      "P1 becomes High (14)",
      "P2 becomes Medium (51)",
    ]);
  });

  it("one record reads in the singular", () => {
    const one = previewWords(
      t,
      {
        ...POSTS,
        from: { ...POSTS.from, count: 1 },
        to: { ...POSTS.to, count: 1 },
        kept: null,
      },
      andList
    );
    expect(one.scope).toBe("1 Post looked at");
    expect(one.see).toBe("See the 1 Idea");
  });
});
