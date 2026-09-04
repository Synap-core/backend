/**
 * AN EXPIRED RULE MUST STOP ACTING, NOT JUST STOP TALKING.
 *
 * `expiry-enforced.tripwire.test.ts` pins the READ side: `ruleNotExpiredWhere()`
 * is ANDed into the agent-facing skill reads, so a lapsed rule stops reaching a
 * model's prompt. That is one half. The other half is the FIRING side — the
 * automation a rule compiled — and it was severed: `automation-trigger-matcher`
 * never looked at the rule at all, so an expired rule's automation kept firing
 * forever. Expiry is the product's chosen mitigation for a standing permission
 * being wrong; silencing the advice while leaving the action running is the
 * wrong half of it.
 *
 * This pins the firing side, and pins the MIRROR: the matcher lives in
 * `@synap/jobs`, which `@synap/api` depends on, so it cannot import the
 * canonical predicate without closing a dependency cycle (the same constraint
 * `focus-session-close-event-one-name.test.ts` guards for
 * `FOCUS_SESSION_CLOSED_EVENT_TYPE`). The mirror is therefore checked against
 * the SSOT here rather than trusted.
 *
 * ENFORCEMENT ≠ VISIBILITY, and the last assertion holds that line: a door may
 * SKIP an expired rule's automation, but it must never delete, archive or
 * otherwise hide it. An owner has to be able to see, renew and remove a rule
 * that lapsed.
 *
 * ── WHY THIS ENUMERATES DOORS RATHER THAN GUARDING ONE ──────────────────────
 * The first version of this file asserted only against the MATCHER, and was
 * titled as though that were the firing side entire. It was not: a rule can
 * also compile to a CRON automation (`services/rules/compile.ts` accepts
 * `triggerType: "cron"` once `triggerConfig.expression` is present), and
 * `automation-cron-scheduler.ts` fired those with no expiry check at all. The
 * test stayed green the whole time — it certified the CATEGORY ("expiry is
 * enforced") while measuring one member of it, which is the same self-
 * certifying shape `backend-rules.md` calls a durable lie.
 *
 * So the population is DERIVED, not listed: every worker in `packages/jobs`
 * that autonomously dispatches an automation must consult the predicate, and a
 * new such worker fails here until it does. `AUTONOMOUS_DISPATCH_MARKERS` is
 * how a dispatching worker is recognised; `KNOWN_NON_AUTONOMOUS` carries the
 * doors deliberately left unguarded, each with its reason, so "forgotten" and
 * "decided" can never look the same from outside.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "..");
/** `packages/api/src/__tripwires__` → `packages/` → the jobs worker. */
const MATCHER = join(
  __dirname,
  "../../../jobs/src/workers/automation-trigger-matcher.ts"
);
/** The SSOT the matcher's predicate mirrors. */
const EXPIRY_SSOT = join(API_SRC, "services/rules/expiry.ts");

function readAt(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`guarded file is missing: ${label}`);
  return readFileSync(path, "utf8");
}

/** `packages/api/src/__tripwires__` → `packages/jobs/src/workers`. */
const WORKERS_DIR = join(__dirname, "../../../jobs/src/workers");

/**
 * A worker AUTONOMOUSLY dispatches when it selects automations itself and then
 * STARTS them — as opposed to executing one automation a caller already named,
 * or merely reading the table. Both markers must be present: selecting from
 * `automations` AND opening a run row for what it selected.
 *
 * `.insert(automationRuns)` is the discriminating half, and it was chosen after
 * a looser marker (the bare identifier `automationRuns`) produced a real false
 * positive: `sync-push-supplementary.ts` SELECTS from both tables to replicate
 * them to sync peers and fires nothing at all. Reading the table is not
 * dispatching; opening a run is.
 */
const AUTONOMOUS_DISPATCH_MARKERS = [
  ".from(automations)",
  ".insert(automationRuns)",
];

/**
 * Doors that touch `automations` but are deliberately NOT expiry-guarded, with
 * the reason. An entry here is a DECISION on the record, not a silence.
 */
