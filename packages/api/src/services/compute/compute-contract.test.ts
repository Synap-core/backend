/**
 * THE COMPUTE CONTRACT (plan a640c5bb B3; founder 18 Nov 2026): a start
 * carries a REQUIRED time to live and spend maximum and names the release
 * verb that ends it; a release names its machine and a mode its verb serves.
 * Each refusal row rules out one way a start nobody can end, or a destroy
 * nobody asked for, would get through.
 */
import { describe, expect, it } from "vitest";
import {
  describeComputeDuration,
  describeComputeStart,
  readComputeRun,
  resourceIdOf,
} from "./compute-contract.js";

const provision = (metadata: unknown = { compute: { releaseVerb: "cloud_delete" } }) => ({
  name: "cloud_create",
  intent: "provision_compute",
  metadata,
});
const release = (modes: unknown = ["destroy"]) => ({
  name: "cloud_delete",
  intent: "release_compute",
  metadata: { compute: { modes } },
});

describe("readComputeRun — a start", () => {
  it("a start with both terms and a release verb is a start", () => {
    expect(
      readComputeRun(provision(), { ttlMinutes: 120, maxSpendCents: 300, size: "cx22" })
    ).toEqual({
      kind: "start",
      ttlMinutes: 120,
      maxSpendCents: 300,
      releaseVerb: "cloud_delete",
    });
    // A string of digits is a whole number (an agent's JSON may quote it).
    expect(
      readComputeRun(provision(), { ttlMinutes: "60", maxSpendCents: "10" })
    ).toMatchObject({ kind: "start", ttlMinutes: 60, maxSpendCents: 10 });
  });

  it.each([
    ["no ttl", { maxSpendCents: 300 }, /ttlMinutes/],
    ["no maximum", { ttlMinutes: 60 }, /maxSpendCents/],
    ["neither", {}, /ttlMinutes .* and maxSpendCents/],
    ["a zero ttl", { ttlMinutes: 0, maxSpendCents: 300 }, /ttlMinutes/],
    ["a negative maximum", { ttlMinutes: 60, maxSpendCents: -5 }, /maxSpendCents/],
    ["a fractional ttl", { ttlMinutes: 1.5, maxSpendCents: 300 }, /ttlMinutes/],
    ["a ttl past a year", { ttlMinutes: 525_601, maxSpendCents: 300 }, /ttlMinutes/],
    ["a word for a ttl", { ttlMinutes: "two hours", maxSpendCents: 300 }, /ttlMinutes/],
  ])("refuses %s", (_label, params, why) => {
    const run = readComputeRun(provision(), params);
    expect(run.kind).toBe("refused");
    expect((run as { message: string }).message).toMatch(why);
    expect((run as { message: string }).message).toMatch(/Nothing was started/);
  });

  it("refuses a start whose verb names no release verb, whatever its terms", () => {
    for (const metadata of [null, {}, { compute: {} }, { compute: { modes: ["destroy"] } }]) {
      const run = readComputeRun(provision(metadata), {
        ttlMinutes: 60,
        maxSpendCents: 300,
      });
      expect(run.kind).toBe("refused");
      expect((run as { message: string }).message).toMatch(/release verb/);
    }
  });
});

describe("readComputeRun — a release", () => {
  it("a destroy through a destroy verb is a release", () => {
    expect(
      readComputeRun(release(), { resourceId: 42, mode: "destroy" })
    ).toEqual({ kind: "release", resourceId: "42", mode: "destroy" });
  });

  it("a stop through a destroy-only verb is refused: a destroy never runs for a stop", () => {
    const run = readComputeRun(release(["destroy"]), {
      resourceId: "42",
      mode: "stop",
    });
    expect(run.kind).toBe("refused");
    expect((run as { message: string }).message).toMatch(/does not stop/);
  });

  it.each([
    ["no machine id", { mode: "destroy" }, /resourceId/],
    ["no mode", { resourceId: "42" }, /mode/],
    ["an unknown mode", { resourceId: "42", mode: "pause" }, /mode/],
  ])("refuses %s", (_label, params, why) => {
    const run = readComputeRun(release(), params);
    expect(run.kind).toBe("refused");
    expect((run as { message: string }).message).toMatch(why);
  });

  it("refuses a release verb that declares no modes", () => {
    const run = readComputeRun(
      { name: "cloud_delete", intent: "release_compute", metadata: {} },
      { resourceId: "42", mode: "destroy" }
    );
    expect(run.kind).toBe("refused");
  });
});

describe("readComputeRun — anything else", () => {
  it("a verb of another intent is not a compute run, whatever it carries", () => {
    expect(
      readComputeRun(
        { name: "x", intent: "run_external_job", metadata: { compute: { releaseVerb: "y" } } },
        {}
      )
    ).toEqual({ kind: "none" });
    expect(readComputeRun({ name: "x", intent: null, metadata: null }, {})).toEqual({
      kind: "none",
    });
  });
});

describe("the review card's words", () => {
  it("says how long, at most what, and that it ends by itself", () => {
    expect(
      describeComputeStart("Hetzner Cloud", { ttlMinutes: 150, maxSpendCents: 1234 })
    ).toBe(
      "Start a cloud machine (Hetzner Cloud) for 2 h 30 min, spending at most 12.34 in the provider's currency. It is destroyed automatically after 2 h 30 min."
    );
  });

  it("durations read as a person says them", () => {
    expect(describeComputeDuration(45)).toBe("45 min");
    expect(describeComputeDuration(120)).toBe("2 h");
    expect(describeComputeDuration(1440)).toBe("1 day");
    expect(describeComputeDuration(4320)).toBe("3 days");
  });

  it("reads the machine id from a start's result, never invents one", () => {
    expect(resourceIdOf({ resourceId: 42 })).toBe("42");
    expect(resourceIdOf({ resourceId: " abc " })).toBe("abc");
    expect(resourceIdOf({ server: { id: 42 } })).toBeNull();
    expect(resourceIdOf({ resourceId: "" })).toBeNull();
    expect(resourceIdOf(null)).toBeNull();
  });
});
