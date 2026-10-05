/**
 * TRIPWIRE — no MCP door approves (or reverts) a proposal.
 *
 * Approval is the human step, by design: an agent key may reject, never
 * approve. On `/mcp` an agent key's `userId` is the LINKED HUMAN and the agent
 * travels as `agentUserId`, so the tRPC review doors are only safe because
 * `computeCanReviewApproval` floors a present `actingAgentUserId`
 * (`approve-acting-agent-floor.test.ts`). This guard is the second wall: no
 * file under `routers/mcp/` may reach an approve-equivalent at all.
 *
 * The scanned set is DERIVED (every non-test `.ts` under `routers/mcp/`), so a
 * new handler file joins by existing. Comments are stripped first so prose
 * about approval never trips it.
 *
 * What it does NOT see: an approve reached INDIRECTLY through a helper that
 * lives outside `routers/mcp/` (it scans call sites in this directory only),
 * or a call built from a computed property name (`caller[verb]()`).
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MCP_DIR = __dirname;

/** Each pattern is one way of reaching an approve-equivalent. */
const FORBIDDEN: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: ".approve(", re: /\.\s*approve\s*\(/ },
  { name: ".batchApprove(", re: /\.\s*batchApprove\s*\(/ },
  { name: ".revert(", re: /\.\s*revert\s*\(/ },
  { name: "applyProposalApproval", re: /\bapplyProposalApproval\b/ },
  {
    name: '["approve"]',
    re: /\[\s*["'`](?:approve|batchApprove|revert)["'`]\s*\]/,
  },
  {
    name: "destructured approve",
    re: /\{[^{}]*\b(?:approve|batchApprove)\b[^{}]*\}\s*=/,
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "node_modules" ? [] : walk(full);
    }
    return full.endsWith(".ts") &&
      !/\.test\.ts$/.test(full) &&
      !full.includes("__tests__")
      ? [full]
      : [];
  });
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function violations(src: string): string[] {
  const code = stripComments(src);
  return FORBIDDEN.filter(({ re }) => re.test(code)).map(({ name }) => name);
}

describe("no MCP door reaches a proposal approve", () => {
  const files = walk(MCP_DIR);

  it("NON-VACUITY: the scan sees the MCP handler files", () => {
    const rel = files.map((f) => relative(MCP_DIR, f));
    expect(files.length).toBeGreaterThan(30);
    expect(rel).toContain(join("handlers", "read.ts"));
    expect(rel).toContain("adapter.ts");
    // …and reads their real content: the get_proposal door is in read.ts.
    expect(
      readFileSync(join(MCP_DIR, "handlers", "read.ts"), "utf8")
    ).toContain("synap_get_proposal");
  });

  it("SELF-CHECK: every pattern fires on a literal sample, and comments are ignored", () => {
    const samples: Record<string, string> = {
      ".approve(": "await caller.approve({ proposalId })",
      ".batchApprove(": "await caller.batchApprove({ proposalIds })",
      ".revert(": "await router.createCaller(ctx).revert({ proposalId })",
      applyProposalApproval:
        'const { applyProposalApproval } = await import("x");',
      '["approve"]': 'await caller["approve"]({ proposalId })',
      "destructured approve": "const { approve } = caller;",
    };
    for (const { name } of FORBIDDEN) {
      expect(violations(samples[name]!), name).toContain(name);
    }
    expect(violations("// caller.approve({ proposalId })")).toEqual([]);
    expect(violations("/* await caller.batchApprove() */")).toEqual([]);
  });

  it("no non-test file under routers/mcp/ reaches an approve-equivalent", () => {
    const hits = files
      .map((f) => ({
        file: relative(MCP_DIR, f),
        found: violations(readFileSync(f, "utf8")),
      }))
      .filter((r) => r.found.length > 0);
    expect(hits).toEqual([]);
  });
});
