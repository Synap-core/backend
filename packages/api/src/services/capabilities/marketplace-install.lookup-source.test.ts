/**
 * `lookupCatalogEntry` — one source per lookup (Pod Console D11). The cache
 * is unique on (source, kind, slug). A bare lookup reads the OFFICIAL source's
 * row and only that one: it used to read every source and refuse on a tie,
 * which still let a single third-party row answer for a slug Synap does not
 * list. A named source reads that source; a name the pod does not know is
 * refused rather than guessed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as Database from "@synap/database";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  eqs: [] as unknown[][],
  snapshot: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof Database>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async (n: number) => h.rows.slice(0, n),
  };
  return {
    ...actual,
    db: { select: () => chain },
    // Record each equality so the test can see which source is read.
    eq: (col: unknown, value: unknown) => {
      h.eqs.push([col, value]);
      return actual.eq(col as never, value as never);
    },
    readMarketplaceSources: (...a: unknown[]) => h.snapshot(...a),
  };
});

import { lookupCatalogEntry } from "./marketplace-install.js";

const CP = "https://cp.synap.live";

const row = (source: string) => ({
  id: `id-${source}`,
  source,
  kind: "template",
  slug: "crm",
  name: "CRM",
  description: null,
  version: "1.0.0",
  tier: null,
  vendor: null,
  definition: null,
  listing: null,
  retiredAt: null,
  replacedBySlug: null,
});

const readSources = () =>
  h.eqs.map(([, v]) => v).filter((v) => v === CP || v === "acme");

beforeEach(() => {
  h.rows = [];
  h.eqs = [];
  h.snapshot.mockReset();
  h.snapshot.mockResolvedValue({
    sources: [
      {
        id: "acme",
        url: "https://acme.test/synap-index.json",
        name: "Acme",
        trust: "trusted",
        publicKey: "k",
        keyFingerprint: "f",
        addedBy: "u",
        addedAt: "",
        enabled: true,
      },
    ],
    official: null,
    status: {},
  });
  process.env.CONTROL_PLANE_URL = CP;
});

describe("lookupCatalogEntry — one source per lookup", () => {
  it("a bare slug reads the official source only, without reading the settings", async () => {
    h.rows = [row(CP)];
    const entry = await lookupCatalogEntry("template", "crm");
    expect(entry?.source).toBe(CP);
    expect(readSources()).toEqual([CP]);
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it("`synap` and the official URL both name the official source", async () => {
    await lookupCatalogEntry("template", "crm", "synap");
    await lookupCatalogEntry("template", "crm", CP);
    expect(readSources()).toEqual([CP, CP]);
  });

  it("a named added source reads that source's rows", async () => {
    h.rows = [row("acme")];
    const entry = await lookupCatalogEntry("template", "crm", "acme");
    expect(entry?.source).toBe("acme");
    expect(readSources()).toEqual(["acme"]);
  });

  it("refuses a source this pod does not have", async () => {
    const err = await lookupCatalogEntry("template", "crm", "evil").catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("NOT_FOUND");
  });

  it("returns null when the source does not carry it", async () => {
    expect(await lookupCatalogEntry("template", "crm")).toBeNull();
  });

  it("still refuses a retired row as an install target", async () => {
    h.rows = [{ ...row(CP), retiredAt: new Date(), replacedBySlug: "crm-2" }];
    const err = await lookupCatalogEntry("template", "crm").catch((e) => e);
    expect((err as TRPCError).code).toBe("PRECONDITION_FAILED");
    expect((err as TRPCError).message).toContain("crm-2");
  });
});
