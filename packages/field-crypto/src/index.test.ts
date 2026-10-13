import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import {
  createKeyring,
  decryptField,
  encryptField,
  envelopeKid,
  fieldAad,
  FieldCryptoError,
  generateFieldKey,
  isEnvelope,
  needsReencrypt,
} from "./index.js";

interface Vectors {
  keyring: string;
  vectors: Array<{
    kid: string;
    aad: string;
    plaintext: string;
    envelope: string;
  }>;
  mustFail: Array<{ reason: string; envelope: string; aad: string }>;
}

const VECTORS = JSON.parse(
  readFileSync(new URL("../test-vectors.json", import.meta.url), "utf8"),
) as Vectors;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof FieldCryptoError ? err.code : "NOT_A_FIELD_ERROR";
  }
  return undefined;
}

const AAD = fieldAad({
  service: "test",
  table: "things",
  column: "secret",
  rowId: "row-1",
});

describe("test vectors (shipped in the package, independent oracle)", () => {
  const ring = createKeyring(VECTORS.keyring);

  it("is not vacuous", () => {
    expect(VECTORS.vectors.length).toBeGreaterThanOrEqual(4);
    expect(VECTORS.mustFail.length).toBeGreaterThanOrEqual(5);
  });

  it.each(VECTORS.vectors.map((v) => [v.aad, v] as const))(
    "decrypts %s",
    (_aad, v) => {
      expect(decryptField(ring, v.envelope, v.aad)).toBe(v.plaintext);
      expect(envelopeKid(v.envelope)).toBe(v.kid);
    },
  );

  it.each(VECTORS.mustFail.map((f) => [f.reason, f] as const))(
    "refuses: %s",
    (_reason, f) => {
      expect(codeOf(() => decryptField(ring, f.envelope, f.aad))).toMatch(
        /^(DECRYPT_FAILED|UNKNOWN_KID|UNSUPPORTED_VERSION|MALFORMED_ENVELOPE)$/,
      );
    },
  );
});

describe("keyring", () => {
  const a = generateFieldKey();
  const b = generateFieldKey();

  it("first key encrypts, every key decrypts", () => {
    const old = createKeyring(`k1:${a}`);
    const rotated = createKeyring(`k2:${b}, k1:${a}`);
    const v1 = encryptField(old, "hello", AAD);
    expect(envelopeKid(v1)).toBe("k1");
    expect(decryptField(rotated, v1, AAD)).toBe("hello");
    const v2 = encryptField(rotated, "hello", AAD);
    expect(envelopeKid(v2)).toBe("k2");
    expect(codeOf(() => decryptField(old, v2, AAD))).toBe("UNKNOWN_KID");
    expect(rotated.current).toBe("k2");
    expect(rotated.kids).toEqual(["k2", "k1"]);
  });

  it("accepts the array form", () => {
    const ring = createKeyring([{ kid: "k1", key: Buffer.from(a, "base64") }]);
    expect(decryptField(ring, encryptField(ring, "x", AAD), AAD)).toBe("x");
  });

  it.each([
    ["empty", ""],
    ["no kid", `:${a}`],
    ["no colon", a],
    ["bad kid", `bad kid:${a}`],
    ["duplicate kid", `k1:${a},k1:${b}`],
    ["short key", `k1:${Buffer.alloc(16).toString("base64")}`],
    ["long key", `k1:${Buffer.alloc(64).toString("base64")}`],
    ["not base64", "k1:!!!!"],
  ])("refuses %s", (_name, spec) => {
    expect(codeOf(() => createKeyring(spec))).toBe("INVALID_KEYRING");
  });

  it("never exposes key bytes when logged or serialised, nor in errors", () => {
    const ring = createKeyring(`k1:${a}`);
    expect(JSON.stringify(ring)).not.toContain(a);
    expect(inspect(ring, { depth: 5, showHidden: true })).not.toContain(a);
    try {
      createKeyring(`k1:${a},k2:${a.slice(0, 20)}`);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(a.slice(0, 20));
    }
  });
});

