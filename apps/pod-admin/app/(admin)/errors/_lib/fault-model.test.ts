import { describe, expect, it } from "vitest";
import {
  faultHeadline,
  faultRequest,
  readableMessage,
  rootCause,
  type FaultLike,
} from "./fault-model";

// The fault of errorId a74f6adc (2026-11-02) as the pod now stores it: the
// original ZodError is the error itself, not a string under a wrapper.
const ZOD_TEXT = JSON.stringify(
  [
    {
      origin: "string",
      code: "too_big",
      maximum: 5000,
      path: ["playbooks", 0, "stages", 2, "goal"],
      message: "Too big: expected string to have <=5000 characters",
    },
  ],
  null,
  2
);

const fault = (over: Partial<FaultLike> = {}): FaultLike => ({
  errorId: "a74f6adc-012e-4ef3-bf9f-26ac16da8746",
  occurredAt: "2026-11-02T17:14:27.499Z",
  door: "rest",
  method: "POST",
  path: "/api/hub/packages/apply",
  status: 500,
  errorName: "ZodError",
  message: ZOD_TEXT,
  stack: "ZodError: [ …",
  causes: [],
  ...over,
});

describe("readableMessage", () => {
  it("reads a validation error's issue list as field: message lines", () => {
    expect(readableMessage(ZOD_TEXT)).toBe(
      "playbooks[0].stages[2].goal: Too big: expected string to have <=5000 characters"
    );
  });

  it("keeps any other text as written", () => {
    expect(readableMessage("Cannot read properties of undefined")).toBe(
      "Cannot read properties of undefined"
    );
    expect(readableMessage("[not json")).toBe("[not json");
    expect(readableMessage('[{"code":1}]')).toBe('[{"code":1}]');
  });
});

describe("rootCause / faultHeadline", () => {
  it("names the error itself when it has no cause", () => {
    expect(faultHeadline(fault())).toBe(
      "ZodError: playbooks[0].stages[2].goal: Too big: expected string to have <=5000 characters"
    );
  });

  it("names the innermost cause, never the wrapper", () => {
    const f = fault({
      errorName: "InternalServerError",
      message: "An unexpected error occurred",
      causes: [
        { name: "DrizzleQueryError", message: "Failed query: insert …" },
        { name: "PostgresError", message: "duplicate key value" },
      ],
    });
    expect(rootCause(f).name).toBe("PostgresError");
    expect(faultHeadline(f)).toBe("PostgresError: duplicate key value");
  });

  it("caps a long line", () => {
    const f = fault({ errorName: "Error", message: "x".repeat(400) });
    expect(faultHeadline(f, 50)).toHaveLength(50);
  });
});

describe("faultRequest", () => {
  it("is the method and path, or a dash", () => {
    expect(faultRequest(fault())).toBe("POST /api/hub/packages/apply");
    expect(faultRequest(fault({ method: null, path: null }))).toBe("—");
  });
});
