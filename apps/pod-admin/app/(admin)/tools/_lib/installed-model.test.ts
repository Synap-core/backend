import { describe, expect, it } from "vitest";
import { toolGroups, type CardLike } from "./installed-model";

function card(over: Partial<CardLike> = {}): CardLike {
  return {
    id: "c1",
    name: "Gmail",
    status: "partial",
    source: "installed",
    verbs: [
      {
        verbId: "gmail_send",
        skillId: "s1",
        label: "gmail_send",
        type: "action",
        enabled: false,
      },
      {
        verbId: "gmail_read",
        skillId: "s2",
        label: "gmail_read",
        type: "read",
        enabled: true,
      },
    ],
    ...over,
  };
}

describe("toolGroups", () => {
  it("keeps installed cards with toggleable verbs, off first", () => {
    const groups = toolGroups([
      card({
        id: "on",
        name: "All on",
        verbs: [
          {
            verbId: "x",
            skillId: "s9",
            label: "x",
            type: "read",
            enabled: true,
          },
        ],
      }),
      card(),
      card({ id: null, name: "Template", source: "available" }),
      card({ id: "empty", name: "Empty", verbs: [] }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["c1", "on"]);
    expect(groups[0]!.verbs.map((v) => v.enabled)).toEqual([false, true]);
    expect(groups[0]!.off).toBe(1);
  });
});
