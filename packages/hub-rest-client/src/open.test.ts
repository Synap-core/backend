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
});
