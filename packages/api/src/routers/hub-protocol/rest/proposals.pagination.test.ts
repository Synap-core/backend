/**
 * Hub Protocol REST — GET /proposals pagination
 *
 * The bug these pin: `limit` and `offset` were accepted by the router and then
 * DROPPED — the handler called `listProposals` without forwarding either, so the
 * tRPC default of 50 applied to every request. Proven live against a pod:
 * `limit=5`, `limit=60`, `limit=200` and `offset=0/50/100` all returned the same
 * 50 rows with the same first id. Proposals 51+ were unreachable through the Hub
 * API and the CLI, and no consumer could tell "50 results" from "the first 50 of
 * many".
 *
 * Why the assertions are shaped this way: a test asserting only "returns 200
 * with an array" passes against the BROKEN handler and proves nothing. Each test
 * below is written so that it FAILS if the parameter is dropped —
 *  1. two different `limit` values must produce two different result COUNTS;
 *  2. `offset` must shift the FIRST ID of the page;
 *  3. `hasMore` must distinguish a full page from the last page;
 *  4. the clamp must hold, and must not be achieved by widening the procedure.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Every `listProposals` input the handler forwarded, in order. */
  calls: [] as Array<Record<string, unknown>>,
  /** The full ordered corpus the fake procedure pages over. */
  corpus: [] as Array<Record<string, unknown>>,
}));

/**
 * Fake `listProposals`, mirroring the real procedure's CURRENT contract:
 * `findMany({ limit, offset })` over a `desc(createdAt)` ordering, plus the
 * `total` it computes from a COUNT under the same predicate.
 *
 * The offset half matters: an earlier version of this fake honoured `limit`
 * only and returned `corpus.slice(0, limit)`, which made the "offset shifts the
 * first id" assertion below pass for the wrong reason — the handler was slicing
 * in-process, so the fake never needed to. Now that offset is forwarded to SQL,
 * a fake that ignores it would report the bug as fixed while the page never
 * moved.
 */
/** The `.max()` on the procedure's `limit` input. Keep in lockstep with
 *  `hub-protocol/proposals.ts` and `MAX_PAGE_SIZE`. */
const PROCEDURE_MAX_LIMIT = 200;

const fakeCaller = {
  proposals: {
    listProposals: async (input: Record<string, unknown>) => {
      h.calls.push(input);
      const limit = (input.limit as number | undefined) ?? 50;
      const offset = (input.offset as number | undefined) ?? 0;
      // Enforce the procedure's real zod bound. A mocked caller that accepts
      // ANY input cannot see a forward that the real procedure would reject —
      // and that is not hypothetical: while the two halves of this fix were
      // being written in parallel, the REST layer briefly forwarded
      // `offset + limit + 1` (up to 1101) into a `.max(200)`, a guaranteed 500
      // that every test here reported as green. The mock must be as strict as
      // the thing it stands in for.
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > PROCEDURE_MAX_LIMIT
      ) {
        throw new Error(
          `zod: limit ${limit} outside 1..${PROCEDURE_MAX_LIMIT} — the REST edge forwarded an out-of-range page size`
        );
      }
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`zod: offset ${offset} is not a non-negative integer`);
      }
      const page = h.corpus.slice(offset, offset + limit);
      return {
        proposals: page,
        total: h.corpus.length,
        limit,
        offset,
        hasMore: offset + page.length < h.corpus.length,
      };
    },
  },
};

vi.mock("./_shared.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  hasScope: (scopes: string[], scope: string) => scopes.includes(scope),
  httpStatusForTrpcError: () => 500,
  errCode: () => "ERR",
  isUuid: (v: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  getCaller: async () => fakeCaller,
  rejectAgentReviewer: async () => null,
  resolveProposalId: async (_u: string, id: string) => id,
}));

vi.mock("../confine-workspace.js", () => ({
  getConfinedWorkspace: () => null,
}));
vi.mock("../../proposals.js", () => ({
  proposalsRouter: { createCaller: () => ({}) },
}));
vi.mock("../utils.js", () => ({
  createHubProtocolCallerContext: async () => ({}),
}));
vi.mock("../../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async () => ({}),
}));

const {
  registerProposalsRoutes,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_OFFSET,
} = await import("./proposals.js");

/** Corpus of `n` proposals with stable, order-revealing ids. */
function seed(n: number): void {
  h.corpus = Array.from({ length: n }, (_, i) => ({
    id: `p-${String(i).padStart(4, "0")}`,
    proposalType: "entity.create",
    targetType: "entity",
    status: "pending",
    summary: `proposal ${i}`,
    data: { big: "payload" },
    createdAt: new Date(2026, 0, 1, 0, 0, n - i).toISOString(),
  }));
}

function buildApp() {
  const app = new OpenAPIHono<{
    Variables: { scopes: string[]; userId: string };
  }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read"]);
    c.set("userId", "user-1");
    await next();
  });
  registerProposalsRoutes(app as never);
  return app;
}

