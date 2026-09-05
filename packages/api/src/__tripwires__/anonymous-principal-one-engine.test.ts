import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

/**
 * TRIPWIRE — the ANONYMOUS PRINCIPAL and the AGENT PRINCIPAL consult ONE engine.
 *
 * `checkPermissionOrPropose` has two AI branches. The agent branch
 * (`if (agentUserId)`) runs the full ladder via `resolveAgentGovernanceDecision`
 * → `decideAgentPolicy`. The LEGACY AI-source branch (`source === "ai" ||
 * source === "intelligence"`, reached when no agent user row resolved — an
 * unattributed `service` / `user_pat` / `hub_inbound` key) used to hand-mirror
 * PART of that ladder inline: it re-declared the destructive floor, the human
 * gate list, the arbitrary-execution list and the DEFAULT_AUTO_APPROVE whitelist
 * lookup, and consulted `decideAgentPolicy` not at all. A second, partial,
 * hand-maintained copy of a decision ladder is a fork the moment it exists —
 * seven rungs were already missing from it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PROVES — and, precisely, WHAT IT DOES NOT.
 *
 * PROVES (structural, from the source text):
 *   • the legacy branch CALLS `decideAgentPolicy`, so its verdict comes from the
 *     shared engine rather than a local conditional;
 *   • the branch re-declares NONE of the policy CONSTANT LISTS, so those lists
 *     cannot drift between the two principals — there is only one copy left;
 *   • the input is built by the ONE named constructor `anonymousPolicyInput`,
 *     never inlined at the call site (the named failure mode: a future
 *     agent-only rung input given a plausible default, silently handing an
 *     unattributed third-party key an agent semantic).
 *
 * DOES NOT PROVE (and no list-parity test could):
 *   • that any particular RUNG fires or no-ops. Rungs 2.55 (untrusted origin),
 *     2.56 (daily ceiling — deliberately deferred for this principal), 5
 *     (writesRequireProposal — no reachable source without an agent row) and 7
 *     (per-channel grant) are LOGIC over resolved inputs, not constant lists.
 *     A source scan is blind to all four. They are covered — or, for 2.56,
 *     deliberately pinned as NOT firing — by the door-level tests in
 *     `utils/permission-check.test.ts`
 *     ("anonymous principal routed through decideAgentPolicy").
 *   • that the RECEIPT is minted. Also a door test.
 *
 * The test names below say only what they check, on purpose: a tripwire whose
 * name implies coverage it does not have is the durable-lie shape this repo has
 * been bitten by before.
 * ══════════════════════════════════════════════════════════════════════════
 */

// Anchored on this file's own location, NOT `process.cwd()`: the tripwires in
// this directory are run with cwd = `packages/api`, but a `vitest run` issued
// from the repo root has a different cwd and would silently ENOENT.
const GATE_PATH = fileURLToPath(
  new URL("../utils/permission-check.ts", import.meta.url)
);
const SOURCE = readFileSync(GATE_PATH, "utf8");

/**
 * The legacy AI-source branch, sliced out of the source text: from its `if`
 * header to the `} catch (error) {` that closes `evaluatePermission`'s try.
 */
function legacyAiSourceBranch(): string {
  const start = SOURCE.indexOf(
    'if (source === "ai" || source === "intelligence") {'
  );
  expect(
    start,
    "legacy AI-source branch not found — did it move?"
  ).toBeGreaterThan(-1);
  const end = SOURCE.indexOf("} catch (error) {", start);
  expect(end, "end of the branch not found").toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("TRIPWIRE — anonymous principal routes through the shared policy engine", () => {
  it("the legacy AI-source branch calls decideAgentPolicy", () => {
    expect(legacyAiSourceBranch()).toContain("decideAgentPolicy(");
  });

  it("it builds that call's input ONLY through anonymousPolicyInput", () => {
    const branch = legacyAiSourceBranch();
    expect(branch).toContain("anonymousPolicyInput({");
    // Exactly one engine call, and it is the helper's own return value.
    const calls = branch.match(/decideAgentPolicy\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(branch).toMatch(/decideAgentPolicy\(\s*anonymousPolicyInput\(\{/);
  });

  it("it re-declares NONE of the policy constant lists (no second copy to drift)", () => {
    const branch = legacyAiSourceBranch();
    // Each of these was hand-mirrored inside this branch before the change.
    // Their ONLY home is now @synap/governance-policy, consulted by the engine.
    for (const forbidden of [
      "HUMAN_GATE_EVENT_KEYS",
      "ARBITRARY_EXECUTION_EVENT_KEYS",
      "DESTRUCTIVE_ACTIONS",
      "isAutoApproved(",
      "ADMIN_ACTIONS",
    ]) {
      expect(
        branch.includes(forbidden),
        `"${forbidden}" is back inside the legacy AI-source branch — that is a second copy of a policy list. Pass the fact into anonymousPolicyInput() and let decideAgentPolicy decide.`
      ).toBe(false);
    }
  });

  it("anonymousPolicyInput pins rung 2.56 (daily write ceiling) to undefined — the deferral is deliberate", () => {
    // Not a claim that the rung is right to be off: a claim that turning it ON
    // must be a deliberate edit here, not a drive-by. `DEFAULT_DAILY_WRITE_
    // CEILING` is 500 and one bulk capture auto-approves ~1,600 rows, so a
    // silent adoption would start queueing proposals mid-capture.
    const helper = SOURCE.slice(
      SOURCE.indexOf("function anonymousPolicyInput("),
      SOURCE.indexOf("async function evaluatePermission(")
    );
    expect(helper).toMatch(/ceilingVerdict:\s*undefined/);
  });
});
