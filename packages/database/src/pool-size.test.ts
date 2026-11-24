/**
 * `DB_POOL_SIZE` is validated before it reaches postgres.js (`dbPoolSize`).
 * It used to be `parseInt(process.env.DB_POOL_SIZE || "50", 10)`: "abc" gave
 * NaN and "0" gave 0, both handed to the pool as its cap.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DB_POOL_SIZE,
  dbPoolSize,
  readReplicaPoolSize,
} from "./pool-size.js";

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

describe("readReplicaPoolSize", () => {
  it("takes a positive integer from the env", () => {
    expect(readReplicaPoolSize("5")).toBe(5);
    expect(readReplicaPoolSize("1")).toBe(1);
  });

  it("falls back to half the writer cap (not less than 1)", () => {
    // Without an explicit env, the replica cap is half the writer cap.
    // Whatever DB_POOL_SIZE is (unset → 50 default), it must be half — never
    // larger than the writer, never less than 1.
    const writer = dbPoolSize();
    for (const raw of [undefined, "", "abc", "0", "-3"]) {
      expect(readReplicaPoolSize(raw), String(raw)).toBe(
        Math.max(1, Math.floor(writer / 2))
      );
    }
  });
});
