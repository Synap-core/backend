/**
 * A playbook's backing cron automation must be armed EXACTLY when the playbook
 * is live.
 *
 * The bug this pins: `archive` set `status:"archived"` and nothing else, while
 * `materializePlaybookCronAutomation` keyed only on `schedule.enabled`. So an
 * archived playbook stopped being suggested on entities while its backing
 * automation stayed `active` with a live `nextRunAt` — it kept firing. The gate
 * is on `status`, not on the archive door, so every transition is covered:
 * draft never arms, paused/archived tear down, active arms.
 *
 * DB is mocked (no live Postgres in CI); assertions are on what the writes were
 * handed, which is where `status` / `nextRunAt` are decided.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: mockGetDb };
});

import { materializePlaybookCronAutomation } from "./cron-automation.js";
import type { Playbook } from "@synap/database/schema";

interface Captured {
  inserted: Record<string, unknown>[];
  updated: Record<string, unknown>[];
}

/** Minimal db double: records every `.values()` / `.set()` payload. */
function mockDb(captured: Captured, existingAutomation: unknown = null) {
  return {
    insert: () => {
      const chain = {
        values: (v: Record<string, unknown>) => {
          captured.inserted.push(v);
          return chain;
        },
        returning: () => Promise.resolve([{ id: "auto-1" }]),
      };
      return chain;
    },
    update: () => {
      const chain = {
        set: (v: Record<string, unknown>) => {
          captured.updated.push(v);
          return chain;
        },
        where: () => Promise.resolve(undefined),
      };
      return chain;
    },
    query: {
      automations: { findFirst: () => Promise.resolve(existingAutomation) },
    },
  };
}

function playbook(over: Partial<Playbook>): Playbook {
  return {
    id: "pb-1",
    workspaceId: "ws-1",
    name: "Weekly digest",
    schedule: { cron: "0 9 * * *", enabled: true },
    flowAutomationId: null,
    subjectProfile: null,
    status: "active",
    ...over,
  } as Playbook;
}

const CTX = { userId: "user-1" };

describe("materializePlaybookCronAutomation — the playbook status gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("active + schedule.enabled → arms one active automation with a nextRunAt", async () => {
    const captured: Captured = { inserted: [], updated: [] };
    mockGetDb.mockResolvedValue(mockDb(captured));

    const id = await materializePlaybookCronAutomation(
      playbook({ status: "active" }),
      CTX
    );

    expect(id).toBe("auto-1");
    expect(captured.inserted).toHaveLength(1);
    expect(captured.inserted[0]!.status).toBe("active");
    expect(captured.inserted[0]!.nextRunAt).toBeInstanceOf(Date);
    // …and the playbook was stamped with the backing row.
    expect(captured.updated[0]!.flowAutomationId).toBe("auto-1");
  });

  it.each(["draft", "paused", "archived"] as const)(
    "%s + schedule.enabled → does NOT arm anything",
    async (status) => {
      const captured: Captured = { inserted: [], updated: [] };
      mockGetDb.mockResolvedValue(mockDb(captured));

      const id = await materializePlaybookCronAutomation(
        playbook({ status }),
        CTX
      );

      expect(id).toBeNull();
      expect(captured.inserted).toEqual([]);
    }
  );

  it("archived with a live backing automation → tears it down (the reported bug)", async () => {
    const captured: Captured = { inserted: [], updated: [] };
    mockGetDb.mockResolvedValue(mockDb(captured, { id: "auto-live" }));

    const id = await materializePlaybookCronAutomation(
      playbook({ status: "archived", flowAutomationId: "auto-live" }),
      CTX
    );

    expect(id).toBeNull();
    expect(captured.inserted).toEqual([]);
    // The automation is paused with its nextRunAt cleared…
    expect(captured.updated[0]).toMatchObject({
      status: "paused",
      nextRunAt: null,
    });
    // …and the playbook no longer points at it.
    expect(captured.updated[1]).toMatchObject({ flowAutomationId: null });
  });

  it("active but schedule disabled → still tears down (unchanged behaviour)", async () => {
    const captured: Captured = { inserted: [], updated: [] };
    mockGetDb.mockResolvedValue(mockDb(captured, { id: "auto-live" }));

    const id = await materializePlaybookCronAutomation(
      playbook({
        status: "active",
        schedule: { cron: "0 9 * * *", enabled: false },
        flowAutomationId: "auto-live",
      }),
      CTX
    );

    expect(id).toBeNull();
    expect(captured.updated[0]).toMatchObject({
      status: "paused",
      nextRunAt: null,
    });
  });
});
