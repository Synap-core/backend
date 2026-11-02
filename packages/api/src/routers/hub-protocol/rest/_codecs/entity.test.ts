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

describe("entityToWire lifecycle status", () => {
  it("projects status and statusCategory from a DB row, snake_case twin too", () => {
    expect(
      entityToWire({
        id: "d-1",
        type: "deal",
        userId: "u",
        properties: {},
        status: "negotiation",
        statusCategory: "active",
      })
    ).toMatchObject({ status: "negotiation", statusCategory: "active" });
    expect(
      entityToWire({
        id: "d-2",
        type: "deal",
        userId: "u",
        properties: {},
        status: "won",
        status_category: "done",
      })
    ).toMatchObject({ status: "won", statusCategory: "done" });
  });

  it("a row with null columns reads null; a row without the keys carries no key", () => {
    const nulls = entityToWire({
      id: "n-1",
      type: "note",
      userId: "u",
      properties: {},
      status: null,
      statusCategory: null,
    });
    expect(nulls.status).toBeNull();
    expect(nulls.statusCategory).toBeNull();
    const doc = entityToWire({
      id: "n-2",
      type: "note",
      userId: "u",
      properties: {},
    });
    expect("status" in doc).toBe(false);
    expect("statusCategory" in doc).toBe(false);
  });
});
