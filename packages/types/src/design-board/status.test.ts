/**
 * Editability is derived from the kind's DECLARED lifecycle: the review's
 * verdict is the first person-only option that is not terminal, so a status at
 * or after it is read-only, and a terminal status is closed. The fixture is
 * the ui-design lifecycle as builder.yaml declares it (`design-status`), in
 * the shape `GET /api/hub/lifecycle` answers. Moved with the rule from app-bases
 * `apps/ui-gallery/src/design/__tests__/designStatus.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  designEditability,
  readDesignLifecycle,
  reviewGate,
  type DesignLifecycle,
} from "./status.js";

const wire = {
  profileSlug: "ui-design",
  profileKind: "kind",
  property: "design-status",
  options: [
    {
      key: "draft",
      label: "Draft",
      category: "open",
      tone: "neutral",
      humanOnly: false,
    },
    {
      key: "in-review",
      label: "In review",
      category: "active",
      tone: "neutral",
      humanOnly: false,
    },
    {
      key: "approved",
      label: "Approved",
      category: "active",
      tone: "neutral",
      humanOnly: true,
    },
    {
      key: "implementing",
      label: "Implementing",
      category: "active",
      tone: "neutral",
      humanOnly: false,
    },
    {
      key: "implemented",
      label: "Implemented",
      category: "done",
      tone: "neutral",
      humanOnly: false,
    },
    {
      key: "archived",
      label: "Archived",
      category: "lost",
      tone: "neutral",
      humanOnly: true,
    },
  ],
  initialStatus: "draft",
};
const uiDesign = readDesignLifecycle(wire);

describe("a design's editability, from the declared lifecycle", () => {
  it("the review's verdict is the first person-only option that is not terminal (archived is person-only too, but lost)", () => {
    expect(reviewGate(uiDesign)?.key).toBe("approved");
  });

  it("edited while it is worked on: draft and in review", () => {
    expect(designEditability("draft", uiDesign)).toEqual({
      editable: true,
      reason: "working",
    });
    expect(designEditability("in-review", uiDesign)).toEqual({
      editable: true,
      reason: "working",
    });
  });

  it("read-only from the review's verdict on: approved, implementing, implemented, archived", () => {
    for (const status of [
      "approved",
      "implementing",
      "implemented",
      "archived",
    ]) {
      const e = designEditability(status, uiDesign);
      expect(e).toMatchObject({
        editable: false,
        reason: "past-review",
        option: { key: status },
      });
    }
    // The label the canvas says it with is the pod's.
    expect(designEditability("approved", uiDesign)).toMatchObject({
      option: { label: "Approved" },
    });
  });

  it("follows the declaration, not names: a lifecycle that moves the person-only verdict moves the line", () => {
    const later: DesignLifecycle = {
      ...uiDesign,
      options: uiDesign.options.map((o) => ({
        ...o,
        humanOnly: o.key === "implementing",
      })),
    };
    expect(designEditability("approved", later)).toEqual({
      editable: true,
      reason: "working",
    });
    expect(designEditability("implementing", later)).toMatchObject({
      editable: false,
      reason: "past-review",
    });
  });

  it("a lifecycle with no person-only verdict: only a terminal status is closed", () => {
    const noGate: DesignLifecycle = {
      ...uiDesign,
      options: uiDesign.options.map((o) => ({ ...o, humanOnly: false })),
    };
    expect(reviewGate(noGate)).toBeNull();
    expect(designEditability("approved", noGate)).toEqual({
      editable: true,
      reason: "working",
    });
    expect(designEditability("implemented", noGate)).toMatchObject({
      editable: false,
      reason: "closed",
    });
    expect(designEditability("archived", noGate)).toMatchObject({
      editable: false,
      reason: "closed",
    });
  });

  it("no status, a status the lifecycle does not declare, or a canvas not in the pod yet: edited", () => {
    expect(designEditability(undefined, uiDesign)).toEqual({
      editable: true,
      reason: "unset",
    });
    expect(designEditability("shipped", uiDesign)).toEqual({
      editable: true,
      reason: "undeclared",
    });
    expect(designEditability("approved", null)).toEqual({
      editable: true,
      reason: "new",
    });
  });
});

describe("reading the pod's lifecycle answer", () => {
  it("keeps the declared order, the categories, the person-only marks and the initial status", () => {
    expect(
      uiDesign.options.map((o) => [o.key, o.category, o.humanOnly])
    ).toEqual([
      ["draft", "open", false],
      ["in-review", "active", false],
      ["approved", "active", true],
      ["implementing", "active", false],
      ["implemented", "done", false],
      ["archived", "lost", true],
    ]);
    expect(uiDesign.initialStatus).toBe("draft");
    expect(
      readDesignLifecycle({ ...wire, initialStatus: null }).initialStatus
    ).toBeNull();
  });

  it("an answer that is not a lifecycle THROWS: editability is never decided on it", () => {
    expect(() => readDesignLifecycle(null)).toThrow(/not a lifecycle/);
    expect(() => readDesignLifecycle({ options: "draft" })).toThrow(
      /not a lifecycle/
    );
    // No `property`: the reader cannot name the field a status is written to.
    expect(() =>
      readDesignLifecycle({ options: [{ key: "draft", category: "open" }] })
    ).toThrow(/not a lifecycle/);
    const p = "design-status";
    expect(() =>
      readDesignLifecycle({
        property: p,
        options: [{ key: "draft", category: "early" }],
      })
    ).toThrow(/known category/);
    expect(() =>
      readDesignLifecycle({ property: p, options: [{ category: "open" }] })
    ).toThrow(/known category/);
  });
});
