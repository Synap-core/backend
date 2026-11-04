/**
 * A field define_kind stores can be PUBLISHED (CP ticket 5980e79d).
 *
 * define_kind normalises `contracts_total` to `contracts-total`
 * (`slugifyPropertyKey`). Every sharing door that names a property key — the
 * exposure policy's public `fields`, a site collection's `slugField` and
 * `sort`, the public collection door's `sort` parser — used to carry its own
 * `/^[A-Za-z][A-Za-z0-9_]{0,63}$/`, so a multi-word field could never appear
 * in a published record. Each door now derives from THE property key
 * (`@synap/database/property-key`); this file pins that each one accepts what
 * define_kind stores, and that none carries a grammar of its own again.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { slugifyPropertyKey } from "@synap/database/property-key";
import {
  parseExposurePolicyInput,
  resolvePublicFields,
} from "../exposure-policy.js";
import { SiteConfigV1Schema } from "../site-config.js";
import { parseCollectionQuery } from "../public-site-read.js";

/** What define_kind stores for multi-word fields. */
const STORED = ["contracts_total", "Funding Amount", "uo_category"].map(
  slugifyPropertyKey
);

const cell = { read: "denied", create: "denied" } as const;
const policyWith = (fields: string[]) => ({
  version: 1,
  kinds: Object.fromEntries(
    ["entity", "document", "view", "project"].map((k) => [
      k,
      {
        guest: cell,
        link: cell,
        public: { read: "direct", create: "direct", fields },
      },
    ])
  ),
});

describe("a define_kind field is publishable", () => {
  it("the stored slugs are hyphenated (the case this file is about)", () => {
    expect(STORED).toEqual([
      "contracts-total",
      "funding-amount",
      "uo-category",
    ]);
  });

  it("the exposure policy accepts them as public fields", () => {
    const stored = parseExposurePolicyInput(policyWith(["title", ...STORED]));
    expect(stored.kinds.entity.public.fields).toEqual(["title", ...STORED]);
  });

  it("the stored allowlist keeps them when read back", () => {
    const settings = { exposurePolicy: policyWith(["title", ...STORED]) };
    expect(resolvePublicFields(settings, "entity")).toEqual([
      "title",
      ...STORED,
    ]);
  });

  it("a site collection may sort by them and address records by one", () => {
    const parsed = SiteConfigV1Schema.safeParse({
      version: 1,
      collections: {
        company: {
          sort: ["-contracts-total", "funding-amount"],
          slugField: "uo-category",
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("the public collection door parses a sort on them", () => {
    expect(
      parseCollectionQuery(
        { sort: ["-contracts-total,funding-amount"] },
        { sort: ["-contracts-total", "funding-amount"], pageSize: 20 }
      )
    ).toMatchObject({
      sort: [
        { key: "contracts-total", desc: true },
        { key: "funding-amount", desc: false },
      ],
    });
  });
});

describe("no sharing door carries a key grammar of its own", () => {
  // Derived, not hand-listed: every source file of the sharing folder.
  const dir = join(__dirname, "..");
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts")
  );

  it("scans the sharing doors", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "exposure-policy.ts",
        "site-config.ts",
        "public-site-read.ts",
      ])
    );
  });

  // The old per-door grammar's head, `[A-Za-z][A-Za-z0-9_]{0,`. Boundary: it
  // catches that grammar copied back (with or without a `-?` prefix or another
  // length); it does not catch a NEW hand-written key grammar of another
  // shape. The behavioural rows above are what pin each door's acceptance.
  const OLD_GRAMMAR = /\[A-Za-z\]\[A-Za-z0-9_\]\{0,/;

  it("the scan still sees the old grammar (self-check)", () => {
    expect("/^-?[A-Za-z][A-Za-z0-9_]{0,63}$/").toMatch(OLD_GRAMMAR);
  });

  it.each(files)("%s names property keys through the one grammar", (file) => {
    const src = readFileSync(join(dir, file), "utf8");
    expect(src).not.toMatch(OLD_GRAMMAR);
  });
});
