/**
 * A duplicate capability key in one CP response must not reach the batch
 * upsert: Postgres refuses the whole statement ("ON CONFLICT DO UPDATE cannot
 * affect row a second time") and the pod's capability cache stays frozen. The
 * CP serves the owning (official) row first, so the FIRST occurrence is kept.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  warn: vi.fn(),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: () => {},
    warn: h.warn,
    error: () => {},
    debug: () => {},
  }),
}));

vi.mock("@synap/database/schema", () => ({
  capabilityTemplateCache: { key: "key" },
}));

vi.mock("@synap/database", () => ({
  drizzleSql: { raw: (s: string) => s },
  notInArray: () => "not-in",
  recordCatalogSyncStamp: async () => {},
  db: {
    insert: () => ({
      values: (rows: Array<Record<string, unknown>>) => {
        h.inserted.push(...rows);
        return { onConflictDoUpdate: async () => {} };
      },
    }),
    delete: () => ({
      where: () => ({ returning: async () => [] }),
    }),
  },
}));

const { handleCapabilityTemplateSync } =
  await import("../capability-template-sync.js");

describe("capability-template-sync — one row per key", () => {
  beforeEach(() => {
    h.inserted.length = 0;
    h.warn.mockClear();
    process.env.CONTROL_PLANE_URL = "https://cp.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          capabilities: [
            { key: "fireflies", name: "Official", definition: {} },
            { key: "fireflies", name: "Imposter", definition: {} },
            { key: "web.read", name: "Web read", definition: {} },
          ],
        }),
      }))
    );
  });

  it("keeps the first row of a duplicated key and says it dropped one", async () => {
    await handleCapabilityTemplateSync();
    expect(h.inserted.map((r) => r.key)).toEqual(["fireflies", "web.read"]);
    expect(h.inserted[0]!.name).toBe("Official");
    expect(h.warn).toHaveBeenCalledWith(
      { dropped: 1 },
      expect.stringContaining("duplicate capability keys")
    );
  });
});
