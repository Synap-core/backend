/**
 * Every message a module frame sends its host, parsed once
 * (`parseCellFrameMessage`). What is not ours, or is malformed, is null.
 */
import { describe, expect, it } from "vitest";
import {
  CELL_FRAME_MAX_ERROR_CHARS,
  parseCellBridgeMessage,
  parseCellFrameMessage,
} from "./index.js";

describe("the module frame's messages", () => {
  it("the handshake: ready and mounted", () => {
    expect(parseCellFrameMessage({ type: "synap:ready" })).toEqual({
      type: "synap:ready",
    });
    expect(parseCellFrameMessage({ type: "synap:mounted", extra: 1 })).toEqual({
      type: "synap:mounted",
    });
  });

  it("a resize is a height in (0, 10000]", () => {
    expect(
      parseCellFrameMessage({ type: "synap:resize", height: 320 })
    ).toEqual({ type: "synap:resize", height: 320 });
    expect(
      parseCellFrameMessage({ type: "synap:resize", height: 10_000 })
    ).toEqual({ type: "synap:resize", height: 10_000 });
    for (const height of [0, -1, 10_001, Infinity, Number.NaN, "x", null])
      expect(
        parseCellFrameMessage({ type: "synap:resize", height }),
        String(height)
      ).toBe(null);
  });

  it("an error is cut at 500 characters, and never empty", () => {
    const long = parseCellFrameMessage({
      type: "synap:error",
      message: "x".repeat(2_000),
    });
    expect(long?.type).toBe("synap:error");
    expect((long as { message: string }).message).toHaveLength(
      CELL_FRAME_MAX_ERROR_CHARS
    );
    expect(parseCellFrameMessage({ type: "synap:error" })).toEqual({
      type: "synap:error",
      message: "The view reported an error.",
    });
  });

  it("navigate carries a typed target, nothing else", () => {
    expect(
      parseCellFrameMessage({
        type: "synap:navigate",
        target: { type: "entity", id: "e1", secret: "x" },
      })
    ).toEqual({ type: "synap:navigate", target: { type: "entity", id: "e1" } });
    expect(
      parseCellFrameMessage({
        type: "synap:navigate",
        target: { type: "shell" },
      })
    ).toBe(null);
    expect(parseCellFrameMessage({ type: "synap:navigate", target: "x" })).toBe(
      null
    );
  });

  it("a toast's level is info unless it says error", () => {
    expect(
      parseCellFrameMessage({
        type: "synap:toast",
        message: "Saved",
        level: "warn",
      })
    ).toEqual({ type: "synap:toast", message: "Saved", level: "info" });
    expect(
      parseCellFrameMessage({
        type: "synap:toast",
        message: "No",
        level: "error",
      })
    ).toEqual({ type: "synap:toast", message: "No", level: "error" });
    expect(parseCellFrameMessage({ type: "synap:toast", message: " " })).toBe(
      null
    );
  });

  it("open-panel, surface:open and context-update keep their shapes", () => {
    expect(
      parseCellFrameMessage({
        type: "synap:open-panel",
        id: "1",
        panelType: "entity",
        resourceId: "e1",
      })
    ).toEqual({
      type: "synap:open-panel",
      id: "1",
      panelType: "entity",
      resourceId: "e1",
    });
    expect(
      parseCellFrameMessage({
        type: "synap:open-panel",
        id: "1",
        panelType: "settings",
        resourceId: "e1",
      })
    ).toBe(null);
    expect(
      parseCellFrameMessage({
        type: "synap:surface:open",
        surface: { kind: "object", objectKind: "entity", objectId: "e1" },
      })
    ).toEqual({
      type: "synap:surface:open",
      surface: { kind: "object", objectKind: "entity", objectId: "e1" },
    });
    expect(
      parseCellFrameMessage({ type: "synap:surface:open", surface: [] })
    ).toBe(null);
    expect(
      parseCellFrameMessage({ type: "synap:context-update", meta: { a: 1 } })
    ).toEqual({ type: "synap:context-update", meta: { a: 1 } });
  });

  it("the bridge messages are the page bridge's own parse (a subset, one rule)", () => {
    for (const data of [
      { type: "synap:query", id: "q1", operation: "entities.list", params: {} },
      {
        type: "synap:mutate",
        id: "m1",
        operation: "create_entity",
        payload: {},
      },
      { type: "synap:query", id: "", operation: "entities.list" },
      { type: "synap:query", id: "q1", operation: "x".repeat(101) },
    ])
      expect(parseCellFrameMessage(data)).toEqual(parseCellBridgeMessage(data));
  });

  it("anything else is not ours", () => {
    for (const data of [
      null,
      "synap:ready",
      [],
      { type: "synap:init" },
      { type: "webpackOk" },
      { type: 42 },
    ])
      expect(parseCellFrameMessage(data)).toBe(null);
  });
});
