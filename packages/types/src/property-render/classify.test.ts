/**
 * The classifier and the field planner, ported with their app-bases tests
 * (`classify/classify-wire-shape.test.ts`, `entity-role-contract.test.ts`
 * "EntityFieldPlan", hooks `classify-property.test.ts`).
 */

import { describe, expect, it } from "vitest";
import {
  classifyBuiltinProperty,
  classifyPropertyKind,
  isSystemField,
  planEntityFields,
  type EffectivePropertyDef,
  type PropertyDef,
} from "./index.js";

/**
 * WIRE-SHAPED defs, copied from a live pod's `effectiveProperties`
 * (synap_get_entity, 2026-09-28) — not idealised. Every system status and
 * priority declares `inputType: "select"`, and task.status still carries a
 * stale `uiHints.enumValues` from another kind.
 */
const WIRE_TASK_DEFS: EffectivePropertyDef[] = [
  {
    id: "w-title",
    slug: "title",
    valueType: "string",
    constraints: { maxLength: 500, minLength: 1 },
    uiHints: { label: "Title", required: true, inputType: "text" },
    required: true,
    displayOrder: 0,
  },
  {
    id: "w-status",
    slug: "status",
    valueType: "string",
    constraints: { enum: ["todo", "in-progress", "done", "cancelled"] },
    uiHints: {
      label: "Status",
      inputType: "select",
      enumValues: ["estimated", "earned", "paid", "void"],
    },
    defaultValue: "todo",
    displayOrder: 1,
  },
  {
    id: "w-priority",
    slug: "priority",
    valueType: "string",
    constraints: { enum: ["low", "medium", "high", "urgent"] },
    uiHints: { label: "Priority", inputType: "select" },
    displayOrder: 2,
  },
  {
    id: "w-due",
    slug: "dueDate",
    valueType: "date",
    constraints: {},
    uiHints: { label: "Due Date", inputType: "date" },
    displayOrder: 3,
  },
];

const WIRE_DECISION_DEFS: EffectivePropertyDef[] = [
  {
    id: "w-dstatus",
    slug: "decisionStatus",
    valueType: "string",
    constraints: { enum: ["proposed", "accepted", "superseded", "rejected"] },
    uiHints: { label: "Status", displayAs: "status", inputType: "select" },
    defaultValue: "accepted",
    displayOrder: 2,
  },
  {
    id: "w-rationale",
    slug: "rationale",
    valueType: "string",
    constraints: { maxLength: 5000 },
    uiHints: { label: "Rationale", inputType: "richtext" },
    displayOrder: 4,
  },
];

/** A USER kind (Brand Library `brand-component`): kebab slugs, select status. */
const WIRE_BRAND_COMPONENT_DEFS: EffectivePropertyDef[] = [
  {
    id: "w-ckind",
    slug: "component-kind",
    valueType: "string",
    constraints: {
      enum: ["hero", "card", "cta", "quote", "banner", "section", "other"],
    },
    uiHints: { label: "Kind", inputType: "select" },
    displayOrder: 0,
  },
  {
    id: "w-cstatus",
    slug: "component-status",
    valueType: "string",
    constraints: { enum: ["draft", "approved", "deprecated"] },
    uiHints: { label: "Status", inputType: "select" },
    displayOrder: 1,
  },
];

const kindOf = (defs: EffectivePropertyDef[], slug: string) => {
  const def = defs.find((d) => d.slug === slug)!;
  return classifyPropertyKind({ slug, def });
};

/**
 * Live pod defs declare `inputType: "select"` on every status and priority.
 * `select` is the EDITOR those roles use, not a different kind: the role must
 * win, or no real status ever reaches the planner's hero bucket.
 */
describe("classifyPropertyKind on wire-shaped defs", () => {
  it.each([
    ["task.status → status", WIRE_TASK_DEFS, "status", "status"],
    ["task.priority → priority", WIRE_TASK_DEFS, "priority", "priority"],
    [
      "decision.decisionStatus (displayAs status) → status",
      WIRE_DECISION_DEFS,
      "decisionStatus",
      "status",
    ],
    [
      "brand-component.component-status → status",
      WIRE_BRAND_COMPONENT_DEFS,
      "component-status",
      "status",
    ],
  ] as const)("%s", (_n, defs, slug, expected) => {
    expect(kindOf(defs, slug)).toBe(expected);
  });

  it("a select with no role stays a select; other inputTypes still win", () => {
    expect(kindOf(WIRE_BRAND_COMPONENT_DEFS, "component-kind")).toBe("select");
    expect(kindOf(WIRE_DECISION_DEFS, "rationale")).toBe("richtext");
    expect(kindOf(WIRE_TASK_DEFS, "dueDate")).toBe("date");
  });

  it("falls back to valueType, then to the value's shape with no def", () => {
    expect(
      classifyPropertyKind({
        slug: "apiKey",
        def: { id: "s", slug: "apiKey", valueType: "secret" },
      })
    ).toBe("secret");
    expect(
      classifyPropertyKind({
        slug: "owner",
        def: { id: "o", slug: "owner", valueType: "entity_id" },
      })
    ).toBe("entity-ref");
    expect(classifyPropertyKind({ slug: "workEmail", value: "a@b.c" })).toBe(
      "email"
    );
    expect(classifyPropertyKind({ slug: "count", value: 3 })).toBe("number");
  });
});

