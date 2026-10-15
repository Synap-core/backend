/**
 * The light-read queue's worker count: a hosted reader run (Apify) can take
 * 120 s, so a bulk "Read N with X" must not run one item at a time — and a
 * bad env value must never mean zero workers (nothing would ever be read).
 */
import { describe, expect, it } from "vitest";
import {
  LIBRARY_LIGHT_READ_CONCURRENCY_DEFAULT,
  libraryLightReadConcurrency,
} from "./library-light-read-worker.js";

describe("libraryLightReadConcurrency", () => {
  it("defaults to several workers", () => {
    expect(LIBRARY_LIGHT_READ_CONCURRENCY_DEFAULT).toBeGreaterThan(1);
    expect(libraryLightReadConcurrency({})).toBe(
      LIBRARY_LIGHT_READ_CONCURRENCY_DEFAULT
    );
  });

  it("is env-tunable, capped, and never zero", () => {
    const at = (v: string) =>
      libraryLightReadConcurrency({ SYNAP_LIBRARY_LIGHT_READ_CONCURRENCY: v });
    expect(at("8")).toBe(8);
    expect(at("1")).toBe(1);
    expect(at("500")).toBe(16);
    for (const bad of ["0", "-2", "2.5", "lots", ""]) {
      expect(at(bad)).toBe(LIBRARY_LIGHT_READ_CONCURRENCY_DEFAULT);
    }
  });
});
