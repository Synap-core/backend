/**
 * Every word the runs feed can emit (`RUN_STATUSES`) has a category in the
 * run machine `statusMark` reads, so no feed row renders muted and
 * humanized for want of a declaration. Iterates the feed's own list.
 */
import { describe, expect, it } from "vitest";
import { STATUS_MACHINES, statusMark } from "@synap-core/types/units";
import { RUN_STATUSES } from "./types.js";

describe("the run machine covers the runs feed", () => {
  it("declares a category for every feed status", () => {
    expect(RUN_STATUSES.length).toBeGreaterThan(5);
    for (const status of RUN_STATUSES) {
      expect(Object.hasOwn(STATUS_MACHINES.run, status), status).toBe(true);
      expect(statusMark("run", status)!.category, status).not.toBeNull();
    }
  });
});
