import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — an agent key must never be minted without a linked human.
 *
 * Sibling of `capability-agent-identity.test.ts`: same threat (agent-identity
 * laundering), different door. The pod derives
 *
 *     agentUserId = keyRecord.linkedUserId ? keyRecord.userId : undefined
 *
 * and a DEFINED `agentUserId` is the only thing routing an agent write through
 * `checkPermissionOrPropose()` into a reviewable PROPOSAL. A key minted with
 * `linkedUserId: null` therefore writes DIRECTLY as the operator — permanently,
 * with no error, no proposal and no signal — and nothing repairs it if a human
 * appears later.
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
        "linkedUserId: null — a permanent, silent governance bypass."
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
    expect(src).toMatch(/LINKED_USER_REQUIRED/);
    const at = src.indexOf("LINKED_USER_REQUIRED");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 800)).toMatch(/\b409\b/);
    // Must not still have the silent oldest-human attribution warn path.
    expect(src).not.toMatch(
      /attributed the agent to the oldest human \(first-owner\)/
    );
  });
});
