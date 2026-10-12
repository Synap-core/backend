import { describe, expect, it } from "vitest";
import {
  planEntityFields,
  type EffectivePropertyDef,
} from "@synap-core/types/property-render";
import type { DeclarativeBlock } from "@synap-core/types/renderer-ref";
import { declarativeSegments } from "./declarative";
import { factsGridClass } from "./facts-grid";
import { FIELD_LIST_MIN_SHOWN, fieldRows } from "./field-rows";
import { statusKindForTone, statusPillFor } from "./tone";

const def = (
  slug: string,
  valueType: string,
  extra: Partial<EffectivePropertyDef> = {}
): EffectivePropertyDef => ({ id: slug, slug, valueType, ...extra });

describe("status pill from a stored status word", () => {
  it.each([
    ["active", "healthy"],
    ["completed", "healthy"],
    ["draft", "stale"],
    ["failed", "down"],
    ["paused", "unknown"],
  ] as const)("%s → %s", (value, kind) => {
    expect(statusPillFor(value)?.kind).toBe(kind);
  });

  it("labels through the vocabulary and drops an empty value", () => {
    expect(statusPillFor("in_progress")?.label).toBeTruthy();
    expect(statusPillFor("in_progress")?.label).not.toContain("_");
    expect(statusPillFor("  ")).toBeNull();
    expect(statusPillFor(null)).toBeNull();
  });

  it("covers every tone", () => {
    for (const tone of [
      "positive",
      "negative",
      "active",
      "pending",
      "neutral",
    ] as const) {
      expect(statusKindForTone(tone)).toBeTruthy();
    }
  });
});

describe("fieldRows — the shared plan drawn as rows", () => {
  const definitions = [
    def("title", "string", { displayOrder: 0 }),
    def("status", "string", {
      displayOrder: 1,
      uiHints: { inputType: "select", label: "Status" },
    }),
    def("apiKey", "secret", { displayOrder: 2 }),
    def("owner", "entity_id", { displayOrder: 3 }),
    def("dueDate", "date", { displayOrder: 4, uiHints: { label: "Due" } }),
    def("tags", "array", { displayOrder: 5 }),
    def("settings", "object", { displayOrder: 6 }),
    def("description", "string", { displayOrder: 7 }),
  ];
  const values = {
    title: "Ship it",
    status: "done",
    apiKey: "sk-live-secret",
    owner: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    dueDate: "2026-10-12T08:00:00Z",
    tags: ["a", "b"],
    settings: { mode: "fast", retries: 2 },
    description: "Long words",
  };
  const plan = planEntityFields({
    definitions,
    values,
    header: { title: "Ship it" },
  });

  it("never draws a secret or a bare entity reference", () => {
    const { shown, more } = fieldRows(plan);
    const keys = [...shown, ...more].map((r) => r.key);
    expect(keys).not.toContain("apiKey");
    expect(keys).not.toContain("owner");
    expect(JSON.stringify([...shown, ...more])).not.toContain("sk-live");
  });

  it("puts the status first as a pill and labels from the def", () => {
    const { shown } = fieldRows(plan);
    expect(shown[0]).toMatchObject({
      key: "status",
      label: "Status",
      pill: { kind: "healthy" },
    });
    expect(shown.find((r) => r.key === "dueDate")?.label).toBe("Due");
  });

  it("reads structure through describeValue, never [object Object]", () => {
    const { shown } = fieldRows(plan);
    expect(shown.find((r) => r.key === "tags")?.value).toBe("a, b");
    const settings = shown.find((r) => r.key === "settings")?.value;
    expect(settings).toBe("Mode, Retries");
  });

  it("keeps the body field behind the disclosure, or drops it on request", () => {
    expect(fieldRows(plan).more.map((r) => r.key)).toEqual(["description"]);
    expect(
      fieldRows(plan, { omit: ["description"] }).more.map((r) => r.key)
    ).toEqual([]);
  });

  it("promotes overflow when too few primary facts would show", () => {
    const sparse = planEntityFields({
      definitions: [def("a", "string"), def("b", "string"), def("c", "string")],
      values: { a: "1", b: "2", c: "3" },
      primaryLimit: 1,
    });
    const { shown, more } = fieldRows(sparse);
    expect(shown).toHaveLength(FIELD_LIST_MIN_SHOWN);
    expect(more).toEqual([]);
  });
});

describe("declarativeSegments", () => {
  it("groups runs of stats and buttons; keeps everything else in order", () => {
    const blocks: DeclarativeBlock[] = [
      { type: "heading", text: "Health" },
      { type: "stat", label: "Runs", value: 12 },
      { type: "stat", label: "Failed", value: 10, hint: "this week" },
      { type: "text", text: "Builds time out." },
      { type: "list", items: ["a", "b"], ordered: true },
      { type: "button", label: "Run", action: "playbook.run" },
      { type: "button", label: "Edit", action: "/edit" },
      { type: "stat", label: "Last", value: "4h ago" },
    ];
    expect(declarativeSegments(blocks).map((s) => s.kind)).toEqual([
      "heading",
      "stats",
      "text",
      "list",
      "buttons",
      "stats",
    ]);
    const [, stats] = declarativeSegments(blocks);
    expect(stats?.kind === "stats" && stats.blocks).toHaveLength(2);
  });

  it("an empty schema draws nothing", () => {
    expect(declarativeSegments([])).toEqual([]);
  });
});

describe("factsGridClass", () => {
  it("is two columns on a phone at every setting", () => {
    for (const n of [2, 3, 4] as const) {
      expect(factsGridClass(n).split(" ")[0]).toBe("grid-cols-2");
    }
    expect(factsGridClass(4)).toContain("lg:grid-cols-4");
    expect(factsGridClass(3)).not.toContain("lg:");
  });
});
