/**
 * ONE merged request write context: every entry COMPOSES with the store it is
 * nested in. An MCP request made with a HUB_TEST key AND a derived session must
 * carry BOTH facts to the floors — a `run` that replaced the store would drop
 * the outer one silently (probe writes stop being marked, or a guessed session
 * starts placing projects again).
 *
 * Driven through the real entry functions and accessors; async boundaries
 * inside each scope, since that is how the floors actually read it.
 */
import { describe, it, expect } from "vitest";
import {
  runWithProbeWrites,
  isProbeWriteContext,
  runWithDerivedSession,
  getDerivedSessionId,
} from "./request-write-context.js";

const S = "11111111-1111-4111-8111-111111111111";
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("request write context — nested entries compose", () => {
  it("derived INSIDE probe keeps both fields", async () => {
    const seen = await runWithProbeWrites(true, () =>
      runWithDerivedSession(S, async () => {
        await tick();
        return { probe: isProbeWriteContext(), derived: getDerivedSessionId() };
      })
    );
    expect(seen).toEqual({ probe: true, derived: S });
  });

  it("probe INSIDE derived keeps both fields", async () => {
    const seen = await runWithDerivedSession(S, () =>
      runWithProbeWrites(true, async () => {
        await tick();
        return { probe: isProbeWriteContext(), derived: getDerivedSessionId() };
      })
    );
    expect(seen).toEqual({ probe: true, derived: S });
  });

  it("outside any scope nothing leaks", async () => {
    await runWithDerivedSession(S, async () => tick());
    expect(getDerivedSessionId()).toBeUndefined();
    expect(isProbeWriteContext()).toBe(false);
  });
});
