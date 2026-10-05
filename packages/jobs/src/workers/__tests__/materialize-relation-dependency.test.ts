/**
 * Since migration 0301 `blocks` / `depends_on` are THE dependency edge (a
 * `links` `blocked_by` row). The api applies an approved one through the
 * dependency door; the raw relation writer here must never mint one, or each
 * approval of a pre-0301 proposal would undo 0301 one row at a time. Every
 * other relation slug is still written (anti-vacuity).
 *
 * Only the proposal lookup and the relation insert are faked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ inserted: [] as Record<string, unknown>[] }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const fakeDb = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        h.inserted.push(v);
        return { onConflictDoNothing: async () => undefined };
      },
    }),
  };
  return {
    ...actual,
    getDb: async () => fakeDb,
    db: {
      ...(actual.db as object),
      query: {
        proposals: {
          findFirst: vi.fn(async () => ({
            id: "p-1",
            status: "approved",
            workspaceId: null,
            agentUserId: null,
          })),
        },
      },
    },
  };
});

vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn(async () => {}) }));

import { EventRepository } from "@synap/database";
import { handleMaterialize } from "../materializer.js";

vi.spyOn(EventRepository.prototype, "append").mockResolvedValue({} as never);

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";

function relationJob(type: string) {
  return {
    id: "job-1",
    name: "materialize",
    data: {
      eventId: "33333333-3333-4333-8333-333333333333",
      eventType: "relation.create.validated",
      subjectType: "relation",
      action: "create",
      subjectId: "rel-1",
      userId: "user-1",
      workspaceId: null,
      data: {
        sourceEntityId: A,
        targetEntityId: B,
        type,
        sourceProposalId: "p-1",
      },
    },
  } as never;
}

beforeEach(() => {
  h.inserted.length = 0;
});

describe("materializeRelation — never a raw dependency row", () => {
  it.each(["blocks", "depends_on"])(
    "refuses `%s` (it is a links blocked_by edge)",
    async (type) => {
      await handleMaterialize(relationJob(type));
      expect(h.inserted).toHaveLength(0);
    }
  );

  it("still writes any other relation (anti-vacuity)", async () => {
    await handleMaterialize(relationJob("works_with"));
    expect(h.inserted).toEqual([
      expect.objectContaining({
        sourceEntityId: A,
        targetEntityId: B,
        type: "works_with",
      }),
    ]);
  });
});
