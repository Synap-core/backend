/**
 * `lookupCatalogEntry` — source-aware. The cache is unique on
 * (source, kind, slug), so `(kind, slug)` alone names one row only while a
 * single source carries the slug. With several, the lookup used to return
 * whichever row the database produced first; it now refuses and names the
 * sources, and a named source narrows the read to that row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as Database from "@synap/database";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  conditions: [] as unknown[][],
  limit: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof Database>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async (n: number) => {
      h.limit(n);
      return h.rows.slice(0, n);
    },
  };
  return {
    ...actual,
    db: { select: () => chain },
    // Record each AND's operands so the test can see the source filter.
    and: (...conds: unknown[]) => {
      h.conditions.push(conds);
      return conds;
    },
  };
});

import { lookupCatalogEntry } from "./marketplace-install.js";

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
  retiredAt: null,
  replacedBySlug: null,
});

beforeEach(() => {
  h.rows = [];
  h.conditions = [];
  h.limit.mockClear();
});

describe("lookupCatalogEntry — source-aware", () => {
  it("returns the one row when a single source carries the slug", async () => {
    h.rows = [row("https://cp.synap.live")];
    const entry = await lookupCatalogEntry("template", "crm");
    expect(entry?.source).toBe("https://cp.synap.live");
    // Two rows are read so an ambiguity is visible, not one.
    expect(h.limit).toHaveBeenCalledWith(2);
    expect(h.conditions[0]).toHaveLength(2);
  });

  it("refuses (CONFLICT, naming the sources) when several sources carry it", async () => {
    h.rows = [row("https://cp.synap.live"), row("https://acme.example")];
    const err = await lookupCatalogEntry("template", "crm").catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("CONFLICT");
    expect((err as TRPCError).message).toContain("https://cp.synap.live");
    expect((err as TRPCError).message).toContain("https://acme.example");
  });

  it("narrows the read to the named source", async () => {
    h.rows = [row("https://acme.example")];
    const entry = await lookupCatalogEntry(
      "template",
      "crm",
      "https://acme.example"
    );
    expect(entry?.source).toBe("https://acme.example");
    expect(h.conditions[0]).toHaveLength(3);
  });

  it("returns null when no source carries it", async () => {
    expect(await lookupCatalogEntry("template", "crm")).toBeNull();
  });

  it("still refuses a retired row as an install target", async () => {
    h.rows = [
      {
        ...row("https://cp.synap.live"),
        retiredAt: new Date(),
        replacedBySlug: "crm-2",
      },
    ];
    const err = await lookupCatalogEntry("template", "crm").catch((e) => e);
    expect((err as TRPCError).code).toBe("PRECONDITION_FAILED");
    expect((err as TRPCError).message).toContain("crm-2");
  });
});
