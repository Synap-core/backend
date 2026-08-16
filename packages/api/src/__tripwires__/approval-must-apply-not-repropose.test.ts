/**
 * TRIPWIRE — an approve executor's replay must APPLY, never re-propose.
 *
 * Executors materialize a proposal by re-running the same router mutation the
 * direct path uses, as the APPROVER. That mutation calls
 * `checkPermissionOrPropose` AGAIN, and the gate can legitimately answer
 * "proposed" — so the replay can file a SECOND proposal instead of applying the
 * first. The executor then marks the original APPROVED and returns success.
 *
 * Observable result: the reviewer approves, nothing is written, and a fresh
 * pending proposal appears with no explanation. Repeatable forever.
 *
 * REACHABILITY (why this is not theoretical): `canReviewProposal` computes
 * `isOwner` as "approver IS the proposer" (`proposals.ts`:
 * `data?.sourceId === reviewerId`). Under the DEFAULT `owner_and_admins` policy
 * that lets a member whose ROLE cannot execute the write approve their OWN
 * proposal — and the replay then re-enters the very insufficient-role branch
 * that created it. Roles `editor`/`admin`/`owner` all hold `write`, so the
 * reachable case is a member below that bar.
 *
 * `assertApplied` converts that silent no-op into a loud failure, and it throws
 * BEFORE the status update, so the original proposal stays PENDING for a
 * reviewer with sufficient authority.
 */

import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { assertApplied } from "../routers/proposals/executors/shared.js";

describe("assertApplied", () => {
  it("throws when a replay re-proposed instead of applying", () => {
    expect(() => assertApplied({ status: "proposed" })).toThrow(TRPCError);
  });

  it("names the cause and the way out, so the failure is diagnosable", () => {
    // A reviewer seeing this needs to know it is a ROLE problem and who to ask —
    // a bare "forbidden" would send them looking for a bug in the project.
    try {
      assertApplied({ status: "proposed" });
      expect.unreachable("assertApplied must throw on a re-proposed replay");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      const message = (err as TRPCError).message;
      expect(message).toMatch(/role/i);
      expect(message).toMatch(/admin|owner/i);
    }
  });

  it.each([
    ["created", { status: "created" }],
    ["updated", { status: "updated" }],
    ["deduped", { status: "deduped" }],
    ["archived", { status: "archived" }],
    // A mutation that returns no status at all has not re-proposed either.
    ["no status", {}],
    ["undefined", undefined],
  ])("passes a genuinely applied result: %s", (_label, result) => {
    expect(() => assertApplied(result)).not.toThrow();
  });
});
