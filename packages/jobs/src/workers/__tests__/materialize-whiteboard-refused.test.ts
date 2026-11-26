/**
 * A whiteboard write is applied by its approve executor
 * (api routers/proposals/executors/whiteboard.ts, through the place door's
 * realtime write), never by the materializer: this worker cannot reach a
 * board. Nothing emits `whiteboard.*.validated` any more, so a stray job (one
 * queued before the executors existed) is refused ONCE and loudly. A THROW
 * would make pg-boss retry a write that can never succeed here and dead-letter
 * it; a silent success would announce a write that did not happen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventRepository } from "@synap/database";
import { handleMaterialize } from "../materializer.js";

const append = vi
  .spyOn(EventRepository.prototype, "append")
  .mockResolvedValue({} as never);

let proposalRow: Record<string, unknown> | undefined;

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      ...(actual.db as object),
      query: { proposals: { findFirst: vi.fn(async () => proposalRow) } },
    },
  };
});

const job = (action: string) =>
  ({
    id: "job-wb",
    name: "materialize",
    data: {
      eventId: "33333333-3333-4333-8333-333333333333",
      eventType: `whiteboard.${action}.validated`,
      subjectType: "whiteboard",
      action,
      subjectId: "11111111-1111-4111-8111-111111111111",
      userId: "u-1",
      data: { sourceProposalId: "p1" },
    },
  }) as never;

beforeEach(() => {
  append.mockClear();
  proposalRow = { id: "p1", status: "approved", workspaceId: "ws-1" };
});

describe("handleMaterialize: whiteboard.*.validated", () => {
  it.each(["place", "update_shapes", "delete_shapes"])(
    "%s is refused once (no throw, so no retry loop) and announces nothing as written",
    async (action) => {
      await expect(handleMaterialize(job(action))).resolves.toBeUndefined();
      expect(append).not.toHaveBeenCalled();
    }
  );
});
