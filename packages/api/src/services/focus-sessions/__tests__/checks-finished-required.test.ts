/**
 * finding 1bff8284: a `ci.finished` of a workflow that is not CI (Depends-On,
 * merge bot) is not "checks finished", and the feed carries the producer's
 * required-checks verdict so a reader says "passed" only for `green`.
 */
import { describe, expect, it } from "vitest";
import { checksOf } from "../checks-finished.js";

const base = {
  status: "success",
  sha: "bead001",
  repo: "Synap-core/backend",
  pr: 584,
};

describe("checksOf", () => {
  it("#584 shape: a Depends-On success settles nothing", () => {
    expect(checksOf({ ...base, workflow: "Depends-On" })).toBeNull();
  });

  it("a CI run carries its required-checks verdict", () => {
    const c = checksOf({
      ...base,
      workflow: "CI",
      requiredChecks: { verdict: "pending", pending: ["Full suite"] },
    });
    expect(c?.requiredChecks).toEqual({
      verdict: "pending",
      pending: ["Full suite"],
    });
  });

  it("a CI run with no verdict reads null, never green", () => {
    expect(checksOf({ ...base, workflow: "CI" })?.requiredChecks).toBeNull();
    expect(
      checksOf({ ...base, workflow: "CI", requiredChecks: { verdict: "ok" } })
        ?.requiredChecks
    ).toBeNull();
  });

  it("a devbox gate job still counts", () => {
    expect(
      checksOf({ ...base, pr: undefined, workflow: "devbox be-file-x" })?.job
    ).toBe("be-file-x");
  });
});
