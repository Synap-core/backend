/**
 * TEMPORAL SPINE WRITE PATH (0241) — `events.session_id` actually reaches the row.
 *
 * `recordDomainMutation` has held the focus-session id in scope since the
 * session substrate landed, and handed it ONLY to the automation matcher. The
 * event row — the one append-only place that knows WHEN something happened —
 * never learned it, so "which session produced this change" was unanswerable.
 *
 * The value crosses four seams to reach the column, and EVERY one of them has
 * silently dropped a fully-plumbed provenance field in this repo before:
 *
 *   recordDomainMutation(opts.sessionId)
 *     → auditLog(opts.sessionId)
 *       → EventRepository.append({ sessionId })
 *         → SynapEventSchema.parse    ← a field the schema does not declare is
 *                                       STRIPPED here, with no error
 *           → INSERT … session_id
 *
 * This exercises the first three from the public door and asserts the fourth
 * structurally, because the INSERT needs Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ appended: [] as Record<string, unknown>[] }));

vi.mock("@synap/database", async (importOriginal) => {
  // TOTAL replacement would kill every other export this module tree imports
  // (a known way to break a whole suite on an unrelated new import), so the
  // real module is spread and only the append seam is swapped.
  const actual = await importOriginal<typeof import("@synap/database")>();
  class CapturingEventRepository {
    async append(record: Record<string, unknown>) {
      h.appended.push(record);
      return { id: "event-1", ...record };
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
  return { ...actual, emitSideEffects: vi.fn(async () => undefined) };
});

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { recordDomainMutation } from "./domain-mutation.js";
import { SynapEventSchema } from "@synap-core/core";

const SESSION_ID = "3f4c1a2b-1111-4111-8111-111111111111";

beforeEach(() => {
  h.appended.length = 0;
});

describe("recordDomainMutation → events.session_id", () => {
  it("carries the session id onto the appended event row", async () => {
    await recordDomainMutation({
      subjectType: "relation",
      action: "create",
      subjectId: "aaaaaaaa-1111-4111-8111-111111111111",
      userId: "user-1",
      sessionId: SESSION_ID,
      data: { relationType: "knows" },
    });

    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({ sessionId: SESSION_ID });
  });

  it("leaves the column unset for a write that happened outside any session", async () => {
    await recordDomainMutation({
      subjectType: "relation",
      action: "create",
      subjectId: "aaaaaaaa-1111-4111-8111-111111111111",
      userId: "user-1",
      data: { relationType: "knows" },
    });

    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]?.sessionId).toBeUndefined();
  });
});

describe("the seams that silently drop a provenance field", () => {
  it("SynapEventSchema DECLARES sessionId, so parse cannot strip it", () => {
    const parsed = SynapEventSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      version: "v1",
      type: "relation.create.completed",
      subjectType: "relation",
      subjectId: "aaaaaaaa-1111-4111-8111-111111111111",
      userId: "user-1",
      timestamp: new Date(),
      data: {},
      metadata: {},
      source: "api",
      sessionId: SESSION_ID,
    });
    expect(parsed.sessionId).toBe(SESSION_ID);
  });

  it("EventRepository.append names session_id in BOTH the column list and the values", () => {
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../database/src/repositories/event-repository.ts"
      ),
      "utf8"
    );
    // The column must be inserted, and it must be fed from the VALIDATED payload
    // (reading `record.sessionId` instead would bypass the schema and mask a
    // future strip).
    expect(src).toMatch(/session_id\s*\n?\s*\)\s*VALUES/);
    expect(src).toContain("validated.sessionId ?? null");
  });
});
