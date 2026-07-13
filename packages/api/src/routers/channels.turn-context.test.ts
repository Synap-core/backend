import { describe, expect, it } from "vitest";
import {
  redactTurnContext,
  TurnContextSchema,
  usesInternalSessionBoundary,
} from "./channels.js";
import { ChannelType } from "@synap/database";

describe("channels.sendMessage turnContext", () => {
  it("accepts a compact flat context and redacts sensitive entries", () => {
    const context = TurnContextSchema.parse({
      entries: [
        { key: "selectionIds", value: ["entity-1", "entity-2"] },
        { key: "viewMode", value: "compact" },
        { key: "apiToken", value: "never-persist-this" },
      ],
    });

    expect(redactTurnContext(context)).toEqual({
      entries: [
        { key: "selectionIds", value: ["entity-1", "entity-2"] },
        { key: "viewMode", value: "compact" },
        { key: "apiToken", value: "[redacted]" },
      ],
    });
  });

  it("rejects unknown fields, nested values, and oversized entry lists", () => {
    expect(() =>
      TurnContextSchema.parse({
        entries: [{ key: "viewMode", value: "compact", extra: true }],
      })
    ).toThrow();
    expect(() =>
      TurnContextSchema.parse({
        entries: [{ key: "selection", value: { ids: ["entity-1"] } }],
      })
    ).toThrow();
    expect(() =>
      TurnContextSchema.parse({
        entries: Array.from({ length: 21 }, (_, index) => ({
          key: `item${index}`,
          value: index,
        })),
      })
    ).toThrow();
    expect(() =>
      TurnContextSchema.parse({
        entries: [{ key: "title", value: "x".repeat(401) }],
      })
    ).toThrow();
    expect(() =>
      TurnContextSchema.parse({
        entries: Array.from({ length: 20 }, (_, index) => ({
          key: `longEntry${index}`,
          value: "x".repeat(400),
        })),
      })
    ).toThrow();
  });

  it("gives Personal turns an internal memory-session boundary", () => {
    expect(usesInternalSessionBoundary(ChannelType.PERSONAL)).toBe(true);
    expect(usesInternalSessionBoundary(ChannelType.FEED)).toBe(false);
  });
});