describe("envelope", () => {
  const ring = createKeyring(`k1:${generateFieldKey()}`);

  it("round-trips and has the documented shape", () => {
    const v = encryptField(ring, "s3cret", AAD);
    expect(v).toMatch(
      /^senc:1:k1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]{22}$/,
    );
    expect(isEnvelope(v)).toBe(true);
    expect(decryptField(ring, v, AAD)).toBe("s3cret");
  });

  it("uses a fresh IV per encryption", () => {
    expect(encryptField(ring, "same", AAD)).not.toBe(
      encryptField(ring, "same", AAD),
    );
  });

  it("binds the AAD: another row or column does not decrypt", () => {
    const v = encryptField(ring, "s3cret", AAD);
    const otherRow = fieldAad({
      service: "test",
      table: "things",
      column: "secret",
      rowId: "row-2",
    });
    const otherColumn = fieldAad({
      service: "test",
      table: "things",
      column: "other",
      rowId: "row-1",
    });
    expect(codeOf(() => decryptField(ring, v, otherRow))).toBe(
      "DECRYPT_FAILED",
    );
    expect(codeOf(() => decryptField(ring, v, otherColumn))).toBe(
      "DECRYPT_FAILED",
    );
  });

  it("refuses a non-envelope unless allowLegacy returns a value", () => {
    expect(codeOf(() => decryptField(ring, "plain", AAD))).toBe(
      "NOT_AN_ENVELOPE",
    );
    expect(
      codeOf(() =>
        decryptField(ring, "plain", AAD, { allowLegacy: () => null }),
      ),
    ).toBe("NOT_AN_ENVELOPE");
    expect(
      decryptField(ring, "plain", AAD, { allowLegacy: (v) => `legacy:${v}` }),
    ).toBe("legacy:plain");
  });

  it("never hands an envelope to allowLegacy (an unknown version is refused)", () => {
    const v = encryptField(ring, "x", AAD).replace("senc:1:", "senc:9:");
    expect(
      codeOf(() => decryptField(ring, v, AAD, { allowLegacy: (s) => s })),
    ).toBe("UNSUPPORTED_VERSION");
  });

  it("refuses malformed envelopes", () => {
    expect(codeOf(() => decryptField(ring, "senc:1:k1:abc", AAD))).toBe(
      "MALFORMED_ENVELOPE",
    );
    const v = encryptField(ring, "x", AAD);
    const parts = v.split(":");
    parts[3] = "AAAA";
    expect(codeOf(() => decryptField(ring, parts.join(":"), AAD))).toBe(
      "MALFORMED_ENVELOPE",
    );
  });

  it("refuses an empty AAD", () => {
    expect(codeOf(() => encryptField(ring, "x", ""))).toBe("INVALID_AAD");
  });
});

describe("needsReencrypt", () => {
  const a = generateFieldKey();
  const old = createKeyring(`k1:${a}`);
  const rotated = createKeyring(`k2:${generateFieldKey()},k1:${a}`);

  it("is true for non-envelopes and older kids, false for the current kid", () => {
    expect(needsReencrypt(rotated, "plain")).toBe(true);
    expect(needsReencrypt(rotated, '{"e":"x","i":"y","t":"z"}')).toBe(true);
    expect(needsReencrypt(rotated, encryptField(old, "x", AAD))).toBe(true);
    expect(needsReencrypt(rotated, encryptField(rotated, "x", AAD))).toBe(
      false,
    );
  });
});

describe("fieldAad", () => {
  it("builds the documented string", () => {
    expect(
      fieldAad({ service: "cp", table: "data_pods", column: "k", rowId: "u1" }),
    ).toBe("synap/cp/data_pods.k/u1");
    expect(
      fieldAad({ service: "cp", table: "data_pods", column: "k", rowId: null }),
    ).toBe("synap/cp/data_pods.k");
  });

  it.each([
    [{ service: "", table: "t", column: "c", rowId: "r" }],
    [{ service: "cp", table: "a/b", column: "c", rowId: "r" }],
    [{ service: "cp", table: "t", column: "c.d", rowId: "r" }],
    [{ service: "cp", table: "t", column: "c", rowId: "" }],
    [{ service: "cp", table: "t", column: "c", rowId: "a/b" }],
  ])("refuses %o", (input) => {
    expect(codeOf(() => fieldAad(input))).toBe("INVALID_AAD");
  });
});
