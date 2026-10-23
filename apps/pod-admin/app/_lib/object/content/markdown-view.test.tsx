import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownView from "./markdown-view";
import { EmbedHostContext } from "./embed-context";
import type { EmbedEntityRead } from "./markdown-model";

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

describe("MarkdownView — measure", () => {
  it("keeps the 65-character measure by default", () => {
    const html = renderToStaticMarkup(<MarkdownView source="Hello" />);
    expect(html).toContain("max-w-[65ch]");
  });

  it("a wide body (a document) drops the measure and uses its card", () => {
    const html = renderToStaticMarkup(
      <MarkdownView source="Hello" measure="wide" />
    );
    expect(html).toContain("max-w-none");
    expect(html).not.toContain("max-w-[65ch]");
  });
});

const embed = (
  directive: string,
  attrs: string,
  props?: unknown,
  fallback = ""
) =>
  [
    `:::${directive}{${attrs}}`,
    ...(props === undefined ? [] : ["```json", JSON.stringify(props), "```"]),
    ...(fallback ? ["", fallback] : []),
    ":::",
  ].join("\n");
const count = (out: string, needle: string) => out.split(needle).length - 1;

describe("MarkdownView — embeds are drawn from the shared model", () => {
  it("a snapshot bar chart is an SVG with one bar per value, on one scale", () => {
    const out = html(
      embed(
        "synap-cell",
        'cellKey="chart-bar"',
        {
          label: "Tasks by status",
          capturedAt: "2026-10-01T00:00:00Z",
          data: [
            { label: "Done", value: 12 },
            { label: "In progress", value: 6 },
            { label: "Blocked", value: 3 },
          ],
        },
        "Most tasks are done."
      )
    );
    expect(count(out, 'data-chart="categories"')).toBe(1);
    expect(count(out, "<rect")).toBe(3);
    expect(count(out, "data-mark")).toBe(3);
    expect(out).toContain('width="100"'); // the largest bar spans the scale
    expect(out).toContain('width="50"'); // 6 of 12
    expect(out).toContain('width="25"'); // 3 of 12
    expect(out).toContain("Tasks by status");
    expect(out).toContain("Snapshot · ");
    expect(out).toContain('role="img"');
    expect(out).toContain(
      'aria-label="Tasks by status: Done 12, In progress 6, Blocked 3"'
    );
    expect(out).toContain("Most tasks are done.");
    expect(out).not.toContain("profileSlug");
  });

  it("a snapshot line chart draws one dot per point", () => {
    const out = html(
      embed("synap-cell", 'cellKey="chart-line"', {
        data: [
          { x: "2026-09-01", y: 4 },
          { x: "2026-09-08", y: 7 },
          { x: "2026-09-15", y: 5 },
          { x: "2026-09-22", y: 9 },
        ],
      })
    );
    expect(count(out, 'data-chart="series"')).toBe(1);
    expect(count(out, "<circle")).toBe(4);
    expect(count(out, "data-mark")).toBe(4);
    expect(out).toContain("<path");
  });

  it("a malformed snapshot shows the error, not an empty chart", () => {
    const out = html(
      embed(
        "synap-cell",
        'cellKey="chart-bar"',
        { data: "oops" },
        "Prose stays."
      )
    );
    expect(out).toContain("can’t be drawn");
    expect(out).toContain("data must be an array of {label, value} items");
    expect(out).not.toContain("data-chart");
    expect(out).not.toContain("data-mark");
    expect(out).toContain("Prose stays.");
  });

  it("a generated cell is a named chip — no iframe, no script, no chart", () => {
    const out = html(
      embed(
        "synap-cell",
        'cellKey="generated:weekly-pulse"',
        { data: [{ label: "A", value: 1 }], html: "<script>alert(1)</script>" },
        "The pulse is steady."
      )
    );
    expect(out).toContain("Weekly pulse");
    expect(out).toContain("· Card");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("data-chart");
    expect(out).toContain("The pulse is steady.");
  });

  it("a live chart is a quiet chip, its prose under it", () => {
    const out = html(
      embed(
        "synap-cell",
        'cellKey="chart-line"',
        { profileSlug: "task" },
        "Trend up."
      )
    );
    expect(out).toContain("Line Chart");
    expect(out).toContain("· Live chart");
    expect(out).not.toContain("data-chart");
    expect(out).toContain("Trend up.");
  });

  it("an entity embed is a link to its console page", () => {
    const out = html(embed("synap-entity", `id="${UUID}"`));
    expect(out).toContain(`href="/open/entity/${UUID}"`);
  });

  it("an entity's title shows only when the reader's own read returns it", () => {
    const withRead = (read: EmbedEntityRead) =>
      renderToStaticMarkup(
        <EmbedHostContext.Provider value={{ useEntity: () => read }}>
          <MarkdownView
            source={embed("synap-entity", `id="${UUID}" label="Ana"`)}
          />
        </EmbedHostContext.Provider>
      );
    const ready = withRead({ state: "ready", title: "Ana Lopez" });
    expect(ready).toContain("Ana Lopez");
    expect(ready).toContain(`href="/open/entity/${UUID}"`);
    const hidden = withRead({ state: "hidden" });
    expect(hidden).toContain("isn’t visible to you");
    expect(hidden).not.toContain("Ana");
    expect(hidden).not.toContain("href");
    const failed = withRead({ state: "failed", retry: () => {} });
    expect(failed).toContain("couldn’t be loaded");
    expect(failed).toContain("Try again");
  });
});
