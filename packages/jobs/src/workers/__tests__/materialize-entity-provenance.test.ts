/**
 * `materializeEntity` — provenance forwarding (run attribution).
 *
 * The materializer is the ONE door for creating an entity row, and it forwards
 * the caller's provenance into `EntityRepository.create`. It forwarded four of
 * five fields: `correlationId` — WHICH RUN produced this row — was silently
 * dropped, because `EntityProvenance` had no such field, even though
 * `EntityRepository.create` accepts it and `entities.correlation_id` exists.
 * Visible symptom: an automation-created entity+document pair where the
 * DOCUMENT knew its run and the ENTITY did not.
 *
 * Lives in `packages/jobs` rather than beside the source because the database
 * package's vitest setup requires a live Postgres; this suite does not, so the
 * test actually RUNS on every gate instead of skipping.
 *
 * The repository is stubbed by SPYING ON ITS PROTOTYPE (not `vi.mock` of the
 * module path — the materializer imports it by a package-internal specifier
 * that a cross-package mock id does not intercept). The materializer
 * constructs the very class exported from the barrel, so the prototype spy is
 * the door it actually goes through.
 *
 * WHAT THIS PROVES / DOES NOT: this locks the ARGUMENTS crossing the
 * materializer→repository door. It does not prove the column write (live PG).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { materializeEntity, EntityRepository } from "@synap/database";

const createSpy = vi.spyOn(EntityRepository.prototype, "create");

const run = (correlationId?: string) =>
  materializeEntity(
    { profileSlug: "report", title: "Weekly report", userId: "user-1" },
    {
      db: {} as never,
      eventRepo: {} as never,
      provenance: {
        createdByKind: "ai_agent",
        agentUserId: "agent-1",
        createdByUserId: "agent-1",
        ...(correlationId ? { correlationId } : {}),
      },
    }
  );

describe("materializeEntity — provenance forwarding", () => {
  beforeEach(() => {
    createSpy.mockReset();
    createSpy.mockResolvedValue({
      id: "e-1",
      title: "Weekly report",
    } as never);
  });

  afterEach(() => {
    createSpy.mockReset();
  });

  it("forwards correlationId (the producing run) into EntityRepository.create", async () => {
    await run("root-run-1");

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      createdByKind: "ai_agent",
      agentUserId: "agent-1",
      createdByUserId: "agent-1",
      correlationId: "root-run-1",
    });
  });

  it("passes correlationId: undefined when the caller states none (no invented value)", async () => {
    await run();

    expect(createSpy.mock.calls[0][0].correlationId).toBeUndefined();
  });
});
