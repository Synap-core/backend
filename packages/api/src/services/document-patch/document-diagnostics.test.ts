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
  podEmbedResolver,
  type EmbedResolver,
  type ReferentStatus,
} from "./document-diagnostics.js";

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
        ["bento-only", { placements: ["bento"], requiredConfig: [] }],
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
