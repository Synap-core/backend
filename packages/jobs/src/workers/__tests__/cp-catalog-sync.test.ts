import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Boundary test for cp-catalog-sync. We mock the DB layer and stub global
 * `fetch`, then assert the REQUEST SHAPE the worker produces (never a real
 * network round-trip) plus two invariants:
 *   - the 0049 vocabulary fix: the outbound CP `category` uses the LIVE
 *     vocabulary (`workspace` / `workflow`), NEVER the retired
 *     `template` / `automation`; a 4xx stamps `misconfigured` + logs at error
 *     (permanent), a 5xx / network error stays `unreachable` (transient);
 *   - the open-marketplace pagination fix: the worker pages a list endpoint to
 *     completion, and PRUNES ONLY when the fetch is provably complete — a
 *     failed/partial page upserts but SKIPS the prune (the critical regression
 *     guard), while a complete fetch still prunes genuinely-removed entries.
 */

const {
  recordStampMock,
  loggerMock,
  insertValuesMock,
  onConflictMock,
  deleteWhereMock,
  deleteReturningMock,
  dbMock,
} = vi.hoisted(() => {
  const onConflictMock = vi.fn(async (): Promise<void> => undefined);
  const insertValuesMock = vi.fn((_rows: unknown) => ({
    onConflictDoUpdate: onConflictMock,
  }));
  const deleteReturningMock = vi.fn(
    async (): Promise<Array<{ slug: string }>> => []
  );
  const deleteWhereMock = vi.fn((_pred: unknown) => ({
    returning: deleteReturningMock,
  }));
  return {
    recordStampMock: vi.fn(
      async (
        _source: string,
        _kind: string,
        _status: string,
        _count: number
      ): Promise<void> => undefined
    ),
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    insertValuesMock,
    onConflictMock,
    deleteWhereMock,
    deleteReturningMock,
    dbMock: {
      insert: vi.fn((_table: unknown) => ({ values: insertValuesMock })),
      delete: vi.fn((_table: unknown) => ({ where: deleteWhereMock })),
    },
  };
});

vi.mock("@synap/database", () => ({
  db: dbMock,
  drizzleSql: { raw: vi.fn() },
  and: vi.fn(),
  eq: vi.fn(),
  notInArray: vi.fn(),
  recordCatalogSyncStamp: recordStampMock,
}));

vi.mock("@synap/database/schema", () => ({
  cpCatalogCache: {
    source: "source",
    kind: "kind",
    slug: "slug",
  },
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => loggerMock,
}));

const fetchMock = vi.fn();

import { handleCpCatalogSync } from "../cp-catalog-sync.js";

const CP = "https://cp.example.test";

beforeEach(() => {
  recordStampMock.mockClear();
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
  dbMock.insert.mockClear();
  dbMock.delete.mockClear();
  insertValuesMock.mockClear();
  onConflictMock.mockClear();
  deleteWhereMock.mockClear();
  deleteReturningMock.mockReset();
  deleteReturningMock.mockResolvedValue([]);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.CONTROL_PLANE_URL = CP;
});

/** All URLs the worker fetched this run. */
function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/** The rows the worker tried to upsert this run (single insert call across the run). */
function upsertedRows(): Array<{ slug: string }> {
  const call = insertValuesMock.mock.calls[0];
  return (call?.[0] ?? []) as Array<{ slug: string }>;
}

const pkg = (slug: string) => ({ slug, displayName: slug, description: null });

/**
 * Serve a paginated `category=workspace` (template) dataset; every OTHER kind
 * returns empty so only the template kind exercises the insert/prune path.
 * `failAtOffset` forces the workspace page at that offset to fail (transient).
 */
function serveWorkspace(
  all: Array<{ slug: string }>,
  opts: { failAtOffset?: number } = {}
) {
  fetchMock.mockImplementation(async (urlArg: string) => {
    const url = String(urlArg);
    if (url.includes("/api/marketplace/capabilities"))
      return jsonRes({ capabilities: [] });
    if (url.includes("/api/marketplace/cells"))
      return jsonRes({ cells: [], total: 0 });
    if (url.includes("category=workflow"))
      return jsonRes({ packages: [], total: 0 });
    if (url.includes("category=workspace")) {
      const q = new URL(url).searchParams;
      const offset = Number(q.get("offset") ?? "0");
      const limit = Number(q.get("limit") ?? "100");
      if (opts.failAtOffset !== undefined && offset === opts.failAtOffset) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return jsonRes({
        packages: all.slice(offset, offset + limit),
        total: all.length,
      });
    }
    return jsonRes({});
  });
}

