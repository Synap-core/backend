/**
 * SECURITY: an agent's skill DELETE must reach the gate AS AN AGENT.
 *
 * THE LIVE HOLE THIS CLOSES, found 2026-09-21. The chain was complete and
 * reachable in production:
 *
 *   DELETE /api/hub/skills/:id   (scope `hub-protocol.write` — any agent key)
 *     -> skillsRouter.delete     (input was `{ id }` ONLY — it could not
 *                                 express who was asking)
 *     -> checkPermissionOrPropose({ userId, … }) with NO agentUserId
 *     -> permission-check.ts:1599 `if (agentUserId) { …AI policy… }` is FALSE
 *        so the whole AI-policy block is SKIPPED and the human path runs
 *     -> `db.delete(skills)` — a HARD delete
 *
 * So the door called the governance gate and then deleted anyway, for every
 * agent caller. Any pod-scoped skill was reachable, including the rows backing
 * the Synap Core verbs (`entity.create`, `market.install`, …) and instruction
 * skills whose prose is injected into the user's agents' prompts.
 *
 * The lesson generalises and is why this test asserts ATTRIBUTION rather than
 * an outcome: a `checkPermissionOrPropose` call proves nothing on its own. If
 * the procedure's input cannot carry `agentUserId`, the gate is decorative for
 * every agent. "Does this door call the gate?" is the wrong question; "can
 * this door TELL the gate who is acting?" is the right one.
 *
 * WHAT THIS DOES NOT COVER, measured: it asserts the route FORWARDS the acting
 * agent into the procedure call. It does not execute the gate (no DB here), so
 * it does not prove the resulting decision is `propose` — that is the gate's
 * own contract, and rung 2.5 floors DESTRUCTIVE below any auto-approve rule.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Strip comments so prose can never satisfy a scan. */
const stripped = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("DELETE /api/hub/skills/:id carries the acting agent", () => {
  it("NON-VACUITY: the route source still calls caller.delete at all", () => {
    // If the call site is renamed or removed, the assertions below stop
    // meaning anything — so check the landmark exists first.
    expect(read("./skills-crud.ts")).toContain("caller.delete({");
  });

  it("the delete call site forwards agentUserId, not just the id", () => {
    // Comments stripped so the prose ABOVE the fix cannot satisfy this scan —
    // a guard passing on its own docblock has happened in this repo before.
    const code = stripped(read("./skills-crud.ts"));
    const call = code.slice(
      code.indexOf("caller.delete({"),
      code.indexOf("caller.delete({") + 240
    );
    expect(
      call,
      "the hub delete route does not forward the acting agent — the gate will " +
        "take the HUMAN path and hard-delete"
    ).toContain("agentUserId");
  });

  it("skills.delete's INPUT can express the acting agent", () => {
    // The root cause was the input schema, not the call site: a route cannot
    // forward a field the procedure refuses to accept.
    const code = stripped(read("../../skills.ts"));
    const at = code.indexOf("  delete: protectedProcedure");
    expect(at, "skills.delete not found — this scan is broken").toBeGreaterThan(
      -1
    );
    const proc = code.slice(at, at + 1400);
    expect(
      proc,
      "skills.delete cannot accept agentUserId, so the gate is decorative " +
        "for every agent caller"
    ).toContain("agentUserId");
    // And it must actually reach the gate call, not merely sit in the schema.
    const gateAt = proc.indexOf("checkPermissionOrPropose({");
    expect(gateAt).toBeGreaterThan(-1);
    expect(
      proc.slice(gateAt, gateAt + 320),
      "agentUserId is accepted but never handed to the gate — declared, not wired"
    ).toContain("agentUserId");
  });
});
