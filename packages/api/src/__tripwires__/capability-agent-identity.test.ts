import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — capability writes must NOT launder agent identity.
 *
 * `executeCapability` gates every capability run. If it passes a hardcoded
 * `agentUserId: null` to the gate, an agent-invoked WRITE verb (feed.post,
 * output.generate, ai.triage, …) runs as the OPERATOR — auto-applied, no
 * per-agent grant/proposal. That is the V0 BYOA "agent-identity laundering"
 * threat, and it's inconsistent with every other write proc in the MCP adapter
 * (which threads agentUserId so agent writes propose).
 *
 * The fix threads the caller's `input.agentUserId` into the gate. This test
 * keeps it that way: the gate call must forward `input.agentUserId`, never a
 * bare hardcoded `agentUserId: null`.
 */

const FILE = "src/services/capabilities/execute-capability.ts";

describe("tripwire: capability execution threads agent identity to the gate", () => {
  const src = readFileSync(join(process.cwd(), FILE), "utf8");

  it("forwards input.agentUserId to the capability gate", () => {
    expect(src).toMatch(/agentUserId:\s*input\.agentUserId/);
  });

  it("never hardcodes agentUserId: null into the gate", () => {
    // `input.agentUserId ?? null` is fine (contains no `agentUserId: null`);
    // a bare `agentUserId: null,` is the laundering regression.
    expect(src).not.toMatch(/agentUserId:\s*null\b/);
  });
});
