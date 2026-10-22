import { describe, expect, it } from "vitest";
import {
  findPgError,
  isForeignKeyViolation,
  isNotNullViolation,
  isUniqueViolation,
  uniqueViolationConstraint,
} from "./pg-errors.js";

/** A driver error wrapped the way drizzle (cause) and then tRPC (cause) wrap it. */
function wrapped(driver: Record<string, unknown>, levels: number): unknown {
  let err: unknown = Object.assign(new Error("driver"), driver);
  for (let i = 0; i < levels; i++) {
    err = Object.assign(new Error(`wrap ${i}`), {
      code: i === levels - 1 ? "INTERNAL_SERVER_ERROR" : undefined,
      cause: err,
    });
  }
  return err;
}

describe("pg-errors — the one door for integrity violations", () => {
  it("finds the violation at the top and through drizzle + tRPC wrapping", () => {
    for (const levels of [0, 1, 2, 3]) {
      expect(isUniqueViolation(wrapped({ code: "23505" }, levels))).toBe(true);
      expect(isForeignKeyViolation(wrapped({ code: "23503" }, levels))).toBe(
        true
      );
      expect(isNotNullViolation(wrapped({ code: "23502" }, levels))).toBe(true);
    }
  });

  it("tells the codes apart and refuses non-errors", () => {
    const fk = wrapped({ code: "23503" }, 1);
    expect(isUniqueViolation(fk)).toBe(false);
    expect(isNotNullViolation(fk)).toBe(false);
    for (const v of [null, undefined, "23505", 23505, {}]) {
      expect(isUniqueViolation(v)).toBe(false);
    }
  });

  it("names the constraint for postgres.js (constraint_name) and PGlite (constraint)", () => {
    expect(
      uniqueViolationConstraint(
        wrapped({ code: "23505", constraint_name: "a_uidx" }, 2)
      )
    ).toBe("a_uidx");
    expect(
      uniqueViolationConstraint(
        wrapped({ code: "23505", constraint: "b_uidx" }, 1)
      )
    ).toBe("b_uidx");
    expect(uniqueViolationConstraint(wrapped({ code: "23505" }, 1))).toBe(
      undefined
    );
    expect(
      uniqueViolationConstraint(wrapped({ code: "23503", constraint: "fk" }, 1))
    ).toBe(undefined);
  });

  it("returns the level that carries the code", () => {
    const err = wrapped({ code: "23505", constraint: "c" }, 2);
    expect(findPgError(err, "23505")).toMatchObject({
      code: "23505",
      constraint: "c",
    });
    expect(findPgError(err, "23503")).toBe(undefined);
  });
});
