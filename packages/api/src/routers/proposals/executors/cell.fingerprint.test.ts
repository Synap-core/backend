/**
 * `cell/define` approve executor — APPROVAL PER FINGERPRINT (decision Q9).
 *
 * The gate stamps a cell proposal with the fingerprint of the content its
 * approval writes, and the revise core stamps it again on every revision. A
 * payload whose fingerprint is not its stamp was changed by a path that is no
 * door: approving it would write content nobody reviewed. The executor refuses
 * it before any write; an unstamped payload (filed before fingerprints, or a
 * legacy `widget/register` one) is applied as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { withCellContentFingerprint } from "../../../services/cells/cell-content-fingerprint.js";

const h = vi.hoisted(() => ({
  defineCalls: [] as Array<Record<string, unknown>>,
  transitions: 0,
  registered: new Map<string, { execute: (a: unknown) => Promise<unknown> }>(),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    select: () => ({
      from: () => ({ where: async () => [{ status: "pending" }] }),
    }),
  },
  transitionProposal: async () => {
    h.transitions++;
  },
}));

vi.mock("../../../services/cells/define-cell.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/cells/define-cell.js")
  >()),
  defineCell: async (input: Record<string, unknown>) => {
    h.defineCalls.push(input);
    return { typeKey: "generated:my-cell", changeType: "created" };
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

async function approve(innerData: Record<string, unknown>) {
  return h.registered.get("cell/define")!.execute({
    proposal: { workspaceId: WS, data: { data: innerData } },
    userId: "u-1",
    input: { proposalId: "p-1" },
    deps: { emitProposalReviewed: () => undefined },
  });
}

const FILED = {
  name: "My Cell",
  rendererSource: "export default () => null",
};

beforeEach(() => {
  h.defineCalls.length = 0;
  h.transitions = 0;
});

describe("cell/define executor — approval per fingerprint", () => {
  it("applies a payload that holds the content it was stamped with", async () => {
    await expect(approve(withCellContentFingerprint(FILED))).resolves.toEqual({
      success: true,
    });
    expect(h.defineCalls).toHaveLength(1);
    expect(h.defineCalls[0]?.rendererSource).toBe(FILED.rendererSource);
  });

  it("REFUSES a payload whose source changed after it was stamped, and writes nothing", async () => {
    const tampered = {
      ...withCellContentFingerprint(FILED),
      rendererSource: "export default () => fetch('https://evil.example')",
    };
    await expect(approve(tampered)).rejects.toThrow(
      /no longer holds the content it was filed with/
    );
    expect(h.defineCalls).toHaveLength(0);
    expect(h.transitions).toBe(0);
  });

  it("REFUSES a payload whose mechanism changed after it was stamped", async () => {
    const tampered = {
      ...withCellContentFingerprint(FILED),
      rendererType: "iframe",
    };
    await expect(approve(tampered)).rejects.toThrow(/fingerprint/);
    expect(h.defineCalls).toHaveLength(0);
  });

  it("applies an unstamped payload (filed before fingerprints) as before", async () => {
    await approve(FILED);
    expect(h.defineCalls).toHaveLength(1);
  });
});
