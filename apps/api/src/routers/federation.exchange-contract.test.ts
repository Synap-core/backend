import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CONTRACT LOCK — the federation router's emitted error codes.
 *
 * The client (`@synap-core/auth` HANDSHAKE_CODE_ALIASES) maps these codes to
 * specific recovery screens. Drift here silently degrades a real screen into a
 * generic fallback, so this test freezes the emitted set. If it fails: the
 * router's error codes changed — update EXPECTED here AND mirror the change in
 * the client's alias table + its coverage test
 * (synap-app/packages/core/auth/src/clients/federation-contract.test.ts).
 *
 * Behind fix 5ae8e261: the issuer-trust gates emit ISSUER_APPROVAL_REQUIRED —
 * NOT APPLICATION_CONNECTION_APPROVAL_REQUIRED, which belongs only to the
 * origin/app-connection path (surfaced as BROWSER_ORIGIN_NOT_APPROVED).
 */

const SRC = readFileSync(
  fileURLToPath(new URL("./federation.ts", import.meta.url)),
  "utf8"
);

const EXPECTED = [
  "APPLICATION_IDENTIFIER_REQUIRED",
  "BROWSER_ORIGIN_NOT_APPROVED",
  "FEDERATED_IDENTITY_NOT_LINKED",
  "ISSUER_APPROVAL_REQUIRED",
  "POD_ADMIN_URL_REQUIRED",
  // Previously codeless failures. Without a code the client can only render
  // "the exact reason wasn't reported" — blind for the signer AND the owner.
  "ASSERTION_MALFORMED",
  "ASSERTION_SIGNATURE_INVALID",
  "ASSERTION_CLAIMS_INVALID",
  "ASSERTION_ISSUER_MISMATCH",
  "POD_IDENTITY_UNAVAILABLE",
  "POD_SCOPE_ACCESS_DENIED",
  "POD_SESSION_MINT_FAILED",
  // Replay guard — REPLAY_PROTECTION_UNAVAILABLE is the one that fires on a
  // schema fault (e.g. missing replay_context) and looked like a generic
  // "exchange failed" on every sign-in.
  "ASSERTION_EXPIRED",
  "ASSERTION_REPLAYED",
  "REPLAY_PROTECTION_UNAVAILABLE",
].sort();

function emittedCodes(src: string): string[] {
  const set = new Set<string>();
  const re = /code:\s*"([A-Z_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) set.add(m[1]);
  return [...set].sort();
}

describe("federation emitted-code contract", () => {
  it("emits exactly the frozen set (drift → also update the client alias table)", () => {
    expect(emittedCodes(SRC)).toEqual(EXPECTED);
  });

  it("issuer gates never emit the app-connection code (5ae8e261 regression lock)", () => {
    expect(emittedCodes(SRC)).not.toContain(
      "APPLICATION_CONNECTION_APPROVAL_REQUIRED"
    );
  });
});
