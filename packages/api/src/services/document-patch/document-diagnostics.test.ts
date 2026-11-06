/**
 * Write-time document diagnostics.
 *
 * Two seams:
 *  1. `diagnoseDocument` over real markdown with a fake resolver — every code
 *     the wire promises, from the grammar pass, the catalog pass and the access
 *     pass.
 *  2. `podEmbedResolver` over a stubbed access layer — the not_found /
 *     not_visible split UNDER THE DOCUMENT'S LENS, and the leak floor (an
 *     object the writer cannot see reads `not_found`, never `not_visible`).
 *     The access layer is stubbed at `scopedDb`: which rows each identity+lens
 *     sees is the access layer's own suite; the seam here is which question the
 *     resolver asks of it, and how it reads the two answers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** Ids each lens sees: key = `${userId}|${lens ?? "floor"}`. */
  sees: new Map<string, Set<string>>(),
  asked: [] as string[],
}));

vi.mock("../../access/index.js", () => {
  class FakeAccess {
    constructor(
      readonly userId: string,
      readonly workspaceLens?: string
    ) {}
    static operator(ctx: { userId: string }) {
      return new FakeAccess(ctx.userId);
    }
    withLens(lens: string) {
      return new FakeAccess(this.userId, lens);
    }
  }
  return {
    AccessContext: FakeAccess,
    scopedDb: (access: FakeAccess) => ({
      findMany: async () => {
        const key = `${access.userId}|${access.workspaceLens ?? "floor"}`;
        h.asked.push(key);
        return [...(h.sees.get(key) ?? [])].map((id) => ({ id }));
      },
    }),
  };
});

vi.mock("../cells/renderables.js", () => ({
  listRenderables: async () => [],
}));

import {
  diagnoseDocument,
  diagnoseHtmlPage,
  podEmbedResolver,
  type EmbedResolver,
  type ReferentStatus,
} from "./document-diagnostics.js";
import { CPU_INLINE_MAX_CHARS } from "@synap/jobs/utils/cpu-pool.js";

const E_VISIBLE = "11111111-1111-4111-8111-111111111111";
const E_PRIVATE = "22222222-2222-4222-8222-222222222222";
const E_HIDDEN = "33333333-3333-4333-8333-333333333333";

function fakeResolver(status: Record<string, ReferentStatus>): EmbedResolver {
  return {
    renderables: async () =>
      new Map([
        [
          "chart-bar",
          { placements: ["bento", "inline"], requiredConfig: ["profileSlug"] },
        ],
        [
          "chart-live-line",
          { placements: ["bento", "inline"], requiredConfig: ["profileSlug"] },
        ],
        ["bento-only", { placements: ["bento"], requiredConfig: [] }],
        [
          "lens-section",
          { placements: ["bento", "inline"], requiredConfig: ["section"] },
        ],
        [
          "entity-list",
          { placements: ["bento", "inline"], requiredConfig: ["profileSlug"] },
        ],
        [
          "cell:pack:thing",
          { placements: ["bento", "inline"], requiredConfig: ["source"] },
        ],
      ]) as never,
    referents: async (_kind, ids) =>
      new Map(ids.map((id) => [id, status[id] ?? "not_found"])),
  };
}

const codes = (d: Array<{ code: string }>) => d.map((x) => x.code);

