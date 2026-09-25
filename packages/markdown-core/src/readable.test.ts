import { describe, expect, it } from "vitest";
import { locateEmbeds, readableMarkdown } from "./readable.js";

const label = (e: { kind: string }) => `label:${e.kind}`;

describe("readableMarkdown — the one readable rule", () => {
  it("replaces an embed by its authored fallback, byte-for-byte around it", () => {
    const md = [
      "Before at 10:30.",
      "",
      ':::synap-cell{cellKey="chart-bar"}',
      "```json",
      '{"profileSlug":"task","label":"It\'s {x}"}',
      "```",
      "",
      "Tasks pile up in **Review**.",
      ":::",
      "",
      "After.",
    ].join("\n");
    expect(readableMarkdown(md, label)).toBe(
      "Before at 10:30.\n\nTasks pile up in **Review**.\n\nAfter."
    );
  });

  it("asks the caller to name an embed with no fallback (legacy form too)", () => {
    const md = [
      ':::synap-cell{cellKey="chart-bar" cellProps=\'{"a":1}\'}',
      ":::",
      "",
      ':::synap-entity{id="11111111-1111-4111-8111-111111111111"}',
      ":::",
    ].join("\n");
    expect(readableMarkdown(md, label)).toBe("*label:cell*\n\n*label:entity*");
  });

  it("leaves sections, fences and prose directives untouched", () => {
    const md =
      '::::synap-section{id="a" owner="ai"}\n## A\n\n```\n:::synap-cell{cellKey="x"}\n:::\n```\n::::\n';
    expect(locateEmbeds(md)).toEqual([]);
    expect(readableMarkdown(md, label)).toBe(md);
  });

  it("locates each embed with its source range", () => {
    const md = 'x\n\n:::synap-view{viewId="v1"}\nFallback.\n:::\n';
    const [one] = locateEmbeds(md);
    expect(one?.embed.kind).toBe("view");
    expect(md.slice(one!.start, one!.end)).toBe(
      ':::synap-view{viewId="v1"}\nFallback.\n:::'
    );
    expect(md.slice(one!.fallbackRange!.start, one!.fallbackRange!.end)).toBe(
      "Fallback."
    );
  });
});
