import { describe, expect, it } from "vitest";
import {
  describeRecordEntries,
  describeValue,
  isStructuredValue,
  parseJsonContainer,
  readObjectRef,
  summarizeShape,
  type RecordListItem,
  type ValueShape,
} from "./structured-value.js";

// ─── The three real payloads from the "Create Template" proposal ───────────────
// (founder screenshot, 2026-10-12: each rendered as raw JSON text)

const PARAMS = [
  {
    name: "url",
    type: "text",
    label: "Link to the tool or product",
    required: true,
  },
  { name: "depth", type: "select", label: "How deep to go", required: false },
];

/** Stored as a JSON STRING — FieldRenderer drew this as one tag. */
const STAGES = JSON.stringify([
  {
    key: "research",
    goal: "Read the product and its pricing page",
    name: "Research the tool",
    category: "started",
    position: 2,
    suggestedTasks: ["Open the site", "Find the pricing"],
  },
  {
    key: "recall",
    goal: "Never duplicate what the pod already knows",
    name: "Check the pod",
    category: "started",
    position: 1,
    suggestedTasks: ["synap_ask about the tool"],
  },
]);

const CRITERIA = [
  {
    key: "verdict-with-reasons",
    check: {
      hint: "Look for a yes/no with at least two reasons",
      kind: "judge",
    },
    statement: "The research states a verdict with its reasons",
  },
];

const UUID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

function asList(shape: ValueShape): RecordListItem[] {
  if (shape.kind !== "recordList")
    throw new Error(`expected recordList, got ${shape.kind}`);
  return shape.items;
}

describe("describeValue — the three real payload shapes", () => {
  it("params: a list of objects becomes items titled by name, labelled, badged by type", () => {
    const items = asList(describeValue(PARAMS));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "url",
      titleKey: "name",
      subtitle: "Link to the tool or product",
      subtitleKey: "label",
      badge: { key: "type", label: "Type", value: "text" },
    });
    // What is left is a labelled row, not JSON.
    expect(items[0].entries).toEqual([
      {
        key: "required",
        label: "Required",
        value: { kind: "boolean", value: true },
      },
    ]);
  });

  it("stages: a JSON STRING is unpacked, sorted by position, position hidden", () => {
    const items = asList(describeValue(STAGES));
    expect(items.map((i) => i.title)).toEqual([
      "Check the pod",
      "Research the tool",
    ]);
    const first = items[0];
    expect(first.subtitle).toBe("Never duplicate what the pod already knows");
    expect(first.badge).toEqual({
      key: "category",
      label: "Category",
      value: "started",
    });
    const keys = first.entries.map((e) => e.key);
    expect(keys).not.toContain("position");
    expect(keys).toEqual(["key", "suggestedTasks"]);
    const tasks = first.entries.find((e) => e.key === "suggestedTasks")!;
    expect(tasks.label).toBe("Suggested tasks");
    expect(tasks.value).toEqual({
      kind: "list",
      items: [{ kind: "text", text: "synap_ask about the tool", long: false }],
    });
  });

  it("criteria: titled by statement, nested check is a record of rows", () => {
    const items = asList(describeValue(CRITERIA));
    expect(items[0].title).toBe(
      "The research states a verdict with its reasons"
    );
    expect(items[0].titleKey).toBe("statement");
    const check = items[0].entries.find((e) => e.key === "check")!;
    expect(check.value).toEqual({
      kind: "record",
      entries: [
        {
          key: "hint",
          label: "Hint",
          value: {
            kind: "text",
            text: "Look for a yes/no with at least two reasons",
            long: false,
          },
        },
        {
          key: "kind",
          label: "Kind",
          value: { kind: "text", text: "judge", long: false },
        },
      ],
    });
  });
});

describe("describeValue — scalars and leaves", () => {
  it("reads each scalar kind", () => {
    expect(describeValue(null)).toEqual({ kind: "empty" });
    expect(describeValue(undefined)).toEqual({ kind: "empty" });
    expect(describeValue("  ")).toEqual({ kind: "empty" });
    expect(describeValue(3)).toEqual({ kind: "number", value: 3 });
    expect(describeValue(false)).toEqual({ kind: "boolean", value: false });
    expect(describeValue(UUID)).toEqual({ kind: "id", id: UUID });
    expect(describeValue("2026-10-12")).toEqual({
      kind: "date",
      iso: "2026-10-12",
    });
    expect(describeValue("2026-10-12T09:30:00Z")).toEqual({
      kind: "date",
      iso: "2026-10-12T09:30:00Z",
    });
    expect(describeValue("2026-10-12 is when")).toMatchObject({ kind: "text" });
  });

  it("flags long or multi-line text so a renderer can clamp it", () => {
    expect(describeValue("a".repeat(161))).toMatchObject({
      kind: "text",
      long: true,
    });
    expect(describeValue("one\ntwo")).toMatchObject({
      kind: "text",
      long: true,
    });
    expect(describeValue("short")).toMatchObject({ kind: "text", long: false });
  });

  it("a non-JSON string that only looks bracketed stays text", () => {
    expect(describeValue("[draft] notes")).toMatchObject({ kind: "text" });
    expect(describeValue("{not json}")).toMatchObject({ kind: "text" });
  });

  it("object refs need a uuid id plus a type or title", () => {
    expect(describeValue({ id: UUID, type: "task", title: "Ship it" })).toEqual(
      {
        kind: "objectRef",
        ref: { id: UUID, type: "task", title: "Ship it" },
      }
    );
    expect(readObjectRef({ id: "abc", name: "x" })).toBeNull();
    expect(readObjectRef({ id: UUID })).toBeNull();
    expect(describeValue([{ id: UUID, name: "A" }])).toEqual({
      kind: "objectRefs",
      refs: [{ id: UUID, type: null, title: "A" }],
    });
  });
});

