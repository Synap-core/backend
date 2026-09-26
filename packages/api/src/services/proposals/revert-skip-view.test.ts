import { describe, expect, it } from "vitest";
import { describeRevertTarget, revertSkipView } from "./revert-creations.js";

describe("revertSkipView — a kept field reads by its API name", () => {
  it("names the description by the field every door uses, never the preview column", () => {
    const view = revertSkipView({
      target: { kind: "entity_field", entityId: "e1", field: "preview" },
      reason: "edited_since",
      detail: "description was edited since",
    } as never);
    expect(view.key).toBe("description");
  });

  it("names the description the same way in a receipt's skip line", () => {
    expect(
      describeRevertTarget({
        kind: "entity_field",
        entityId: "e1",
        field: "preview",
        after: null,
      } as never)
    ).toBe("description of entity e1");
  });

  it("keeps the title key as-is", () => {
    const view = revertSkipView({
      target: { kind: "entity_field", entityId: "e1", field: "title" },
      reason: "edited_since",
      detail: "title was edited since",
    } as never);
    expect(view.key).toBe("title");
  });
});
