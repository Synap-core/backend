import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownView from "./markdown-view";
import { EmbedHostContext } from "./embed-context";
import type { EmbedEntityRead, ObjectRefRead } from "./markdown-model";

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

  // The founder's report (document dad7e3cb, 3 Nov 2026) drew these two as a
  // table and as bar rows.
  it("a snapshot composed chart draws bars and a line with its legend, not a table", () => {
    const out = html(
      embed("synap-cell", 'cellKey="chart-composed"', {
        label: "Jobs run per day vs minutes over the wait target (light queue)",
        barLabel: "Jobs run",
        lineLabel: "Minutes over target",
        data: [
          { x: "30 Oct", bar: 567, line: 44 },
          { x: "31 Oct", bar: 468, line: 18 },
          { x: "1 Nov", bar: 367, line: 37 },
          { x: "2 Nov", bar: 616, line: 294 },
        ],
        capturedAt: "2026-11-03T00:05:00Z",
      })
    );
    expect(count(out, 'data-chart="composed"')).toBe(1);
    expect(out).not.toContain("<table");
    expect(count(out, "<rect")).toBe(4);
    expect(count(out, "<circle")).toBe(4);
    expect(count(out, "data-mark")).toBe(8);
    expect(count(out, "<path")).toBe(1);
    // Legend and both scales' ticks.
    expect(out).toContain("Jobs run");
    expect(out).toContain("Minutes over target");
    expect(out).toContain((616).toLocaleString());
    expect(out).toContain(">294<");
    expect(out).toContain("30 Oct");
    expect(out).toContain("2 Nov");
    expect(out).toContain('role="img"');
    expect(out).toContain(
      `aria-label="Jobs run per day vs minutes over the wait target (light queue): 30 Oct Jobs run ${(567).toLocaleString()}, Minutes over target 44; `
    );
  });

  it("a snapshot pie draws a donut with one segment per share and a legend, not bars", () => {
    const out = html(
      embed("synap-cell", 'cellKey="chart-pie"', {
        label: "How the account moves happened (all moves on record)",
        groupBy: "trigger",
        data: [
          { label: "After a crash (failed turn)", value: 347 },
          { label: "Cleanly, at the end of a turn", value: 7 },
        ],
        capturedAt: "2026-11-03T00:05:00Z",
      })
    );
    expect(count(out, 'data-chart="categories"')).toBe(1);
    expect(out).not.toContain("<rect");
    expect(out).not.toContain("<table");
    expect(count(out, "data-mark")).toBe(2);
    expect(count(out, "stroke-dasharray")).toBe(2);
    expect(out).toContain("var(--synap-identity-1)");
    expect(out).toContain("var(--synap-identity-2)");
    expect(out).toContain("After a crash (failed turn)");
    expect(out).toContain("347 · 98%");
    expect(out).toContain("7 · 2%");
    expect(out).toContain(
      'aria-label="How the account moves happened (all moves on record): After a crash (failed turn) 347 (98%), Cleanly, at the end of a turn 7 (2%)"'
    );
  });

  it("a pie whose values add up to zero draws no segment and no NaN", () => {
    const out = html(
      embed("synap-cell", 'cellKey="chart-pie"', {
        data: [
          { label: "A", value: 0 },
          { label: "B", value: 0 },
        ],
      })
    );
    expect(count(out, "data-mark")).toBe(0);
    expect(out).not.toContain("NaN");
    expect(out).toContain("0 · 0%");
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

  // With no reader the renderer asks the pod nothing: the cell's embedded
  // `props` never run. An HTML cell runs only from its STORED source, in the
  // isolated frame (`embed-view.test.tsx`).
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

describe("MarkdownView — a ```mermaid fence", () => {
  const source = "flowchart LR\n  A[Start] --> B{Ok?}";

  it("shows its source until the diagram is drawn, never markup", () => {
    const out = html(["```mermaid", source, "```"].join("\n"));
    expect(out).toContain("flowchart LR");
    expect(out).toContain("A[Start] --&gt; B{Ok?}");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<svg");
  });

  it("leaves every other fence a code block", () => {
    const out = html(["```ts", "const a = 1;", "```"].join("\n"));
    expect(out).toContain("<pre");
    expect(out).toContain("const a = 1;");
  });
});

describe("a reference names its object (founder, 2026-11-04)", () => {
  const withRef = (source: string, read: ObjectRefRead) =>
    renderToStaticMarkup(
      <EmbedHostContext.Provider
        value={{
          useEntity: () => ({ state: "unresolved" }),
          useObjectRef: () => read,
        }}
      >
        <MarkdownView source={source} />
      </EmbedHostContext.Provider>
    );
  const named: ObjectRefRead = {
    state: "ready",
    type: "entity",
    name: "Migrate the billing worker",
    openable: true,
    profileSlug: "task",
  };

  it("with no lookup, a bare id stays the text the author wrote", () => {
    const out = html(`Blocked by ${UUID} since Monday.`);
    expect(out).toContain(`Blocked by ${UUID} since Monday.`);
    expect(out).not.toContain("href");
  });

  it("with no lookup, an unlabelled marker reads as its kind, never an empty link", () => {
    const out = html(`See [[doc:${UUID}]].`);
    expect(out).toContain(`href="/open/document/${UUID}"`);
    expect(out).toMatch(/>Document</);
  });

  it("a bare id the reader's lookup names: its name, its kind's colour, its page", () => {
    const out = withRef(`Blocked by ${UUID}.`, named);
    expect(out).toContain("Migrate the billing worker");
    expect(out).toContain(`href="/open/entity/${UUID}"`);
    expect(out).toMatch(/<svg[^>]*style="color:[^"]+"/);
    expect(out).not.toContain(`>${UUID}<`);
  });

  it("an id nobody this reader can see stays text, with no link", () => {
    const out = withRef(`Blocked by ${UUID}.`, { state: "unknown" });
    expect(out).toContain(`Blocked by ${UUID}.`);
    expect(out).not.toContain("href");
  });

  it("a broken lookup keeps the words and offers to ask again, never a guess", () => {
    const out = withRef(`Blocked by ${UUID}.`, {
      state: "failed",
      retry: () => {},
    });
    expect(out).toContain(UUID);
    expect(out).toContain("Couldn’t look this up. Try again");
    expect(out).not.toContain("href");
  });

  it("an unlabelled marker shows the looked-up name, and its profile's own colour", () => {
    const out = withRef(`Owner: [[entity:${UUID}]].`, {
      state: "ready",
      type: "entity",
      name: "Ana Lopez",
      openable: true,
      profileSlug: "person",
      profile: { slug: "person", uiHints: { color: "#ff0000" } },
    });
    expect(out).toContain("Ana Lopez");
    expect(out).toContain(`href="/open/entity/${UUID}"`);
    expect(out).toContain("color:#ff0000");
  });

  it("a labelled marker keeps the author's words", () => {
    const out = withRef(`Owner: [[entity:${UUID}|Ana]].`, {
      ...named,
      name: "Ana Lopez",
    });
    expect(out).toContain(">Ana<");
    expect(out).not.toContain("Ana Lopez");
  });

  it("a web link with no path is a web link, never a chip", () => {
    const out = withRef("[home](https://example.com)", named);
    expect(out).toContain('href="https://example.com/"');
    expect(out).toContain('target="_blank"');
    expect(out).not.toContain("Migrate the billing worker");
  });

  it("an id in code is code, even with a lookup", () => {
    const out = withRef("Run `get " + UUID + "`.", named);
    expect(out).toContain(`get ${UUID}`);
    expect(out).not.toContain("href");
  });
});
