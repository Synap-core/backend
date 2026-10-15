/**
 * The trust checks on what a third-party marketplace source serves. Every
 * case signs with a REAL ed25519 keypair generated here (Node crypto), so a
 * pass means the signature math held, not that a mock said yes.
 */

import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import {
  MARKETPLACE_INDEX_MAX_LIFETIME_DAYS,
  keyFingerprint,
  verifyDefinitionBytes,
  verifyEd25519,
  verifyIndex,
} from "../marketplace-source-verify.js";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const raw = Buffer.from(jwk.x, "base64url").toString("base64");
  return { publicKey: raw, privateKey };
}

const NOW = new Date("2026-10-13T12:00:00Z");
const DEF = Buffer.from(JSON.stringify({ workspaceName: "CRM", profiles: [] }));
const DEF_SHA = createHash("sha256").update(DEF).digest("hex");

function indexBytes(
  publicKey: string | undefined,
  over: Record<string, unknown> = {}
) {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      source: {
        id: "acme",
        name: "Acme Labs",
        ...(publicKey ? { publicKey } : {}),
      },
      expires: "2026-11-01T00:00:00Z",
      packages: [
        {
          slug: "crm",
          kind: "template",
          version: "h-0123456789ab",
          displayName: "CRM",
          definitionUrl: "defs/crm.json",
          sha256: DEF_SHA,
        },
      ],
      ...over,
    })
  );
}

const sigOf = (
  bytes: Buffer,
  privateKey: ReturnType<typeof keypair>["privateKey"]
) => sign(null, bytes, privateKey).toString("base64");

