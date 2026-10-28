import { describe, expect, it } from "vitest";
import { OBSERVATION_NAMESPACES } from "../events/unified.js";
import { EVENT_FAMILY_LABELS, resolveEventFamilyLabel } from "./index.js";

describe("resolveEventFamilyLabel — an activity family in words", () => {
  it("names every observation namespace, and only those", () => {
    expect(Object.keys(EVENT_FAMILY_LABELS)).toEqual([
      ...OBSERVATION_NAMESPACES,
    ]);
    expect(resolveEventFamilyLabel("dev")).toBe("Dev events");
    expect(resolveEventFamilyLabel("ci")).toBe("CI events");
    expect(resolveEventFamilyLabel("ci", "short")).toBe("CI");
  });

  it("humanizes an unknown family instead of leaking it", () => {
    expect(resolveEventFamilyLabel("deploy_log")).toBe("Deploy log events");
    expect(resolveEventFamilyLabel("deploy_log", "short")).toBe("Deploy log");
  });
});
