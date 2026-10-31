import { describe, expect, it } from "vitest";
import { createT } from "@synap-core/types/i18n";
import { SOURCE_CATALOGS } from "./copy";
import {
  lastTestLine,
  scopeLabel,
  testCouldNotRun,
  testOutcome,
  type SourceConfigRow,
} from "./source-config-model";

const t = createT("en", SOURCE_CATALOGS);

const ROW: SourceConfigRow = {
  id: "s1",
  providerType: "rss-direct",
  name: "News",
  enabled: true,
};

describe("testOutcome", () => {
  it("says what the probe returned: ok with a sample count", () => {
    expect(testOutcome({ ok: true, sampleCount: 12 }, t)).toEqual({
      kind: "ok",
      message: "The source answered with 12 items.",
    });
    expect(testOutcome({ ok: true, sampleCount: 1 }, t).message).toBe(
      "The source answered with 1 item."
    );
  });

  it("does not invent a count the probe did not give", () => {
    expect(testOutcome({ ok: true }, t)).toEqual({
      kind: "ok",
      message: "The source answered.",
    });
  });

  it("a failed probe is an error carrying the probe's own reason, never a success", () => {
    expect(testOutcome({ ok: false, error: "HTTP 401" }, t)).toEqual({
      kind: "error",
      message: "The source did not answer: HTTP 401",
    });
  });

  it("a failed probe with no reason still reads as a failure", () => {
    expect(testOutcome({ ok: false }, t).kind).toBe("error");
    expect(testOutcome({ ok: false, error: "  " }, t).message).toBe(
      "The source did not answer, and gave no reason."
    );
  });

  it("a call that threw is worded apart from a failed probe", () => {
    expect(testCouldNotRun("Network down", t)).toEqual({
      kind: "error",
      message: "Couldn’t run the test: Network down",
    });
  });
});

describe("lastTestLine", () => {
  it("never tested", () => {
    expect(lastTestLine(ROW, "2 h ago", t)).toBe("Never tested");
  });
  it("passed and failed, with the stored reason", () => {
    const base = { ...ROW, lastTestedAt: "2026-10-31T00:00:00Z" };
    expect(lastTestLine({ ...base, lastTestStatus: "ok" }, "2 h ago", t)).toBe(
      "Passed 2 h ago"
    );
    expect(
      lastTestLine(
        { ...base, lastTestStatus: "error", lastTestError: "timeout" },
        "2 h ago",
        t
      )
    ).toBe("Failed 2 h ago: timeout");
  });
});

describe("scopeLabel", () => {
  it("pod-wide, or one space by short id", () => {
    expect(scopeLabel(ROW, t)).toBe("Pod-level");
    expect(
      scopeLabel(
        { ...ROW, workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e" },
        t
      )
    ).toBe("Space 808939d1");
  });
});
