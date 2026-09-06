import { describe, it, expect } from "vitest";
import {
  actionOptionSchema,
  referenceValueSchema,
  REFERENCE_CARDINALITIES,
  REFERENCE_MODES,
} from "./automations.js";
import { OBJECT_KINDS } from "@synap-core/types/vocabulary";

/**
 * The `reference` param type — BEHAVIOURAL cover for the one piece of this
 * contract that is logic rather than shape.
 *
 * `action-option-parity.test.ts` (synap-app) pins the two vocabularies against
 * each other by source scan; it cannot see whether the door actually REJECTS a
 * half-declared reference. That refinement is what stops `type: "reference"`
 * reaching a client with no kind to list — a picker over nothing — so it gets a
 * test that runs the parse rather than reading the file.
 */

const base = { key: "assignee", label: "Assignee", required: true };
const option = (params: unknown) => ({
  key: "entity_update",
  label: "Update an entity",
  nodeType: "output" as const,
  params,
});

describe("actionOptionSchema — reference params", () => {
  it("accepts a fully declared reference param", () => {
    const parsed = actionOptionSchema.parse(
      option([
        {
          ...base,
          type: "reference",
          refKind: "person",
          refCardinality: "single",
        },
      ])
    );
    expect(parsed.params?.[0]).toMatchObject({
      type: "reference",
      refKind: "person",
      refCardinality: "single",
    });
  });

  it("rejects a reference param with no refKind", () => {
    const r = actionOptionSchema.safeParse(
      option([{ ...base, type: "reference", refCardinality: "single" }])
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("refKind");
  });

  it("rejects a reference param with no refCardinality", () => {
    // Absent cardinality is NOT defaulted to single: a multi-select rendered as
    // a lone picker silently truncates the author's intent.
    const r = actionOptionSchema.safeParse(
      option([{ ...base, type: "reference", refKind: "person" }])
    );
    expect(r.success).toBe(false);
  });

  it("rejects refKind on a param whose type is not reference", () => {
    // A producer that half-migrated. Failing here beats a client branching on
    // a kind that the type says does not apply.
    const r = actionOptionSchema.safeParse(
      option([{ ...base, type: "string", refKind: "person" }])
    );
    expect(r.success).toBe(false);
  });

  it("rejects a refKind that is not in the object-kind vocabulary", () => {
    const r = actionOptionSchema.safeParse(
      option([
        {
          ...base,
          type: "reference",
          refKind: "nonsense",
          refCardinality: "single",
        },
      ])
    );
    expect(r.success).toBe(false);
  });

  it("leaves every non-reference param exactly as it was (additive)", () => {
    // The whole change must be invisible to the five existing types.
    const params = [
      { key: "title", label: "Title", required: true },
      { key: "count", label: "Count", required: false, type: "number" },
      {
        key: "profileSlug",
        label: "Profile",
        required: false,
        type: "enum",
        options: ["person", "task"],
        description: "which kind of thing",
      },
    ];
    const parsed = actionOptionSchema.parse(option(params));
    expect(parsed.params).toEqual(params);
  });

  it("offers every object kind the vocabulary knows, and no bespoke list", () => {
    // 37 kinds today. The point of sourcing OBJECT_KINDS is that a new kind is
    // referenceable the moment it is registered, with no edit here.
    const kinds = Object.keys(OBJECT_KINDS);
    expect(kinds.length).toBeGreaterThan(30);
    for (const kind of kinds) {
      const r = actionOptionSchema.safeParse(
        option([
          {
            ...base,
            type: "reference",
            refKind: kind,
            refCardinality: "multiple",
          },
        ])
      );
      expect(r.success, kind).toBe(true);
    }
  });
});

describe("referenceValueSchema — the stored value", () => {
  it("accepts a bound value and keeps the kind with it", () => {
    const v = referenceValueSchema.parse({
      mode: "bound",
      refKind: "channel",
      value: [{ id: "c1", label: "#general" }],
    });
    expect(v).toEqual({
      mode: "bound",
      refKind: "channel",
      value: [{ id: "c1", label: "#general" }],
    });
  });

  it("accepts the UNBOUND ask mode — the point of the tagged union", () => {
    // "Ask me when it runs" is not expressible as a bare id, which is the
    // reason this is a union and not a string. If this ever regresses to a
    // plain id the mobile disambiguation flow has nothing to store.
    const v = referenceValueSchema.parse({
      mode: "ask",
      refKind: "person",
      prompt: "Who should I assign this to?",
    });
    expect(v.mode).toBe("ask");
  });

  it("carries the value as an array for BOTH cardinalities", () => {
    // Cardinality lives on the declaration; the value shape never changes, so
    // widening single → multiple is not a data migration.
    expect(
      referenceValueSchema.safeParse({
        mode: "bound",
        refKind: "task",
        value: [{ id: "t1" }, { id: "t2" }],
      }).success
    ).toBe(true);
  });

  it("rejects a bare id string", () => {
    expect(referenceValueSchema.safeParse("some-id").success).toBe(false);
  });

  it("rejects a bound value with nothing in it", () => {
    // `bound` means the author picked something. An empty array is `ask` badly
    // spelled, and would execute as a silent no-op.
    expect(
      referenceValueSchema.safeParse({
        mode: "bound",
        refKind: "task",
        value: [],
      }).success
    ).toBe(false);
  });

  it("rejects an unknown mode rather than falling through", () => {
    expect(
      referenceValueSchema.safeParse({
        mode: "maybe",
        refKind: "task",
        value: [],
      }).success
    ).toBe(false);
  });

  it("the exported vocabularies are the ones the schema enforces", () => {
    // A tuple nobody reads is how the third copy got there in the first place.
    for (const mode of REFERENCE_MODES) {
      const payload =
        mode === "bound"
          ? { mode, refKind: "task", value: [{ id: "t1" }] }
          : { mode, refKind: "task" };
      expect(referenceValueSchema.safeParse(payload).success, mode).toBe(true);
    }
    for (const cardinality of REFERENCE_CARDINALITIES) {
      const r = actionOptionSchema.safeParse(
        option([
          {
            ...base,
            type: "reference",
            refKind: "task",
            refCardinality: cardinality,
          },
        ])
      );
      expect(r.success, cardinality).toBe(true);
    }
  });
});
