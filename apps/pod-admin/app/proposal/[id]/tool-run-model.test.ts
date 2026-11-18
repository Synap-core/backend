import { describe, expect, it } from "vitest";
import {
  changedDrafts,
  reviewToolRun,
  toolRunArguments,
  toolRunSplit,
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

describe("the card shows what the tool does", () => {
  const post = {
    action: "Publish post",
    tool: "LinkedIn",
    parameters: [
      {
        key: "accountId",
        label: "Account",
        value: "9b2d7a1c-3f4e-4c1a-8f00-2f6f6d1e0a11",
      },
      { key: "text", label: "Text", value: "Hello world" },
      { key: "apiKey", label: "Api key", secret: true as const },
      { key: "visibility", label: "Visibility", value: "public" },
    ],
  };

  it("leads with the text; ids and credentials wait behind Details", () => {
    const { shown, detail } = toolRunSplit(post);
    expect(shown.map((a) => a.key)).toEqual(["text", "visibility"]);
    expect(detail.map((a) => a.key).sort()).toEqual(["accountId", "apiKey"]);
  });

  it("only text can be edited: never an id, a credential or a link", () => {
    const args = toolRunArguments({
      ...post,
      parameters: [
        ...post.parameters,
        { key: "url", label: "Link", value: "https://example.com/a" },
      ],
    });
    expect(args.filter((a) => a.editable).map((a) => a.key)).toEqual([
      "text",
      "visibility",
    ]);
  });

  it("sends only the drafts that differ from what was proposed", () => {
    expect(
      changedDrafts(post, {
        text: "Hello, LinkedIn",
        visibility: "public",
        accountId: "other",
        apiKey: "x",
        nope: "y",
      })
    ).toEqual({ text: "Hello, LinkedIn" });
    expect(changedDrafts(post, { text: "Hello world" })).toEqual({});
  });
});
