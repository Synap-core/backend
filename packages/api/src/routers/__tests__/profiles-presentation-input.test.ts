/**
 * `uiHints.presentation` is judged by the ONE parser on BOTH profile write
 * doors. Drives the routers' REAL input parsers (no hand-built schema): update
 * used to accept any record, so an invalid declaration reached the row.
 */
import { describe, it, expect } from "vitest";
import { profilesRouter } from "../profiles.js";

type Parser = { safeParse: (v: unknown) => { success: boolean } };
const inputOf = (name: "create" | "update"): Parser => {
  const proc = (
    profilesRouter._def.procedures as unknown as Record<
      string,
      { _def: { inputs: Parser[] } }
    >
  )[name]!;
  expect(proc._def.inputs.length).toBeGreaterThan(0);
  return proc._def.inputs[0]!;
};

const ID = "11111111-1111-4111-8111-111111111111";
const invalid = { presentation: { family: "not-a-family" } };
const valid = { presentation: { family: "media" } };

describe("profile uiHints.presentation is parsed on create and update", () => {
  it("update refuses an invalid presentation", () => {
    expect(inputOf("update").safeParse({ id: ID, uiHints: invalid }).success).toBe(
      false
    );
  });

  it("update accepts a valid one, and uiHints without presentation", () => {
    const update = inputOf("update");
    expect(update.safeParse({ id: ID, uiHints: valid }).success).toBe(true);
    expect(update.safeParse({ id: ID, uiHints: { icon: "x" } }).success).toBe(
      true
    );
  });

  it("create refuses the same invalid presentation", () => {
    expect(
      inputOf("create").safeParse({
        slug: "k",
        displayName: "K",
        uiHints: invalid,
      }).success
    ).toBe(false);
  });
});
