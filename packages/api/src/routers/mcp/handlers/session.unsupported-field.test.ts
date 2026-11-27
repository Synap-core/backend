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
 * The refusal is configuration on the tool's definition (`refusedArgs`), run
 * by the one input check (`parseToolArgs`, no DB needed); the forwarded set is
 * still a SOURCE scan, because invoking the handler needs a DB and a key.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripComments } from "../../../../../../scripts/strip-comments.mjs";
import { parseToolArgs } from "../define-tool.js";

const SRC = readFileSync(resolve(__dirname, "session.ts"), "utf8");

/** Comment-stripped, so prose explaining the rule cannot satisfy the rule. */
const CODE = stripComments(SRC, "ts");

describe("synap_update_session refuses what it cannot do", () => {
  it("the scan is not vacuous — this really is the session handler", () => {
    expect(CODE).toMatch(/synap_update_session:\s*async/);
    expect(CODE).toMatch(/updateFocusSession/);
  });

  it("REFUSES `stages` instead of accepting and dropping it, NOTHING WAS CHANGED, naming the door that can", async () => {
    const out = await parseToolArgs("synap_update_session", {
      sessionId: "s1",
      stages: [],
    });
    expect(out.ok).toBe(false);
    const text = !out.ok
      ? (out.result.content[0] as { text: string }).text
      : "";
    // "not supported" alone reads as a warning beside a success.
    expect(text).toMatch(/stages is not supported by synap_update_session/);
    expect(text).toMatch(/NOTHING WAS CHANGED/);
    // A refusal without a destination is a dead end.
    expect(text).toMatch(/focusSessions\.update/);
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
