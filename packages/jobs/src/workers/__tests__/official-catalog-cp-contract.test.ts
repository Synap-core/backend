/**
 * THE CROSS-REPO CONTRACT, pod side: the signed files the Control Plane
 * produced with TEST-ONLY keys (control-plane-api
 * src/lib/catalog-signing/catalog-signing.contract.test.ts generates them;
 * both repos commit the same bytes in fixtures/official-catalog-cp/), checked
 * with the pod's OWN verifier:
 *   - the keys statement verifies under the (test) roots, the index under
 *     the online key it names;
 *   - every definition, exactly as the CP's doors serve it, recomputes to the
 *     digest the index lists (`checkOfficialListing`) — so the pod and the CP
 *     canonicalize and hash the same way;
 *   - the fixture set is the one the CP pinned (FIXTURE_SET_SHA256 is the
 *     same constant in the CP's test): a drift on either side fails here or
 *     there;
 *   - the pod's own limits and patterns are the ones `contract.json` carries
 *     from the CP's `formats.ts` (the ceremony tool pins the same file);
 *   - every TEST-ONLY key the fixtures use is on the pod's deny list, which
 *     the pod derives from the same labels.
 * The keys are derived from public labels — never trust them anywhere.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CATALOG_KEYS_MAX_BYTES,
  CATALOG_KEYS_MAX_KEYS,
  CATALOG_KEYS_MAX_LIFETIME_DAYS,
  CATALOG_KEY_MAX_LIFETIME_DAYS,
  ED25519_PUBLIC_KEY_PATTERN,
  MARKETPLACE_CELL_SLUG_PATTERN,
  MARKETPLACE_INDEX_MAX_BYTES,
  MARKETPLACE_INDEX_MAX_PACKAGES,
  MARKETPLACE_KIND_ALIASES,
  MARKETPLACE_PACKAGE_KINDS,
  MARKETPLACE_SIGNATURE_MAX_BYTES,
  MARKETPLACE_SLUG_PATTERN,
  officialIndexSchema,
  type MarketplacePackageKind,
} from "@synap-core/types/marketplace-source";
import {
  MARKETPLACE_INDEX_MAX_LIFETIME_DAYS,
  checkOfficialListing,
  officialContentHash,
  verifyKeysStatement,
  verifyOfficialIndex,
} from "../marketplace-source-verify.js";
import {
  TEST_ONLY_CATALOG_KEY_LABELS,
  TEST_ONLY_CATALOG_KEY_SEED_PREFIX,
  TEST_ONLY_CATALOG_PUBLIC_KEYS,
} from "../catalog-test-only-keys.js";

const DIR = path.join(__dirname, "fixtures", "official-catalog-cp");
const FIXTURE_SET_SHA256 =
  "4b2967b1671b3d497cad347d4b28fdc0de3514ecc78b6d78c708444a972575c5";

const read = (name: string) => readFileSync(path.join(DIR, name));
const contract = JSON.parse(read("contract.json").toString()) as {
  rootKeys: string[];
  onlineKey: string;
  verifyAt: string;
  keysVersion: number;
  indexExpires: string;
  packageCount: number;
  limits: Record<string, unknown>;
  testOnlyKeys: { seedPrefix: string; labels: string[]; publicKeys: string[] };
};
const served = JSON.parse(read("served-definitions.json").toString()) as Array<{
  kind: MarketplacePackageKind;
  slug: string;
  version: string;
  definition: Record<string, unknown>;
}>;
const NOW = new Date(contract.verifyAt);
const sha = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");

function verified() {
  const keys = verifyKeysStatement({
    statementBytes: read("synap-catalog-keys.json"),
    signature: read("synap-catalog-keys.json.sig").toString(),
    rootKeys: contract.rootKeys,
    lastVersion: null,
    now: NOW,
  });
  if (!keys.ok) throw new Error(keys.message);
  const index = verifyOfficialIndex({
    indexBytes: read("synap-index.json"),
    signature: read("synap-index.json.sig").toString(),
    trustedKeys: keys.keys,
    now: NOW,
  });
  if (!index.ok) throw new Error(index.message);
  return { keys, index };
}

describe("the Control Plane's signed catalog (TEST-ONLY fixtures)", () => {
  it("is the fixture set the Control Plane pinned", () => {
    const names = readdirSync(DIR).sort();
    expect(names).toEqual([
      "contract.json",
      "served-definitions.json",
      "synap-catalog-keys.json",
      "synap-catalog-keys.json.sig",
      "synap-index.json",
      "synap-index.json.sig",
    ]);
    expect(sha(names.map((n) => `${n} ${sha(read(n))}\n`).join(""))).toBe(
      FIXTURE_SET_SHA256
    );
  });

  it("verifies root → keys statement → index with the pod's verifier", () => {
    const { keys, index } = verified();
    expect(keys.statement.version).toBe(contract.keysVersion);
    expect(keys.keys).toEqual([contract.onlineKey]);
    expect(index.index.expires).toBe(contract.indexExpires);
    expect(index.index.packages).toHaveLength(contract.packageCount);
    // The CP's own `version` counter is tolerated (not part of the pod's format).
    expect(
      officialIndexSchema.safeParse(
        JSON.parse(read("synap-index.json").toString())
      ).success
    ).toBe(true);
  });

  it("vouches for every definition exactly as the CP's doors serve it", () => {
    const { index } = verified();
    const listed = new Map(
      index.index.packages.map((p) => [`${p.kind}|${p.slug}`, p])
    );
    expect(served.length).toBe(listed.size);
    for (const s of served) {
      const entry = listed.get(`${s.kind}|${s.slug}`) ?? null;
      expect(
        checkOfficialListing({
          kind: s.kind,
          slug: s.slug,
          version: s.version,
          definition: s.definition,
          listed: entry,
        }),
        `${s.kind} ${s.slug}`
      ).toBeNull();
      expect(entry!.contentHash).toBe(
        officialContentHash(s.kind, s.definition)
      );
    }
  });

  it("refuses the same files once tampered, under another root, or replayed", () => {
    const statement = read("synap-catalog-keys.json");
    expect(
      verifyKeysStatement({
        statementBytes: Buffer.from(
          statement.toString().replace('"version": 1', '"version": 9')
        ),
        signature: read("synap-catalog-keys.json.sig").toString(),
        rootKeys: contract.rootKeys,
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(
      verifyKeysStatement({
        statementBytes: statement,
        signature: read("synap-catalog-keys.json.sig").toString(),
        rootKeys: [contract.onlineKey],
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(
      verifyKeysStatement({
        statementBytes: statement,
        signature: read("synap-catalog-keys.json.sig").toString(),
        rootKeys: contract.rootKeys,
        lastVersion: contract.keysVersion + 1,
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "replayed" });
    const index = read("synap-index.json");
    expect(
      verifyOfficialIndex({
        indexBytes: Buffer.from(index.toString().replace('"CRM"', '"CRX"')),
        signature: read("synap-index.json.sig").toString(),
        trustedKeys: [contract.onlineKey],
        now: NOW,
      })
    ).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(
      verifyOfficialIndex({
        indexBytes: index,
        signature: read("synap-index.json.sig").toString(),
        trustedKeys: [contract.onlineKey],
        now: new Date(new Date(contract.indexExpires).getTime() + 1),
      })
    ).toMatchObject({ ok: false, reason: "expired" });
  });

  it("holds the same limits and patterns as the Control Plane and the ceremony tool", () => {
    expect({
      keyMaxLifetimeDays: CATALOG_KEY_MAX_LIFETIME_DAYS,
      keysStatementMaxLifetimeDays: CATALOG_KEYS_MAX_LIFETIME_DAYS,
      indexMaxLifetimeDays: MARKETPLACE_INDEX_MAX_LIFETIME_DAYS,
      keysStatementMaxBytes: CATALOG_KEYS_MAX_BYTES,
      keysStatementMaxKeys: CATALOG_KEYS_MAX_KEYS,
      indexMaxBytes: MARKETPLACE_INDEX_MAX_BYTES,
      indexMaxPackages: MARKETPLACE_INDEX_MAX_PACKAGES,
      signatureMaxBytes: MARKETPLACE_SIGNATURE_MAX_BYTES,
      slugPattern: MARKETPLACE_SLUG_PATTERN.source,
      cellSlugPattern: MARKETPLACE_CELL_SLUG_PATTERN.source,
      publicKeyPattern: ED25519_PUBLIC_KEY_PATTERN.source,
      kinds: [...MARKETPLACE_PACKAGE_KINDS],
      kindAliases: MARKETPLACE_KIND_ALIASES,
    }).toEqual(contract.limits);
  });

  it("refuses every TEST-ONLY key the fixtures are signed with (one deny list, same labels)", () => {
    expect(contract.testOnlyKeys).toEqual({
      seedPrefix: TEST_ONLY_CATALOG_KEY_SEED_PREFIX,
      labels: [...TEST_ONLY_CATALOG_KEY_LABELS],
      publicKeys: [...TEST_ONLY_CATALOG_PUBLIC_KEYS],
    });
    for (const key of [...contract.rootKeys, contract.onlineKey]) {
      expect(TEST_ONLY_CATALOG_PUBLIC_KEYS).toContain(key);
    }
  });

  it("refuses a served definition changed after signing", () => {
    const { index } = verified();
    const s = served.find((d) => d.kind === "capability")!;
    const entry = index.index.packages.find(
      (p) => p.kind === s.kind && p.slug === s.slug
    )!;
    expect(
      checkOfficialListing({
        kind: s.kind,
        slug: s.slug,
        version: s.version,
        definition: { ...s.definition, tools: [] },
        listed: entry,
      })
    ).toMatch(/doesn't match the digest/);
  });
});
