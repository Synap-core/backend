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

const sourcesMock = vi.hoisted(() => ({
  read: vi.fn(async (): Promise<unknown> => ({
    sources: [],
    official: null,
    status: {},
  })),
  syncThirdParty: vi.fn(async () => ({ state: "ok" })),
}));

vi.mock("@synap/database", () => ({
  db: dbMock,
  drizzleSql: { raw: vi.fn() },
  and: vi.fn(),
  eq: vi.fn(),
  notInArray: vi.fn(),
  recordCatalogSyncStamp: recordStampMock,
  readMarketplaceSources: sourcesMock.read,
}));

vi.mock("../marketplace-source-sync.js", () => ({
  syncThirdPartySource: sourcesMock.syncThirdParty,
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

import {
  DEFAULT_CATALOG_SOURCE,
  describeCatalogSources,
  handleCpCatalogSync,
} from "../cp-catalog-sync.js";

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
    // template kind → CP category=workspace, paginated (limit + offset), and
    // asks for tombstones too (TEMPLATE-LIFECYCLE Contract A)
    expect(urls).toContain(
      `${CP}/api/packages?category=workspace&limit=100&offset=0&includeRetired=true`
    );
    // ONLY the template kind asks for retired rows — a retired workflow/skill
    // must never enter the cache a browse reads.
    expect(
      urls
        .filter((u) => u.includes("includeRetired"))
        .every((u) => u.includes("category=workspace"))
    ).toBe(true);
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
      `${CP}/api/packages?category=workspace&limit=100&offset=0&includeRetired=true`
    );
    expect(urls).toContain(
      `${CP}/api/packages?category=workspace&limit=100&offset=100&includeRetired=true`
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

  it("writes the CP `packageVersion` to the cache row's version column", async () => {
    serveOneCell({ ...BASE, packageVersion: "1.4.2" });
    await handleCpCatalogSync();
    const rows = upsertedRows() as unknown as Array<{ version: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe("1.4.2");
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

describe("handleCpCatalogSync — dedupe by (source, kind, slug) before upsert", () => {
  it("dedupes a duplicate CAPABILITY key keeping the FIRST row the CP served (a content-hash version is not an order)", async () => {
    fetchMock.mockImplementation(async (urlArg: string) => {
      const url = String(urlArg);
      if (url.includes("/api/marketplace/capabilities")) {
        // Two entries with same slug, different versions — upstream bug
        return jsonRes({
          capabilities: [
            {
              key: "fireflies",
              name: "Fireflies.ai Meetings",
              description: "v1",
              version: "h-16a7f0bd5ee5", // older
            },
            {
              key: "fireflies",
              name: "Fireflies.ai Meetings",
              description: "v2",
              version: "h-53e4b4d3acc3", // newer
            },
          ],
        });
      }
      if (url.includes("/api/marketplace/cells"))
        return jsonRes({ cells: [], total: 0 });
      return jsonRes({ packages: [], total: 0 });
    });

    await handleCpCatalogSync();

    const rows = upsertedRows() as Array<{ slug: string; version: string }>;
    // ONE row, and it is the first one served: the CP serves the owning
    // (official) row first. "Newest" by hash would let an imposter win.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("fireflies");
    expect(rows[0]!.version).toBe("h-16a7f0bd5ee5");
    // Warning should be logged about dedup
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        source: CP,
        kind: "capability",
        before: 2,
        after: 1,
      }),
      expect.stringContaining("deduped duplicate slugs")
    );

    // The persisted stamp must report the number of rows ACTUALLY upserted (1),
    // not the number fetched (2). The insert was deduped; if the stamp still
    // counted the pre-dedupe `rows`, the catalog-sync ledger would overstate
    // what landed on every sync against a CP that ships a duplicate slug —
    // an inflated count that reads as a successful, larger sync.
    expect(recordStampMock).toHaveBeenCalledWith(CP, "capability", "ok", 1);
  });

  it("keeps both entries when slugs differ (no false dedupe)", async () => {
    fetchMock.mockImplementation(async (urlArg: string) => {
      const url = String(urlArg);
      if (url.includes("/api/marketplace/capabilities")) {
        return jsonRes({
          capabilities: [
            {
              key: "fireflies",
              name: "Fireflies.ai Meetings",
              version: "1.0.0",
            },
            { key: "freellmapi", name: "FreeLLMAPI Gateway", version: "2.0.0" },
          ],
        });
      }
      if (url.includes("/api/marketplace/cells"))
        return jsonRes({ cells: [], total: 0 });
      return jsonRes({ packages: [], total: 0 });
    });

    await handleCpCatalogSync();

    const rows = upsertedRows() as Array<{ slug: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.slug).sort()).toEqual(["fireflies", "freellmapi"]);
    // No warn about dedupe
    const warnCalls = loggerMock.warn.mock.calls.filter((c) =>
      String(c[1]).includes("deduped")
    );
    expect(warnCalls).toHaveLength(0);
  });

  it("a non-capability kind still keeps the newest version (cells: semver)", async () => {
    const cell = (version: string) => ({
      key: "chart",
      name: "Chart",
      packageSlug: "acme",
      code: "export default () => null",
      packageVersion: version,
    });
    fetchMock.mockImplementation(async (urlArg: string) => {
      const url = String(urlArg);
      if (url.includes("/api/marketplace/cells"))
        return jsonRes({
          cells: [cell("1.2.3"), cell("2.0.0"), cell("1.2.4")],
          total: 3,
        });
      if (url.includes("/api/marketplace/capabilities"))
        return jsonRes({ capabilities: [] });
      return jsonRes({ packages: [], total: 0 });
    });

    await handleCpCatalogSync();

    const rows = upsertedRows() as Array<{ slug: string; version: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe("2.0.0");
  });

  it("a capability keeps the first row even when a later one has a 'higher' version", async () => {
    fetchMock.mockImplementation(async (urlArg: string) => {
      const url = String(urlArg);
      if (url.includes("/api/marketplace/capabilities")) {
        return jsonRes({
          capabilities: [
            { key: "test-cap", name: "Official", version: "1.0.0" },
            { key: "test-cap", name: "Imposter", version: "9.9.9" },
          ],
        });
      }
      if (url.includes("/api/marketplace/cells"))
        return jsonRes({ cells: [], total: 0 });
      return jsonRes({ packages: [], total: 0 });
    });

    await handleCpCatalogSync();

    const rows = upsertedRows() as Array<{ slug: string; name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Official");
  });
});

/**
 * Template tombstones (TEMPLATE-LIFECYCLE Contract A): the CP DTO's
 * `retired: null | { at, replacedBy, reason }` lands on the three cache
 * columns, and an older CP that sends no `retired` field degrades to "not
 * retired" (today's behaviour), never to a guess.
 */
describe("handleCpCatalogSync — retired templates", () => {
  type RetiredRow = {
    slug: string;
    retiredAt: Date | null;
    replacedBySlug: string | null;
    retiredReason: string | null;
  };

  it("maps a retired DTO onto retiredAt / replacedBySlug / retiredReason", async () => {
    serveWorkspace([
      pkg("ecosystem"),
      {
        ...pkg("radar"),
        retired: {
          at: "2026-10-11T00:00:00.000Z",
          replacedBy: "ecosystem",
          reason: "Radar became the Ecosystem space.",
        },
      } as { slug: string },
    ]);

    await handleCpCatalogSync();

    const rows = upsertedRows() as RetiredRow[];
    const radar = rows.find((r) => r.slug === "radar")!;
    expect(radar.retiredAt?.toISOString()).toBe("2026-10-11T00:00:00.000Z");
    expect(radar.replacedBySlug).toBe("ecosystem");
    expect(radar.retiredReason).toBe("Radar became the Ecosystem space.");
    const live = rows.find((r) => r.slug === "ecosystem")!;
    expect(live.retiredAt).toBeNull();
    expect(live.replacedBySlug).toBeNull();
    // A retired row is part of the complete set: it must not be pruned, and
    // the stamp stays `ok` (the completeness template health relies on).
    expect(recordStampMock.mock.calls.map((c) => c[2])).toContain("ok");
  });

  it("an older CP (no `retired` field) degrades to not-retired", async () => {
    serveWorkspace([pkg("crm")]);
    await handleCpCatalogSync();
    const [row] = upsertedRows() as RetiredRow[];
    expect(row!.retiredAt).toBeNull();
    expect(row!.replacedBySlug).toBeNull();
    expect(row!.retiredReason).toBeNull();
  });
});

/**
 * An OLDER Control Plane does not ignore `includeRetired`: its strict query
 * schema answers 400 `UNKNOWN_QUERY_PARAM` naming it (lane-cp finding). The
 * worker must fetch again without the param (today's behaviour) — never stamp
 * the template kind `misconfigured` — and record that the source could not
 * report retirements, so template health answers `unknown`, not `unlisted`.
 */
describe("handleCpCatalogSync — an older CP refuses includeRetired", () => {
  /** A CP that predates retired templates: 400s the param, serves the rest. */
  function serveOlderCp(all: Array<{ slug: string }>, error?: string) {
    fetchMock.mockImplementation(async (urlArg: string) => {
      const url = String(urlArg);
      if (url.includes("includeRetired")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: error ?? "Unrecognized query parameter(s): 'includeRetired'",
            code: "UNKNOWN_QUERY_PARAM",
          }),
        };
      }
      if (url.includes("/api/marketplace/capabilities"))
        return jsonRes({ capabilities: [] });
      if (url.includes("/api/marketplace/cells"))
        return jsonRes({ cells: [], total: 0 });
      if (url.includes("category=workspace"))
        return jsonRes({ packages: all, total: all.length });
      return jsonRes({ packages: [], total: 0 });
    });
  }
  const templateStamps = () =>
    recordStampMock.mock.calls.filter((c) => c[1] === "template");

  it("retries ONCE without the param, syncs + prunes the live set, stamps `ok` with retirementsUnreported", async () => {
    serveOlderCp([pkg("crm"), pkg("ecosystem")]);
    await handleCpCatalogSync();

    const workspaceUrls = fetchedUrls().filter((u) =>
      u.includes("category=workspace")
    );
    expect(workspaceUrls).toEqual([
      `${CP}/api/packages?category=workspace&limit=100&offset=0&includeRetired=true`,
      `${CP}/api/packages?category=workspace&limit=100&offset=0`,
    ]);
    expect(upsertedRows().map((r) => r.slug)).toEqual(["crm", "ecosystem"]);
    // The live set is complete, so the prune still runs.
    expect(deleteWhereMock).toHaveBeenCalled();
    const stamps = templateStamps();
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.slice(2)).toEqual([
      "ok",
      2,
      { retirementsUnreported: true },
    ]);
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it("a CP that serves includeRetired stamps `ok` WITHOUT the flag", async () => {
    serveWorkspace([pkg("crm")]);
    await handleCpCatalogSync();
    const stamps = templateStamps();
    expect(stamps[0]!.slice(2)).toEqual(["ok", 1]);
  });

  it("a 400 UNKNOWN_QUERY_PARAM naming ANOTHER param is not retried: `misconfigured`", async () => {
    serveOlderCp([pkg("crm")], "Unrecognized query parameter(s): 'limit'");
    await handleCpCatalogSync();
    expect(
      fetchedUrls().filter((u) => u.includes("category=workspace"))
    ).toHaveLength(1);
    expect(templateStamps().map((c) => c[2])).toEqual(["misconfigured"]);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });
});

describe("describeCatalogSources — the one source seam", () => {
  const KEYS = ["CONTROL_PLANE_URL", "CP_URL", "SYNAP_CATALOG_SOURCE"] as const;
  const withEnv = <T>(
    env: Partial<Record<(typeof KEYS)[number], string>>,
    run: () => T
  ): T => {
    const saved = KEYS.map((k) => [k, process.env[k]] as const);
    KEYS.forEach((k) => delete process.env[k]);
    Object.assign(process.env, env);
    try {
      return run();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  const official = (env: Partial<Record<(typeof KEYS)[number], string>>) =>
    withEnv(env, () => describeCatalogSources(null)[0]!);

  it("the official source is the pod's Control Plane when one is set", () => {
    expect(
      official({ CONTROL_PLANE_URL: "https://cp.example.com/" })
    ).toMatchObject({
      id: "synap",
      cacheKey: "https://cp.example.com",
      trust: "official",
      enabled: true,
    });
  });

  it("falls back to Synap's public catalog when none is set (or it is empty)", () => {
    expect(official({}).cacheKey).toBe(DEFAULT_CATALOG_SOURCE);
    expect(official({ CONTROL_PLANE_URL: "" }).cacheKey).toBe(
      DEFAULT_CATALOG_SOURCE
    );
  });

  it("SYNAP_CATALOG_SOURCE=off switches it off and the console cannot turn it on", () => {
    expect(
      official({
        CONTROL_PLANE_URL: "https://cp.example.com",
        SYNAP_CATALOG_SOURCE: "off",
      })
    ).toMatchObject({
      enabled: false,
      lockedOff: true,
      cacheKey: "https://cp.example.com",
    });
    expect(
      withEnv(
        { SYNAP_CATALOG_SOURCE: "off" },
        () =>
          describeCatalogSources({
            sources: [],
            official: { enabled: true, changedBy: "u", changedAt: "" },
          })[0]
      )
    ).toMatchObject({ enabled: false });
  });

  it("a pod admin can turn the official source off; added sources follow it, keyed by id", () => {
    const list = withEnv({}, () =>
      describeCatalogSources({
        official: { enabled: false, changedBy: "u", changedAt: "" },
        sources: [
          {
            id: "acme",
            url: "https://acme.test",
            name: "Acme",
            trust: "showcase",
            publicKey: null,
            keyFingerprint: null,
            agentsMayPropose: true,
            addedBy: "u",
            addedAt: "",
            enabled: true,
          },
        ],
      })
    );
    expect(list.map((s) => [s.id, s.cacheKey, s.enabled])).toEqual([
      ["synap", DEFAULT_CATALOG_SOURCE, false],
      ["acme", "acme", true],
    ]);
    // The agent opt-in only means something on a TRUSTED source.
    expect(list[1]!.agentsMayPropose).toBe(false);
  });
});

describe("handleCpCatalogSync — sources", () => {
  const added = {
    id: "acme",
    url: "https://acme.test",
    name: "Acme",
    trust: "trusted",
    publicKey: "k",
    keyFingerprint: "f",
    addedBy: "u",
    addedAt: "",
    enabled: true,
  };

  beforeEach(() => {
    sourcesMock.read.mockReset();
    sourcesMock.syncThirdParty.mockClear();
    fetchMock.mockResolvedValue(
      jsonRes({ capabilities: [], packages: [], cells: [], total: 0 })
    );
  });

  it("syncs an enabled added source through the signed-index sync, with its last status", async () => {
    sourcesMock.read.mockResolvedValue({
      sources: [added, { ...added, id: "off", enabled: false }],
      official: null,
      status: { acme: { state: "ok" } },
    });
    await handleCpCatalogSync();
    expect(sourcesMock.syncThirdParty).toHaveBeenCalledTimes(1);
    expect(sourcesMock.syncThirdParty.mock.calls[0]).toMatchObject([
      { id: "acme", official: false },
      { state: "ok" },
    ]);
    expect(fetchedUrls().some((u) => u.startsWith(CP))).toBe(true);
  });

  it("a switched-off official source is not fetched", async () => {
    sourcesMock.read.mockResolvedValue({
      sources: [],
      official: { enabled: false, changedBy: "u", changedAt: "" },
      status: {},
    });
    await handleCpCatalogSync();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failed settings read still syncs the official catalog, and no added source", async () => {
    sourcesMock.read.mockRejectedValue(new Error("db down"));
    await handleCpCatalogSync();
    expect(fetchedUrls().some((u) => u.startsWith(CP))).toBe(true);
    expect(sourcesMock.syncThirdParty).not.toHaveBeenCalled();
  });
});