async function get(path: string) {
  const res = await buildApp().request(path);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

beforeEach(() => {
  h.calls = [];
  seed(500);
});

describe("GET /proposals — pagination", () => {
  it("two different `limit` values produce two different result counts", async () => {
    const five = await get("/proposals?limit=5");
    const sixty = await get("/proposals?limit=60");

    expect(five.status).toBe(200);
    expect(sixty.status).toBe(200);
    // The exact assertion the live bug failed: same request shape, two limits,
    // two counts. Before the fix both were 50.
    expect((five.body.proposals as unknown[]).length).toBe(5);
    expect((sixty.body.proposals as unknown[]).length).toBe(60);
    expect((five.body.proposals as unknown[]).length).not.toBe(
      (sixty.body.proposals as unknown[]).length
    );
  });

  it("`offset` shifts the first id of the page", async () => {
    const first = await get("/proposals?limit=10&offset=0");
    const second = await get("/proposals?limit=10&offset=10");
    const third = await get("/proposals?limit=10&offset=100");

    const firstId = (r: Record<string, unknown>) =>
      ((r.proposals as Array<{ id: string }>)[0] ?? {}).id;

    // Before the fix all three returned the same first id.
    expect(firstId(first.body)).toBe("p-0000");
    expect(firstId(second.body)).toBe("p-0010");
    expect(firstId(third.body)).toBe("p-0100");
    expect(
      new Set([firstId(first.body), firstId(second.body), firstId(third.body)])
        .size
    ).toBe(3);
  });

  it("`hasMore` distinguishes a full page from the last page", async () => {
    seed(25);
    const full = await get("/proposals?limit=10&offset=0");
    const last = await get("/proposals?limit=10&offset=20");

    expect(full.body.hasMore).toBe(true);
    expect((full.body.proposals as unknown[]).length).toBe(10);

    // 25 rows, offset 20 ⇒ 5 rows and nothing beyond. A caller counting the page
    // would report 5; `hasMore:false` is what makes "done" provable.
    expect((last.body.proposals as unknown[]).length).toBe(5);
    expect(last.body.hasMore).toBe(false);
  });

  it("a full final page still reports hasMore:false", async () => {
    seed(20);
    const res = await get("/proposals?limit=10&offset=10");
    expect((res.body.proposals as unknown[]).length).toBe(10);
    // Provable rather than inferred: the procedure derives `hasMore` from a
    // COUNT of the matching set, so 10 rows returned does NOT imply more exist.
    expect(res.body.hasMore).toBe(false);
  });

  it("defaults are unchanged for a caller that sends nothing", async () => {
    const res = await get("/proposals");
    expect((res.body.proposals as unknown[]).length).toBe(DEFAULT_PAGE_SIZE);
    expect(res.body.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(res.body.offset).toBe(0);
  });

  it("clamps limit and offset at the REST edge, without widening the procedure", async () => {
    const over = await get(`/proposals?limit=${MAX_PAGE_SIZE + 900}`);
    expect(over.body.limit).toBe(MAX_PAGE_SIZE);
    expect((over.body.proposals as unknown[]).length).toBe(MAX_PAGE_SIZE);

    const deep = await get(`/proposals?offset=${MAX_OFFSET + 5000}`);
    expect(deep.body.offset).toBe(MAX_OFFSET);

    // The clamp must be enforced BEFORE the procedure call — the tRPC `limit`
    // carries no `.max()`, so an unclamped forward would pull the whole table.
    for (const call of h.calls) {
      // Clamped at the REST edge. The bound is MAX_PAGE_SIZE itself now: the
      // handler forwards `limit` verbatim instead of over-fetching
      // `offset + limit + 1`, so a request can no longer pull a window sized by
      // its own offset.
      expect(call.limit as number).toBeLessThanOrEqual(MAX_PAGE_SIZE);
      expect(call.offset as number).toBeLessThanOrEqual(MAX_OFFSET);
    }
  });

  it("returns `total` in BOTH views — the number the UI is actually missing", async () => {
    seed(322);
    const full = await get("/proposals?limit=50");
    const basic = await get("/proposals?view=basic&limit=50");

    // The whole point of the fix. Three surfaces rendered 322 / 100 / 50, two of
    // them page sizes wearing a total's clothes. A page of 50 out of 322 must
    // report 322 — and in the DEFAULT view, not only `view=basic`. `total` was
    // briefly returned for the basic branch alone, which left the default path
    // (every existing caller) still unable to tell a page from a queue.
    expect(full.body.total).toBe(322);
    expect(basic.body.total).toBe(322);
    expect((full.body.proposals as unknown[]).length).toBe(50);
    expect(full.body.hasMore).toBe(true);
    // `total` is the size of the QUEUE, never the size of the page.
    expect(full.body.total).not.toBe((full.body.proposals as unknown[]).length);
  });

  it("forwards limit AND offset on EVERY call — the dropped-parameter regression guard", async () => {
    await get("/proposals?limit=7&offset=3");
    expect(h.calls).toHaveLength(1);
    // The literal defect: the handler built this input without `limit` at all,
    // so every request silently got the procedure's default of 50 and `offset`
    // did nothing. Both must reach the procedure.
    expect(h.calls[0]).toHaveProperty("limit");
    expect(h.calls[0]).toHaveProperty("offset");
    // Forwarded VERBATIM — the procedure applies SQL LIMIT/OFFSET itself. An
    // earlier revision asserted `offset + limit + 1` here because the handler
    // over-fetched and sliced in-process; that strategy is gone, and asserting
    // it would now pin an implementation the code no longer uses.
    expect(h.calls[0].limit).toBe(7);
    expect(h.calls[0].offset).toBe(3);
  });

  it("rejects a malformed limit/offset rather than silently ignoring it", async () => {
    expect((await get("/proposals?limit=abc")).status).toBe(400);
    expect((await get("/proposals?offset=-5")).status).toBe(400);
  });

  it("paginates the basic view too", async () => {
    const res = await get("/proposals?view=basic&limit=3&offset=6");
    expect((res.body.proposals as unknown[]).length).toBe(3);
    expect(res.body.hasMore).toBe(true);
    expect((res.body.proposals as Array<{ id: string }>)[0].id).toBe("p-0006");
    // `view=basic` exists to avoid paying for every `data` payload — pagination
    // must not silently re-full-fetch it into the response.
    expect(
      (res.body.proposals as Array<Record<string, unknown>>)[0]
    ).not.toHaveProperty("data");
  });
});
