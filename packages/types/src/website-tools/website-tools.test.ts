/**
 * Websites as tools: tagged AND http(s). Rules out a `javascript:`, `data:`
 * or `file:` link an agent tagged as a tool opening in one click, a tag that
 * only contains the word ("toolbox"), and a tool with no address.
 */
import { describe, expect, it } from "vitest";
import { hasToolTag, hostOf, websiteToolOf } from "./index.js";

const row = (
  url: unknown,
  tags: unknown = ["tool"],
  title: string | null = "Site"
) => ({
  id: "e1",
  title,
  properties: { url, tags },
});

describe("websiteToolOf", () => {
  it("is a tool when tagged and http(s)", () => {
    expect(websiteToolOf(row("https://figma.com"))).toEqual({
      id: "e1",
      name: "Site",
      url: "https://figma.com",
    });
    expect(websiteToolOf(row("http://localhost:3000/x"))?.url).toBe(
      "http://localhost:3000/x"
    );
  });

  it("never opens another scheme, even tagged", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "file:///etc/passwd",
      "synap://open/x",
    ]) {
      expect(websiteToolOf(row(url)), url).toBeNull();
    }
  });

  it("is not a tool untagged, or with no address", () => {
    expect(websiteToolOf(row("https://figma.com", ["reading"]))).toBeNull();
    expect(websiteToolOf(row(undefined))).toBeNull();
    expect(websiteToolOf(row("  "))).toBeNull();
  });

  it("names an untitled site by its host", () => {
    expect(
      websiteToolOf(row("https://www.linear.app/team", ["tool"], null))?.name
    ).toBe("linear.app");
  });
});

describe("hasToolTag / hostOf", () => {
  it("reads an array or a comma string, case and space blind; never a longer word", () => {
    expect(hasToolTag(["a", " TOOL "])).toBe(true);
    expect(hasToolTag("a, tool")).toBe(true);
    expect(hasToolTag("toolbox")).toBe(false);
    expect(hasToolTag(undefined)).toBe(false);
  });

  it("drops www, and gives back what does not parse", () => {
    expect(hostOf("https://www.figma.com/f")).toBe("figma.com");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
