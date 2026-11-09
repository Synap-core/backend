import { describe, it, expect } from "vitest";
import { withDerivedLifecycleLists } from "./lifecycle-model.js";

const options = [
  { key: "new", category: "open" },
  { key: "done", category: "done" },
  { key: "prospect" },
];

describe("withDerivedLifecycleLists", () => {
  it("derives the pick-list (categorised keys) and the default from the one declaration", () => {
    const out = withDerivedLifecycleLists({
      constraints: { enumOptions: options, defaultValue: "prospect" },
      uiHints: { enumValues: ["prospect", "lost"], label: "Stage" },
      defaultValue: "new",
    });
    expect((out.uiHints as any).enumValues).toEqual(["new", "done"]);
    expect((out.uiHints as any).label).toBe("Stage");
    expect((out.constraints as any).defaultValue).toBe("new");
  });

  it("drops a stale stored default when the lifecycle has no initial status", () => {
    const out = withDerivedLifecycleLists({
      constraints: { enumOptions: options, defaultValue: "prospect" },
      defaultValue: null,
    });
    expect((out.constraints as any).defaultValue).toBeUndefined();
  });

  it("leaves a property with no option objects alone", () => {
    const p = { constraints: { enum: ["a"] }, defaultValue: "a" };
    expect(withDerivedLifecycleLists(p)).toBe(p);
  });
});
