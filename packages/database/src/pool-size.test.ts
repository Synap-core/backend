/**
 * `DB_POOL_SIZE` is validated before it reaches postgres.js (`dbPoolSize`).
 * It used to be `parseInt(process.env.DB_POOL_SIZE || "50", 10)`: "abc" gave
 * NaN and "0" gave 0, both handed to the pool as its cap.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_DB_POOL_SIZE, dbPoolSize } from "./pool-size.js";

describe("dbPoolSize", () => {
  it("takes a positive integer", () => {
    expect(dbPoolSize("10")).toBe(10);
    expect(dbPoolSize("1")).toBe(1);
  });

  it("falls back to the default for anything else", () => {
    for (const raw of [undefined, "", "abc", "0", "-3"]) {
      expect(dbPoolSize(raw), String(raw)).toBe(DEFAULT_DB_POOL_SIZE);
    }
  });

  it("the default is the 50 the connection budget counts", () => {
    expect(DEFAULT_DB_POOL_SIZE).toBe(50);
  });
});
