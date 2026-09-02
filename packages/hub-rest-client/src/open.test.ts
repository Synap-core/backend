import { describe, expect, it } from "vitest";
import { openAppUrl, openPath, openUrl } from "./open.js";

describe("portable open locator", () => {
  it("builds a bare-id https locator and strips a trailing slash", () => {
    expect(openUrl("https://pod.example.com/", "abc-1")).toBe(
      "https://pod.example.com/open/abc-1"
    );
  });

  it("encodes ids the desktop protocol also encodes", () => {
    expect(openPath("generated:board")).toBe("/open/generated%3Aboard");
    expect(openAppUrl("cell", "generated:board")).toBe(
      "synap://open/cell/generated%3Aboard"
    );
    expect(openAppUrl("proposal", "p 1")).toBe("synap://open/proposal/p%201");
  });

  it("matches the CLI desktop grammar synap://open/<kind>/<id>", () => {
    expect(openAppUrl("entity", "abc-1")).toBe("synap://open/entity/abc-1");
  });

  it("appends address params, which some kinds need to be resolvable at all", () => {
    // A run is addressed by {flowType, runId}: object-nav's `run` arm defaults a
    // missing flowType to 'automation', so a playbook run without the param
    // silently opens the wrong reader. `/resolve/:id` returns the param; this
    // producer is where it becomes part of the URL.
    expect(openAppUrl("run", "abc-1", { flowType: "playbook" })).toBe(
      "synap://open/run/abc-1?flowType=playbook"
    );
    // An empty params object must not mint a trailing "?".
    expect(openAppUrl("entity", "abc-1", {})).toBe("synap://open/entity/abc-1");
  });
});
