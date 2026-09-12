import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — an agent key must never be minted without a linked human.
 *
 * Sibling of `capability-agent-identity.test.ts`: same threat (agent-identity
 * laundering), different door. `resolveKeyIdentity` (access/key-identity.ts)
 * derives
 *
 *     effectiveUserId = keyRecord.linkedUserId ?? keyRecord.userId
 *
 * — the data floor the key reads/writes as. This branch is NOT `podWide`, so a
 * key minted here with `linkedUserId: null` falls back to the agent's OWN
 * userId as `effectiveUserId` instead of a human's: it reads/writes as itself
 * rather than as a human's second brain, permanently, with no error and no
 * signal — and nothing repairs it if a human appears later.
 *
 * THE HOLE THIS CLOSES (found 2026-07-24): `POST /api/hub/setup/agent` resolved
 * `linkedUserId` by falling back to the oldest human on the pod, inside an
 * `if (humans[0])` with NO else. On a pod with zero humans the value stayed
 * undefined and the mint below coerced it to `null`. That state is reachable:
 * the PROVISIONING_TOKEN auth door works during pod bootstrap, which is exactly
 * when no human exists yet.
 *
 * The invariant is NOT "linkedUserId is always truthy" — the surface-key path
 * legitimately supplies its own, and callers may pass one explicitly. It is:
 * **the auto-resolve branch must fail closed rather than fall through to a null
 * mint.**
 */

const SETUP = "src/routers/hub-protocol/rest/setup.ts";

describe("tripwire: setup/agent never mints an agent key with no linked human", () => {
  const src = readFileSync(join(process.cwd(), SETUP), "utf8");

  it("fails closed when the pod has no human owner", () => {
    // The guard must exist and be a refusal, not a warning.
    expect(
      src,
      "setup/agent must REFUSE to mint when no human exists. Without this, " +
        "resolvedLinkedUserId stays undefined and the key is minted with " +
        "linkedUserId: null — the agent reads/writes as itself instead of a " +
        "human's second brain, permanently and silently."
    ).toMatch(/NO_HUMAN_OWNER/);
  });

  it("returns a 4xx on that branch rather than continuing to the mint", () => {
    const at = src.indexOf("NO_HUMAN_OWNER");
    expect(at).toBeGreaterThan(-1);
    // The refusal and its status code live together; 409 = conflicting state.
    expect(
      src.slice(at, at + 600),
      "the NO_HUMAN_OWNER branch must return a 409 — logging and falling " +
        "through would still mint the ungoverned key"
    ).toMatch(/\b409\b/);
  });

  it("still threads a resolved linkedUserId into the mint", () => {
    // Guards against a 'fix' that drops the field entirely instead of gating it.
    expect(src).toMatch(/linkedUserId:\s*resolvedLinkedUserId/);
  });

  it("fails closed on multi-human pods without explicit linkedUserId (non-surface)", () => {
    // JWT / PROVISIONING_TOKEN / setup.agent must not warn-and-continue to the
    // oldest human — that mis-attributes creator×type ownership.
    //
    // Asserts the STATUS OF THE CALL that carries the code, not "a 409 appears
    // within N chars". The old 800-char window went red the moment the 409 body
    // grew a candidate list (a correct change), and — worse — would have gone
    // GREEN on a 409 belonging to a NEIGHBOURING branch that happened to fall
    // inside the window. The call is the unit; the distance was never the point.
    expect(statusOfJsonCallCarrying(src, '"LINKED_USER_REQUIRED"')).toBe("409");
    // Must not still have the silent oldest-human attribution warn path.
    expect(src).not.toMatch(
      /attributed the agent to the oldest human \(first-owner\)/
    );
  });

  it("fails closed when a supplied email/name does not resolve to exactly one human", () => {
    // `linkedUserId` accepts an email or name. An unknown or AMBIGUOUS value
    // must refuse, never resolve to a best guess: binding to the wrong human is
    // the same mis-attribution the multi-human guard above exists to prevent.
    expect(statusOfJsonCallCarrying(src, '"LINKED_USER_UNRESOLVED"')).toBe(
      "409"
    );
  });

  it("the call scanner can see what it hunts (non-vacuity)", () => {
    // Self-check on a literal sample, including a paren INSIDE a string and a
    // `)` inside a comment — the two things that would desynchronise a naive
    // bracket counter and silently pick the wrong closing paren.
    const sample = [
      "return c.json(",
      '  { code: "SAMPLE_CODE", detail: "a (paren) in a string" },',
      "  // a ) in a comment",
      "  418",
      ");",
    ].join("\n");
    expect(statusOfJsonCallCarrying(sample, '"SAMPLE_CODE"')).toBe("418");
    expect(statusOfJsonCallCarrying(sample, '"ABSENT"')).toBeNull();
  });
});

/**
 * The HTTP status passed as the LAST argument of the `c.json(...)` call whose
 * argument list contains `literal`, or null when there is no such call.
 *
 * Finds the literal, walks back to the nearest `c.json(`, then balances parens
 * forward while skipping string literals ('…', "…", `…`) and comments — so a
 * paren inside prose cannot end the call early. Limitation, stated: it trusts
 * the NEAREST preceding `c.json(` to be the enclosing call, which holds for a
 * literal that sits inside the call's first argument (the only shape used here).
 */
function statusOfJsonCallCarrying(
  source: string,
  literal: string
): string | null {
  const at = source.indexOf(literal);
  if (at === -1) return null;
  const start = source.lastIndexOf("c.json(", at);
  if (start === -1) return null;

  // `code` is the call with COMMENTS REMOVED (strings kept verbatim). The
  // status is read from it, not from raw source: a comment between the body
  // and the status argument otherwise defeats the tail match even though the
  // paren balancing skipped it correctly. Balancing and reading must see the
  // same text, or they can disagree about where the call ends.
  let code = "";
  let depth = 0;
  let closed = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const eol = source.indexOf("\n", i);
      if (eol === -1) return null;
      i = eol - 1; // keep the newline itself on the next iteration
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      for (; j < source.length && source[j] !== ch; j++) {
        if (source[j] === "\\") j++;
      }
      code += source.slice(i, j + 1);
      i = j;
      continue;
    }
    code += ch;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        closed = true;
        break;
      }
    }
  }
  if (!closed) return null;
  if (!code.includes(literal)) return null; // nearest c.json( was not the enclosing call
  const m = code.match(/,\s*(\d{3})\s*,?\s*\)$/);
  return m ? m[1]! : null;
}
