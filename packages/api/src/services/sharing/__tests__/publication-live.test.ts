/**
 * `isPublicationLive` — the one "served on the public web right now" rule.
 *
 * Each row names the older hand-written rule it rules out:
 *   - LISTING (share-service) ignored `publishedAt` and the kind;
 *   - PUBLISH (publish-service) checked `state` only, so a revoked or expired
 *     row counted as "republished";
 * and the scan below keeps a fourth copy from appearing in the sharing code.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPublicationLive,
  type PublicationLiveInput,
} from "../publication-live.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const LIVE: PublicationLiveInput = {
  audience: "public",
  resourceType: "entity",
  state: "published",
  revokedAt: null,
  expiresAt: null,
  publishedAt: new Date(NOW - 60_000),
  hasToken: true,
};

describe("isPublicationLive", () => {
  it("a published, unrevoked, unexpired entity with a url is live (positive control)", () => {
    expect(isPublicationLive(LIVE, NOW)).toBe(true);
    expect(
      isPublicationLive({ ...LIVE, expiresAt: new Date(NOW + 1) }, NOW)
    ).toBe(true);
  });

  it.each([
    ["no publishedAt (rules out the LISTING rule)", { publishedAt: null }],
    ["not an entity (rules out the LISTING rule)", { resourceType: "view" }],
    ["revoked (rules out the PUBLISH rule)", { revokedAt: new Date(NOW) }],
    ["expired (rules out the PUBLISH rule)", { expiresAt: new Date(NOW) }],
    ["no url yet (rules out the PUBLISH rule)", { hasToken: false }],
    ["unpublished", { state: "draft" }],
    ["not a public row", { audience: "link" }],
  ] as Array<[string, Partial<PublicationLiveInput>]>)(
    "%s ⇒ not live",
    (_l, patch) => {
      expect(isPublicationLive({ ...LIVE, ...patch }, NOW)).toBe(false);
    }
  );
});

describe("no second liveness rule in the sharing code", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const DIR = path.resolve(HERE, "..");
  const files = readdirSync(DIR).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts")
  );
  // A JS comparison on the state value; SQL filters (`eq(state, …)`) and
  // written values (`state: "published"`) are not a liveness decision.
  const COMPARES = /state\s*[!=]==\s*["']published["']/;

  it("self-check: the scan sees the files and the rule's own comparison", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(
      COMPARES.test(readFileSync(path.join(DIR, "publication-live.ts"), "utf8"))
    ).toBe(true);
  });

  it("only publication-live.ts compares a publication's state", () => {
    const offenders = files.filter(
      (f) =>
        f !== "publication-live.ts" &&
        COMPARES.test(readFileSync(path.join(DIR, f), "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
