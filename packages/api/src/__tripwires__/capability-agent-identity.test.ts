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

/**
 * Strip comments before pattern-matching.
 *
 * This guard reads SOURCE TEXT, so it cannot tell code from prose. It fired for
 * real on the line that DOCUMENTS the fix — `// Without this the row stored
 * agentUserId:null and only admins could review.` — i.e. the note explaining the
 * regression tripped the guard against the regression. A tripwire that goes red
 * on its own changelog is worse than no tripwire: a permanently-red guard trains
 * everyone to ignore it, and then it cannot report the real thing.
 *
 * Deliberately simple (no full tokenizer): the patterns below are object-literal
 * shapes that never legitimately appear inside a string.
 *
 * ⚠️ Only WHOLE-LINE line-comments are stripped, never a trailing one. An
 * UNANCHORED line-comment pattern truncates a line at its first slash-slash —
 * including one inside a string literal — so a line like
 * `const doc = "see https:` + slash-slash + `x"; gate({ agentUserId: null });`
 * would lose everything from that point on, and the negative assertion below
 * would stay GREEN over the real regression. A guard defeated by a URL on the
 * wrong line is the same "gate that lies" failure this function was written to
 * fix, so the line-comment pattern stays anchored with `^\s*`.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
}

describe("tripwire: capability execution threads agent identity to the gate", () => {
  const code = stripComments(readFileSync(join(process.cwd(), FILE), "utf8"));

  it("forwards input.agentUserId to the capability gate", () => {
    expect(code).toMatch(/agentUserId:\s*input\.agentUserId/);
  });

  it("never hardcodes agentUserId: null into the gate", () => {
    // `input.agentUserId ?? null` is fine (contains no `agentUserId: null`);
    // a bare `agentUserId: null,` is the laundering regression.
    expect(code).not.toMatch(/agentUserId:\s*null\b/);
  });
});
