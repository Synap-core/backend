import { describe, expect, it } from "vitest";
import {
  classifyProperty,
  resolveKindProjection,
  type ProjectionProperty,
} from "./index.js";

/**
 * The REAL `task` effective-property set, read off the live pod on 2026-09-21
 * through the Builder workspace lens (`synap_get_entity` ->
 * `effectiveProperties` for task 911323cf…, workspace 808939d1…).
 *
 * 18 fields, in the resolver's own order (layer -> displayOrder -> slug).
 * Only the fields the classifier reads are kept; ids/timestamps are irrelevant
 * to a pure projection and are omitted rather than faked.
 */
const TASK_PROPERTIES: ProjectionProperty[] = [
  {
    slug: "title",
    valueType: "string",
    constraints: { maxLength: 500, minLength: 1 },
    uiHints: { label: "Title", required: true, inputType: "text" },
    required: true,
    displayOrder: 0,
    workspaceId: null,
  },
  {
    slug: "task-status",
    valueType: "string",
    constraints: {
      enum: [
        "Backlog",
        "Queued",
        "Running",
        "Review",
        "Done",
        "Failed",
        "Cancelled",
      ],
      defaultValue: "Queued",
    },
    uiHints: { label: "Status", inputType: "select" },
    required: false,
    displayOrder: 0,
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  },
  {
    slug: "task-priority",
    valueType: "string",
    constraints: {
      enum: ["Critical", "High", "Medium", "Low"],
      defaultValue: "Medium",
    },
    uiHints: { label: "Priority", inputType: "select" },
    required: false,
    displayOrder: 1,
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  },
  {
    slug: "status",
    valueType: "string",
    constraints: { enum: ["todo", "in-progress", "done", "cancelled"] },
    uiHints: { label: "Status", inputType: "select" },
    required: false,
    displayOrder: 1,
    workspaceId: null,
  },
  {
    slug: "priority",
    valueType: "string",
    constraints: { enum: ["low", "medium", "high", "urgent"] },
    uiHints: { label: "Priority", inputType: "select" },
    required: false,
    displayOrder: 2,
    workspaceId: null,
  },
  {
    slug: "task-project",
    valueType: "entity_id",
    constraints: { targetProfileSlug: "project" },
    uiHints: { label: "Project", linkedProfileSlug: "project" },
    required: false,
    displayOrder: 2,
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  },
  {
    slug: "task-type",
    valueType: "string",
    constraints: {
      enum: [
        "Code",
        "Research",
        "Content",
        "Ops",
        "Data",
        "Outreach",
        "Review",
        "Monitor",
        "Custom",
      ],
    },
    uiHints: { label: "Type", inputType: "select" },
    required: false,
    displayOrder: 3,
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  },
  {
    slug: "dueDate",
    valueType: "date",
    constraints: {},
    uiHints: { label: "Due Date", inputType: "date" },
    required: false,
    displayOrder: 3,
    workspaceId: null,
  },
  {
    slug: "assignee",
    valueType: "entity_id",
    constraints: {},
    uiHints: {
      label: "Assignee",
      inputType: "entity-select",
      linkedProfileSlug: "person",
    },
    required: false,
    displayOrder: 4,
    workspaceId: null,
  },
  {
    slug: "task-due-date",
    valueType: "date",
    constraints: {},
    uiHints: { label: "Due Date" },
    required: false,
    displayOrder: 4,
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  },
  {
    slug: "task-effort-hours",
    valueType: "number",
    constraints: {},
    uiHints: { label: "Effort Estimate (hrs)" },
    required: false,
    displayOrder: 5,
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  },
  {
    slug: "projectId",
    valueType: "entity_id",
    constraints: {},
    uiHints: {
      label: "Project",
      inputType: "entity-select",
      linkedProfileSlug: "project",
    },
    required: false,
    displayOrder: 5,
    workspaceId: null,
  },
  {
    slug: "task-token-estimate",
    valueType: "number",
    constraints: {},
    uiHints: { label: "Token Estimate (K)" },
    required: false,
    displayOrder: 6,
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  },
  {
    slug: "tags",
    valueType: "array",
    constraints: {},
    uiHints: { label: "Tags", inputType: "tags" },
    required: false,
    displayOrder: 6,
    workspaceId: null,
  },
  {
    slug: "description",
    valueType: "string",
    constraints: { maxLength: 5000 },
    uiHints: { label: "Description", inputType: "textarea" },
    required: false,
    displayOrder: 7,
    workspaceId: null,
  },
  {
    slug: "task-actual-tokens",
    valueType: "number",
    constraints: {},
    uiHints: { label: "Actual Tokens Used (K)" },
    required: false,
    displayOrder: 7,
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  },
  {
    slug: "task-blocked-by",
    valueType: "string",
    constraints: {},
    uiHints: { label: "Blocked By" },
    required: false,
    displayOrder: 8,
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  },
  {
    slug: "task-session-key",
    valueType: "string",
    constraints: {},
    uiHints: { label: "Session Key" },
    required: false,
    displayOrder: 9,
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  },
];

