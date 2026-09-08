/**
 * `cell/define` approve executor — the typeKey the reviewer approved is the
 * typeKey the pod writes, and it is RE-VALIDATED at the reviewed scope.
 *
 * TWO defects, one change:
 *  1. The gate `data` carried name/rendererSource/workspaceId/viewTypes/
 *     contentKind but NOT `typeKey`, and this executor never read one — so an
 *     agent-supplied typeKey was silently dropped and the approved cell
 *     materialised under `generated:<slug(name)>`. Accidentally safe (the
 *     forged key never landed), contractually a drop: approve one thing, write
 *     another.
 *  2. Carrying it re-opens the forgery vector unless the floor runs again HERE:
 *     `revise` can re-target `proposals.workspaceId` after the payload was
 *     written, so a key that was editable at the original scope may be a MINT
 *     at the new one. The executor therefore re-asserts against
 *     `proposal.workspaceId` — the scope actually reviewed — never the payload.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  defineCalls: [] as Array<Record<string, unknown>>,
  /** Rows the provenance-floor lookup finds. Empty ⇒ the key would be MINTED. */
  existingRows: [] as Array<{ id: string }>,
  proposalStatus: "pending" as string,
  registered: new Map<string, { execute: (a: unknown) => Promise<unknown> }>(),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  // The executor's idempotency read (`db.select({...}).from(proposals)`, awaited
  // directly — no `.where()` chain terminator).
  db: {
    select: () => ({
      from: () => ({ where: async () => [{ status: h.proposalStatus }] }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
  // The provenance floor's existence lookup, which goes through `getDb()`.
  getDb: async () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => h.existingRows }) }),
    }),
  }),
}));

vi.mock("../../../services/cells/define-cell.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/cells/define-cell.js")
  >()),
  defineCell: async (input: Record<string, unknown>) => {
    h.defineCalls.push(input);
    return { typeKey: String(input.typeKey ?? "x"), changeType: "created" };
  },
}));

vi.mock("../execution-registry.js", () => ({
  registerProposalExecutor: (e: {
    key: string;
    execute: (a: unknown) => Promise<unknown>;
  }) => h.registered.set(e.key, e),
}));

vi.mock("./shared.js", () => ({ reportApproved: async () => undefined }));

const { registerCellExecutors } = await import("./cell.js");
registerCellExecutors();

const WS = "11111111-1111-4111-8111-111111111111";

async function approve(innerData: Record<string, unknown>, workspaceId = WS) {
  const exec = h.registered.get("cell/define")!;
  return exec.execute({
    proposal: { workspaceId, data: { data: innerData } },
    userId: "u-1",
    input: { proposalId: "p-1" },
    deps: { emitProposalReviewed: () => undefined },
  });
}

const BASE = { name: "My Cell", rendererSource: "export default () => null" };

beforeEach(() => {
  h.defineCalls.length = 0;
  h.existingRows = [];
  h.proposalStatus = "pending";
});

describe("cell/define executor — typeKey", () => {
  it("materialises the typeKey the reviewer approved, not a slug of the name", async () => {
    h.existingRows = [{ id: "row-1" }];
    await approve({ ...BASE, typeKey: "cell:acme-charts:pie" });
    expect(h.defineCalls[0]?.typeKey).toBe("cell:acme-charts:pie");
  });

  it("REFUSES to mint a namespaced key at the REVIEWED scope", async () => {
    // No existing row at `proposal.workspaceId` ⇒ approving would MINT the
    // vendor-namespaced key, forging provenance. The approval must fail loudly
    // rather than write it.
    h.existingRows = [];
    await expect(
      approve({ ...BASE, typeKey: "cell:acme-charts:pie" })
    ).rejects.toThrow(/namespaced/);
    expect(h.defineCalls).toHaveLength(0);
  });

  it("passes UNDEFINED when the proposal carried no typeKey", async () => {
    // Omit-is-silence: `defineCell` then mints `generated:<slug(name)>` exactly
    // as it always has for a door that names no key.
    await approve(BASE);
    expect(h.defineCalls).toHaveLength(1);
    expect(h.defineCalls[0]?.typeKey).toBeUndefined();
  });
});
