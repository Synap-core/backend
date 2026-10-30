import { describe, expect, it } from "vitest";
import {
  reviewToolRun,
  toolRunArguments,
  toolRunValue,
} from "./tool-run-model";

describe("toolRunValue", () => {
  it("a short value reads inline, whole", () => {
    expect(toolRunValue({ value: "cx23" })).toEqual({
      kind: "text",
      text: "cx23",
    });
    expect(toolRunValue({ value: 3 })).toEqual({ kind: "text", text: "3" });
  });

  it("a value of several lines is code, every line kept", () => {
    const script = "#cloud-config\npackages:\n  - curl";
    expect(toolRunValue({ value: script })).toEqual({
      kind: "code",
      text: script,
      lines: 3,
    });
  });

  it("a web address is a link; any other scheme stays text", () => {
    expect(toolRunValue({ value: "https://api.synap.live/x" })).toEqual({
      kind: "link",
      href: "https://api.synap.live/x",
      text: "api.synap.live/x",
    });
    expect(toolRunValue({ value: "javascript:alert(1)" }).kind).toBe("text");
  });

  it("a list of words is chips; a structure is its JSON, whole", () => {
    expect(toolRunValue({ value: ["ssh", 22] })).toEqual({
      kind: "list",
      items: ["ssh", "22"],
    });
    const nested = { labels: { env: "prod" } };
    expect(toolRunValue({ value: nested })).toEqual({
      kind: "code",
      text: JSON.stringify(nested, null, 2),
      lines: 5,
    });
  });

  it("booleans, empties and secrets are marks", () => {
    expect(toolRunValue({ value: true }).kind).toBe("yes");
    expect(toolRunValue({ value: false }).kind).toBe("no");
    for (const v of [null, undefined, "  ", [], {}]) {
      expect(toolRunValue({ value: v }).kind).toBe("empty");
    }
    expect(toolRunValue({ value: "tok", secret: true })).toEqual({
      kind: "secret",
    });
  });
});

describe("toolRunArguments", () => {
  it("keeps the pod's order; code and long text take the whole width", () => {
    const args = toolRunArguments({
      action: "Create server",
      parameters: [
        { key: "serverType", label: "Server type", value: "cx23" },
        { key: "userData", label: "User data", value: "a\nb" },
        { key: "note", label: "Note", value: "x".repeat(81) },
      ],
    });
    expect(args.map((a) => [a.key, a.wide])).toEqual([
      ["serverType", false],
      ["userData", true],
      ["note", true],
    ]);
  });
});

describe("reviewToolRun", () => {
  it("reads the call from the review, or nothing", () => {
    const run = { action: "Create server", parameters: [] };
    expect(reviewToolRun({ toolRun: run })).toBe(run);
    expect(reviewToolRun({})).toBeNull();
    expect(reviewToolRun({ toolRun: { action: 1 } })).toBeNull();
    expect(reviewToolRun(undefined)).toBeNull();
  });
});
