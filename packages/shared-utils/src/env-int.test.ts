import { describe, it, expect } from "vitest";
import { envInt } from "./env-int.js";

const B = { default: 4, min: 1, max: 16 };
const at = (v: string | undefined) => envInt({ X: v }, "X", B);

describe("envInt", () => {
  it("unset, empty or not a plain decimal integer → the default", () => {
    for (const v of [undefined, "", "  ", "4.5", "0x10", "-1", "abc", "1e3"]) {
      expect(at(v), String(v)).toBe(4);
    }
  });
  it("a value in range is read (trimmed)", () => {
    expect(at("7")).toBe(7);
    expect(at(" 9 ")).toBe(9);
  });
  it("below min → the default; above max → max", () => {
    expect(at("0")).toBe(4);
    expect(at("99")).toBe(16);
    expect(at("99999999999999999999")).toBe(4); // not a safe integer
  });
});