const KNOWN_NON_AUTONOMOUS: Record<string, string> = {
  "automation-executor.ts":
    "Executes ONE automation a door already chose. Every CHOOSING door is guarded instead: the matcher and the cron scheduler here, and the manual `automations.trigger` router for the agent-initiated case (pinned by the THIRD-DOOR test below). Re-checking in the executor would double-guard those and would also veto a HUMAN's deliberate run of their own lapsed rule, which is the owner's call to make, not the executor's.",
  "automation-run-reaper.ts":
    "Reaps stale RUN rows. It never starts a run, so there is nothing for expiry to prevent.",
};

describe("rule expiry reaches EVERY autonomous firing door", () => {
  it("every worker that dispatches automations on its own consults the predicate", () => {
    const files = readdirSync(WORKERS_DIR).filter(
      (f) => f.endsWith(".ts") && !f.includes(".test.")
    );
    // Guard the SCAN, not just the doors: an empty or tiny corpus means the
    // path moved and this test would pass by finding nothing to check.
    expect(files.length).toBeGreaterThan(3);

    const unguarded: string[] = [];
    let dispatchers = 0;
    for (const file of files) {
      const src = readFileSync(join(WORKERS_DIR, file), "utf8");
      if (!AUTONOMOUS_DISPATCH_MARKERS.every((m) => src.includes(m))) continue;
      if (KNOWN_NON_AUTONOMOUS[file]) continue;
      dispatchers += 1;
      // Must CALL it, not merely mention it. Two mutations got past weaker
      // forms of this line and both are pinned here:
      //   • a bare `includes("loadExpiredRuleIds")` accepted the renamed
      //     identifier `loadExpiredRuleIdsXX` — hence the word boundary;
      //   • requiring only the NAME was satisfied by the surviving `import`
      //     line after the entire filter body was deleted — hence the `(`.
      // `function ` is excluded so the matcher cannot satisfy this with its
      // own declaration; the sibling test below pins the matcher's call site.
      const calls = [
        ...src.matchAll(/(\w+\s+)?\bloadExpiredRuleIds\s*\(/g),
      ].some((m) => m[1] !== "function ");
      if (!calls) unguarded.push(file);
    }

    // Both firing doors known today: the event matcher and the cron scheduler.
    expect(
      dispatchers,
      "The dispatcher scan found fewer doors than exist. The markers or the " +
        "workers directory moved — fix the scan before trusting a green."
    ).toBeGreaterThanOrEqual(2);

    expect(
      unguarded,
      "These workers dispatch automations on their own initiative but never " +
        "consult `loadExpiredRuleIds`, so an expired rule's automation keeps " +
        "firing through them. Guard the door, or add it to " +
        "KNOWN_NON_AUTONOMOUS with the reason it is exempt:\n  " +
        unguarded.join("\n  ")
    ).toEqual([]);
  });

  /**
   * THE THIRD FIRING DOOR, and the one that is not a worker.
   *
   * `automations.trigger` runs an automation by id on demand, and reaches an
   * AGENT through `synap_trigger_automation` (MCP) and two Hub REST routes. The
   * derived scan above is over `packages/jobs/src/workers`, so it structurally
   * cannot see a router — naming it here is not laziness, it is the scan's
   * honest boundary, and leaving it unstated would let the derived population
   * imply a coverage it does not have.
   *
   * The agent branch must REFUSE rather than fall through to the governance
   * gate: that gate would turn the request into a proposal, and a proposal card
   * carrying no expiry signal asks a human to approve a lapsed rule's behaviour
   * without showing them the fact that matters.
   */
  it("the manual trigger door refuses an AGENT run of an expired rule", () => {
    const src = readFileSync(
      join(__dirname, "../routers/automations.ts"),
      "utf8"
    );
    const at = src.indexOf("  trigger: protectedProcedure");
    expect(
      at,
      "`automations.trigger` not found — this scan moved"
    ).toBeGreaterThan(0);
    const body = src.slice(at, at + 6000);

    // It must consult the SSOT predicate, not re-derive "expired" locally.
    expect(
      body,
      "`automations.trigger` no longer consults `isRuleExpired`, so an agent " +
        "can run the behaviour of a rule whose review date has passed."
    ).toMatch(/\bisRuleExpired\s*\(/);

    // And it must be LEXICALLY INSIDE the agent branch: guarding the human
    // path too would veto an owner running their own lapsed rule on purpose.
    //
    // ⚠️ This was first written as an index comparison,
    // `body.indexOf("if (agentUserId)") < checkAt`, and it was GREEN against a
    // mutant that moved the refusal OUT of the branch — because a COMMENT
    // fifteen lines earlier contains the words `if (agentUserId)` and matched
    // first. A scan that cannot tell code from prose is measuring prose. So:
    // find the real statement (the brace is what the comment lacks) and walk
    // its body.
    const branchOpener = "if (agentUserId) {";
    const branchAt = body.indexOf(branchOpener);
    expect(
      branchAt,
      "no `if (agentUserId) {` statement in trigger"
    ).toBeGreaterThan(-1);
    let depth = 1;
    let i = branchAt + branchOpener.length;
    while (i < body.length && depth > 0) {
      if (body[i] === "{") depth += 1;
      else if (body[i] === "}") depth -= 1;
      i += 1;
    }
    expect(
      /\bisRuleExpired\s*\(/.test(body.slice(branchAt, i)),
      "the expiry refusal must sit INSIDE the `if (agentUserId)` branch — " +
        "outside it, a human running their own lapsed rule is vetoed too"
    ).toBe(true);
  });

  it("every declared exemption names a worker that still exists", () => {
    const stale = Object.keys(KNOWN_NON_AUTONOMOUS).filter(
      (f) => !existsSync(join(WORKERS_DIR, f))
    );
    expect(
      stale,
      `These exemptions name workers that are gone — a stale exemption can ` +
        `silence a future file that reuses the name:\n  ${stale.join("\n  ")}`
    ).toEqual([]);
  });
});

describe("rule expiry reaches the automation-trigger matcher", () => {
  it("finds every file it claims to guard (never vacuously green)", () => {
    expect(() => readAt(MATCHER, "matcher")).not.toThrow();
    expect(() => readAt(EXPIRY_SSOT, "expiry SSOT")).not.toThrow();
  });

  it("the matcher CALLS the expiry filter — not merely defines it", () => {
    const src = readAt(MATCHER, "matcher");
    // Assert the CALL. A definition with no call site is precisely the shape
    // this whole tripwire family exists to catch.
    expect(src).toMatch(/await\s+loadExpiredRuleIds\s*\(/);
    // …and that its verdict is actually APPLIED to the candidate set.
    expect(src).toMatch(/expiredRuleIds\.has\(/);
  });

  it("the filter reads the AUTHORITATIVE rule row, not a stamped copy", () => {
    const src = readAt(MATCHER, "matcher");
    // A copy of `expiresAt` stamped onto the automation would go stale the
    // moment a rule is renewed or shortened — the repo's recurring
    // "marker asserting something nobody re-checked" defect.
    expect(src).toMatch(/\.from\(skills\)/);
    expect(src).toMatch(/inArray\(skills\.id,\s*ruleIds\)/);
  });

  it("the mirrored predicate matches the SSOT's canonical comparison", () => {
    const ssot = readAt(EXPIRY_SSOT, "expiry SSOT");
    const matcher = readAt(MATCHER, "matcher");
    // The SSOT compares canonical ISO strings with `<=` (absent ⇒ not expired).
    expect(ssot).toMatch(/return expiresAt <= now\.toISOString\(\)/);
    expect(matcher).toMatch(/d\.toISOString\(\) <= now\.toISOString\(\)/);
    // Both must read the SAME JSONB path.
    expect(ssot).toContain('"{rule,expiresAt}"');
    expect(matcher).toContain('"expiresAt"');
    expect(matcher).toContain('"rule"');
  });

  it("ABSENT is not EXPIRED, on both sides", () => {
    expect(readAt(EXPIRY_SSOT, "expiry SSOT")).toMatch(
      /if \(!expiresAt\) return false;/
    );
    expect(readAt(MATCHER, "matcher")).toMatch(
      /if \(typeof raw !== "string" \|\| raw\.length === 0\) return false;/
    );
  });

  it("expiry SKIPS the fire — it never deletes, archives or hides the rule", () => {
    const src = readAt(MATCHER, "matcher");
    // The matcher must not have grown a write against `skills` (or an archive
    // of the automation) on the expiry path. Enforcement is a filter, full stop.
    expect(src).not.toMatch(/\.delete\(skills\)/);
    expect(src).not.toMatch(/\.update\(skills\)/);
    expect(src).not.toMatch(/status:\s*"archived"/);
  });
});
