import { describe, expect, it } from "vitest";
import { resolveTargetName } from "./proposal-utils.js";
import { resolveObjectNoun } from "../vocabulary/index.js";

describe("resolveTargetName — never an id as a name (dogfood-2 #10)", () => {
  it("no name anywhere: the kind's noun, not `<type> · <shortId>`", () => {
    const name = resolveTargetName({ targetType: "playbook", targetId: "368aae92-1111-2222-3333-444455556666" });
    expect(name).toBe(resolveObjectNoun("playbook"));
    expect(name).not.toMatch(/[0-9a-f]{8}/);
  });
  it("a payload name still wins", () => {
    expect(resolveTargetName({ targetType: "playbook", targetId: "x", entityPayload: { name: "Win a deal" } })).toBe("Win a deal");
  });
});
