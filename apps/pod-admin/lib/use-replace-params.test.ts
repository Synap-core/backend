import { describe, expect, it } from "vitest";
import { editedHref } from "./use-replace-params";

describe("editedHref", () => {
  it("sets a param and keeps the others", () => {
    expect(
      editedHref("/runs", "focus=a&x=1", (p) => p.set("filter", "failing"))
    ).toBe("/runs?focus=a&x=1&filter=failing");
  });

  it("drops the ? when the query empties", () => {
    expect(editedHref("/review", "focus=a", (p) => p.delete("focus"))).toBe(
      "/review"
    );
  });

  it("does not mutate the caller's query", () => {
    const current = "type=access";
    editedHref("/review", current, (p) => p.delete("type"));
    expect(current).toBe("type=access");
  });
});
