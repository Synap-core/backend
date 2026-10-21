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
 *     there.
 * The keys are derived from public labels — never trust them anywhere.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  officialIndexSchema,
  type MarketplacePackageKind,
} from "@synap-core/types/marketplace-source";
import {
  checkOfficialListing,
  officialContentHash,
  verifyKeysStatement,
  verifyOfficialIndex,
} from "../marketplace-source-verify.js";

const DIR = path.join(__dirname, "fixtures", "official-catalog-cp");
const FIXTURE_SET_SHA256 =
  "ab9f8bbe6aade74cede7a01992ef8590a86982c7bdd59e3430e9bee8193d8819";

const read = (name: string) => readFileSync(path.join(DIR, name));
const contract = JSON.parse(read("contract.json").toString()) as {
  rootKeys: string[];
  onlineKey: string;
  verifyAt: string;
  keysVersion: number;
  indexExpires: string;
  packageCount: number;
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
