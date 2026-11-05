/**
 * The dead-credential rule (`nango-dead-credential.ts`) on Nango 0.70.9's real
 * answers, and the pin that keeps the control plane's copy in step.
 *
 * THE PIN. The control plane keeps a byte-identical copy at
 * `synap-control-plane-api/src/lib/nango-dead-credential.ts`. Its sibling
 * check (`nango-dead-credential.tripwire.test.ts` there) only runs where both
 * repos are checked out side by side, never in either CI. So each repo pins
 * the file's sha256 in a test its OWN CI runs: an edit to this file goes red
 * here until the pin is updated, and the message says what else to update.
 * What the pin does NOT see: the CP copy itself (this repo cannot read it in
 * CI). It turns "edited one side" into a red test that names the other side;
 * the CP's own pin does the same on its side.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { credentialCause, deadCredential } from "./nango-dead-credential.js";

/** sha256 of `nango-dead-credential.ts`; the CP's tripwire pins the same. */
const NANGO_DEAD_CREDENTIAL_SHA256 =
  "d8ee0b38a716f12ae0e3648ea7e23461d0a4e1581c9d1a0aa30a9be15837db90";

const body = (code: string, message: string) => ({
  error: { code, message, payload: {} },
});

const EXHAUSTED = "The refresh limit has been reached for this connection.";
const BACKOFF = "A recent refresh attempt failed. Backing off before retrying.";
const EXTERNAL =
  "The external API returned an error when trying to refresh the access token. Please try again later.";

describe("nango-dead-credential pin", () => {
  it("the file is the one the control plane's copy is pinned to", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./nango-dead-credential.ts", import.meta.url))
    );
    expect(
      createHash("sha256").update(source).digest("hex"),
      "nango-dead-credential.ts changed: copy it byte for byte to synap-control-plane-api/src/lib/nango-dead-credential.ts, then set the new sha256 in this test AND in that repo's nango-dead-credential.tripwire.test.ts"
    ).toBe(NANGO_DEAD_CREDENTIAL_SHA256);
  });
});

describe("credentialCause on Nango 0.70.9's answers", () => {
  it.each([
    // Nango's own verdict after refreshes failed on 4 distinct days.
    [424, body("invalid_credentials", EXHAUSTED), "dead"],
    // A refresh failed < 30s ago: the next read retries.
    [424, body("invalid_credentials", BACKOFF), "retry"],
    // Built for ANY refresh failure (provider refusal, 5xx, 429, network):
    // a retry until Nango escalates it to the 424 above.
    [400, body("invalid_credentials", EXTERNAL), "retry"],
    // Right message, wrong status for its cause: not a cause the rule knows.
    [400, body("invalid_credentials", EXHAUSTED), "unknown"],
    [503, body("invalid_credentials", EXTERNAL), "unknown"],
    // A reworded or new cause: unknown, so the caller logs it.
    [424, body("invalid_credentials", "Token revoked by the user."), "unknown"],
  ])("status %s, %j → %s", (status, answer, verdict) => {
    expect(credentialCause(status, answer)?.verdict).toBe(verdict);
  });

  it.each([
    [424, body("unknown_provider_config", EXHAUSTED)],
    [424, { error: "invalid_credentials" }],
    [424, null],
  ])("status %s, %j → not about the credential (null)", (status, answer) => {
    expect(credentialCause(status, answer)).toBeNull();
  });

  it("deadCredential returns Nango's message for the dead cause only", () => {
    expect(deadCredential(424, body("invalid_credentials", EXHAUSTED))).toBe(
      EXHAUSTED
    );
    expect(deadCredential(400, body("invalid_credentials", EXTERNAL))).toBe(
      null
    );
    expect(deadCredential(424, body("invalid_credentials", "new"))).toBe(null);
  });
});
