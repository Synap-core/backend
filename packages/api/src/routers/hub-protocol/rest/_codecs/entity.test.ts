import { describe, expect, it } from "vitest";
import { entityToWire } from "./entity.js";

describe("entityToWire Knowledge compatibility projection", () => {
  it("derives knowledgeForm for a legacy Knowledge row without removing ek_type", () => {
    const wire = entityToWire({
      id: "knowledge-1",
      type: "knowledge",
      userId: "user-1",
      properties: { ek_type: "gotcha" },
    });

    expect(wire.properties).toEqual({
      ek_type: "gotcha",
      knowledgeForm: "caution",
    });
  });

  it("does not project Knowledge fields onto other kinds", () => {
    const wire = entityToWire({
      id: "note-1",
      type: "note",
      userId: "user-1",
      properties: { ek_type: "gotcha" },
    });

    expect(wire.properties).toEqual({ ek_type: "gotcha" });
  });
});
