/**
 * Regression lock for the "realtime events never fire" P0.
 *
 * Root cause: `eventHooks` is a plain per-instance field on EventRepository
 * (see `event-repository.ts`), but ~40 call sites across the API package
 * constructed their own `new EventRepository(sql)` to feed into
 * EntityRepository/ViewRepository/RelationRepository/WorkspaceRepository/etc.
 * Those fresh instances have an EMPTY hook array, so `BaseRepository.
 * emitCompleted()` → `eventRepo.append()` → `notifyHooks()` was a silent
 * no-op — the registered realtime/materialization/sync hooks (registered
 * once, at startup, on the module-level `eventRepository` singleton) were
 * never reached.
 *
 * These tests exercise the hook mechanism itself with a stubbed `sql` client
 * (no live DB needed) to lock two invariants:
 *   1. Hooks registered on an instance ARE notified — exactly once each —
 *      when that same instance appends an event.
 *   2. Hooks are per-instance: a hook registered on one EventRepository
 *      instance is NOT notified by a different instance's append(). This is
 *      exactly the bug shape, and it's why the fix (surgical: swap the ~40
 *      repository-feeding call sites to the shared singleton) is necessary —
 *      a global/static hook list (the "Option A" alternative) was rejected
 *      instead, because non-realtime callers (e.g. `utils/audit-log.ts`)
 *      deliberately construct fresh, hookless instances to avoid
 *      double-firing hooks for events they append outside the repository
 *      layer, and a shared static array would have broken that isolation.
 */

import { describe, it, expect, vi } from "vitest";
import { EventRepository } from "../event-repository.js";

/** Minimal fake postgres.js client: only `.unsafe()` is exercised by `query()`. */
function makeFakeSql() {
  const unsafe = vi.fn().mockImplementation(async (_sqlString: string) => {
    // Simulate the `RETURNING *` row shape `mapRow()` expects.
    return [
      {
        id: "evt-1",
        subject_id: "subject-1",
        subject_type: "entity",
        type: "entity.create.completed",
        user_id: "user-1",
        data: JSON.stringify({ id: "entity-1" }),
        metadata: JSON.stringify({}),
        source: "api",
        timestamp: new Date().toISOString(),
      },
    ];
  });
  return { unsafe } as any;
}

function baseEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: crypto.randomUUID(),
    type: "entity.create.completed",
    userId: crypto.randomUUID(),
    data: { id: "entity-1" },
    timestamp: new Date(),
    source: "api" as const,
    version: "v1" as const,
    ...overrides,
  };
}

describe("EventRepository hooks (realtime wiring regression lock)", () => {
  it("notifies every hook registered on the instance exactly once per append", async () => {
    const repo = new EventRepository(makeFakeSql());
    const hookA = vi.fn();
    const hookB = vi.fn();
    repo.addEventHook(hookA);
    repo.addEventHook(hookB);

    await repo.append(baseEvent() as any);
    // notifyHooks is fire-and-forget (not awaited inside append()) — flush
    // the microtask queue before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hookA).toHaveBeenCalledTimes(1);
    expect(hookB).toHaveBeenCalledTimes(1);
  });

  it("does NOT notify a hook registered on a different EventRepository instance (the exact bug shape)", async () => {
    const singleton = new EventRepository(makeFakeSql());
    const hookOnSingleton = vi.fn();
    singleton.addEventHook(hookOnSingleton);

    // This mirrors the pre-fix call sites: `new EventRepository(sql)` fed
    // into a repository instead of the shared singleton.
    const freshInstance = new EventRepository(makeFakeSql());
    await freshInstance.append(baseEvent() as any);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hookOnSingleton).not.toHaveBeenCalled();
  });

  it("removeEventHook stops further notification", async () => {
    const repo = new EventRepository(makeFakeSql());
    const hook = vi.fn();
    repo.addEventHook(hook);
    repo.removeEventHook(hook);

    await repo.append(baseEvent() as any);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hook).not.toHaveBeenCalled();
  });
});
