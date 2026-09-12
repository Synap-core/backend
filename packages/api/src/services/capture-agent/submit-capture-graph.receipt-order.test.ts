import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ProfileResolutionService,
  resolveGraphWorkspaceFromSlugs,
} from "@synap/database";

/**
 * P0 REGRESSION GUARD — the receipt row must EXIST before the entities that
 * name it.
 *
 * MEASURED ON THE LIVE POD (2026-09-12, container logs): every structured agent
 * create through the MCP `synap_capture` `entities[]` lane died with
 *
 *   insert or update on table "entities" violates foreign key constraint
 *   "entities_source_proposal_id_fkey"
 *
 * and was reported to the caller as a "storage layer" fault. Cause: the capture
 * auto-apply path PRE-ALLOCATES the auto_approved receipt id, puts it on the
 * composite ctx (so `entities.create` stamps it into
 * `entities.source_proposal_id`), and used to insert the `proposals` row only
 * AFTER materialization — because the row had to carry
 * `data.materialized.entityIds` for revert. `entities.source_proposal_id` has
 * been a FK to `proposals(id)` since migration 0107, so the FIRST entity insert
 * died and rolled the whole capture back.
 *
 * This test drives the REAL `submitCaptureGraph` and records CALL ORDER at three
 * seams: the receipt insert, the materializer, and the receipt update. It fails
 * on the pre-fix ordering.
 *
 * COVERAGE BOUNDARY — stated, not implied:
 *   - The materializer is stubbed, so this does NOT prove a real entity insert
 *     succeeds against Postgres (local PG is down; see the report). It proves
 *     the ORDER of the three writes and that the id the ctx carries is the id
 *     the inserted row has.
 *   - It does not cover the proposal-APPROVAL composite path
 *     (`apply-approval.ts`), which passes an already-persisted `proposal.id` and
 *     was never exposed to this defect.
 */

const calls: string[] = [];
let capturedCtx: Record<string, unknown> | undefined;
const dbUpdates: Array<Record<string, unknown>> = [];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    resolveGraphWorkspaceFromSlugs: vi.fn(),
    db: {
      ...actual.db,
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            calls.push("receipt-update");
            dbUpdates.push(values);
          },
        }),
      }),
    },
  };
});

vi.mock("@synap/database/agent-governance", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@synap/database/agent-governance")>();
  return {
    ...actual,
    resolveAgentGovernanceDecision: vi
      .fn()
      .mockResolvedValue({ decision: "execute" }),
  };
});

// Stub the two routers the composite caller reaches for, so the ctx the capture
// path builds is OBSERVABLE (a tRPC caller does not expose its ctx) and the
// heavy router modules never load.
vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: {
    createCaller: (ctx: Record<string, unknown>) => {
      capturedCtx = ctx;
      return {};
    },
  },
}));
vi.mock("../../routers/relations.js", () => ({
  relationsRouter: { createCaller: () => ({}) },
}));

const { submitCaptureGraph } = await import("./submit-capture-graph.js");

describe("submitCaptureGraph auto-apply — receipt is inserted BEFORE materialization", () => {
  beforeEach(() => {
    calls.length = 0;
    dbUpdates.length = 0;
    capturedCtx = undefined;
    vi.restoreAllMocks();
    // Pod-wide graph: `membershipRole` short-circuits to "owner", so no
    // workspace-membership DB read is needed to reach the auto-apply branch.
    vi.mocked(resolveGraphWorkspaceFromSlugs).mockResolvedValue(null);
    vi.spyOn(
      ProfileResolutionService.prototype,
      "resolveProfile"
    ).mockResolvedValue(null as never);
  });

  async function run() {
    const receiptWriter = await import("../../utils/event-backed-proposal.js");
    const materializer = await import("../../utils/materialize-composite.js");

    let insertedId: string | undefined;
    vi.spyOn(receiptWriter, "createAutoApprovedProposal").mockImplementation(
      async (input) => {
        insertedId = input.id;
        calls.push("receipt-insert");
        return {
          proposal: { id: input.id, data: input.data },
          requestedEvent: null,
          completedEvent: null,
          correlationId: "corr-1",
        } as never;
      }
    );

    vi.spyOn(materializer, "materializeCompositeGraph").mockImplementation(
      async () => {
        calls.push("materialize");
        return {
          entities: [{ ref: "p1", entityId: "entity-1", linked: false }],
          relations: [],
          relationsFailed: [],
          created: 1,
        } as never;
      }
    );

    const result = await submitCaptureGraph({
      userId: "user-1",
      agentUserId: "agent-1",
      workspaceId: null,
      entities: [
        { ref: "p1", profileSlug: "person", title: "Jane Doe", properties: {} },
      ] as never,
    } as never);

    return { result, insertedId };
  }

  it("inserts the proposals row, then materializes, then updates it with the materialized ids", async () => {
    const { result, insertedId } = await run();

    // LOAD-BEARING, not a smoke check. The receipt id is pre-allocated ONLY on
    // the auto-approve branch, so a test that fell through to the PROPOSED path
    // would stay green over the bug and prove nothing. `applied: true` is
    // unreachable from the pending path (it returns `applied: false`), so this
    // assertion is what proves the branch under test is the failing one.
    expect(result.applied).toBe(true);

    // THE ORDER. Pre-fix this read ["materialize", "receipt-insert"].
    expect(calls).toEqual(["receipt-insert", "materialize", "receipt-update"]);

    // The id the composite ctx stamps onto every created entity IS the id of
    // the row inserted first — an FK that resolves, not a dangling reference.
    expect(insertedId).toBeTruthy();
    expect(capturedCtx?.governanceProposalId).toBe(insertedId);
    expect(result.writeReceipt?.proposalId).toBe(insertedId);

    // The receipt starts honest-empty and is COMPLETED afterwards, so revert
    // reads what actually landed rather than a promise made before the fact.
    expect(dbUpdates).toHaveLength(1);
    expect(
      (dbUpdates[0]?.data as { materialized?: { entityIds?: string[] } })
        ?.materialized?.entityIds
    ).toEqual(["entity-1"]);
    // …and the update MERGES over the row's stored data rather than replacing
    // it (idempotencyKey is what a re-submit resolves through).
    expect(
      (dbUpdates[0]?.data as { idempotencyKey?: string })?.idempotencyKey
    ).toBeTruthy();
  });

  it("does not stamp an id nothing points at when the receipt insert fails", async () => {
    const receiptWriter = await import("../../utils/event-backed-proposal.js");
    const materializer = await import("../../utils/materialize-composite.js");
    vi.spyOn(receiptWriter, "createAutoApprovedProposal").mockRejectedValue(
      new Error("receipt insert exploded")
    );
    vi.spyOn(materializer, "materializeCompositeGraph").mockImplementation(
      async () => {
        calls.push("materialize");
        return {
          entities: [{ ref: "p1", entityId: "entity-1", linked: false }],
          relations: [],
          relationsFailed: [],
          created: 1,
        } as never;
      }
    );

    const result = await submitCaptureGraph({
      userId: "user-1",
      agentUserId: "agent-1",
      workspaceId: null,
      entities: [
        { ref: "p1", profileSlug: "person", title: "Jane Doe", properties: {} },
      ] as never,
    } as never);

    // The capture still lands — losing the governance JOIN is strictly better
    // than losing the write — but the ctx must carry NO proposal id, or every
    // entity insert dies on the same FK.
    expect(result.applied).toBe(true);
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.governanceProposalId).toBeUndefined();
  });
});
