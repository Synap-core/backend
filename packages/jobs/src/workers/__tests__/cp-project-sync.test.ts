import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the CP project directory pusher (P4-lite W1). The payload
 * builder is pure; the handler test mocks the DB layer and stubs global
 * `fetch`, then asserts the exact CONTRACT request shape (never a real
 * network round-trip) — the CP receiver is built against this same contract.
 */

const { loggerMock, selectMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  selectMock: vi.fn(),
}));

// Chainable, awaitable query builder: every builder method returns itself and
// awaiting it resolves the queued rows (mirrors drizzle's thenable builder).
function queryResult(rows: unknown[]) {
  const q: any = {
    from: () => q,
    where: () => q,
    limit: () => q,
    then: (
      resolve: (v: unknown[]) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve(rows).then(resolve, reject),
  };
  return q;
}

vi.mock("@synap/database", () => {
  const drizzleSql: any = (..._args: unknown[]) => ({});
  drizzleSql.raw = (..._args: unknown[]) => ({});
  return {
    db: { select: selectMock },
    drizzleSql,
  };
});

vi.mock("@synap/database/schema", () => ({
  projects: {
    id: "id",
    slug: "slug",
    name: "name",
    status: "status",
    updatedAt: "updatedAt",
  },
  workspaces: { settings: "settings" },
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => loggerMock,
}));

const fetchMock = vi.fn();

import {
  buildProjectSyncPayloads,
  handleCpProjectSync,
  PROJECT_SYNC_CHUNK_SIZE,
  CP_PROJECT_SYNC_QUEUE,
  CP_PROJECT_SYNC_CRON,
} from "../cp-project-sync.js";

const CP = "https://cp.example.test";
const POD_ID = "pod-123";

beforeEach(() => {
  selectMock.mockReset();
  fetchMock.mockReset();
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  process.env.CONTROL_PLANE_URL = CP;
  process.env.SYNAP_POD_INTERNAL_KEY = "internal-key";
});

function row(n: number) {
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    slug: `project-${n}`,
    name: `Project ${n}`,
    status: "active",
    updatedAt: new Date("2026-07-19T10:00:00.000Z"),
  };
}

describe("buildProjectSyncPayloads", () => {
  it("emits the exact CONTRACT entry shape", () => {
    const payloads = buildProjectSyncPayloads(POD_ID, [
      {
        id: "11111111-1111-1111-1111-111111111111",
        slug: "synap",
        name: "Synap",
        status: "active",
        updatedAt: new Date("2026-07-19T09:30:00.000Z"),
      },
    ]);
    expect(payloads).toEqual([
      {
        podId: POD_ID,
        full: true,
        projects: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            slug: "synap",
            name: "Synap",
            status: "active",
            updatedAt: "2026-07-19T09:30:00.000Z",
            deletedAt: null,
          },
        ],
      },
    ]);
  });

  it("serializes Date AND string timestamps to ISO 8601 (postgres.js gotcha)", () => {
    const [payload] = buildProjectSyncPayloads(POD_ID, [
      { ...row(1), updatedAt: new Date("2026-01-02T03:04:05.000Z") },
      { ...row(2), updatedAt: "2026-01-02 03:04:05+00" }, // driver string form
    ]);
    expect(payload!.projects[0]!.updatedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(payload!.projects[1]!.updatedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("preserves null slugs and always stamps deletedAt null (hard deletes)", () => {
    const [payload] = buildProjectSyncPayloads(POD_ID, [
      { ...row(1), slug: null },
    ]);
    expect(payload!.projects[0]!.slug).toBeNull();
    expect(payload!.projects[0]!.deletedAt).toBeNull();
  });

  it("chunks at 200 per request, each chunk full:true with the same podId", () => {
    const rows = Array.from({ length: 401 }, (_, i) => row(i));
    const payloads = buildProjectSyncPayloads(POD_ID, rows);
    expect(PROJECT_SYNC_CHUNK_SIZE).toBe(200);
    expect(payloads.map((p) => p.projects.length)).toEqual([200, 200, 1]);
    for (const p of payloads) {
      expect(p.full).toBe(true);
      expect(p.podId).toBe(POD_ID);
    }
    // No row lost or duplicated across chunks.
    const ids = payloads.flatMap((p) => p.projects.map((e) => e.id));
    expect(new Set(ids).size).toBe(401);
  });

  it("pushes ONE empty payload when the pod has no projects (CP tombstones all)", () => {
    expect(buildProjectSyncPayloads(POD_ID, [])).toEqual([
      { podId: POD_ID, full: true, projects: [] },
    ]);
  });
});

describe("handleCpProjectSync", () => {
  it("skips without touching DB or network when CP envs are unset", async () => {
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.SYNAP_POD_INTERNAL_KEY;
    await handleCpProjectSync();
    expect(selectMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips when the pod has no CP identity (no controlPlane.podId)", async () => {
    selectMock.mockReturnValueOnce(queryResult([])); // resolveCpPodId → none
    await handleCpProjectSync();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the contract payload to /internal/projects/sync with X-Internal-Key", async () => {
    selectMock
      .mockReturnValueOnce(queryResult([{ podId: POD_ID }])) // resolveCpPodId
      .mockReturnValueOnce(queryResult([row(1)])); // project list
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await handleCpProjectSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${CP}/internal/projects/sync`);
    expect(init.method).toBe("POST");
    expect(init.headers["X-Internal-Key"]).toBe("internal-key");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      podId: POD_ID,
      full: true,
      projects: [
        {
          id: row(1).id,
          slug: "project-1",
          name: "Project 1",
          status: "active",
          updatedAt: "2026-07-19T10:00:00.000Z",
          deletedAt: null,
        },
      ],
    });
  });

  it("defers quietly (warn, no throw) when the CP rejects or is unreachable", async () => {
    selectMock
      .mockReturnValueOnce(queryResult([{ podId: POD_ID }]))
      .mockReturnValueOnce(queryResult([row(1)]));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(handleCpProjectSync()).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});

describe("queue constants", () => {
  it("stays on the agreed queue name + 30-minute cron", () => {
    expect(CP_PROJECT_SYNC_QUEUE).toBe("cp-project-sync");
    expect(CP_PROJECT_SYNC_CRON).toBe("*/30 * * * *");
  });
});
