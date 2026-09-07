import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — the project-lens derivation at the pending-proposal one door.
 *
 * Lives in `@synap/api` rather than beside the code it pins because
 * `@synap/database`'s vitest config sets a package-global `setupFiles` that
 * opens Postgres, so EVERY test in that package is unrunnable while the local
 * DB is down — a pin there would be permanently skipped, which is worse than
 * no pin at all (it looks like coverage).
 *
 * Scope, honestly: this asserts the derivation is WIRED, not that it returns
 * the right row. That is the half that breaks silently, for two reasons that
 * already produced this exact defect:
 *   - `projectId` is OPTIONAL on the input, so deleting the derivation is
 *     invisible to `tsc` — verified on the sibling field `governanceReason`,
 *     where removing its threading produced ZERO typecheck errors; and
 *   - nothing downstream reads it, so no other test goes red.
 *
 * What it protects: measured live 2026-09-01, `projectId` was set on **0 of
 * 670** pending proposals while `sessionId` was set on 361. The column, the
 * forwarding through `createPendingProposal`, and the REST field all existed —
 * only the derivation was missing, so the product's cross-cutting lens could
 * surface entities, sessions and runs but never a decision.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ CONTRACT CHANGE — 2026-09-06, DELIBERATE AND ANNOUNCED, NOT A TEST EDITED
 * TO MATCH BROKEN CODE.
 *
 * `deriveProposalProjectId` used to BE a ladder: it re-implemented explicit →
 * session → channel inline, and this file pinned those inline statements by
 * source string. That duplicate has been DELETED. It is now a thin adapter over
 * the ONE shared ladder, `resolveProjectPlacement`
 * (@synap/database/services/project-resolution-service), which runs
 * explicit → session → channel → **3.5 declared focus** → relational gravity →
 * NONE.
 *
 * So three assertions here — the session lookup, "explicit wins", and "runs on
 * the caller's executor" — were pinning an IMPLEMENTATION LOCATION, and that
 * location is precisely what the consolidation moves. They have been rewritten
 * to follow the SAME invariants ACROSS BOTH FILES, never relaxed:
 *   - the session→project lookup must still exist (now in the ladder), AND the
 *     door must still hand it the proposal's `sessionId`;
 *   - explicit must still win, and still without a DB round trip;
 *   - the lookup must still run on the CALLER'S executor, and the uuid shape
 *     guard must still exclude a malformed id BEFORE the query.
 *
 * And the pin is now STRICTLY STRONGER than what it replaced — two invariants
 * the old version could not express have been added:
 *   - rung 3.5 must actually be threaded (the gain the consolidation exists
 *     for: a `synap_set_project_focus` focus reaching a proposal raised with no
 *     session and no channel — structurally EVERY `focus_session.create`); and
 *   - the door must not grow a SECOND ladder back (no local focusSessions /
 *     channels query), which is the regression that would silently undo all of
 *     this.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DOOR = join(
  process.cwd(),
  "../database/src/utils/insert-pending-proposal.ts"
);
const LADDER = join(
  process.cwd(),
  "../database/src/services/project-resolution-service.ts"
);

