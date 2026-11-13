/**
 * The OpenAPI document of the place door (`PlacementRequestDoc`, zod-openapi)
 * and its parser (`PlaceOnBoardRequestObject`, `@synap-core/types/whiteboard`)
 * are two zod instances, so one cannot be composed from the other. This pins
 * them to the same keys, level by level, so the document never drifts from
 * what the door accepts.
 */
import { describe, expect, it } from "vitest";
import { PlaceOnBoardRequestObject } from "@synap-core/types/whiteboard";
import { PlacementRequestDoc } from "./whiteboards.js";

const keys = (schema: unknown): string[] =>
  Object.keys((schema as { shape: Record<string, unknown> }).shape).sort();
const inner = (schema: unknown): unknown => {
  let s = schema as { unwrap?: () => unknown; element?: unknown };
  while (typeof s.unwrap === "function") s = s.unwrap() as typeof s;
  return (s as { element?: unknown }).element ?? s;
};
const field = (schema: unknown, name: string): unknown =>
  inner((schema as { shape: Record<string, unknown> }).shape[name]);

describe("PlacementRequestDoc documents what PlaceOnBoardRequestObject parses", () => {
  it("the request has the same fields", () => {
    expect(keys(PlacementRequestDoc)).toEqual(
      keys(PlaceOnBoardRequestObject)
    );
  });
  it("options has the same fields", () => {
    expect(keys(field(PlacementRequestDoc, "options"))).toEqual(
      keys(field(PlaceOnBoardRequestObject, "options"))
    );
  });
  it("an update has the same fields", () => {
    expect(keys(field(PlacementRequestDoc, "update"))).toEqual(
      keys(field(PlaceOnBoardRequestObject, "update"))
    );
  });
  it("is not vacuous: the key lists are real", () => {
    expect(keys(PlaceOnBoardRequestObject)).toContain("idempotencyKey");
    expect(keys(field(PlaceOnBoardRequestObject, "update"))).toContain("shapeId");
  });
});
