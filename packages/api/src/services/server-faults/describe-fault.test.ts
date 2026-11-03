/**
 * `describeFault` — the shape a 5xx's cause is logged and stored in. Pure.
 */
import { describe, expect, it } from "vitest";
import { toSynapError } from "@synap-core/core";
import {
  describeFault,
  MAX_CAUSE_DEPTH,
  redactFaultText,
} from "./describe-fault.js";

describe("describeFault", () => {
  it("keeps a TypeError's own name, message and stack", () => {
    let thrown: unknown;
    try {
      void (undefined as unknown as { stages: unknown }).stages;
    } catch (e) {
      thrown = e;
    }
    const f = describeFault(thrown);
    expect(f.name).toBe("TypeError");
    expect(f.message).toMatch(/reading 'stages'/);
    expect(f.stack).toMatch(/^TypeError/);
    expect(f.causes).toEqual([]);
  });

  it("walks the cause chain, outermost first", () => {
    const root = new RangeError("pool exhausted");
    const mid = new Error("query failed", { cause: root });
    const top = new Error("apply failed", { cause: mid });
    const f = describeFault(top);
    expect(f.message).toBe("apply failed");
    expect(f.causes.map((c) => [c.name, c.message])).toEqual([
      ["Error", "query failed"],
      ["RangeError", "pool exhausted"],
    ]);
  });

  it("stops at a cycle and at the depth bound", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(describeFault(a).causes.map((c) => c.message)).toEqual(["b"]);

    let deep: Error = new Error("0");
    for (let i = 1; i < 20; i++) deep = new Error(String(i), { cause: deep });
    expect(describeFault(deep).causes).toHaveLength(MAX_CAUSE_DEPTH);
  });

  it("reads back the original a toSynapError wrapper kept as strings", () => {
    const original = new SyntaxError("Unexpected token");
    const f = describeFault(
      toSynapError(original, "An unexpected error occurred")
    );
    expect(f.name).toBe("InternalServerError");
    expect(f.causes[0]).toMatchObject({
      name: "SyntaxError",
      message: "Unexpected token",
    });
  });

  it("a non-error throw is still described", () => {
    expect(describeFault("boom")).toEqual({
      name: "string",
      message: "boom",
      stack: null,
      causes: [],
    });
  });
});

describe("redactFaultText", () => {
  it("cuts a Drizzle query's bound params, keeps its SQL", () => {
    expect(
      redactFaultText(
        'Failed query: select 1 from "users" where "email" = $1\nparams: ada@acme.com'
      )
    ).toBe(
      'Failed query: select 1 from "users" where "email" = $1\nparams: [redacted]'
    );
  });

  it("cuts URL credentials and bearer tokens", () => {
    expect(
      redactFaultText("GET https://x.io/v1?key=sk-1&q=a&token=t0 failed")
    ).toBe("GET https://x.io/v1?key=[redacted]&q=a&token=[redacted] failed");
    expect(redactFaultText("Authorization: Bearer abc.def-123")).toBe(
      "Authorization: Bearer [redacted]"
    );
  });
});