describe("verifyIndex — first add (no pinned key yet)", () => {
  it("accepts a well-signed index and reports the key the person must confirm", () => {
    const k = keypair();
    const bytes = indexBytes(k.publicKey);
    const v = verifyIndex({
      indexBytes: bytes,
      signature: sigOf(bytes, k.privateKey),
      pinnedKey: null,
      requireSignature: true,
      now: NOW,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.publicKey).toBe(k.publicKey);
    expect(v.fingerprint).toBe(keyFingerprint(k.publicKey));
    expect(v.index.source.name).toBe("Acme Labs");
  });

  it("refuses an index whose signature does not verify under the key it names", () => {
    const k = keypair();
    const other = keypair();
    const bytes = indexBytes(k.publicKey);
    const v = verifyIndex({
      indexBytes: bytes,
      signature: sigOf(bytes, other.privateKey),
      pinnedKey: null,
      requireSignature: true,
      now: NOW,
    });
    expect(v).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("refuses an unsigned index unless it is an unsigned showcase", () => {
    const bytes = indexBytes(undefined);
    expect(
      verifyIndex({
        indexBytes: bytes,
        signature: null,
        pinnedKey: null,
        requireSignature: true,
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "unsigned" });
    const showcase = verifyIndex({
      indexBytes: bytes,
      signature: null,
      pinnedKey: null,
      requireSignature: false,
      now: NOW,
    });
    expect(showcase).toMatchObject({
      ok: true,
      publicKey: null,
      fingerprint: null,
    });
  });

  it("refuses a key-declaring index served without its signature", () => {
    const k = keypair();
    expect(
      verifyIndex({
        indexBytes: indexBytes(k.publicKey),
        signature: null,
        pinnedKey: null,
        requireSignature: false,
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "bad_signature" });
  });
});

describe("verifyIndex — a pinned source", () => {
  it("accepts the pinned key's signature", () => {
    const k = keypair();
    const bytes = indexBytes(k.publicKey);
    expect(
      verifyIndex({
        indexBytes: bytes,
        signature: sigOf(bytes, k.privateKey),
        pinnedKey: k.publicKey,
        requireSignature: true,
        expectedSourceId: "acme",
        now: NOW,
      }).ok
    ).toBe(true);
  });

  it("refuses ONE flipped byte (bad signature, not a key change)", () => {
    const k = keypair();
    const bytes = indexBytes(k.publicKey);
    const signature = sigOf(bytes, k.privateKey);
    const tampered = Buffer.from(
      bytes.toString().replace("Acme Labs", "Acme Labz")
    );
    expect(
      verifyIndex({
        indexBytes: tampered,
        signature,
        pinnedKey: k.publicKey,
        requireSignature: true,
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("detects a KEY CHANGE: a new key that verifies blocks, carrying the new fingerprint", () => {
    const old = keypair();
    const next = keypair();
    const bytes = indexBytes(next.publicKey);
    const v = verifyIndex({
      indexBytes: bytes,
      signature: sigOf(bytes, next.privateKey),
      pinnedKey: old.publicKey,
      requireSignature: true,
      now: NOW,
    });
    expect(v).toMatchObject({
      ok: false,
      reason: "key_changed",
      newPublicKey: next.publicKey,
      newFingerprint: keyFingerprint(next.publicKey),
    });
  });

  it("a new key that does NOT verify is a bad signature, not a key change", () => {
    const old = keypair();
    const claimed = keypair();
    const bytes = indexBytes(claimed.publicKey);
    expect(
      verifyIndex({
        indexBytes: bytes,
        signature: sigOf(bytes, old.privateKey),
        pinnedKey: old.publicKey,
        requireSignature: true,
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("an index that drops its key is refused", () => {
    const k = keypair();
    const bytes = indexBytes(undefined);
    expect(
      verifyIndex({
        indexBytes: bytes,
        signature: sigOf(bytes, k.privateKey),
        pinnedKey: k.publicKey,
        requireSignature: true,
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("refuses an index that renames its source id", () => {
    const k = keypair();
    const bytes = indexBytes(k.publicKey, {
      source: { id: "acme-two", name: "Acme", publicKey: k.publicKey },
    });
    expect(
      verifyIndex({
        indexBytes: bytes,
        signature: sigOf(bytes, k.privateKey),
        pinnedKey: k.publicKey,
        requireSignature: true,
        expectedSourceId: "acme",
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("verifyIndex — expiry, size, shape", () => {
  it("refuses an expired index even when the signature is good", () => {
    const k = keypair();
    const bytes = indexBytes(k.publicKey, { expires: "2026-10-13T11:59:59Z" });
    expect(
      verifyIndex({
        indexBytes: bytes,
        signature: sigOf(bytes, k.privateKey),
        pinnedKey: k.publicKey,
        requireSignature: true,
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "expired" });
  });

  it(`refuses an index that says it stays valid more than ${MARKETPLACE_INDEX_MAX_LIFETIME_DAYS} days ahead`, () => {
    const k = keypair();
    const verify = (expires: string) => {
      const bytes = indexBytes(k.publicKey, { expires });
      return verifyIndex({
        indexBytes: bytes,
        signature: sigOf(bytes, k.privateKey),
        pinnedKey: k.publicKey,
        requireSignature: true,
        now: NOW,
      });
    };
    expect(verify("2036-10-13T12:00:00Z")).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    // Exactly at the cap is still fine.
    expect(verify("2026-11-13T12:00:00Z")).toMatchObject({ ok: true });
  });

  it("refuses an OLDER copy than the index the pod already accepted (a replay)", () => {
    const k = keypair();
    const bytes = indexBytes(k.publicKey, { expires: "2026-10-20T00:00:00Z" });
    const verify = (lastAcceptedExpires: string | null) =>
      verifyIndex({
        indexBytes: bytes,
        signature: sigOf(bytes, k.privateKey),
        pinnedKey: k.publicKey,
        requireSignature: true,
        lastAcceptedExpires,
        now: NOW,
      });
    expect(verify("2026-11-01T00:00:00Z")).toMatchObject({
      ok: false,
      reason: "replayed",
    });
    // The same index again, or a newer one, is accepted.
    expect(verify("2026-10-20T00:00:00Z")).toMatchObject({ ok: true });
    expect(verify("2026-10-15T00:00:00Z")).toMatchObject({ ok: true });
    expect(verify(null)).toMatchObject({ ok: true });
    // A floor from before the lifetime cap (years ahead) never locks it out.
    expect(verify("2036-01-01T00:00:00Z")).toMatchObject({ ok: true });
  });

  it("refuses an oversized index before reading it", () => {
    const k = keypair();
    const bytes = indexBytes(k.publicKey);
    expect(
      verifyIndex({
        indexBytes: bytes,
        signature: sigOf(bytes, k.privateKey),
        pinnedKey: k.publicKey,
        requireSignature: true,
        now: NOW,
        maxBytes: bytes.byteLength - 1,
      })
    ).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("refuses non-JSON and an index outside the format", () => {
    const base = {
      signature: null,
      pinnedKey: null,
      requireSignature: false,
      now: NOW,
    };
    expect(
      verifyIndex({ ...base, indexBytes: Buffer.from("<html>") })
    ).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(
      verifyIndex({
        ...base,
        indexBytes: Buffer.from(JSON.stringify({ schemaVersion: 1 })),
      })
    ).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("refuses a malformed signature without throwing", () => {
    const k = keypair();
    const bytes = indexBytes(k.publicKey);
    expect(verifyEd25519(bytes, "not base64 at all!!", k.publicKey)).toBe(
      false
    );
    expect(verifyEd25519(bytes, "", k.publicKey)).toBe(false);
    expect(verifyEd25519(bytes, sigOf(bytes, k.privateKey), "bad-key")).toBe(
      false
    );
  });
});

describe("verifyDefinitionBytes", () => {
  it("accepts the exact bytes the index digests", () => {
    expect(verifyDefinitionBytes(DEF, DEF_SHA)).toMatchObject({
      ok: true,
      definition: { workspaceName: "CRM" },
    });
  });

  it("refuses a digest mismatch — one changed byte", () => {
    const changed = Buffer.from(DEF.toString().replace("CRM", "CRN"));
    expect(verifyDefinitionBytes(changed, DEF_SHA)).toMatchObject({
      ok: false,
      reason: "digest_mismatch",
    });
  });

  it("refuses an oversized definition and a non-object body", () => {
    expect(verifyDefinitionBytes(DEF, DEF_SHA, 10)).toMatchObject({
      ok: false,
      reason: "too_large",
    });
    const arr = Buffer.from("[1,2]");
    expect(
      verifyDefinitionBytes(arr, createHash("sha256").update(arr).digest("hex"))
    ).toMatchObject({ ok: false, reason: "invalid" });
  });
});