describe("handleCpCatalogSync — request shape", () => {
  it("queries the CP with LIVE package categories (workspace/workflow), never the retired template/automation", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ capabilities: [], packages: [], cells: [] }),
    });

    await handleCpCatalogSync();

    const urls = fetchedUrls();
    // template kind → CP category=workspace, paginated (limit + offset)
    expect(urls).toContain(
      `${CP}/api/packages?category=workspace&limit=100&offset=0`
    );
    // automation kind → CP category=workflow
    expect(urls).toContain(
      `${CP}/api/packages?category=workflow&limit=100&offset=0`
    );
    // the retired vocabulary must never leave the pod
    expect(urls.some((u) => u.includes("category=template"))).toBe(false);
    expect(urls.some((u) => u.includes("category=automation"))).toBe(false);
  });
});

describe("handleCpCatalogSync — 4xx vs transient split", () => {
  it("stamps a 4xx as `misconfigured` and logs it loudly (never `unreachable`)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
    });

    await handleCpCatalogSync();

    const statuses = recordStampMock.mock.calls.map((c) => c[2]);
    expect(statuses).toContain("misconfigured");
    expect(statuses).not.toContain("unreachable");
    expect(loggerMock.error).toHaveBeenCalled();
  });

  it("keeps a 5xx as transient `unreachable` (cache left intact, no false misconfig)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    await handleCpCatalogSync();

    const statuses = recordStampMock.mock.calls.map((c) => c[2]);
    expect(statuses).toContain("unreachable");
    expect(statuses).not.toContain("misconfigured");
  });
});

describe("handleCpCatalogSync — pagination + prune-on-complete-only", () => {
  it("(i) pages a multi-page catalog to completion, upserting EVERY entry (not just the first 100)", async () => {
    const all = Array.from({ length: 150 }, (_, i) =>
      pkg(`tpl-${String(i).padStart(3, "0")}`)
    );
    serveWorkspace(all);

    await handleCpCatalogSync();

    const urls = fetchedUrls();
    // Both pages were fetched (offset 0 and offset 100).
    expect(urls).toContain(
      `${CP}/api/packages?category=workspace&limit=100&offset=0`
    );
    expect(urls).toContain(
      `${CP}/api/packages?category=workspace&limit=100&offset=100`
    );
    // All 150 entries reached the upsert — the top-100 ceiling is gone.
    expect(upsertedRows()).toHaveLength(150);
    // A complete fetch still prunes.
    expect(dbMock.delete).toHaveBeenCalled();
    const statuses = recordStampMock.mock.calls.map((c) => c[2]);
    expect(statuses).toContain("ok");
  });

  it("(ii) CRITICAL: a failed/partial page UPSERTS but SKIPS the prune (never deletes unseen entries)", async () => {
    const all = Array.from({ length: 150 }, (_, i) =>
      pkg(`tpl-${String(i).padStart(3, "0")}`)
    );
    // First page (offset 0) succeeds with 100; second page (offset 100) fails.
    serveWorkspace(all, { failAtOffset: 100 });

    await handleCpCatalogSync();

    // The retrieved page was still upserted (additive, safe).
    expect(dbMock.insert).toHaveBeenCalled();
    expect(upsertedRows()).toHaveLength(100);
    // The prune was SKIPPED — nothing was deleted against the truncated set.
    expect(dbMock.delete).not.toHaveBeenCalled();
    // Stamped `partial` and logged loudly.
    const statuses = recordStampMock.mock.calls.map((c) => c[2]);
    expect(statuses).toContain("partial");
    expect(statuses).not.toContain("ok");
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it("(iii) a complete single-page fetch prunes genuinely-removed entries", async () => {
    const all = Array.from({ length: 50 }, (_, i) => pkg(`tpl-${i}`));
    serveWorkspace(all);
    // The DB currently holds one slug no longer in the CP → prune returns it.
    deleteReturningMock.mockResolvedValue([{ slug: "tpl-removed-legacy" }]);

    await handleCpCatalogSync();

    expect(upsertedRows()).toHaveLength(50);
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
    const statuses = recordStampMock.mock.calls.map((c) => c[2]);
    expect(statuses).toContain("ok");
    expect(statuses).not.toContain("partial");
  });
});
