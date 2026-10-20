/**
 * The checks on Synap's own signed catalog — the keys statement (root keys →
 * online catalog keys), the official index under that key set, and the
 * content digest of a definition the Control Plane serves. Real ed25519
 * keypairs throughout, so a pass means the signature math held.
 */

import { describe, it, expect } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  checkOfficialListing,
  officialContentHash,
  verifyKeysStatement,
  verifyOfficialIndex,
} from "../marketplace-source-verify.js";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    publicKey: Buffer.from(jwk.x, "base64url").toString("base64"),
    privateKey,
  };
}
type Key = ReturnType<typeof keypair>;

const NOW = new Date("2026-10-19T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const sigOf = (b: Buffer, k: Key) =>
  sign(null, b, k.privateKey).toString("base64");

const ROOT = keypair();
const STANDBY = keypair();
const CATALOG = keypair();

function statement(over: Record<string, unknown> = {}) {
  return bytes({
    schemaVersion: 1,
    version: 4,
    expires: at(200),
    keys: [{ publicKey: CATALOG.publicKey, notAfter: at(60) }],
    ...over,
  });
}

describe("verifyKeysStatement", () => {
  const verify = (
    b: Buffer,
    signer: Key,
    over: Partial<Parameters<typeof verifyKeysStatement>[0]> = {}
  ) =>
    verifyKeysStatement({
      statementBytes: b,
      signature: sigOf(b, signer),
      rootKeys: [ROOT.publicKey, STANDBY.publicKey],
      now: NOW,
      ...over,
    });

  it("accepts a statement signed by the current root or the standby", () => {
    for (const root of [ROOT, STANDBY]) {
      const v = verify(statement(), root);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.keys).toEqual([CATALOG.publicKey]);
    }
  });

  it("refuses a statement signed by any other key, or unsigned", () => {
    const b = statement();
    expect(verify(b, CATALOG)).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    expect(
      verifyKeysStatement({
        statementBytes: b,
        signature: null,
        rootKeys: [ROOT.publicKey],
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("refuses an expired statement unless the operator allows expired files, over a version floor", () => {
    const b = statement({ expires: at(-1) });
    expect(verify(b, ROOT)).toMatchObject({ ok: false, reason: "expired" });
    expect(verify(b, ROOT, { allowExpired: true, lastVersion: 4 }).ok).toBe(
      true
    );
    expect(verify(b, ROOT, { allowExpired: true, lastVersion: 3 }).ok).toBe(
      true
    );
  });

  it("allowing expired files never brings back a retired key: no floor, or an older statement, is refused", () => {
    const retired = keypair();
    const old = statement({
      version: 2,
      expires: at(-30),
      keys: [{ publicKey: retired.publicKey, notAfter: at(-40) }],
    });
    // A fresh pod (no floor yet) is not air-gapped trust: refused as expired.
    expect(verify(old, ROOT, { allowExpired: true })).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(
      verify(old, ROOT, { allowExpired: true, lastVersion: null })
    ).toMatchObject({ ok: false, reason: "expired" });
    // Below the floor: the replay is refused, whatever the flag says.
    expect(verify(old, ROOT, { allowExpired: true, lastVersion: 3 }).ok).toBe(
      false
    );
    // At the floor, the expired key of the CURRENT statement stays usable.
    const current = statement({
      version: 3,
      expires: at(-1),
      keys: [{ publicKey: CATALOG.publicKey, notAfter: at(-2) }],
    });
    const v = verify(current, ROOT, { allowExpired: true, lastVersion: 3 });
    expect(v.ok && v.keys).toEqual([CATALOG.publicKey]);
    expect(verify(current, ROOT, { allowExpired: true }).ok).toBe(false);
  });

  it("refuses a statement valid for more than a year", () => {
    expect(verify(statement({ expires: at(400) }), ROOT)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("never steps back to an older statement version", () => {
    expect(verify(statement(), ROOT, { lastVersion: 5 })).toMatchObject({
      ok: false,
      reason: "replayed",
    });
    expect(verify(statement(), ROOT, { lastVersion: 4 }).ok).toBe(true);
  });

  it("trusts only short-lived catalog keys that are still valid", () => {
    const longLived = keypair();
    const lapsed = keypair();
    const v = verify(
      statement({
        keys: [
          { publicKey: CATALOG.publicKey, notAfter: at(60) },
          { publicKey: longLived.publicKey, notAfter: at(200) },
          { publicKey: lapsed.publicKey, notAfter: at(-1) },
        ],
      }),
      ROOT
    );
    expect(v.ok && v.keys).toEqual([CATALOG.publicKey]);
    expect(
      verify(
        statement({
          keys: [{ publicKey: longLived.publicKey, notAfter: at(200) }],
        }),
        ROOT
      )
    ).toMatchObject({ ok: false, reason: "invalid" });
  });
});

const DEFINITION = {
  workspaceName: "CRM",
  profiles: [{ slug: "deal", name: "Deal" }],
  _meta: { slug: "crm" },
};
const DIGEST = officialContentHash("template", DEFINITION);

function officialIndex(signer: Key, over: Record<string, unknown> = {}) {
  return bytes({
    schemaVersion: 1,
    source: { id: "synap", name: "Synap", publicKey: signer.publicKey },
    expires: at(14),
    packages: [
      {
        slug: "crm",
        kind: "workspace",
        version: `h-${DIGEST.slice(0, 12)}`,
        displayName: "CRM",
        definitionUrl: "/api/packages/crm/h-x/definition.json",
        sha256: DIGEST,
        contentHash: DIGEST,
      },
    ],
    ...over,
  });
}

describe("verifyOfficialIndex", () => {
  it("accepts an index signed by a trusted catalog key, in the official format", () => {
    const b = officialIndex(CATALOG);
    const v = verifyOfficialIndex({
      indexBytes: b,
      signature: sigOf(b, CATALOG),
      trustedKeys: [CATALOG.publicKey],
      now: NOW,
    });
    expect(v.ok).toBe(true);
    if (v.ok)
      expect(v.index.packages[0]).toMatchObject({
        kind: "template",
        contentHash: DIGEST,
      });
  });

  it("refuses an index under a key the statement does not name, even if it verifies", () => {
    const rogue = keypair();
    const b = officialIndex(rogue);
    expect(
      verifyOfficialIndex({
        indexBytes: b,
        signature: sigOf(b, rogue),
        trustedKeys: [CATALOG.publicKey],
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("refuses an altered index, a replayed one and an expired one", () => {
    const b = officialIndex(CATALOG);
    const sig = sigOf(b, CATALOG);
    const altered = Buffer.from(b.toString().replace('"CRM"', '"CRM!"'));
    const base = { trustedKeys: [CATALOG.publicKey], now: NOW };
    expect(
      verifyOfficialIndex({ ...base, indexBytes: altered, signature: sig })
    ).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    expect(
      verifyOfficialIndex({
        ...base,
        indexBytes: b,
        signature: sig,
        lastAcceptedExpires: at(20),
      })
    ).toMatchObject({ ok: false, reason: "replayed" });
    const old = officialIndex(CATALOG, { expires: at(-1) });
    const oldSig = sigOf(old, CATALOG);
    expect(
      verifyOfficialIndex({ ...base, indexBytes: old, signature: oldSig })
    ).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(
      verifyOfficialIndex({
        ...base,
        indexBytes: old,
        signature: oldSig,
        allowExpired: true,
      }).ok
    ).toBe(true);
  });

  it("refuses a third-party-shaped index (no content digest) even when signed", () => {
    const b = officialIndex(CATALOG, {
      packages: [
        {
          slug: "crm",
          kind: "template",
          version: "1",
          displayName: "CRM",
          definitionUrl: "x",
          sha256: DIGEST,
        },
      ],
    });
    expect(
      verifyOfficialIndex({
        indexBytes: b,
        signature: sigOf(b, CATALOG),
        trustedKeys: [CATALOG.publicKey],
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("officialContentHash / checkOfficialListing", () => {
  it("is sha256 over the canonical JSON, the Control Plane's content hash", () => {
    // PARITY LITERAL — the Control Plane pins the same canonical form and
    // digest (docs/pod-console/open-hosting-and-catalog-signing.md §B.8.4).
    const canonical =
      '{"profiles":[{"name":"Deal","slug":"deal"}],"workspaceName":"CRM"}';
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(
      "68f8c9908b0cacaed63dd011d3275521e51e663865e882ac800c32f862cbec54"
    );
    expect(DIGEST).toBe(
      "68f8c9908b0cacaed63dd011d3275521e51e663865e882ac800c32f862cbec54"
    );
    expect(
      officialContentHash("template", { ...DEFINITION, workspaceName: "CRM" })
    ).toBe(DIGEST);
  });

  const listed = { version: `h-${DIGEST.slice(0, 12)}`, contentHash: DIGEST };
  const check = (
    over: Partial<Parameters<typeof checkOfficialListing>[0]> = {}
  ) =>
    checkOfficialListing({
      kind: "template",
      slug: "crm",
      version: listed.version,
      definition: DEFINITION,
      listed,
      ...over,
    });

  it("admits the listed definition, with or without a version to compare", () => {
    expect(check()).toBeNull();
    expect(check({ version: null })).toBeNull();
  });

  it("refuses an unlisted package, another version, a changed body or another identity", () => {
    expect(check({ listed: null })).toMatch(/not in Synap's signed catalog/);
    expect(check({ version: "h-000000000000" })).toMatch(/not the version/);
    expect(
      check({ definition: { ...DEFINITION, workspaceName: "CRM (evil)" } })
    ).toMatch(/doesn't match the digest/);
    expect(
      check({ definition: { ...DEFINITION, _meta: { slug: "billing" } } })
    ).toMatch(/names itself "billing"/);
  });

  it("checks a cell's own definition, not the listing fields the endpoint adds", () => {
    const cell = { key: "bar", code: "export default 1" };
    const digest = officialContentHash("cell", cell);
    expect(
      checkOfficialListing({
        kind: "cell",
        slug: "charts/bar",
        version: "1.0.0",
        definition: {
          ...cell,
          packageSlug: "charts",
          installCount: 42,
          isVerified: true,
        },
        listed: { version: "1.0.0", contentHash: digest },
      })
    ).toBeNull();
  });
});