describe("diagnoseDocument", () => {
  it("a clean document has no diagnostics", async () => {
    const md = [
      `:::synap-entity{id="${E_VISIBLE}"}`,
      ":::",
      "",
      ':::synap-cell{cellKey="chart-bar"}',
      "```json",
      '{"profileSlug":"task"}',
      "```",
      ":::",
    ].join("\n");
    expect(
      await diagnoseDocument(md, fakeResolver({ [E_VISIBLE]: "visible" }))
    ).toEqual([]);
  });

  it("catalog: unknown key, not embeddable, missing required props", async () => {
    const md = [
      ':::synap-cell{cellKey="nope"}',
      ":::",
      "",
      ':::synap-cell{cellKey="bento-only"}',
      ":::",
      "",
      ':::synap-cell{cellKey="chart-bar"}',
      ":::",
      "",
      ':::synap-cell{cellKey="cell:pack:thing"}',
      "```json",
      '{"other":1}',
      "```",
      ":::",
    ].join("\n");
    const out = await diagnoseDocument(md, fakeResolver({}));
    expect(codes(out)).toEqual([
      "unknown_key",
      "unknown_key",
      "bad_props",
      "bad_props",
    ]);
    expect(out[0]!.fix).toContain(
      'synap_list_widgets({ surface: "document" })'
    );
    expect(out[1]!.message).toMatch(/not embeddable in a document/);
    expect(out[2]!.message).toMatch(/props\.profileSlug/);
    expect(out[3]!.message).toMatch(/props\.source/);
  });

  it("catalog: a work block's props are read in author mode — every problem a reader would fall back on is said", async () => {
    // Review A5: the reader falls back quietly on a bad `empty` or `limit`
    // (founder Q1), so only the document's diagnostics can tell its author,
    // whichever door (MCP, patch, the editor) wrote it.
    const block = (props: string) =>
      [
        ':::synap-cell{cellKey="lens-section"}',
        "```json",
        props,
        "```",
        ":::",
        "",
      ].join("\n");
    const md = [
      block('{"section":"blocking"}'),
      block('{"section":"blocking","empty":"shout"}'),
      block('{"section":"happening","limit":"lots"}'),
      block('{"section":"nowhere"}'),
      block('{"section":"doneWhen"}'),
      block('{"section":"produced","empty":"explain","limit":4}'),
    ].join("\n");
    const out = await diagnoseDocument(md, fakeResolver({}));
    expect(out.map((d) => [d.code, d.severity])).toEqual([
      ["bad_props", "warning"],
      ["bad_props", "warning"],
      ["bad_props", "error"],
      ["bad_props", "error"],
    ]);
    expect(out[0]!.message).toMatch(/props\.empty "shout"/);
    expect(out[1]!.message).toMatch(/props\.limit "lots"/);
    expect(out[2]!.message).toMatch(/"nowhere"/);
    expect(out[3]!.message).toMatch(/"doneWhen" belongs to the work page/);
    for (const d of out) {
      expect(d.ref).toEqual({ cellKey: "lens-section" });
      expect(d.fix).toContain("blocking");
    }
  });

  it("catalog: a snapshot chart needs no query keys; a live-only chart still does", async () => {
    // A chart of numbers that are not pod records (a measurement) has no
    // profileSlug to give: its snapshot `data` is what draws it.
    const md = [
      ':::synap-cell{cellKey="chart-bar"}',
      "```json",
      '{"label":"Tokens","data":[{"label":"before","value":84895},{"label":"after","value":56364}],"capturedAt":"2026-10-22T05:00:00Z"}',
      "```",
      "Tokens fell by a third.",
      ":::",
      "",
      ':::synap-cell{cellKey="chart-live-line"}',
      "```json",
      '{"data":[{"x":"2026-10-01","y":3}],"capturedAt":"2026-10-22T05:00:00Z"}',
      "```",
      "Three on the first.",
      ":::",
    ].join("\n");
    const out = await diagnoseDocument(md, fakeResolver({}));
    expect(codes(out)).toEqual(["bad_props"]);
    expect(out[0]!.ref).toEqual({ cellKey: "chart-live-line" });
    expect(out[0]!.message).toMatch(/props\.profileSlug/);
  });

  it("design (rule 7): a list cell over its cap warns; at the cap it does not", async () => {
    const list = (limit: number) =>
      [
        ':::synap-cell{cellKey="entity-list"}',
        "```json",
        `{"profileSlug":"task","limit":${limit}}`,
        "```",
        "Open tasks.",
        ":::",
      ].join("\n");
    const over = await diagnoseDocument(list(25), fakeResolver({}));
    expect(codes(over)).toEqual(["over_cap"]);
    expect(over[0]!.severity).toBe("warning");
    expect(over[0]!.message).toMatch(/limit 25.*at most 8/);
    expect(over[0]!.fix).toMatch(/Show all/);
    expect(await diagnoseDocument(list(8), fakeResolver({}))).toEqual([]);
  });

  it("design (rule 10): a chart snapshot with no sentence warns; with one it does not", async () => {
    const chart = (fallback: string) =>
      [
        ':::synap-cell{cellKey="chart-bar"}',
        "```json",
        '{"data":[{"label":"a","value":1}],"capturedAt":"2026-10-22T05:00:00Z"}',
        "```",
        ...(fallback ? [fallback] : []),
        ":::",
      ].join("\n");
    const bare = await diagnoseDocument(chart(""), fakeResolver({}));
    expect(codes(bare)).toEqual(["chart_no_finding"]);
    expect(bare[0]!.ref).toEqual({ cellKey: "chart-bar" });
    expect(await diagnoseDocument(chart("A leads."), fakeResolver({}))).toEqual(
      []
    );
  });

  it("design (grammar pass): empty heading, bare id, raw HTML, banned phrase reach the wire with a fix", async () => {
    const md = [
      "## Needs you",
      "",
      "## Happened",
      "",
      `Oops, ${E_VISIBLE} stopped.`,
      "",
      "<div>late</div>",
    ].join("\n");
    const out = await diagnoseDocument(md, fakeResolver({}));
    expect(codes(out)).toEqual([
      "empty_heading",
      "bare_id",
      "banned_phrase",
      "raw_html",
    ]);
    for (const d of out) expect(d.fix.length).toBeGreaterThan(20);
  });

  it("grammar: legacy props, malformed props, missing reference, unterminated", async () => {
    const md = [
      `:::synap-cell{cellKey="chart-bar" cellProps='{"profileSlug":"task"}'}`,
      ":::",
      "",
      ':::synap-cell{cellKey="chart-bar"}',
      "```json",
      "{not json",
      "```",
      ":::",
      "",
      ":::synap-view{}",
      ":::",
      "",
      '::::synap-section{id="s"}',
      "## S",
      "",
      `:::synap-entity{id="${E_VISIBLE}"}`,
      "fallback",
      "::::",
    ].join("\n");
    const out = await diagnoseDocument(
      md,
      fakeResolver({ [E_VISIBLE]: "visible" })
    );
    expect(new Set(codes(out))).toEqual(
      new Set(["legacy_props", "bad_props", "missing_attr", "unterminated"])
    );
  });

  it("access: not_found and not_visible are different answers", async () => {
    const md = [
      `:::synap-entity{id="${E_PRIVATE}"}`,
      ":::",
      "",
      `:::synap-entity{id="${E_HIDDEN}"}`,
      ":::",
    ].join("\n");
    const out = await diagnoseDocument(
      md,
      fakeResolver({ [E_PRIVATE]: "not_visible", [E_HIDDEN]: "not_found" })
    );
    expect(codes(out)).toEqual(["not_visible", "not_found"]);
    expect(out[0]!.message).toMatch(/not visible to this document's readers/);
    expect(out[0]!.severity).toBe("warning");
  });

  it("a resolver that skips an id is a broken resolver, not a pass", async () => {
    const skipping: EmbedResolver = {
      renderables: async () => new Map(),
      referents: async () => new Map(),
    };
    await expect(
      diagnoseDocument(`:::synap-entity{id="${E_VISIBLE}"}\n:::\n`, skipping)
    ).rejects.toThrow(/no status/);
  });
});

describe("podEmbedResolver — the document's lens, and the leak floor", () => {
  beforeEach(() => {
    h.sees.clear();
    h.asked = [];
  });

  it("workspace document: visible in the workspace ⇒ visible; writer-only ⇒ not_visible; unseen ⇒ not_found", async () => {
    h.sees.set("writer|floor", new Set([E_VISIBLE, E_PRIVATE]));
    h.sees.set("writer|ws-1", new Set([E_VISIBLE]));
    const r = podEmbedResolver({ writerUserId: "writer", workspaceId: "ws-1" });
    const status = await r.referents("entity", [
      E_VISIBLE,
      E_PRIVATE,
      E_HIDDEN,
      "not-a-uuid",
    ]);
    expect(Object.fromEntries(status)).toEqual({
      [E_VISIBLE]: "visible",
      [E_PRIVATE]: "not_visible",
      [E_HIDDEN]: "not_found",
      "not-a-uuid": "not_found",
    });
    // The readers' question is asked UNDER the document's workspace lens.
    expect(h.asked.sort()).toEqual(["writer|floor", "writer|ws-1"]);
  });

  it("never leaks: an object readers see but the writer does not reads not_found", async () => {
    h.sees.set("writer|floor", new Set());
    h.sees.set("writer|ws-1", new Set([E_HIDDEN]));
    const r = podEmbedResolver({ writerUserId: "writer", workspaceId: "ws-1" });
    expect((await r.referents("entity", [E_HIDDEN])).get(E_HIDDEN)).toBe(
      "not_found"
    );
  });

  it("personal document: the readers are the writer's own floor (no lens)", async () => {
    h.sees.set("writer|floor", new Set([E_PRIVATE]));
    const r = podEmbedResolver({ writerUserId: "writer", workspaceId: null });
    expect((await r.referents("entity", [E_PRIVATE])).get(E_PRIVATE)).toBe(
      "visible"
    );
    expect(h.asked).toEqual(["writer|floor", "writer|floor"]);
  });
});

describe("diagnoseHtmlPage — what the one frame policy refuses, said to the author", () => {
  it("a page that loads code from a CDN is an error naming the host", () => {
    const out = diagnoseHtmlPage(
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script><canvas></canvas>'
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: "network_code", severity: "error" });
    expect(out[0]!.message).toContain("cdn.jsdelivr.net");
    expect(out[0]!.fix).toMatch(/inline/i);
  });

  it("a page with only web fonts is a warning: it still runs, with system fonts", () => {
    const out = diagnoseHtmlPage(
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><h1>Hi</h1>'
    );
    expect(out.map((d) => [d.code, d.severity])).toEqual([
      ["network_assets", "warning"],
    ]);
  });

  it("a self-contained page, raw HTML and all, has nothing to say", () => {
    expect(
      diagnoseHtmlPage(
        "<!doctype html><html><body><div>chart</div><script>draw()</script></body></html>"
      )
    ).toEqual([]);
  });
});

