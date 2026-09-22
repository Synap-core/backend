/**
 * A DOOR MUST NOT REPORT SUCCESS FOR WORK IT DID NOT DO.
 *
 * Found by dogfooding the deployed pod on 2026-09-22: calling
 * `synap_update_session` with `stages` returned `status: "updated"` and a moved
 * `updatedAt`, while the row's `stages` stayed `[]`. The handler forwards a
 * fixed list of fields to `updateFocusSession` and silently ignores the rest,
 * and `updateFocusSession` has no `stages` at all — `focus_sessions.stages`
 * (migration 0270) is written by the tRPC `focusSessions.update` door, which
 * builds its own `set`.
 *
 * This is the SAME defect `unsupportedUpdateFieldError` guards on the Hub REST
 * door, where `stages` is already named. That door was fixed by review; this
 * one had the identical lie and nobody had looked at it.
 *
 * ── What this test can and cannot see ──────────────────────────────────────
 * It is a SOURCE scan, because invoking the handler needs a DB, a key and a
 * scope check. It therefore pins that the refusal EXISTS and that the field is
 * NOT in the forwarded set. It cannot prove the runtime response shape — that
 * was verified by hand against the live pod and is recorded above.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(__dirname, "session.ts"), "utf8");

/** Comment-stripped, so prose explaining the rule cannot satisfy the rule. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("synap_update_session refuses what it cannot do", () => {
  it("the scan is not vacuous — this really is the session handler", () => {
    expect(CODE).toMatch(/synap_update_session:\s*async/);
    expect(CODE).toMatch(/updateFocusSession/);
  });

  it("REFUSES `stages` instead of accepting and dropping it", () => {
    expect(CODE).toMatch(/"stages" in args/);
    expect(CODE).toMatch(/stages is not supported by synap_update_session/);
  });

  it("says NOTHING WAS CHANGED, so a caller cannot read it as partial success", () => {
    // The wording is the point. "not supported" alone reads as a warning
    // beside a success; an agent retries or moves on believing the row changed.
    expect(SRC).toMatch(/NOTHING WAS CHANGED/);
  });

  it("names the door that CAN do it — a refusal without a destination is a dead end", () => {
    expect(SRC).toMatch(/focusSessions\.update/);
  });

  it("still does NOT forward `stages` — the refusal is the whole contract", () => {
    // If someone later wires `stages:` into the forwarded object, the refusal
    // above becomes unreachable and this row says so. Scoped to the forwarded
    // call, not the file, because the refusal itself mentions the word.
    const call = CODE.slice(
      CODE.indexOf("await updateFocusSession({"),
      CODE.indexOf("addAgentId:")
    );
    expect(call.length).toBeGreaterThan(100);
    expect(call).not.toMatch(/\bstages:/);
  });
});