/**
 * `classifyPropertyKind` follows the ONE classifier (`classifyBuiltinProperty`)
 * — the rule the web property renderer and relay read — so a field's row and
 * its card never disagree. Each case is a place where the older five-tier
 * dispatch this package used to hold said something else.
 */
describe("classifyPropertyKind follows the shared classifier", () => {
  const def = (
    slug: string,
    extra: Partial<EffectivePropertyDef> = {}
  ): EffectivePropertyDef => ({
    id: slug,
    slug,
    valueType: "string",
    ...extra,
  });
  const kind = (d: EffectivePropertyDef) =>
    classifyPropertyKind({ slug: d.slug, def: d });

  it("a status-named field with no options is text, not a status", () => {
    expect(kind(def("status"))).toBe("text");
    expect(kind(def("status", { uiHints: { inputType: "select" } }))).toBe(
      "text"
    );
    expect(
      kind(def("status", { constraints: { enum: ["open", "done"] } }))
    ).toBe("status");
  });

  it("a stage / phase / state with options is a status", () => {
    for (const slug of ["leadStage", "phase", "state"])
      expect(kind(def(slug, { constraints: { enum: ["a", "b"] } }))).toBe(
        "status"
      );
  });

  it("inputType select with no options is text — nothing to choose from", () => {
    expect(kind(def("kind", { uiHints: { inputType: "select" } }))).toBe(
      "text"
    );
    expect(
      kind(
        def("kind", {
          uiHints: { inputType: "select" },
          constraints: { enum: ["a"] },
        })
      )
    ).toBe("select");
  });

  it("note-like slugs are richtext, even under a one-line inputType", () => {
    for (const slug of ["brief", "readme", "message", "summary", "notes"])
      expect(kind(def(slug, { uiHints: { inputType: "text" } }))).toBe(
        "richtext"
      );
  });

  it("the valueType comes first: a contradicting inputType is ignored", () => {
    expect(kind(def("dueOn", { uiHints: { inputType: "date" } }))).toBe("text");
    expect(
      kind(
        def("flag", { valueType: "number", uiHints: { inputType: "checkbox" } })
      )
    ).toBe("number");
  });

  it("an array with options is a multi-select; progress / price / rating read by meaning", () => {
    expect(
      kind(
        def("labels", { valueType: "array", constraints: { enum: ["a", "b"] } })
      )
    ).toBe("multi-select");
    expect(kind(def("progress", { valueType: "number" }))).toBe("percent");
    expect(kind(def("price", { valueType: "object" }))).toBe("currency");
    expect(kind(def("rating", { valueType: "number" }))).toBe("number");
  });

  it("with no definition, the value's shape stands in for the valueType", () => {
    expect(classifyPropertyKind({ slug: "status", value: "open" })).toBe(
      "text"
    );
    expect(classifyPropertyKind({ slug: "email", value: "a@b.c" })).toBe(
      "email"
    );
    expect(classifyPropertyKind({ slug: "tags", value: ["x"] })).toBe("tags");
    expect(classifyPropertyKind({ slug: "done", value: true })).toBe("boolean");
  });

  it("every live-shaped def gets the shared classifier's kind where the names agree", () => {
    const SAME_NAME = new Set([
      "status",
      "priority",
      "date",
      "boolean",
      "tags",
      "email",
      "phone",
      "url",
      "number",
      "richtext",
      "text",
      "secret",
      "object",
      "currency",
    ]);
    const wire = [
      ...WIRE_TASK_DEFS,
      ...WIRE_DECISION_DEFS,
      ...WIRE_BRAND_COMPONENT_DEFS,
    ];
    let compared = 0;
    for (const d of wire) {
      const shared = classifyBuiltinProperty(d as unknown as PropertyDef);
      if (!SAME_NAME.has(shared)) continue;
      compared += 1;
      expect(kind(d), d.slug).toBe(shared);
    }
    // Non-vacuity: most of the wire defs were compared, not skipped.
    expect(compared).toBeGreaterThanOrEqual(wire.length - 1);
  });
});

