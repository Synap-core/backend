/**
 * TRIPWIRE — every APPROVAL-CLASS capability refusal must carry an enable-link.
 *
 * Measured on the live pod (2026-09-03): 0 of 11 capability containers approved,
 * so every verb read `granted:false` / `effectiveExecMode:"propose"` and nothing
 * in the product could run. The mechanism to fix that already existed; what was
 * missing was the SIGNAL — a refusal that says "not enabled" and hands the agent
 * no way to tell the human WHAT to enable and WHERE is a dead end, and a dead end
 * is what an agent relays to the user as "the pod cannot do this".
 *
 * Derived, not hand-listed. The refusal set is discovered by parsing
 * `execute-capability.ts`'s own source for every `return` of a `kind: "deny"`
 * object, then classifying each by its REASON text. A new approval-class refusal
 * added tomorrow is therefore in scope automatically — the failure mode a
 * hand-maintained list has (and that this repo has already been bitten by: a
 * comparator reading four fields while the applier wrote ten).
 *
 * DELIBERATELY OUT OF SCOPE: a deny whose reason is not about approval/grant/
 * enablement. The run-time-connection-selector refusal ("runs as a code skill and
 * does not support run-time connection selection") is a CONFIGURATION refusal, not
 * a governance one; forcing an "Enable X" hint onto it would name the wrong fix,
 * which is exactly the approve-vs-connect collapse this work exists to prevent.
 * The class predicate — not a list of files — is what keeps that judgement
 * reviewable.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(here, "..");

const EXECUTE = join(API_SRC, "services/capabilities/execute-capability.ts");
const REGISTRY = join(API_SRC, "services/capabilities/capability-registry.ts");
const MCP_HANDLER = join(API_SRC, "routers/mcp/handlers/capability.ts");
const HUB_EXECUTE = join(
  API_SRC,
  "routers/hub-protocol/rest/capabilities-execute.ts"
);

const WHY_IT_MATTERS =
  "A capability refusal that says 'not granted / not approved' without an " +
  "enable-link is a dead end: the agent knows the cause and cannot act on it, " +
  "and the human never learns which capability to enable or where. Attach " +
  "`enable` by resolving `resolveRefusalBlock({ reason: 'enable' })` (or " +
  "`'connect'` for a dead account — they are DIFFERENT fixes and must not be " +
  "collapsed). See services/capabilities/capability-enable-link.ts.";

/** The reason texts that make a refusal approval-class. */
const APPROVAL_CLASS = /\b(approv|enabl|grant)/i;

/**
 * Is this deny in scope — i.e. could it be a "not granted / not approved"
 * refusal?
 *
 * FAIL-CLOSED on an opaque reason. The DOMINANT refusal on this door is
 * `reason: decision.reason` — the gate's own text, which lives in
 * `@synap/capability-gate` and includes "installed but not yet enabled". A
 * scanner cannot read it from here, and the first version of this tripwire
 * therefore classified it OUT of scope and stayed green while the link was
 * stripped from the single most important path (caught by the RED run, my miss).
 * So: a reason the scanner cannot PROVE is non-governance is in scope.
 *
 * Out of scope is only an explicit string/template literal with no approval,
 * grant or enablement words in it — e.g. the run-time-connection-selector
 * refusal, which is a configuration refusal and would be mislabelled by an
 * "Enable X" hint.
 */
