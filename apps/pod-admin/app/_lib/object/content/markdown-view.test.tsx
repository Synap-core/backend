import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownView from "./markdown-view";

const UUID = "11111111-1111-4111-8111-111111111111";
const html = (source: string) =>
  renderToStaticMarkup(<MarkdownView source={source} />);

describe("MarkdownView — nothing in content runs", () => {
  it("raw HTML shows as the text it is", () => {
    const out = html(
      'Hello <script>alert(1)</script>\n\n<img src=x onerror="alert(2)">'
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;img");
  });

  it("a javascript: link is drawn as its words, with no href", () => {
    const out = html("[click me](javascript:alert(1))");
    expect(out).toContain("click me");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("href");
  });

  it("an outside link opens in a new tab without a referrer", () => {
    const out = html("[docs](https://example.com/docs)");
    expect(out).toContain('href="https://example.com/docs"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it("an image is named and linked, never loaded", () => {
    const out = html("![a chart](https://tracker.example/p.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain("Image: a chart");
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it("an object marker becomes its console page", () => {
    const out = html(
      `See [[entity:${UUID}|Ana]] and [[doc:${UUID}|the plan]].`
    );
    expect(out).toContain(`href="/open/entity/${UUID}"`);
    expect(out).toContain(`href="/open/document/${UUID}"`);
    expect(out).toContain(">Ana<");
    expect(out).not.toContain("synap://");
  });

  it("draws the Synap dialect: tasks, highlight, alerts, directives", () => {
    const out = html(
      [
        "- [x] done",
        "- [ ] open",
        "",
        "A ==key== word.",
        "",
        "> [!WARNING]",
        "> Careful.",
        "",
        ':::synap-section{id="s1"}',
        "Inside a section.",
        ":::",
      ].join("\n")
    );
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("disabled");
    expect(out).toContain("<mark");
    expect(out).toContain("Warning");
    expect(out).toContain("Careful.");
    expect(out).toContain("Inside a section.");
    expect(out).not.toContain(":::");
  });

  it("an embed reads as its fallback prose, never its config", () => {
    const out = html(
      [
        "Intro.",
        "",
        ':::synap-cell{cellKey="chart-bar"}',
        "```json",
        '{"profileSlug":"task"}',
        "```",
        "",
        "Tasks pile up in **Review**.",
        ":::",
      ].join("\n")
    );
    expect(out).toContain("Tasks pile up in");
    expect(out).not.toContain("profileSlug");
  });
});
