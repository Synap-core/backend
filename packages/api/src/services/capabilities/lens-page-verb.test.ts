/**
 * `lens.page` — a document refresher's grounding read is THE lens page read.
 *
 * The verb exists so a refresher flow can read what it writes about
 * (lens.page → ai.generate → document.update upsert_section). It must read
 * the same rows the lens widgets read: `signals.list` with the ONE input
 * builder the Hub door behind the browser's `lens.page` bridge op uses
 * (`GET /attention/lens-page`), never a second derivation. This drives the
 * real handler with the router stubbed at its caller and asserts on the input
 * it was asked, against the builder and the shared caps.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LENS_PAGE_READ_CAPS } from "@synap-core/types/lens";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ ctx: Record<string, unknown>; input: unknown }>,
}));

// Keep sibling module-load deps quiet (mirrors builtin-verbs-generate.test.ts).
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
}));
vi.mock("./place-artboard-deck.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./place-artboard-deck.js")>();
  return { ...actual, placeArtboardDeck: vi.fn() };
});
vi.mock("../mail-feed/triage.js", () => ({ triageEmails: vi.fn() }));

vi.mock("../../routers/signals.js", () => ({
  signalsRouter: {
    createCaller: (ctx: Record<string, unknown>) => ({
      list: async (input: unknown) => {
        h.calls.push({ ctx, input });
        return { signals: [], page: { marker: "the page" } };
      },
    }),
  },
}));

import { BUILTIN_VERBS, READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";
import { lensPageListInput } from "../signals/lens-page-read.js";

const P = "22222222-2222-4222-8222-222222222222";
const W = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  h.calls = [];
});

describe("lens.page", () => {
  it("reads signals.list({ lens: 'page' }) through the shared builder, with the shared caps", async () => {
    const out = await BUILTIN_VERBS["lens.page"]!(
      { workspaceId: W, projectId: P, since: "2026-11-02T00:00:00.000Z" },
      { userId: "user-1", workspaceId: W }
    );
    expect(out).toEqual({ signals: [], page: { marker: "the page" } });
    expect(h.calls).toHaveLength(1);
    const asked = h.calls[0]!.input;
    expect(asked).toEqual(
      lensPageListInput({
        workspaceId: W,
        projectId: P,
        since: "2026-11-02T00:00:00.000Z",
      })
    );
    expect(asked).toEqual({
      lens: "page",
      workspaceId: W,
      projectId: P,
      caps: { ...LENS_PAGE_READ_CAPS },
      since: "2026-11-02T00:00:00.000Z",
    });
  });

  it("reads as the caller, a person context (no agent, not the hub door)", async () => {
    await BUILTIN_VERBS["lens.page"]!(
      { projectId: P },
      { userId: "user-1", workspaceId: null }
    );
    expect(h.calls[0]!.ctx).toMatchObject({
      userId: "user-1",
      agentUserId: null,
      isHubProtocol: false,
    });
  });

  it("refuses a scope that is not an id (never reads the whole pod in its place)", async () => {
    await expect(
      BUILTIN_VERBS["lens.page"]!(
        { projectId: "not-a-uuid" },
        { userId: "u", workspaceId: null }
      )
    ).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });

  it("is read-only, so it auto-runs inside a refresher flow", () => {
    expect(READ_ONLY_BUILTIN_VERBS.has("lens.page")).toBe(true);
  });
});