function isRefusalInScope(literal: string): boolean {
  if (APPROVAL_CLASS.test(literal)) return true;
  const reason = /reason:\s*([\s\S]*?)(?:,\n|\n\s*\})/.exec(literal)?.[1] ?? "";
  const isLiteralText = /^\s*[`"']/.test(reason);
  return !isLiteralText;
}

/**
 * Every `return <object literal>` in `src` whose literal declares `kind: "deny"`.
 * Brace-matched from the `return {` so a nested object cannot truncate the slice.
 */
function denyReturns(src: string): string[] {
  const out: string[] = [];
  const re = /return\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const literal = src.slice(m.index, i + 1);
    if (/kind:\s*"deny"/.test(literal)) out.push(literal);
  }
  return out;
}

describe("TRIPWIRE: capability refusals carry an enable-link", () => {
  const executeSrc = readFileSync(EXECUTE, "utf-8");

  it("finds the refusal set by scanning source (extraction is not vacuous)", () => {
    const denies = denyReturns(executeSrc);
    // Floor, not an exact count: a broken brace-matcher or a renamed field must
    // fail here rather than pass a tripwire that checked nothing.
    expect(denies.length).toBeGreaterThanOrEqual(3);
    // Both classes must be non-empty, or the predicate is not actually splitting
    // anything and the next assertion is vacuous.
    expect(denies.filter(isRefusalInScope).length).toBeGreaterThanOrEqual(2);
    expect(
      denies.filter((d) => !isRefusalInScope(d)).length
    ).toBeGreaterThanOrEqual(1);
  });

  it("every approval-class deny carries `enable`", () => {
    const offenders = denyReturns(executeSrc)
      .filter(isRefusalInScope)
      .filter((d) => !/\benable\b/.test(d));
    expect(offenders, WHY_IT_MATTERS).toEqual([]);
  });

  it("the gate-deny wrapper resolves an enable-link before returning", () => {
    // The dominant refusal is not a literal reason in this file — it is the gate's
    // own `decision.decision === "deny"` (its reason lives in @synap/capability-gate,
    // which cannot import this package's deep-links). The wrapper is where the link
    // must be attached, so assert the wrapper, not just the literals.
    const wrapper = /decision\.decision === "deny"\)\s*\{([\s\S]*?)\n  \}/.exec(
      executeSrc
    );
    expect(
      wrapper,
      "gate-deny wrapper not found — did the branch move?"
    ).not.toBeNull();
    expect(wrapper![1], WHY_IT_MATTERS).toMatch(/resolveRefusalBlock/);
    expect(wrapper![1], WHY_IT_MATTERS).toMatch(/reason: "enable"/);
  });

  it("a dead CONNECTION resolves `connect`, never `enable` — the fixes differ", () => {
    const connect = /async function attachConnectBlock\(([\s\S]*?)\n\}/.exec(
      executeSrc
    );
    expect(connect, "attachConnectBlock not found").not.toBeNull();
    expect(connect![1]).toMatch(/no_connection/);
    expect(connect![1]).toMatch(/reason: "connect"/);
  });

  it("DISCOVERY: the sectioned registry attaches a block per row", () => {
    // Moment 1 — an agent must be able to surface this BEFORE trying, off the
    // `granted:false` / `connected:false` it already receives.
    const src = readFileSync(REGISTRY, "utf-8");
    expect(src, WHY_IT_MATTERS).toMatch(/resolveCapabilityBlock\(/);
    expect(src).toMatch(/row\.blocked = blocked/);
  });

  it("both agent-facing doors FORWARD the link (a dropped link is no link)", () => {
    expect(readFileSync(MCP_HANDLER, "utf-8"), WHY_IT_MATTERS).toMatch(
      /outcome\.enable \? \{ enable: outcome\.enable \}/
    );
    expect(readFileSync(HUB_EXECUTE, "utf-8"), WHY_IT_MATTERS).toMatch(
      /outcome\.enable \? \{ enable: outcome\.enable \}/
    );
  });

  it("the link's kind is served by the typed /open route (no costume links)", () => {
    // `openTypedLink` may only emit kinds `TYPED_OPEN_KINDS` actually serves.
    // apps/api/src/open-kinds.lock.test.ts locks the other half of this against
    // pod-admin; this half locks the EMITTER, which lives in this package.
    const deepLinks = readFileSync(
      join(API_SRC, "utils/deep-links.ts"),
      "utf-8"
    );
    const kinds = /TYPED_DEEP_LINK_KINDS = \[([^\]]*)\]/.exec(deepLinks);
    expect(kinds).not.toBeNull();
    expect(kinds![1]).toContain('"capability"');
  });
});

/**
 * TRIPWIRE (second half) — every refusal must also EMIT A HUMAN-FACING RECORD.
 *
 * The enable-link above is handed to the CALLING AGENT. If that agent is a cron,
 * a background flow, or simply one that gives up, the human never learns they
 * were blocked: a capped agent and a dead agent were byte-identical from the UI.
 * A refusal must therefore leave a row the runs feed can render — and the record
 * must reach a READER, which is asserted here too (an emitter with no consumer
 * is the exact shape of defect this work exists to close).
 *
 * Derived, not hand-listed: the deny set comes from the SAME source scan as the
 * enable-link half above (`denyReturns` + `isRefusalInScope`), so a refusal added
 * tomorrow is in scope automatically.
 */
const PERMISSION_CHECK = join(API_SRC, "utils/permission-check.ts");
const RUNS_READER = join(API_SRC, "services/runs/index.ts");

const WHY_EMIT_MATTERS =
  "A refusal that emits nothing is invisible: no event, no notification, no " +
  "proposal. The agent may never relay the enable-link, and the user never " +
  "learns anything was blocked. Emit via `recordRefusedCapabilityRun` " +
  "(execute-capability.ts) so the runs feed renders it as `blocked_by_policy`.";

describe("TRIPWIRE: capability refusals emit a human-facing record", () => {
  const executeSrc = readFileSync(EXECUTE, "utf-8");

  it("every in-scope deny is PAIRED with its own emit (one record per refusal)", () => {
    const denies = denyReturns(executeSrc).filter(isRefusalInScope);
    expect(denies.length).toBeGreaterThanOrEqual(2);
    const offenders: string[] = [];
    for (const literal of denies) {
      const at = executeSrc.indexOf(literal);
      const before = executeSrc.slice(0, at);
      const emitAt = before.lastIndexOf("recordRefusedCapabilityRun({");
      if (emitAt === -1) {
        offenders.push(literal);
        continue;
      }
      // The emit must be THIS refusal's, not the previous one's: no other deny
      // return may sit between the emit and this return. Stripping one emit
      // therefore fails on the deny it belonged to, never silently borrows a
      // sibling's.
      const between = executeSrc.slice(emitAt, at);
      if (/return\s*\{[^}]*kind:\s*"deny"/.test(between))
        offenders.push(literal);
    }
    expect(offenders, WHY_EMIT_MATTERS).toEqual([]);
  });

  it("the three refusal reasons stay DISTINCT (they need different fixes)", () => {
    // not_approved → enable the container. not_connected → fix the account.
    // capped → clear the review queue. Collapsing any two names the wrong fix.
    expect(executeSrc).toMatch(/"not_approved"/);
    expect(executeSrc).toMatch(/"not_connected"/);
    expect(readFileSync(PERMISSION_CHECK, "utf-8")).toMatch(
      /refusalReason: "capped"/
    );
    const emit =
      /async function recordRefusedCapabilityRun\(([\s\S]*?)\n\}\n/.exec(
        executeSrc
      );
    expect(
      emit,
      "recordRefusedCapabilityRun not found — did it move?"
    ).not.toBeNull();
    // Same event grammar as a SUCCESSFUL direct run — no new event type.
    expect(emit![1]).toMatch(/action: "capability_run"/);
    expect(emit![1]).toMatch(/kind: "capability_run"/);
    expect(emit![1]).toMatch(/outcome: "refused"/);
    expect(emit![1]).toMatch(/refusalReason/);
  });

  it("a dead CONNECTION records `not_connected`, never `not_approved`", () => {
    const connect = /async function attachConnectBlock\(([\s\S]*?)\n\}/.exec(
      executeSrc
    );
    expect(connect).not.toBeNull();
    expect(connect![1], WHY_EMIT_MATTERS).toMatch(/recordRefusedCapabilityRun/);
    expect(connect![1]).toMatch(/refusalReason: "not_connected"/);
  });

  it("the DAILY-CAP refusal emits too (a logger.warn reaches no user)", () => {
    const src = readFileSync(PERMISSION_CHECK, "utf-8");
    const cap = /if \(alreadyToday >= cap\) \{([\s\S]*?)\n    \}/.exec(src);
    expect(cap, "daily-cap branch not found — did it move?").not.toBeNull();
    expect(cap![1], WHY_EMIT_MATTERS).toMatch(/emitAiDecision\(/);
    expect(cap![1]).toMatch(/outcome: "refused"/);
    expect(cap![1]).toMatch(/denied: true/);
  });

  it("READER PARITY: the runs feed actually surfaces both refusal kinds", () => {
    // An emitter with no consumer is the defect this whole task exists to close
    // (the enable payload shipped with no reader). Assert the read layer branches
    // on the refusal marker for BOTH ledgers, and renders a governance status.
    const reader = readFileSync(RUNS_READER, "utf-8");
    expect(reader, WHY_EMIT_MATTERS).toMatch(/REFUSED_OUTCOME/);
    expect(reader).toMatch(/AGENT_WRITE_EVENT_KIND/);
    // Both mappers must map a refusal to `blocked_by_policy` — a refusal
    // rendered as `completed` is a worse lie than the silence it replaced.
    const blocked = reader.match(/"blocked_by_policy" as const/g) ?? [];
    expect(blocked.length, WHY_EMIT_MATTERS).toBeGreaterThanOrEqual(2);
  });
});
