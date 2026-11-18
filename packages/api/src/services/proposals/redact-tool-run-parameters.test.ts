/**
 * A tool run's credential arguments never reach a reader: not in `data`, not in
 * the revision chain. Older revisions that replaced `parameters` WHOLE carry
 * the credential in `before` and `patch`; they are masked on read.
 *
 * NEGATIVE CONTROL: removing the `redactToolRunData(...)` or
 * `redactRevisionHistory(...)` call in routers/proposals/display.ts turns the
 * last two tests red; making `maskParameters` return its input turns the rest red.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  redactRevisionHistory,
  redactToolRunData,
} from "./redact-tool-run-parameters.js";
import { REDACTED_PARAM } from "./proposal-setup.js";

const none = new Set<string>();

describe("redactToolRunData", () => {
  it("masks a credential by name and by the verb's own mark, keeps the rest", () => {
    const data = {
      skillId: "s",
      parameters: { text: "hi", apiToken: "tok_1", pin: "1234", note: "" },
    };
    const out = redactToolRunData(data, new Set(["pin"]));
    expect(out.parameters).toEqual({
      text: "hi",
      apiToken: REDACTED_PARAM,
      pin: REDACTED_PARAM,
      note: "",
    });
    expect(JSON.stringify(out)).not.toMatch(/tok_1|1234/);
    // Never mutated: the stored row is untouched.
    expect(data.parameters.apiToken).toBe("tok_1");
  });

  it("returns data without parameters, or without a credential, as it was", () => {
    const a = { params: { apiKey: "k" } };
    expect(redactToolRunData(a, none)).toBe(a);
    const b = { parameters: { text: "hi" } };
    expect(redactToolRunData(b, none)).toBe(b);
  });
});

describe("redactRevisionHistory", () => {
  const whole = {
    at: "t",
    by: "u",
    before: { parameters: { text: "a", apiToken: "tok_old" } },
    patch: { parameters: { text: "b", apiToken: "tok_new" } },
  };
  it("masks the credential on both sides of a wholesale revision", () => {
    const out = redactRevisionHistory([whole], none);
    expect(JSON.stringify(out)).not.toMatch(/tok_old|tok_new/);
    expect(out[0]).toMatchObject({
      before: { parameters: { text: "a", apiToken: REDACTED_PARAM } },
      patch: { parameters: { text: "b", apiToken: REDACTED_PARAM } },
    });
    expect(whole.patch.parameters.apiToken).toBe("tok_new");
  });
  it("leaves other entries and a non-list alone", () => {
    const other = {
      at: "t",
      before: { _summary: "a" },
      patch: { _summary: "b" },
    };
    expect(redactRevisionHistory([other], none)[0]).toBe(other);
    expect(redactRevisionHistory(null, none)).toBeNull();
  });
});

describe("the read door applies them", () => {
  const src = readFileSync(
    new URL("../../routers/proposals/display.ts", import.meta.url),
    "utf8"
  );
  it("masks data.parameters before the request and the review are built", () => {
    expect(src).toMatch(
      /enrichedData = redactToolRunData\(enrichedData, toolRunSecretKeys\)/
    );
  });
  it("masks the revision chain it serves", () => {
    expect(src).toMatch(/revisionHistory: redactRevisionHistory\(/);
  });
});
