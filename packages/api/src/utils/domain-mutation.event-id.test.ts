/**
 * THE PRODUCER for `automation_runs.trigger_event_id` (0256).
 *
 * The column, the matcher threading, the session stamp and the `events.session_id`
 * back-stamp all shipped correct and the column still read NULL for every
 * event-fired run — because nothing on the first-party path named the event.
 * `emitSideEffects` has no `events` row of its own: the row is written
 * independently by `auditLog`, and the two were uncorrelated.
 *
 * `recordDomainMutation` is the ONE door where they meet. It already AWAITS the
 * log append and holds the returned `EventRecord` before it fans out, so naming
 * the event costs no extra query. This pins that it does.
 *
 *   recordDomainMutation
 *     → auditLog(...)            → EventRecord { id }      ← awaited, in hand
 *     → emitSideEffects({ eventId: record.id })
 *       → automation-trigger-match reactor                 ← pinned in @synap/jobs
 *         → automation_runs.trigger_event_id               ← pinned in @synap/jobs
 *
 * TWO properties, and the second is the one with teeth:
 *   1. the id ARRIVES, and it is the log row's own id — not a fresh uuid, not
 *      the subjectId, not something reconstructed.
 *   2. it arrives TOP-LEVEL and NEVER inside `data`. `data.eventId` is the first
 *      candidate `resolveAutomationEventFingerprintId` reads, so a unique id
 *      there would give every event a unique fingerprint and silently switch
 *      OFF the D5 exactly-once claim. Nothing would throw; runs would just start
 *      duplicating. The matcher-side tripwire
 *      (`automation-trigger-matcher.fingerprint-provenance.test.ts`) proves the
 *      consequence; this one proves this door never creates it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  appended: [] as Record<string, unknown>[],
  emitted: [] as Record<string, unknown>[],
  /** true ⇒ simulate a failed best-effort append (auditLog then returns null). */
  failAppend: false,
}));

vi.mock("@synap/database", async (importOriginal) => {
  // importOriginal + spread, never a total factory: a total replacement kills
  // the whole file the moment this module tree gains an unrelated import.
  const actual = await importOriginal<typeof import("@synap/database")>();
  class CapturingEventRepository {
    async append(record: Record<string, unknown>) {
      h.appended.push(record);
      if (h.failAppend) throw new Error("append failed");
      // ECHOES the incoming id, because that is what the real repository does:
      // `createSynapEvent` mints the id, `auditLog` passes it to `append`, and
      // `EventRepository.append` INSERTs `validated.id` as the row's PK
      // (event-repository.ts:271). A mock that substituted its OWN id would be
      // unfaithful, and the first version of this test did exactly that — it
      // went red against correct code, which is how the drift was caught.
      return { ...record, id: record.id };
    }
  }
  return {
    ...actual,
    sql: {},
    EventRepository: CapturingEventRepository,
    eventRepository: new CapturingEventRepository(),
  };
});

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/events")>();
  return {
    ...actual,
    emitSideEffects: vi.fn(async (p: Record<string, unknown>) => {
      h.emitted.push(p);
    }),
  };
});

import { recordDomainMutation } from "./domain-mutation.js";

const SUBJECT = "aaaaaaaa-1111-4111-8111-111111111111";

const mutate = () =>
  recordDomainMutation({
    subjectType: "relation",
    action: "create",
    subjectId: SUBJECT,
    userId: "user-1",
    workspaceId: "ws-1",
    data: { relationType: "knows" },
  });

beforeEach(() => {
  h.appended.length = 0;
  h.emitted.length = 0;
  h.failAppend = false;
});

describe("recordDomainMutation names the event it just wrote", () => {
  it("hands the APPENDED row's own id to the side-effect fan-out", async () => {
    await mutate();

    // Non-vacuity: a log row was actually appended, so the id below is a real
    // return value and not an accident of an empty capture.
    expect(h.appended).toHaveLength(1);
    expect(h.emitted).toHaveLength(1);

    // The VALUE, tied BY IDENTITY to the row that was appended rather than to a
    // constant this test chose — so it stays true if the id scheme changes and
    // it cannot pass on a coincidence.
    const appendedId = h.appended[0].id;
    expect(typeof appendedId).toBe("string");
    expect(h.emitted[0].eventId).toBe(appendedId);
    // Not something reconstructed: not the subject, not a second fresh uuid.
    expect(h.emitted[0].eventId).not.toBe(SUBJECT);
  });

  it("puts it TOP-LEVEL and never inside `data` (the fingerprint trap)", async () => {
    await mutate();
    const emitted = h.emitted[0];

    expect(emitted).toHaveProperty("eventId");
    // `data` must be exactly what the caller passed. An id in here would make
    // every event's fingerprint unique and disable the exactly-once claim.
    expect(emitted.data).toEqual({ relationType: "knows" });
    expect((emitted.data as Record<string, unknown>).eventId).toBeUndefined();
  });

  it("claims NO event when the best-effort append failed", async () => {
    // `auditLog` swallows a failed append and returns null. The fan-out still
    // runs — that is the existing contract — but it must not claim an event
    // that was never written. NULL means "nothing claimed".
    h.failAppend = true;
    await mutate();

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].eventId).toBeNull();
  });

  it("does not disturb the fields the fan-out already carried", async () => {
    // Surgical: this change adds a key, it does not reshape the payload that
    // search-indexing, webhooks and the matcher already read.
    await mutate();
    expect(h.emitted[0]).toMatchObject({
      subjectType: "relation",
      action: "create",
      subjectId: SUBJECT,
      userId: "user-1",
      workspaceId: "ws-1",
      sessionId: null,
    });
  });
});