describe("describeValue — records and nesting", () => {
  it("drops null/undefined entries and keeps stored key order", () => {
    const shape = describeValue({
      zeta: 1,
      alpha: null,
      beta: "b",
      gamma: undefined,
    });
    expect(shape.kind).toBe("record");
    if (shape.kind !== "record") return;
    expect(shape.entries.map((e) => e.key)).toEqual(["zeta", "beta"]);
  });

  it("labels go through humanizeToken", () => {
    const shape = describeValue({ maxCharacters: 1, snake_case_key: 2 });
    if (shape.kind !== "record") throw new Error(shape.kind);
    expect(shape.entries.map((e) => e.label)).toEqual([
      "Max characters",
      "Snake case key",
    ]);
  });

  it("an empty object or all-null object is empty, never '{}'", () => {
    expect(describeValue({})).toEqual({ kind: "empty" });
    expect(describeValue({ a: null })).toEqual({ kind: "empty" });
    expect(describeValue([])).toEqual({ kind: "empty" });
    expect(describeValue("{}")).toEqual({ kind: "empty" });
  });

  it("past the depth cap the subtree is a pretty JSON block", () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    const shape = describeValue(deep);
    const a = shape.kind === "record" ? shape.entries[0].value : null;
    const b = a?.kind === "record" ? a.entries[0].value : null;
    const c = b?.kind === "record" ? b.entries[0].value : null;
    expect(c).toEqual({
      kind: "json",
      text: JSON.stringify({ d: 1 }, null, 2),
    });
    expect(describeValue(deep, { maxDepth: 1 })).toMatchObject({
      kind: "record",
      entries: [{ key: "a", value: { kind: "json" } }],
    });
  });

  it("a JSON string nested inside a record is unpacked too", () => {
    const shape = describeValue({ config: '{"limit": 5}' });
    expect(shape).toEqual({
      kind: "record",
      entries: [
        {
          key: "config",
          label: "Config",
          value: {
            kind: "record",
            entries: [
              {
                key: "limit",
                label: "Limit",
                value: { kind: "number", value: 5 },
              },
            ],
          },
        },
      ],
    });
  });

  it("does not sort when some items lack the order field, and keeps it visible", () => {
    const items = asList(
      describeValue([{ name: "b", position: 2 }, { name: "a" }])
    );
    expect(items.map((i) => i.title)).toEqual(["b", "a"]);
    expect(items[0].entries.map((e) => e.key)).toEqual(["position"]);
  });

  it("a mixed array is a list of per-item shapes", () => {
    expect(describeValue(["a", 2, { x: 1 }])).toEqual({
      kind: "list",
      items: [
        { kind: "text", text: "a", long: false },
        { kind: "number", value: 2 },
        {
          kind: "record",
          entries: [
            { key: "x", label: "X", value: { kind: "number", value: 1 } },
          ],
        },
      ],
    });
  });

  it("an over-long string is never a badge", () => {
    const items = asList(
      describeValue([{ name: "n", status: "x".repeat(40) }])
    );
    expect(items[0].badge).toBeNull();
    expect(items[0].entries.map((e) => e.key)).toEqual(["status"]);
  });
});

describe("isStructuredValue / parseJsonContainer", () => {
  it("answers whether a host should hand the value to the structured renderer", () => {
    expect(isStructuredValue(PARAMS)).toBe(true);
    expect(isStructuredValue(STAGES)).toBe(true);
    expect(isStructuredValue({ a: 1 })).toBe(true);
    expect(isStructuredValue(["a", "b"])).toBe(false);
    expect(isStructuredValue("hello")).toBe(false);
    expect(isStructuredValue(42)).toBe(false);
    expect(isStructuredValue(new Date())).toBe(false);
    expect(isStructuredValue(null)).toBe(false);
  });

  it("only parses a bracketed object/array", () => {
    expect(parseJsonContainer(" [1,2] ")).toEqual([1, 2]);
    expect(parseJsonContainer("42")).toBeUndefined();
    expect(parseJsonContainer('"x"')).toBeUndefined();
    expect(parseJsonContainer("[oops")).toBeUndefined();
  });
});

describe("describeRecordEntries", () => {
  it("keeps a record that looks like an object ref as rows", () => {
    const entries = describeRecordEntries({
      id: UUID,
      type: "task",
      note: null,
      title: "T",
    });
    expect(entries.map((e) => e.key)).toEqual(["id", "type", "title"]);
    expect(entries[0].value).toEqual({ kind: "id", id: UUID });
  });
});

describe("summarizeShape", () => {
  it("names what is there in one line", () => {
    expect(summarizeShape(describeValue(STAGES))).toBe(
      "Check the pod, Research the tool"
    );
    expect(
      summarizeShape(describeValue({ maxCharacters: 1, scope: "x" }))
    ).toBe("Max characters, Scope");
    expect(summarizeShape(describeValue([{ a: 1 }, { b: 2 }]))).toBe("2 items");
    expect(summarizeShape(describeValue([{ a: 1 }]))).toBe("1 item");
    expect(summarizeShape(describeValue(["a", "b"]))).toBe("a, b");
    expect(summarizeShape(describeValue(null))).toBe("");
  });
});