describe("proposals carry the project lens", () => {
  it("can see the two files it pins", () => {
    expect(
      existsSync(DOOR),
      `${DOOR} moved — fix this path rather than deleting the pin`
    ).toBe(true);
    expect(
      existsSync(LADDER),
      `${LADDER} moved — fix this path rather than deleting the pin`
    ).toBe(true);
  });

  const src = existsSync(DOOR) ? readFileSync(DOOR, "utf8") : "";
  const ladder = existsSync(LADDER) ? readFileSync(LADDER, "utf8") : "";

  /**
   * Strip `//` and block comments. The sibling door-parity tripwire learned this
   * the hard way in both directions: a key named only in a COMMENT satisfies a
   * scan the code does not, and — the failure hit while writing this file — the
   * adapter's own JSDoc says "`proposals.thread_id` FKs `channels.id`", which
   * made the "no second ladder" check fire on PROSE describing the delegation it
   * was meant to forbid. Scan code, never comments.
   */
  const stripComments = (block: string): string =>
    block.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  /** The adapter's own body — sliced so a check cannot drift onto the INSERT. */
  const deriveBody = (() => {
    const start = src.indexOf("export async function deriveProposalProjectId");
    return start === -1
      ? ""
      : stripComments(src.slice(start, src.indexOf("\n}\n", start)));
  })();

  it("derives projectId from the proposal's session", () => {
    // The lookup itself now lives in the shared ladder (rung 2)…
    expect(
      /eq\(focusSessions\.id,\s*input\.sessionId\)/.test(ladder) &&
        /session\?\.projectId/.test(ladder),
      "the session→project lookup is gone from the shared ladder; every " +
        "producer goes back to writing project-blind proposals and the lens " +
        "returns to 0/670"
    ).toBe(true);
    // …and the proposal door must still HAND it the proposal's session, or the
    // lookup exists but is never reached from here.
    expect(
      /sessionId:\s*input\.sessionId/.test(deriveBody),
      "the proposal door stopped forwarding its sessionId to the ladder — the " +
        "rung is intact but unreachable from proposals"
    ).toBe(true);
  });

  it("an explicit projectId still wins — the derivation only fills a gap", () => {
    expect(
      /explicitProjectId:\s*input\.projectId/.test(deriveBody),
      "the door must pass its caller-supplied projectId as the ladder's rung-1 " +
        "explicit pin"
    ).toBe(true);
    // Rung 1 must still short-circuit BEFORE any await — a caller that already
    // knows its project must never be overridden by, or pay for, a lookup.
    const rung1 = ladder.indexOf("if (input.explicitProjectId) {");
    const firstAwait = ladder.indexOf("await db.query");
    expect(rung1, "rung 1 (explicit) is gone from the ladder").toBeGreaterThan(
      -1
    );
    expect(
      rung1 < firstAwait,
      "rung 1 no longer short-circuits ahead of the DB lookups"
    ).toBe(true);
  });

  it("threads rung 3.5 — a DECLARED project focus reaches a proposal with no session and no channel", () => {
    // THE GAIN. The hand-rolled duplicate this adapter replaced stopped at the
    // channel rung, so a focus set via `synap_set_project_focus` could not reach
    // ANY proposal raised outside a session or a channel — and structurally
    // EVERY `focus_session.create` proposal is raised outside one.
    expect(
      /if \(input\.focusProjectId\) \{/.test(ladder),
      "rung 3.5 is gone from the shared ladder — a declared project focus can " +
        "no longer place anything"
    ).toBe(true);
    expect(
      /focusProjectId:\s*input\.focusProjectId/.test(deriveBody),
      "the proposal door stopped forwarding the declared focus — rung 3.5 " +
        "exists but proposals can never reach it, which is the exact defect " +
        "the ladder consolidation fixed"
    ).toBe(true);
  });

  it("the derivation is a SHARED helper both proposal doors call", () => {
    // The derivation was extracted out of `insertPendingProposal` so the
    // AUTO_APPROVED receipt insert in `@synap/api` can reuse it. Two doors
    // re-implementing it is exactly how the pending door ended up with a lens
    // the receipt door did not have.
    expect(
      /export async function deriveProposalProjectId/.test(src),
      "the shared derivation is gone — the receipt door has no way to compute " +
        "the same project without re-implementing it"
    ).toBe(true);
    expect(
      /await deriveProposalProjectId\(/.test(src),
      "the pending door must consume the shared helper, not its own copy"
    ).toBe(true);
    const receipt = readFileSync(
      join(process.cwd(), "src/utils/permission-check.ts"),
      "utf8"
    );
    expect(
      /await deriveProposalProjectId\(/.test(receipt),
      "the auto-approve receipt door stopped deriving the project lens — an " +
        "auto-approved write goes back to being invisible to the project lens"
    ).toBe(true);
  });

  it("the DERIVED value is what reaches the insert", () => {
    // The bug shape this exists for: deriving correctly into a local, then
    // still spreading `input.projectId` into `.values()` — work done and
    // discarded. tsc cannot see that either.
    expect(
      /\.\.\.\(projectId \? \{ projectId \} : \{\}\)/.test(src),
      "the insert is not using the derived value"
    ).toBe(true);
  });

  it("runs the lookup on the caller's executor, so a same-transaction session is visible", () => {
    // Review finding: a try/catch here was pinned as "a lookup failure cannot
    // lose the proposal". It could not deliver that — inside a transaction a
    // failed statement aborts the tx, so the swallowed error only resurfaced
    // at the insert with a worse message. The real invariant is visibility:
    // `resolveOrCreateAgentProposalSession` can mint the session in the SAME
    // tx, and a read on a different connection would miss it and derive null.
    expect(
      /resolveProjectPlacement\(\s*executor\s*,/.test(deriveBody),
      "the ladder must run on the CALLER'S executor — passing the module-level " +
        "`db` reads a different connection and misses a session minted in the " +
        "same transaction"
    ).toBe(true);
    expect(
      /try\s*\{/.test(deriveBody),
      "a guard that cannot deliver its promise is worse than none — do not re-add it"
    ).toBe(false);
    // Review finding: without a catch, a malformed body-supplied sessionId
    // (22P02 on a healthy connection) would LOSE the proposal — inside a
    // transaction it aborts the WHOLE tx. The guard is shape-checking before
    // the query, not catching after it. It MOVED into the ladder with the
    // derivation; this asserts it arrived, and that both body-supplied rungs
    // carry it.
    expect(
      /UUID_SHAPE\.test\(input\.sessionId\)/.test(ladder),
      "a non-uuid sessionId must be excluded before the query — otherwise a " +
        "bad id costs the enclosing transaction, not just the lens"
    ).toBe(true);
    expect(
      /UUID_SHAPE\.test\(input\.channelId\)/.test(ladder),
      "the channel rung takes a body-supplied id too and needs the same guard"
    ).toBe(true);
  });

  it("the door did not grow a SECOND ladder back", () => {
    // The whole point of the consolidation: ONE ladder. A local focusSessions /
    // channels query in the proposal door means the duplicate has regrown, and
    // a regrown duplicate will again be missing rung 3.5 — silently, because
    // every other assertion in this file would still pass.
    expect(
      /focusSessions/.test(deriveBody),
      "the proposal door re-implemented the session rung locally — delegate to " +
        "`resolveProjectPlacement` instead"
    ).toBe(false);
    expect(
      /channels\./.test(deriveBody),
      "the proposal door re-implemented the channel rung locally — delegate to " +
        "`resolveProjectPlacement` instead"
    ).toBe(false);
  });

  it("the ladder still ends in NONE — no AI rung, no default", () => {
    // A SAFETY PROPERTY, not a gap. `belongs_to_project` WIDENS cross-workspace
    // access (accessScopeWhere unions project-member exposure across
    // workspaces), so an AI-guessed project must never be auto-linked. The
    // ladder abstaining is the correct terminal state.
    expect(
      /reason: "no deterministic project context"/.test(ladder),
      "the ladder's NONE terminal is gone — if something now defaults or " +
        "infers a project, it silently WIDENS access"
    ).toBe(true);
    expect(
      /return NONE;/.test(ladder),
      "the ladder must still fall through to NONE rather than inventing a project"
    ).toBe(true);
  });
});