/** Measured fill over 134 live tasks. Slugs absent here were unmeasured. */
const TASK_FILL = {
  title: { filled: 134, sampleSize: 134 },
  status: { filled: 118, sampleSize: 134 },
  priority: { filled: 80, sampleSize: 134 },
  description: { filled: 38, sampleSize: 134 },
  dueDate: { filled: 15, sampleSize: 134 },
  tags: { filled: 14, sampleSize: 134 },
  projectId: { filled: 10, sampleSize: 134 },
  "task-status": { filled: 4, sampleSize: 134 },
  assignee: { filled: 0, sampleSize: 134 },
} as const;

describe("resolveKindProjection — live `task`, Builder lens", () => {
  it("returns exactly the seven data-bearing columns", () => {
    const projection = resolveKindProjection({
      properties: TASK_PROPERTIES,
      fill: TASK_FILL,
    });

    expect(projection.lineItem).toEqual([
      "title", // required + 134/134
      "status", // 118/134
      "priority", // 80/134
      "description", // 38/134  — dropped entirely by declared order
      "dueDate", // 15/134
      "tags", // 14/134
      "projectId", // 10/134
    ]);
    // assignee (0/134) is declared 9th but never reaches the cap …
    expect(projection.lineItem).not.toContain("assignee");
    // … and the near-dead overlay twin sinks below it with no suppression rule.
    expect(projection.lineItem).not.toContain("task-status");
    expect(projection.lineItem).not.toContain("task-priority");
  });

  it("degrades to required -> declared order when `fill` is omitted", () => {
    const projection = resolveKindProjection({ properties: TASK_PROPERTIES });

    expect(projection.lineItem).toEqual(
      TASK_PROPERTIES.slice(0, 7).map((p) => p.slug)
    );
    expect(projection.lineItem).toEqual([
      "title",
      "task-status",
      "task-priority",
      "status",
      "priority",
      "task-project",
      "task-type",
    ]);
  });

  it("derives the OData roles", () => {
    const projection = resolveKindProjection({
      properties: TASK_PROPERTIES,
      fill: TASK_FILL,
    });

    expect(projection.title).toBe("title");
    expect(projection.selectionFields).toEqual([
      "status",
      "priority",
      "task-status",
      "task-priority",
      "task-type",
    ]);
    expect(projection.textKeys).toEqual(["description"]);
    expect(projection.dateKeys).toEqual(["dueDate", "task-due-date"]);
    expect(projection.identityKeys).toEqual([]);
  });

  it("is pure — same input, same output; input untouched", () => {
    const snapshot = JSON.stringify(TASK_PROPERTIES);
    const a = resolveKindProjection({
      properties: TASK_PROPERTIES,
      fill: TASK_FILL,
    });
    const b = resolveKindProjection({
      properties: TASK_PROPERTIES,
      fill: TASK_FILL,
    });
    expect(a).toEqual(b);
    expect(JSON.stringify(TASK_PROPERTIES)).toBe(snapshot);
  });
});

