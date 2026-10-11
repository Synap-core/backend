/**
 * SEAM test (TEMPLATE-LIFECYCLE Contract C): the REAL
 * `reconcileWorkspaceFromDefinition` HOLDS the `packageVersion` stamp while a
 * consentable data change the template depends on is pending, and stamps it
 * once only destructive (operator-step) changes remain. The marker may only
 * claim what converged (backend-rules: template→installed convergence).
 * `pendingTemplateDataChanges` is mocked (proven on PGlite in
 * `conversions/data-changes.pglite.test.ts`); `holdsTemplateStamp` is REAL.
 * Same mocked-`client-pg` harness as `reconcile-workspace-brief.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPending = vi.fn();

let liveSettings: Record<string, unknown> = {};
let casMatches = true;
const writes: Array<{ patch: Record<string, unknown>; whereSql: string }> = [];

/** Pull the JSON params and SQL text out of a drizzle `sql` object. */
function flatten(node: unknown, params: string[], text: string[]): void {
  if (node === null || node === undefined) return;
  if (typeof node === "string") {
    params.push(node);
    return;
  }
  const n = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(n.queryChunks)) {
    for (const c of n.queryChunks) flatten(c, params, text);
    return;
  }
  if (Array.isArray(n.value)) text.push((n.value as string[]).join(""));
}

vi.mock("../client-pg.js", () => {
  const db = {
    query: {
      workspaces: {
        findFirst: async () => ({ id: "ws-1", settings: liveSettings }),
      },
      views: { findMany: async () => [] },
      relationDefs: {
        findMany: async () => [],
        findFirst: async () => undefined,
      },
      intelligenceCommands: { findMany: async () => [] },
    },
    // `.limit` too: the identity check reads one row (none held here).
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve([]), { limit: async () => [] }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: (w: unknown) => {
          const params: string[] = [];
          const text: string[] = [];
          flatten(v.settings, params, text);
          const whereParams: string[] = [];
          const whereText: string[] = [];
          flatten(w, whereParams, whereText);
          for (const p of params) {
            try {
              writes.push({
                patch: JSON.parse(p) as Record<string, unknown>,
                whereSql: whereText.join(" "),
              });
            } catch {
              /* not JSON */
            }
          }
          const isCas = whereText.join(" ").includes("onboarding");
          const rows =
            casMatches || !isCas ? [{ id: "ws-1", settings: {} }] : [];
          const p = Promise.resolve(rows) as Promise<unknown[]> & {
            returning: () => Promise<unknown[]>;
          };
          p.returning = async () => rows;
          return p;
        },
      }),
    }),
  };
  return { getDb: async () => db, sql: {} };
});
vi.mock("../repositories/event-repository.js", () => ({
  EventRepository: class {
    async append() {}
  },
}));
vi.mock("./workspace-client-projection.js", () => ({
  projectWorkspaceSettings: (w: unknown) => w,
}));

vi.mock("../conversions/data-changes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../conversions/data-changes.js")>()),
  pendingTemplateDataChanges: (...a: unknown[]) => mockPending(...a),
}));

const { reconcileWorkspaceFromDefinition } =
  await import("./reconcile-workspace-from-definition.js");

const change = (opKey: string, destructive: boolean) => ({
  opKey,
  description: opKey,
  affected: 3,
  destructive,
  counts: {},
});

const stamped = () => writes.some((w) => w.patch.packageVersion === "2.0.0");

async function reconcile(pendingDataChanges?: ReturnType<typeof change>[]) {
  return reconcileWorkspaceFromDefinition({
    workspaceId: "ws-1",
    userId: "u-1",
    definition: { workspaceSubtype: "crm" },
    packageSlug: "crm",
    packageVersion: "2.0.0",
    ...(pendingDataChanges ? { pendingDataChanges } : {}),
  });
}

beforeEach(() => {
  writes.length = 0;
  liveSettings = { packageSlug: "crm", packageVersion: "1.0.0" };
  mockPending.mockReset();
});

describe("reconcile — the version stamp waits for data changes (seam)", () => {
  it("HOLDS the stamp while a consentable change is pending", async () => {
    mockPending.mockResolvedValue([change("crm.deal", false)]);
    const report = await reconcile();
    expect(report.dataChanges?.versionHeld).toBe(true);
    expect(report.settings.merged).not.toContain("packageVersion");
    expect(stamped()).toBe(false);
  });

  it("stamps when only destructive changes remain (operator steps never hold it)", async () => {
    mockPending.mockResolvedValue([change("crm.churned", true)]);
    const report = await reconcile();
    expect(report.dataChanges?.versionHeld).toBe(false);
    expect(report.settings.merged).toContain("packageVersion");
    expect(stamped()).toBe(true);
  });

  it("stamps when nothing is pending", async () => {
    mockPending.mockResolvedValue([]);
    const report = await reconcile();
    expect(report.dataChanges?.versionHeld).toBe(false);
    expect(stamped()).toBe(true);
  });

  it("a FAILED pending read holds the stamp — never stamped unearned", async () => {
    mockPending.mockRejectedValue(new Error("ledger unreadable"));
    const report = await reconcile();
    expect(report.dataChanges).toMatchObject({
      versionHeld: true,
      error: "ledger unreadable",
    });
    expect(stamped()).toBe(false);
  });

  it("the boot sweep's memoized set is used as given (no second read)", async () => {
    const report = await reconcile([change("crm.deal", false)]);
    expect(mockPending).not.toHaveBeenCalled();
    expect(report.dataChanges?.versionHeld).toBe(true);
    expect(stamped()).toBe(false);
  });
});
