/**
 * `captures.list` / `captures.get` are reachable on the app router a client
 * calls (`AppRouter` = `coreRouter`), not merely defined in `captures.ts`.
 *
 * NOT covered: the HTTP mount of `coreRouter` itself (shared by every router).
 */

import { describe, it, expect } from "vitest";
import { coreRouter } from "../root.js";

describe("captures router reachability", () => {
  it("mounts captures.list and captures.get on coreRouter", () => {
    const procedures = Object.keys(coreRouter._def.procedures);
    // Non-vacuity: the scan sees the app router, not an empty record.
    expect(procedures).toContain("documents.list");
    expect(procedures).toEqual(
      expect.arrayContaining(["captures.list", "captures.get"])
    );
  });
});
