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

/**
 * The cell hop is the LAST place a package's install payload can lose a field
 * before `installCellFromDefinition` reads it, and it has lost three:
 * `viewTypes` (renderer unselectable), `contentKind` (defaulted to the `widget`
 * slot), `externalHosts` (declared egress arrived contained). All three were
 * the same defect — a field-by-field rebuild that dropped anything unnamed.
 *
 * These tests pin the STRUCTURAL fix (wholesale forward), not the three names:
 * the third case carries a field this repo has never heard of, so re-narrowing
 * the rebuild to any finite list fails here even for a field added later.
 */
describe("handleCpCatalogSync — cell definitions are forwarded WHOLESALE", () => {
  /** Serve exactly one cell; every other kind empty so cells own the insert. */
  function serveOneCell(cell: Record<string, unknown>) {
    fetchMock.mockImplementation(async (urlArg: string) => {
      const url = String(urlArg);
      if (url.includes("/api/marketplace/cells"))
        return jsonRes({ cells: [cell], total: 1 });
      if (url.includes("/api/marketplace/capabilities"))
        return jsonRes({ capabilities: [] });
      return jsonRes({ packages: [], total: 0 });
    });
  }

  const BASE = {
    key: "chart",
    name: "Chart",
    packageSlug: "acme",
    code: "export default () => null",
  };

  async function syncedCellDefinition(
    cell: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    serveOneCell(cell);
    await handleCpCatalogSync();
    const rows = upsertedRows() as Array<{
      slug: string;
      definition: Record<string, unknown>;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("acme/chart");
    return rows[0].definition;
  }

  it("carries `contentKind` — dropped, it silently defaults the renderer slot to `widget`", async () => {
    const def = await syncedCellDefinition({
      ...BASE,
      contentKind: "entity-detail",
    });
    expect(def.contentKind).toBe("entity-detail");
  });

  it("carries `externalHosts` — dropped, a cell's declared egress arrives contained", async () => {
    const def = await syncedCellDefinition({
      ...BASE,
      externalHosts: ["https://api.example.test"],
    });
    expect(def.externalHosts).toEqual(["https://api.example.test"]);
  });

  it("carries `viewTypes` and the ALREADY-NAMED payload fields", async () => {
    const def = await syncedCellDefinition({
      ...BASE,
      deps: { d3: "7.0.0" },
      previewCode: "preview",
      defaultSize: { w: 4, h: 3 },
      configSchema: { type: "object" },
      viewTypes: ["gallery"],
    });
    expect(def).toMatchObject({
      key: "chart",
      code: BASE.code,
      packageSlug: "acme",
      deps: { d3: "7.0.0" },
      previewCode: "preview",
      defaultSize: { w: 4, h: 3 },
      configSchema: { type: "object" },
      viewTypes: ["gallery"],
    });
  });

  it("carries a field NO code in this repo names — the structural guarantee", async () => {
    // If someone reintroduces a field-by-field rebuild, they cannot possibly
    // name this key, so this case fails while the three above might not.
    const def = await syncedCellDefinition({
      ...BASE,
      aFieldTheControlPlaneAddsTomorrow: { nested: [1, 2, 3] },
    });
    expect(def.aFieldTheControlPlaneAddsTomorrow).toEqual({
      nested: [1, 2, 3],
    });
  });
});

describe("handleCpCatalogSync — derived search tokens fold into tags", () => {
  it("folds playbook/dep tokens into tags when the CP row has a definition, without stuffing definition onto a list row", async () => {
    fetchMock.mockImplementation(async (urlArg: string) => {
      const url = String(urlArg);
      if (url.includes("/api/marketplace/capabilities")) {
        return jsonRes({
          capabilities: [
            {
              key: "silent-pack",
              name: "Enterprise OS",
              description: "Company operating core.",
              definition: {
                playbooks: [
                  {
                    name: "Studio pipeline",
                    goalTemplate: "Run the content creation pipeline.",
                  },
                ],
              },
            },
          ],
        });
      }
      if (url.includes("/api/marketplace/cells"))
        return jsonRes({ cells: [], total: 0 });
      return jsonRes({ packages: [], total: 0 });
    });

    await handleCpCatalogSync();

    const rows = upsertedRows() as Array<{
      slug: string;
      tags: string[] | null;
      definition: Record<string, unknown> | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("silent-pack");
    expect(rows[0]!.tags).toEqual(
      expect.arrayContaining(["content", "creation"])
    );
    // Capabilities already ship definition; folding must not drop it.
    expect(rows[0]!.definition).toMatchObject({
      playbooks: [{ name: "Studio pipeline" }],
    });
  });

  it("copies list-view tags as-is and keeps definition null (does not start sending bodies)", async () => {
    fetchMock.mockImplementation(async (urlArg: string) => {
      const url = String(urlArg);
      if (url.includes("/api/marketplace/capabilities"))
        return jsonRes({ capabilities: [] });
      if (url.includes("/api/marketplace/cells"))
        return jsonRes({ cells: [], total: 0 });
      if (url.includes("category=workspace")) {
        return jsonRes({
          packages: [
            {
              slug: "enterprise-os",
              displayName: "Enterprise OS",
              description: null,
              tags: ["suite", "content", "creation"],
            },
          ],
          total: 1,
        });
      }
      return jsonRes({ packages: [], total: 0 });
    });

    await handleCpCatalogSync();

    const rows = upsertedRows() as Array<{
      slug: string;
      tags: string[] | null;
      definition: unknown;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("enterprise-os");
    expect(rows[0]!.tags).toEqual(["suite", "content", "creation"]);
    expect(rows[0]!.definition).toBeNull();
  });
});
