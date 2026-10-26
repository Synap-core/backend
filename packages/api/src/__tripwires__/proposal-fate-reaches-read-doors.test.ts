import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ProposalBasicSchema,
  WireProposalSchema,
  toProposalBasic,
  withProposalClass,
} from "../routers/hub-protocol/rest/_codecs/proposal.js";

/**
 * Proposal FATE (and WAITS) reach every read door (Resolve-XP W3) — the same
 * four doors `proposal-class-reaches-read-doors.test.ts` pins for the class:
 *   1. `enrichProposalsForDisplay` → tRPC list/get, Hub `GET /proposals/:id`,
 *      MCP get (source scan: it batch-joins the database);
 *   3. `toProposalBasic`  → Hub REST `view=basic` + MCP list (behaviour);
 *   4. `withProposalClass` → Hub REST `view=full` (behaviour);
 * and `waits`, which needs reads, is produced by the list doors that feed 3/4
 * (source scan) and FORWARDED by 3 (behaviour).
 *
 * One pending row per fate kind — each derived from the row's own columns, so
 * a door that dropped `createdAt` or `sessionId` on the way reads the wrong
 * kind here, not merely an absent one.
 */

const NOW = Date.now();
const DAY = 86_400_000;
const SESSION = "00000000-0000-4000-8000-0000000000aa";
const ONE_PER_KIND = [
  {
    kind: "expires",
    row: {
      proposalType: "capability.run",
      targetType: "capability",
      data: { verbId: "messaging.send" },
      sessionId: SESSION,
      createdAt: new Date(NOW - 3_600_000).toISOString(),
    },
  },
  {
    kind: "dies_with_session",
    row: {
      proposalType: "update",
      targetType: "document",
      data: {},
      sessionId: SESSION,
      createdAt: new Date(NOW - 3_600_000).toISOString(),
    },
  },
  {
    kind: "review_later",
    row: {
      proposalType: "create",
      targetType: "entity",
      data: {},
      sessionId: null,
      createdAt: new Date(NOW - 8 * DAY).toISOString(),
    },
  },
  {
    kind: "until_decided",
    row: {
      proposalType: "create",
      targetType: "entity",
      data: {},
      sessionId: null,
      createdAt: new Date(NOW - 6 * DAY).toISOString(),
    },
  },
] as const;

const raw = (
  row: (typeof ONE_PER_KIND)[number]["row"],
  status = "pending"
) => ({
  id: "p1",
  targetId: "t1",
  workspaceId: null,
  status,
  ...row,
  data: { ...row.data },
});

describe("fate reaches the pure doors, one row per kind", () => {
  for (const { kind, row } of ONE_PER_KIND) {
    it(`${kind}: toProposalBasic and withProposalClass both say it`, () => {
      const basic = toProposalBasic(raw(row));
      const full = withProposalClass(raw(row));
      expect(basic.fate?.kind).toBe(kind);
      expect(full.fate?.kind).toBe(kind);
      expect(() => ProposalBasicSchema.parse(basic)).not.toThrow();
      expect(() => WireProposalSchema.parse(full)).not.toThrow();
    });
  }

  it("the ephemeral's clock and its session both reach the wire", () => {
    const fate = toProposalBasic(raw(ONE_PER_KIND[0].row)).fate;
    expect(fate).toEqual({
      kind: "expires",
      expiresAt: new Date(
        Date.parse(ONE_PER_KIND[0].row.createdAt) + 24 * 3_600_000
      ).toISOString(),
      orSessionEnd: true,
    });
  });

  it("a decided proposal has no fate", () => {
    expect(
      toProposalBasic(raw(ONE_PER_KIND[2].row, "approved")).fate
    ).toBeUndefined();
    expect(
      withProposalClass(raw(ONE_PER_KIND[2].row, "rejected")).fate
    ).toBeUndefined();
  });

  it("toProposalBasic forwards the waits its list door resolved", () => {
    const basic = toProposalBasic({
      ...raw(ONE_PER_KIND[3].row),
      waits: { waits: true, reason: "gate" },
    });
    expect(basic.waits).toEqual({ waits: true, reason: "gate" });
  });
});

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the doors that batch-join stamp fate and waits (source scan)", () => {
  it("enrichProposalsForDisplay spreads fate, waits and supersededBy into its row", () => {
    const src = readSrc("../routers/proposals/display.ts");
    expect(src).toMatch(/\.\.\.proposalFateFields\(row\)/);
    expect(src).toMatch(
      /\.\.\.proposalWaitsFields\(row\.id,\s*waitsByProposal\)/
    );
    expect(src).toMatch(/resolveProposalWaits\(rows,/);
    expect(src).toMatch(/\.\.\.supersededByFields\(row\)/);
  });

  it("the Hub list and the MCP list resolve waits for the rows they forward", () => {
    for (const rel of [
      "../routers/hub-protocol/proposals.ts",
      "../routers/mcp/handlers/read.ts",
    ]) {
      const src = readSrc(rel);
      expect(src, rel).toMatch(/resolveProposalWaits\(/);
      expect(src, rel).toMatch(/proposalWaitsFields\(row\.id,\s*waits\)/);
    }
  });
});
