import { describe, it, expect, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { dispatchExternalOnce } from "../approve-executors.js";

/**
 * Unit coverage for the at-most-once HYBRID dispatch decision table
 * (dispatchExternalOnce). This is the irreversible-send governance primitive —
 * a wrong branch either double-sends or silently reports a failed send as
 * delivered, so every arm is pinned here. No DB: a fake executor stands in for
 * the CAS claim + release, distinguished by the value set on external_dispatched_at
 * (a Date = claim, null = release).
 */
function makeExecutor(claimWon: boolean) {
  const calls = { claims: 0, releases: 0 };
  const executor = {
    update() {
      return {
        set(vals: Record<string, unknown>) {
          const isRelease = vals.externalDispatchedAt === null;
          if (isRelease) calls.releases++;
          else calls.claims++;
          const whereResult = Promise.resolve(undefined) as Promise<undefined> & {
            returning: () => Promise<Array<{ id: string }>>;
          };
          whereResult.returning = () =>
            Promise.resolve(isRelease ? [] : claimWon ? [{ id: "p1" }] : []);
          return { where: () => whereResult };
        },
      };
    },
  };
  return { executor: executor as unknown as Parameters<typeof dispatchExternalOnce>[2], calls };
}

describe("dispatchExternalOnce — at-most-once hybrid failure policy", () => {
  it("claim LOST → throws CONFLICT, never runs the send, never releases", async () => {
    const { executor, calls } = makeExecutor(false);
    const send = vi.fn();
    await expect(
      dispatchExternalOnce("p1", send, executor)
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(send).not.toHaveBeenCalled();
    expect(calls.releases).toBe(0);
  });

  it("claim WON + delivered:true → resolves, send ran once, no release (caller marks APPROVED)", async () => {
    const { executor, calls } = makeExecutor(true);
    const send = vi.fn().mockResolvedValue({ delivered: true });
    await expect(dispatchExternalOnce("p1", send, executor)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls.claims).toBe(1);
    expect(calls.releases).toBe(0);
  });

  it("claim WON + delivered:false (DEFINITE not-sent) → RELEASES the claim, then throws", async () => {
    const { executor, calls } = makeExecutor(true);
    const send = vi.fn().mockResolvedValue({ delivered: false });
    await expect(
      dispatchExternalOnce("p1", send, executor)
    ).rejects.toBeInstanceOf(TRPCError);
    expect(calls.releases).toBe(1); // released so a Retry can re-dispatch
  });

  it("claim WON + send THROWS (ambiguous) → propagates the error, KEEPS the claim (no release)", async () => {
    const { executor, calls } = makeExecutor(true);
    const send = vi.fn().mockRejectedValue(new Error("connector timeout"));
    await expect(dispatchExternalOnce("p1", send, executor)).rejects.toThrow(
      "connector timeout"
    );
    expect(calls.releases).toBe(0); // claim kept → retry will NOT resend (at-most-once)
  });
});
