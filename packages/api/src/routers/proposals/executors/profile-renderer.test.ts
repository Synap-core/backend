/**
 * `profile/renderer.set` — the approval half of the renderer binding door.
 *
 * The point of the test is LINEAGE and FORWARDING: an approved proposal must
 * reach the write door carrying the proposal's own id (so the minted
 * `renderer_bindings` row records what authorized it) and carrying the payload's
 * `scope` / `subjectId` (so the per-object GOVERNED EXCEPTION cannot be widened
 * to a kind-level binding by an executor that quietly drops the field — the
 * shape of every "forwarded but never read" severance in this codebase).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  setProfileRenderer: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../../../services/profiles/set-profile-renderer.js", () => ({
  setProfileRenderer: h.setProfileRenderer,
}));
vi.mock("../../profiles.js", () => ({
  profilesRouter: { createCaller: () => ({}) },
}));
vi.mock("./shared.js", () => ({ reportApproved: vi.fn() }));
// PARTIAL mock (importOriginal + spread) — a TOTAL replacement dies the moment
// any module in the import graph reaches for a drizzle helper this suite never
// mentions (see the database-mock-total-ratchet tripwire). Only `db` is faked;
// the real `proposals` table, `eq`, and `ProposalStatus` are used as-is.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      // The executor's idempotency probe: "already APPROVED?" → no rows.
      select: () => ({ from: () => ({ where: async () => [] }) }),
      update: () => ({ set: () => ({ where: h.update }) }),
    },
  };
});

const { registerProfileExecutors } = await import("./profile.js");
const { proposalExecRegistry } = await import("../execution-registry.js");

function runRendererExecutor(data: Record<string, unknown>) {
  const executor = proposalExecRegistry.resolve(
    "profile/renderer.set",
    "renderer.set"
  );
  if (!executor)
    throw new Error("profile/renderer.set executor not registered");
  return executor.execute({
    proposal: {
      workspaceId: "ws-1",
      data: { data },
    },
    userId: "approver-1",
    input: { proposalId: "prop-42" },
    deps: { emitProposalReviewed: vi.fn() },
  } as never);
}

const ref = { kind: "cell" as const, cellKey: "contact-card", props: {} };

beforeEach(() => {
  h.setProfileRenderer.mockReset();
  h.update.mockReset();
  proposalExecRegistry._reset();
  registerProfileExecutors();
});

describe("profile/renderer.set executor", () => {
  it("stamps the approving proposal's id as the binding's lineage", async () => {
    await runRendererExecutor({ profileSlug: "person", slot: "detail", ref });
    expect(h.setProfileRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        profileSlug: "person",
        slot: "detail",
        sourceProposalId: "prop-42",
        userId: "approver-1",
      })
    );
  });

  it("forwards a per-object binding instead of widening it to the kind", async () => {
    await runRendererExecutor({
      profileSlug: "person",
      slot: "card",
      scope: "user",
      subjectId: "entity-7",
      ref,
    });
    expect(h.setProfileRenderer).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "user", subjectId: "entity-7" })
    );
  });

  it("defaults an omitted scope to workspace and an omitted subject to the kind", async () => {
    await runRendererExecutor({ profileSlug: "person", slot: "list", ref });
    expect(h.setProfileRenderer).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "workspace", subjectId: null })
    );
  });

  it("refuses a payload missing the fields the write door needs", async () => {
    await expect(runRendererExecutor({ slot: "detail", ref })).rejects.toThrow(
      /missing profileSlug\/slot\/ref/
    );
    expect(h.setProfileRenderer).not.toHaveBeenCalled();
  });
});
