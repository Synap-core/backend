/**
 * THE DOOR REFUSES WHAT THE VISIBILITY FLOOR REFUSES — and writes nothing.
 *
 * `blockExpectedOutput` accepts a `ref` so an agent can hand the person a real
 * target instead of prose. That pointer goes through the SAME floor a produced
 * artifact's ref goes through (`isOutputRefVisible`), because the alternative is
 * the hole that floor was written to close, one door over: a caller naming any
 * id it likes on its own session.
 *
 * Two properties, and the second is the one that is easy to get wrong:
 *   1. the refusal is a NAMED result member, not a silent drop. A caller told
 *      "blocked" while its pointer was discarded puts an undoorable card on the
 *      board and believes otherwise.
 *   2. NOTHING IS WRITTEN. The mock's `transaction` THROWS, so a refusal that
 *      reaches the write fails this test instead of passing quietly.
 *
 * The `{url}` arm is used for the refused case because it is adjudicated with
 * no database at all (`isHttpUrl`), which keeps this test honest about what it
 * is proving: the DOOR's wiring, not postgres.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    session: null as null | { id: string; expectedOutputs: unknown },
    transactionCalls: 0,
  },
}));

// PARTIAL mock — only `db`. A total replacement goes dark at COLLECTION time
// the moment the module under test imports one more export.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        focusSessions: { findFirst: async () => state.session },
      },
      transaction: async () => {
        state.transactionCalls += 1;
        throw new Error(
          "the write was reached — the refusal did not stop before it"
        );
      },
    },
  };
});

const { blockExpectedOutput } = await import("../block-output.js");

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  state.transactionCalls = 0;
  state.session = {
    id: SESSION,
    expectedOutputs: [{ kind: "url", label: "Stripe key" }],
  };
});

const block = (ref?: unknown) =>
  blockExpectedOutput({
    sessionId: SESSION,
    userId: USER,
    expectedLabel: "Stripe key",
    blockedReason: "credential",
    why: "The restricted key for the live account",
    ...(ref === undefined ? {} : { ref: ref as never }),
  });

describe("blockExpectedOutput — the ref visibility floor", () => {
  it("REFUSES a ref the floor rejects, by name, and writes nothing", async () => {
    const result = await block({ url: "javascript:alert(1)" });
    expect(result.status).toBe("ref_unreachable");
    expect(result).toHaveProperty("reason");
    // Property 2: the refusal happened BEFORE the lock. If this is 1, the
    // transaction threw and the assertion above never ran anyway — but assert
    // it explicitly so the negative control is legible.
    expect(state.transactionCalls).toBe(0);
  });

  it("lets a ref the floor accepts through to the write", async () => {
    // Reaching the write is what we are proving; the mocked transaction throws
    // to make "reached" observable. Anything OTHER than that throw would mean
    // the floor refused a legitimate ref.
    await expect(
      block({ url: "https://dashboard.stripe.com/apikeys" })
    ).rejects.toThrow(/the write was reached/);
    expect(state.transactionCalls).toBe(1);
  });

  it("does not consult the floor at all when no ref is given", async () => {
    await expect(block()).rejects.toThrow(/the write was reached/);
    expect(state.transactionCalls).toBe(1);
  });
});
