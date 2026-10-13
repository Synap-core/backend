/**
 * The classifier and the field planner, ported with their app-bases tests
 * (`classify/classify-wire-shape.test.ts`, `entity-role-contract.test.ts`
 * "EntityFieldPlan").
 */

import { describe, expect, it } from "vitest";
import {
  classifyPropertyKind,
  isSystemField,
  planEntityFields,
  type EffectivePropertyDef,
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

describe("EntityFieldPlan", () => {
  it("partitions the minimal path once and keeps overflow as secondary fields", () => {
    const definitions: EffectivePropertyDef[] = [
      { id: "title", slug: "title", valueType: "string", displayOrder: 0 },
      { id: "status", slug: "status", valueType: "string", displayOrder: 1 },
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
