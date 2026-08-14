import { describe, expect, it } from "vitest";
import { entityToWire, CreateEntityRequestSchema } from "./entity.js";

describe("CreateEntityRequestSchema externalId (B1 contract)", () => {
  it("accepts an optional externalId `provider:id` anchor", () => {
    const parsed = CreateEntityRequestSchema.parse({
      title: "Ada Lovelace",
      profileSlug: "person",
      externalId: "discord:123456789012345678",
    });
    expect(parsed.externalId).toBe("discord:123456789012345678");
  });

  it("stays backward-compatible — externalId is optional", () => {
    const parsed = CreateEntityRequestSchema.parse({
      title: "Ada Lovelace",
      profileSlug: "person",
    });
    expect(parsed.externalId).toBeUndefined();
  });
});

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
