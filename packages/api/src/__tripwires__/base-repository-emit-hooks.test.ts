/**
 * TRIPWIRE — `BaseRepository.emitCompleted()` must keep appending through its
 * `eventRepo`, because that append is the FACT bus: it is the only thing that
 * runs `EventRepository.notifyHooks()` and therefore the only path to the four
 * hooks registered at startup by `setupEventBroadcasting()` — SSE broadcast,
 * the Socket.IO domain bridge, materialization, and cross-pod sync push.
 *
 * WHY THIS EXISTS (a near-miss, not a hypothetical): the append used to carry
 * the comment "Inngest workers will pick up completed events from the
 * database". Inngest was removed (packages/jobs/src/workers/side-effects.ts),
 * so that comment described a dead consumer and made the append itself read as
 * dead code. It is not dead. A proposal to delete it — on the theory that
 * `recordDomainMutation()` already covers the same mutations — would have
 * silently killed realtime, SSE and peer sync, because:
 *
 *   - `auditLog()` DELIBERATELY builds a fresh, hookless `new
 *     EventRepository(sql)` for every non-`validated` phase, specifically so it
 *     does NOT double-fire these hooks (its own comment names "the
 *     repositories" as the half that drives broadcast/sync). So the two emits
 *     are NOT interchangeable: one writes a row AND fires hooks, the other
 *     writes a row only.
 *   - `view.*`, `document.*`, `project.*` and `entity_facet.*` have NO
 *     `recordDomainMutation` door anywhere in the backend — `emitCompleted` is
 *     their ONLY producer.
 *   - `workspaces.update.completed` (plural, emitted here) is the sole producer
 *     of the `workspace:updated` Socket.IO event mapped in
 *     `utils/domain-event-bridge.ts`. The live door writes SINGULAR
 *     `workspace.*`, which that bridge does not map.
 *
 * These tests assert the MECHANISM — that a hook registered on the instance a
 * repository was constructed with actually fires when `emitCompleted` runs —
 * not the wording of any comment. Deleting the append, or routing it through a
 * hookless instance, fails them.
 */

import { describe, it, expect, vi } from "vitest";
import { BaseRepository, EventRepository } from "@synap/database";

/** Minimal fake postgres.js client: only `.unsafe()` is exercised by `query()`. */
function makeFakeSql() {
  const unsafe = vi.fn().mockImplementation(async () => [
    {
      id: "evt-1",
      subject_id: "subject-1",
      subject_type: "view",
      type: "view.update.completed",
      user_id: "user-1",
      data: JSON.stringify({ id: "view-1" }),
      metadata: JSON.stringify({}),
      source: "api",
      timestamp: new Date().toISOString(),
    },
  ]);
  return { unsafe } as any;
}

/**
 * A concrete BaseRepository purely to reach the protected `emitCompleted`.
 * The abstract CRUD members are unused by these tests.
 */
class ProbeRepository extends BaseRepository<
  { id: string },
  { id: string },
  { id: string }
> {
  async create(): Promise<{ id: string }> {
    throw new Error("unused");
  }
  async update(): Promise<{ id: string }> {
    throw new Error("unused");
  }
  async delete(): Promise<void> {
    throw new Error("unused");
  }

  /** Public seam onto the protected method under test. */
  async probeEmit(action: "create" | "update" | "delete", id: string) {
    // `append()` Zod-validates subjectId/userId as UUIDs — use real ones.
    await this.emitCompleted(action as never, { id }, crypto.randomUUID());
  }
}

const VIEW_ID = crypto.randomUUID();
const WS_ID = crypto.randomUUID();

describe("tripwire: BaseRepository.emitCompleted feeds the event hooks", () => {
  it("appends through eventRepo, so hooks registered on that instance fire", async () => {
    const eventRepo = new EventRepository(makeFakeSql());
    const hook = vi.fn();
    eventRepo.addEventHook(hook);

    const repo = new ProbeRepository({} as never, eventRepo, {
      subjectType: "view",
    });
    await repo.probeEmit("update", VIEW_ID);

    // notifyHooks is fire-and-forget inside append() — flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // THE INVARIANT: removing the `eventRepo.append(...)` call from
    // emitCompleted makes this zero, which is exactly the realtime outage.
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("emits `<subjectType>.<action>.completed`, preserving the configured subjectType verbatim", async () => {
    const eventRepo = new EventRepository(makeFakeSql());
    const appendSpy = vi.spyOn(eventRepo, "append");

    // `workspaces` is PLURAL on purpose — domain-event-bridge.ts maps
    // `workspaces.update.completed`, and the singular `workspace.*` written by
    // the recordDomainMutation door is a DIFFERENT, unmapped name. If someone
    // "corrects" the spelling here, workspace realtime goes dark silently.
    const repo = new ProbeRepository({} as never, eventRepo, {
      subjectType: "workspaces",
    });
    await repo.probeEmit("update", WS_ID);

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const appended = appendSpy.mock.calls[0][0] as {
      type: string;
      subjectType: string;
      subjectId: string;
    };
    expect(appended.type).toBe("workspaces.update.completed");
    expect(appended.subjectType).toBe("workspaces");
    expect(appended.subjectId).toBe(WS_ID);
  });

  it("a hookless instance receives nothing — why emitCompleted must be fed the singleton", async () => {
    // Mirrors `auditLog()`'s deliberate fresh-instance construction: the row is
    // still written, but no hook runs. This is the shape of the outage, and it
    // is why "recordDomainMutation already covers it" is false.
    const singleton = new EventRepository(makeFakeSql());
    const hookOnSingleton = vi.fn();
    singleton.addEventHook(hookOnSingleton);

    const freshHookless = new EventRepository(makeFakeSql());
    const repo = new ProbeRepository({} as never, freshHookless, {
      subjectType: "view",
    });
    await repo.probeEmit("update", VIEW_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hookOnSingleton).not.toHaveBeenCalled();
  });
});