describe("the ordering rule", () => {
  const props: ProjectionProperty[] = [
    { slug: "a", valueType: "string", uiHints: {} },
    { slug: "b", valueType: "string", uiHints: {} },
    { slug: "c", valueType: "string", uiHints: {} },
  ];

  it("sampleSize 0 contributes 0 — it does not sort last", () => {
    // `b` is measured over an empty sample; `a` is measured at a real 0; `c` is
    // unmeasured. All three contribute 0, so declared order must survive.
    // If sampleSize 0 were treated as "worse than 0" (or as NaN), `b` would move.
    const projection = resolveKindProjection({
      properties: props,
      fill: {
        a: { filled: 0, sampleSize: 100 },
        b: { filled: 0, sampleSize: 0 },
      },
    });
    expect(projection.lineItem).toEqual(["a", "b", "c"]);

    // and a sampleSize-0 field is NOT pushed behind a genuinely filled one only
    // by virtue of being unmeasured — it is simply ranked at 0.
    const withData = resolveKindProjection({
      properties: props,
      fill: {
        b: { filled: 0, sampleSize: 0 },
        c: { filled: 50, sampleSize: 100 },
      },
    });
    expect(withData.lineItem).toEqual(["c", "a", "b"]);
  });

  it("a required-but-empty field still ranks first", () => {
    const projection = resolveKindProjection({
      properties: [
        { slug: "filled", valueType: "string", uiHints: {} },
        { slug: "alsoFilled", valueType: "string", uiHints: {} },
        { slug: "brandNew", valueType: "string", uiHints: {}, required: true },
      ],
      fill: {
        filled: { filled: 500, sampleSize: 500 },
        alsoFilled: { filled: 250, sampleSize: 500 },
        brandNew: { filled: 0, sampleSize: 500 },
      },
    });
    expect(projection.lineItem[0]).toBe("brandNew");
  });

  it("never filters an empty field out — fill is a tiebreaker, not a gate", () => {
    const projection = resolveKindProjection({
      properties: props,
      fill: {
        a: { filled: 0, sampleSize: 999 },
        b: { filled: 0, sampleSize: 999 },
        c: { filled: 0, sampleSize: 999 },
      },
      limit: 10,
    });
    expect(projection.lineItem).toEqual(["a", "b", "c"]);
  });

  it("caps at `limit`, default 7", () => {
    expect(
      resolveKindProjection({ properties: TASK_PROPERTIES }).lineItem
    ).toHaveLength(7);
    expect(
      resolveKindProjection({ properties: TASK_PROPERTIES, limit: 3 }).lineItem
    ).toHaveLength(3);
    expect(
      resolveKindProjection({ properties: TASK_PROPERTIES, limit: 0 }).lineItem
    ).toEqual([]);
  });

  it("handles an empty schema", () => {
    expect(resolveKindProjection({ properties: [] })).toEqual({
      title: null,
      lineItem: [],
      selectionFields: [],
      textKeys: [],
      dateKeys: [],
      identityKeys: [],
    });
  });
});

describe("classifyProperty — leads with inputType, not displayAs", () => {
  it("uses inputType even when displayAs is absent (the 98.9% case)", () => {
    expect(
      classifyProperty({
        slug: "x",
        valueType: "string",
        uiHints: { inputType: "textarea" },
      })
    ).toBe("longtext");
    expect(
      classifyProperty({
        slug: "x",
        valueType: "string",
        uiHints: { inputType: "select" },
      })
    ).toBe("featured");
    expect(
      classifyProperty({
        slug: "x",
        valueType: "string",
        uiHints: { inputType: "url" },
      })
    ).toBe("identity");
    expect(
      classifyProperty({
        slug: "x",
        valueType: "string",
        uiHints: { inputType: "date" },
      })
    ).toBe("date");
  });

  it("falls back to valueType / constraints.enum, then slug", () => {
    expect(classifyProperty({ slug: "x", valueType: "date" })).toBe("date");
    expect(classifyProperty({ slug: "x", valueType: "boolean" })).toBe(
      "featured"
    );
    expect(
      classifyProperty({
        slug: "x",
        valueType: "string",
        constraints: { enum: ["a", "b"] },
      })
    ).toBe("featured");
    expect(
      classifyProperty({ slug: "contactEmail", valueType: "string" })
    ).toBe("identity");
    expect(classifyProperty({ slug: "summary", valueType: "string" })).toBe(
      "longtext"
    );
    expect(classifyProperty({ slug: "whatever", valueType: "string" })).toBe(
      "general"
    );
  });
});

describe("title resolution", () => {
  it("prefers a conventional slug regardless of spelling", () => {
    expect(
      resolveKindProjection({
        properties: [
          { slug: "ref", valueType: "string" },
          { slug: "display_name", valueType: "string" },
        ],
      }).title
    ).toBe("display_name");
    expect(
      resolveKindProjection({
        properties: [
          { slug: "name", valueType: "string" },
          { slug: "title", valueType: "string" },
        ],
      }).title
    ).toBe("title");
  });

  it("falls back to the first required short-text field, then any short text", () => {
    expect(
      resolveKindProjection({
        properties: [
          { slug: "ref", valueType: "string" },
          { slug: "code", valueType: "string", required: true },
        ],
      }).title
    ).toBe("code");
    expect(
      resolveKindProjection({
        properties: [
          { slug: "count", valueType: "number" },
          { slug: "ref", valueType: "string" },
        ],
      }).title
    ).toBe("ref");
    expect(
      resolveKindProjection({
        properties: [{ slug: "count", valueType: "number" }],
      }).title
    ).toBeNull();
  });
});
