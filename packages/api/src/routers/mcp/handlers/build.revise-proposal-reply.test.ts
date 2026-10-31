/**
 * synap_revise_proposal says what the revision did (30 Oct live test, item 1).
 *
 * An agent's own revision of its capture graph is decided again
 * (`redecideOwnGraphRevision`, #512) and may be APPLIED on the spot. The door
 * answered a bare `success: true` either way, so the agent believed its graph
 * still waited for a person. The reply now carries the proposal's status, one
 * plain sentence, and — when applied — the ids it created.
 *
 * The revise core is stubbed to the re-decision it returns; the handler, the
 * shared reply helper and the codec's ref → id mapping are real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ redecision: null as unknown }));

vi.mock(
  "../../../services/proposals/proposals-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    reviseProposal: async () => h.redecision,
  })
);

import { buildHandlers } from "./build.js";
import type { McpToolContext } from "./shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const PROPOSAL = "33333333-3333-4333-8333-333333333333";

async function revise() {
  const res = await buildHandlers.synap_revise_proposal!({
    toolName: "synap_revise_proposal",
    args: {
      proposalId: PROPOSAL,
      patch: { kind: "inner", fields: { operations: [] } },
    },
    userId: USER,
    apiKeyScopes: ["mcp.write"],
    agentUserId: AGENT,
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  } as McpToolContext);
  const block = res.content?.[0] as { text: string };
  return JSON.parse(block.text) as Record<string, unknown>;
}

beforeEach(() => {
  h.redecision = null;
});

describe("synap_revise_proposal reply", () => {
  it("an applied re-decision answers auto_approved, says so, and maps each ref to its id", async () => {
    h.redecision = {
      outcome: "applied",
      proposalId: PROPOSAL,
      materialized: {
        entityIds: ["ent-1"],
        byOp: { u1: { op: "create_entity", entityId: "ent-1" } },
      },
    };
    const out = await revise();
    expect(out).toMatchObject({
      success: true,
      proposalId: PROPOSAL,
      status: "auto_approved",
      materializedIds: { u1: { op: "create_entity", id: "ent-1" } },
    });
    expect(String(out.message)).toMatch(/applied/);
  });

  it("nothing re-decided: it still waits, and the reply says pending", async () => {
    const out = await revise();
    expect(out).toMatchObject({
      success: true,
      proposalId: PROPOSAL,
      status: "pending",
    });
    expect(out.materializedIds).toBeUndefined();
  });

  it("a re-decision whose apply failed answers approval_failed", async () => {
    h.redecision = { outcome: "failed", proposalId: PROPOSAL };
    const out = await revise();
    expect(out.status).toBe("approval_failed");
  });
});