describe("EntityFieldPlan", () => {
  it("partitions the minimal path once and keeps overflow as secondary fields", () => {
    const definitions: EffectivePropertyDef[] = [
      { id: "title", slug: "title", valueType: "string", displayOrder: 0 },
      {
        id: "status",
        slug: "status",
        valueType: "string",
        constraints: { enum: ["active", "closed"] },
        displayOrder: 1,
      },
      { id: "email", slug: "email", valueType: "string", displayOrder: 2 },
      { id: "phone", slug: "phone", valueType: "string", displayOrder: 3 },
      { id: "body", slug: "notes", valueType: "string", displayOrder: 4 },
      { id: "system", slug: "metadata", valueType: "object", displayOrder: 5 },
      { id: "empty", slug: "website", valueType: "string", displayOrder: 6 },
    ];
    const plan = planEntityFields({
      definitions,
      values: {
        title: "Ada",
        status: "active",
        email: "ada@example.com",
        phone: "+33",
        notes: "Body",
        metadata: { source: "import" },
      },
      header: { title: "Ada" },
      primaryLimit: 1,
    });

    expect(plan.identity.map(({ def }) => def.slug)).toEqual(["title"]);
    expect(plan.hero.map(({ def }) => def.slug)).toEqual(["status"]);
    expect(plan.primary.map(({ def }) => def.slug)).toEqual(["email"]);
    expect(plan.secondary.map(({ def }) => def.slug)).toEqual(["phone"]);
    expect(plan.body.map(({ def }) => def.slug)).toEqual(["notes"]);
    expect(plan.system.map(({ def }) => def.slug)).toEqual(["metadata"]);
    expect(plan.empty.map(({ def }) => def.slug)).toEqual(["website"]);
  });

  it("orders by displayOrder and defaults to six primary fields", () => {
    const definitions: EffectivePropertyDef[] = Array.from(
      { length: 8 },
      (_, i) => ({
        id: `f${i}`,
        slug: `field${i}`,
        valueType: "string",
        displayOrder: 8 - i,
      })
    );
    const values = Object.fromEntries(definitions.map((d) => [d.slug, d.slug]));
    const plan = planEntityFields({ definitions, values });
    expect(plan.primary.map(({ def }) => def.slug)).toEqual([
      "field7",
      "field6",
      "field5",
      "field4",
      "field3",
      "field2",
    ]);
    expect(plan.secondary.map(({ def }) => def.slug)).toEqual([
      "field1",
      "field0",
    ]);
  });
});

describe("isSystemField", () => {
  it.each(["id", "createdAt", "__debug", "rawJson", "embedding"])(
    "%s is bookkeeping",
    (key) => expect(isSystemField(key)).toBe(true)
  );
  it.each(["channelId", "workspaceId", "email", "status"])(
    "%s is a real field",
    (key) => expect(isSystemField(key)).toBe(false)
  );
});

describe("what the plan shows as a fact", () => {
  it("media-urls (a capture's copy-job input) is bookkeeping, never a fact row", () => {
    const urls = [
      "https://cdn.example.com/a.jpg",
      "https://cdn.example.com/b.jpg",
    ];
    for (const slug of ["media-urls", "mediaUrls", "media_urls"]) {
      const plan = planEntityFields({
        definitions: [
          { id: "t", slug: "title", valueType: "string", displayOrder: 0 },
          { id: "m", slug, valueType: "array", displayOrder: 1 },
        ],
        values: { title: "Clip", [slug]: urls },
        header: { title: "Clip" },
      });
      const facts = [...plan.hero, ...plan.primary, ...plan.secondary];
      expect(
        facts.map(({ def }) => def.slug),
        slug
      ).toEqual([]);
      expect(plan.system.map(({ def }) => def.slug)).toEqual([slug]);
    }
  });

  it("a status-named string with no options is a plain fact, not a hero status", () => {
    const plan = planEntityFields({
      definitions: [
        {
          id: "s",
          slug: "status",
          valueType: "string",
          uiHints: { inputType: "select" },
          displayOrder: 0,
        },
      ],
      values: { status: "whatever the importer wrote" },
    });
    expect(plan.hero).toEqual([]);
    expect(plan.primary.map((f) => [f.def.slug, f.renderKind])).toEqual([
      ["status", "text"],
    ]);
  });
});