describe("diagnoseDocument — off the event loop past a tiny document", () => {
  // A small document is parsed inline; the same document followed by plain
  // prose (no diagnostic of its own, nothing moves a line) is over the inline
  // size, so its parse runs in the CPU pool's worker. Same verdicts.
  const issues = [
    `:::synap-entity{id="${E_PRIVATE}"}`,
    ":::",
    "",
    `:::synap-cell{cellKey="chart-bar" cellProps='{"profileSlug":"task"}'}`,
    ":::",
    "",
    ':::synap-cell{cellKey="nope"}',
    ":::",
    "",
    ':::synap-view{viewId="not-a-uuid"}',
    ":::",
    "",
  ].join("\n");
  const padding =
    "Plain prose for the reader, nothing to flag here.\n\n".repeat(60);

  it("gives the same diagnostics in the worker as inline", async () => {
    const big = issues + padding;
    expect(issues.length).toBeLessThanOrEqual(CPU_INLINE_MAX_CHARS);
    expect(big.length).toBeGreaterThan(CPU_INLINE_MAX_CHARS);
    const resolver = fakeResolver({ [E_PRIVATE]: "not_visible" });
    const inline = await diagnoseDocument(issues, resolver);
    expect(codes(inline)).toEqual([
      "not_visible",
      "legacy_props",
      "unknown_key",
      "not_found",
    ]);
    expect(await diagnoseDocument(big, resolver)).toStrictEqual(inline);
  });
});
