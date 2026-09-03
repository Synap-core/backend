import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ProposalBasicSchema,
  WireProposalSchema,
  toProposalBasic,
  withProposalClass,
} from "../routers/hub-protocol/rest/_codecs/proposal.js";
import {
  collapseProposalsToClusters,
  type ClusterInputRow,
} from "../services/proposals/fingerprint.js";
import {
  PROPOSAL_CLASSES,
  CLASS_LIFETIME_HOURS,
} from "../services/proposals/proposal-class.js";

/**
 * Proposal CLASS reaches EVERY read door.
 *
 * `classifyProposal` was pure, correct, and read by exactly ONE production
 * caller (the expiry worker). A class no read door serializes is a class no
 * surface can render — the decision "how long does this stay answerable" was
 * knowable and unreachable at the same time.
 *
 * This file pins the four doors that now carry it:
 *   1. `enrichProposalsForDisplay`   → tRPC `proposals.list` / `proposals.get`
 *   2. `collapseProposalsToClusters` → tRPC `proposals.groups`
 *   3. `toProposalBasic`             → Hub REST `view=basic` + MCP list
 *   4. `withProposalClass`           → Hub REST `view=full`
 *
 * Doors 2-4 are pure and asserted by BEHAVIOUR below. Door 1 batch-joins the
 * database, so it is asserted by SOURCE SCAN — the same mechanism, for the same
 * reason, as the projection-parity tripwires.
 */

/** One (proposalType, targetType) pair per class, and the class it must yield. */
const ONE_ROW_PER_CLASS = [
  {
    proposalType: "capability.run",
    targetType: "capability",
    cls: "ephemeral",
  },
  { proposalType: "merge", targetType: "entity", cls: "curatorial" },
  { proposalType: "create", targetType: "entity", cls: "objectWork" },
  {
    proposalType: "governance.widen_lane",
    targetType: "governance_rule",
    cls: "governance",
  },
] as const;

it("the fixtures cover every declared class", () => {
  expect(new Set(ONE_ROW_PER_CLASS.map((r) => r.cls))).toEqual(
    new Set(PROPOSAL_CLASSES)
  );
});

describe("door 3 — toProposalBasic (REST view=basic, MCP synap_list_proposals)", () => {
  for (const { proposalType, targetType, cls } of ONE_ROW_PER_CLASS) {
    it(`stamps class="${cls}" and its lifetime`, () => {
      const basic = toProposalBasic({
        id: "p1",
        proposalType,
        targetType,
        targetId: "t1",
        status: "pending",
        workspaceId: null,
        data: {},
      });
      expect(basic.class).toBe(cls);
      expect(basic.lifetimeHours).toBe(CLASS_LIFETIME_HOURS[cls]);
      // The projection must still SATISFY its own declared schema — the field
      // being present is only half the contract.
      expect(() => ProposalBasicSchema.parse(basic)).not.toThrow();
    });
  }
});

describe("door 4 — withProposalClass (REST view=full)", () => {
  for (const { proposalType, targetType, cls } of ONE_ROW_PER_CLASS) {
    it(`stamps class="${cls}" onto a raw row`, () => {
      const row = withProposalClass({
        id: "p1",
        workspaceId: null,
        targetType,
        targetId: "t1",
        proposalType,
        data: {},
        status: "pending",
      });
      expect(row.class).toBe(cls);
      expect(row.lifetimeHours).toBe(CLASS_LIFETIME_HOURS[cls]);
      expect(() => WireProposalSchema.parse(row)).not.toThrow();
    });
  }
});

