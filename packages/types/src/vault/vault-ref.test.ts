/**
 * The vault-ref door — and the DELIBERATE split between its two questions.
 *
 * Until now the pod held two parsers with different rules: this leaf's
 * `parseVaultReference` (string-only, no trim, `""` for a bare scheme) and
 * `services/proposals/setup-required-error.ts`'s `parseVaultRef` (unknown-safe,
 * trimmed, `null` for a bare scheme). The second one is deleted; these rows pin
 * the surviving rule, INCLUDING the rows where the two disagreed, so the merge
 * is a decision rather than a coincidence.
 *
 * The decision: "is this a POINTER?" (`parseVaultReference`) is LENIENT, and
 * "is this RESOLVABLE?" (`isVaultReference`) is UUID-STRICT. They are different
 * questions and collapsing them would be a leak — see the note on the
 * `vault://not-a-uuid` row below.
 */

import { describe, expect, it } from "vitest";
import {
  VAULT_REF_PREFIX,
  isVaultReference,
  makeVaultReference,
  parseVaultReference,
  vaultSecretIdOf,
} from "./index.js";

const UUID = "11111111-2222-3333-4444-555555555555";

describe("parseVaultReference — the POINTER question", () => {
  it("returns the id of a well-formed ref", () => {
    expect(parseVaultReference(`vault://${UUID}`)).toBe(UUID);
  });

  // ── The rows where the two old parsers DISAGREED ──────────────────────────
  it("a NON-STRING is not a ref (the old leaf parser threw on `.startsWith`)", () => {
    expect(parseVaultReference(undefined)).toBeNull();
    expect(parseVaultReference(null)).toBeNull();
    expect(parseVaultReference(42)).toBeNull();
    expect(parseVaultReference({ ref: `vault://${UUID}` })).toBeNull();
  });

  it("a BARE scheme is not a ref (the old leaf parser returned an empty string)", () => {
    expect(parseVaultReference("vault://")).toBeNull();
    expect(parseVaultReference("vault://   ")).toBeNull();
  });

  it("trims surrounding whitespace inside the ref", () => {
    expect(parseVaultReference(`vault://  ${UUID}  `)).toBe(UUID);
  });

  it("a pointer padded on the OUTSIDE is still a pointer — the writer and the reader must agree", () => {
    // `vaultSecretIdOf` trims the whole value; a parser that did not would call
    // this a literal, and the installer would encrypt it AS the credential.
    expect(parseVaultReference(`  vault://${UUID}  `)).toBe(UUID);
    expect(parseVaultReference("  vault://not-a-uuid  ")).toBe("not-a-uuid");
    expect(parseVaultReference("  vault://   ")).toBeNull();
  });

  /**
   * THE load-bearing row. A malformed id still parses as a POINTER.
   *
   * If this returned `null`, `vault://not-a-uuid` would be read as a plain
   * VALUE — and a plain value is encrypted and stored AS the credential
   * (`create-from-definition`), so a capability would authenticate with the
   * literal text of a broken pointer, and `proposal-setup` would report the
   * param as satisfied. A broken pointer must fail to RESOLVE, never quietly
   * become a secret.
   */
  it("a malformed id is still a POINTER, never a value", () => {
    expect(parseVaultReference("vault://not-a-uuid")).toBe("not-a-uuid");
    expect(isVaultReference("vault://not-a-uuid")).toBe(false);
  });

  it("anything without the scheme is not a ref", () => {
    expect(parseVaultReference("sk-live-1234")).toBeNull();
    // A scheme that only appears mid-string is a literal, not a pointer.
    expect(parseVaultReference(`key ${`vault://${UUID}`}`)).toBeNull();
    // NOTE: padding on the outside is NOT "without the scheme" — see the row
    // below. This assertion used to pin `"  vault://<uuid>"` as null, which
    // froze the old leaf parser's missing trim as if it were a decision: the
    // installer would then encrypt a padded pointer AS the credential while the
    // reader (`vaultSecretIdOf`, which trims) treated it as a pointer.
  });
});

describe("isVaultReference — the RESOLVABLE question, UUID-strict", () => {
  it.each([
    [`vault://${UUID}`, true],
    ["vault://not-a-uuid", false],
    ["vault://", false],
    [`vault://${UUID}/field`, false],
    [UUID, false],
    [undefined, false],
  ])("%s → %s", (value, expected) => {
    expect(isVaultReference(value)).toBe(expected);
  });
});

describe("makeVaultReference — the only speller of the scheme", () => {
  it("round-trips through the parser", () => {
    expect(parseVaultReference(makeVaultReference(UUID))).toBe(UUID);
  });

  it("uses the exported prefix, so no call site needs the literal", () => {
    expect(VAULT_REF_PREFIX).toBe("vault://");
    expect(makeVaultReference(UUID).startsWith(VAULT_REF_PREFIX)).toBe(true);
  });
});

describe("vaultSecretIdOf — the id may go to a uuid column", () => {
  // Rows where the three questions DISAGREE. A malformed pointer is a pointer
  // (parseVaultReference) that is not resolvable (isVaultReference) and must
  // not reach the database (vaultSecretIdOf): `inArray(uuidColumn, ["x"])`
  // throws a cast error that a batch caller swallows, degrading EVERY ref on
  // the page to "missing".
  it("returns the id for a well-formed ref, trimmed", () => {
    expect(vaultSecretIdOf(makeVaultReference(UUID))).toBe(UUID);
    expect(vaultSecretIdOf(`  ${makeVaultReference(UUID)}  `)).toBe(UUID);
  });

  it.each([
    "vault://not-a-uuid",
    "vault://12345",
    "vault://a/b/c",
    "vault://",
    `${makeVaultReference(UUID)}/field`,
  ])(
    "is null for the malformed pointer %j — even though it IS a pointer",
    (v) => {
      expect(vaultSecretIdOf(v)).toBeNull();
    }
  );

  it("is null for anything that is not a string", () => {
    for (const v of [undefined, null, 5, {}, ["vault://x"]]) {
      expect(vaultSecretIdOf(v)).toBeNull();
    }
  });

  it("agrees with isVaultReference on every row (one strictness, two shapes)", () => {
    for (const v of [
      makeVaultReference(UUID),
      "vault://not-a-uuid",
      "vault://",
      "plain",
      "",
    ]) {
      expect(vaultSecretIdOf(v) !== null).toBe(isVaultReference(v));
    }
  });

  it("non-vacuity: the malformed rows really are pointers (that is the whole hazard)", () => {
    expect(parseVaultReference("vault://not-a-uuid")).not.toBeNull();
  });
});
