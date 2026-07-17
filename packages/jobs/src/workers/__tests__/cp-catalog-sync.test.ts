import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Boundary test for cp-catalog-sync. We mock the DB layer and stub global
 * `fetch`, then assert the REQUEST SHAPE the worker produces (never a real
 * network round-trip) plus the resilience split introduced alongside the
 * 0049 vocabulary fix:
 *   - the outbound CP `category` uses the LIVE vocabulary (`workspace` /
 *     `workflow`), NEVER the retired `template` / `automation`;
 *   - a 4xx is stamped `misconfigured` + logged at error (permanent), while a
 *     5xx / network error stays `unreachable` (transient).
 */

const { recordStampMock, loggerMock } = vi.hoisted(() => ({
  recordStampMock: vi.fn(
    async (
      _source: string,
      _kind: string,
      _status: string,
      _count: number
    ): Promise<void> => undefined
  ),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@synap/database", () => ({
  db: {},
  drizzleSql: { raw: vi.fn() },
  and: vi.fn(),
  eq: vi.fn(),
  notInArray: vi.fn(),
  recordCatalogSyncStamp: recordStampMock,
}));

vi.mock("@synap/database/schema", () => ({
  cpCatalogCache: {},
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
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.CONTROL_PLANE_URL = CP;
});

/** All URLs the worker fetched this run. */
function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
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
    // template kind → CP category=workspace
    expect(urls).toContain(`${CP}/api/packages?category=workspace&limit=100`);
    // automation kind → CP category=workflow
    expect(urls).toContain(`${CP}/api/packages?category=workflow&limit=100`);
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