describe("door 2 — collapseProposalsToClusters (proposals.groups)", () => {
  it("gives every cluster the class of its own fingerprint", () => {
    const rows: ClusterInputRow[] = ONE_ROW_PER_CLASS.map((r, i) => ({
      id: `p${i}`,
      createdAt: new Date(2026, 8, 3, 12, i),
      proposalType: r.proposalType,
      targetType: r.targetType,
      targetId: `t${i}`,
      data: {},
      workspaceId: null,
    }));
    const clusters = collapseProposalsToClusters(rows);
    expect(clusters).toHaveLength(ONE_ROW_PER_CLASS.length);
    for (const { proposalType, cls } of ONE_ROW_PER_CLASS) {
      const cluster = clusters.find((c) => c.proposalType === proposalType);
      expect(cluster?.class).toBe(cls);
      expect(cluster?.lifetimeHours).toBe(CLASS_LIFETIME_HOURS[cls]);
    }
  });

  it("only the ephemeral cluster carries a lifetime", () => {
    const rows: ClusterInputRow[] = ONE_ROW_PER_CLASS.map((r, i) => ({
      id: `p${i}`,
      createdAt: new Date(2026, 8, 3, 12, i),
      proposalType: r.proposalType,
      targetType: r.targetType,
      targetId: `t${i}`,
      data: {},
      workspaceId: null,
    }));
    const withLifetime = collapseProposalsToClusters(rows).filter(
      (c) => c.lifetimeHours !== null
    );
    expect(withLifetime.map((c) => c.class)).toEqual(["ephemeral"]);
  });
});

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("door 1 — enrichProposalsForDisplay (proposals.list / proposals.get)", () => {
  it("spreads the class fields into the row it returns", () => {
    const src = readSrc("../routers/proposals/display.ts");
    // Source scan, not a call: the function batch-joins entities/users/facets/
    // events and cannot run without a database. What must not silently
    // disappear is the SPREAD — so that is what is pinned.
    expect(src).toContain(
      "...proposalClassFields(row.proposalType, row.targetType)"
    );
  });
});

/**
 * PROJECTION PARITY — a declared zod schema IS the contract.
 *
 * The T4 cross-door audit found ten fields that reached NO door while the
 * schemas that named them looked complete: a `z.record(...)` passthrough is not
 * coverage, and `ok(data: unknown)` severs the types that would have caught it.
 * The only mechanism that actually holds is a scan of the source itself.
 *
 * So: every OUTPUT projection in the proposal codec that names `proposalType`
 * must also name `class`. A future projection (a third view, a webhook payload)
 * that lists proposalType and forgets the class fails here instead of shipping
 * a queue no surface can triage. REQUEST/QUERY schemas are exempt — `class` is
 * derived on read and must never be accepted from a caller, least of all from
 * the agent whose proposal it classifies.
 */
describe("projection parity — every proposal OUTPUT projection names class", () => {
  const src = readSrc("../routers/hub-protocol/rest/_codecs/proposal.ts");

  /** Top-level `export const X = ...` / `export function X(...)` blocks. */
  const blocks = [...src.matchAll(/^export (?:const|function) (\w+)/gm)].map(
    (m, i, all) => {
      const start = m.index!;
      const end = i + 1 < all.length ? all[i + 1].index! : src.length;
      // Drop the NEXT export's leading doc comment, which the naive slice
      // swallows — otherwise a block inherits its neighbour's prose and the
      // scan guards schemas it never touches.
      const raw = src.slice(start, end);
      const trailingDoc = raw.indexOf("\n/**");
      return {
        name: m[1],
        body: trailingDoc === -1 ? raw : raw.slice(0, trailingDoc),
      };
    }
  );

  // Inputs the caller sends us — deliberately class-free.
  const INPUT_SUFFIXES = ["RequestSchema", "QuerySchema"];

  const projections = blocks.filter(
    (b) =>
      b.body.includes("proposalType") &&
      !INPUT_SUFFIXES.some((s) => b.name.endsWith(s))
  );

  it("finds the projections it is supposed to guard", () => {
    // A scan that matches nothing passes vacuously; assert it has teeth.
    expect(projections.map((p) => p.name).sort()).toEqual([
      "ProposalBasicSchema",
      "WireProposalSchema",
      "toProposalBasic",
      "withProposalClass",
    ]);
  });

  for (const projection of projections) {
    it(`${projection.name} names class`, () => {
      // Either inline, or via the shared `proposalClassShape` / the shared
      // `proposalClassFields` door — all three name the field exactly once.
      expect(
        /\bclass\b/.test(projection.body) ||
          projection.body.includes("proposalClassShape") ||
          projection.body.includes("proposalClassFields")
      ).toBe(true);
    });
  }
});
