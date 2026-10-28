/**
 * D7 Q3 (founder, 2026-10-28) at the capture door: a decision the person made
 * in chat, captured born decided, reaches the own-organise class row only when
 * EVERY decision op of the graph carries the relay proof.
 *
 * Seam: the REAL `captureGraphMemberProposes` and floor derivation; the proof
 * (`ownWorkOrganiseForRelayedDecision`, tested on its own in
 * `own-organise-d7.test.ts`) answers from the op's properties; the resolver
 * stand-in answers like the engine with the class row ON: a terminal move
 * proposes unless the door passed `ownWorkOrganise`.
 *
 * Rows that rule out a wrong wiring:
 *  - relayed decision born `accepted` ⇒ executes, and the resolver got the
 *    claim (a door that never passes it proposes here);
 *  - the same graph with ONE unrelayed decision ⇒ proposes (a door that
 *    claims the kind on its first op only executes here);
 *  - a relayed decision born `proposed` ⇒ no claim (the class is only for a
 *    decision born decided).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    ProfileResolutionService: class {
      async resolveProfile() {
        return { id: "p-decision", defaultValues: {} };
      }
      async getEffectiveLifecycle() {
        return {
          propertySlug: "decisionStatus",
          propertyDefId: "def-1",
          declaredOnProfileId: "p-decision",
          unclassified: [],
          options: [
            { key: "proposed", category: "open" },
            { key: "accepted", category: "done" },
          ],
        };
      }
    },
  };
});
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: h.resolve,
}));
vi.mock("../governance/own-organise.js", () => ({
  ownWorkOrganiseForRelayedDecision: async (input: {
    properties?: Record<string, unknown>;
  }) => input.properties?.answeredVia === "relayed",
}));

import { captureGraphMemberProposes } from "./capture-graph-governance.js";

const decision = (ref: string, properties: Record<string, unknown>) =>
  ({
    op: "create_entity",
    ref,
    profileSlug: "decision",
    title: `Decision ${ref}`,
    properties,
  }) as never;
const relayed = { answeredVia: "relayed", decisionStatus: "accepted" };

const ask = (operations: never[]) =>
  captureGraphMemberProposes({
    agentUserId: "agent-1",
    userId: "user-1",
    workspaceId: "ws-1",
    operations,
  });

beforeEach(() => {
  h.resolve
    .mockReset()
    .mockImplementation(
      async (args: {
        lifecycleMove?: { intoTerminal: boolean };
        ownWorkOrganise?: boolean;
      }) => ({
        decision:
          args.lifecycleMove?.intoTerminal && args.ownWorkOrganise !== true
            ? "propose"
            : "execute",
      })
    );
});

describe("a relayed decision captured born decided", () => {
  it("executes through the class row: the resolver is handed the door's proof", async () => {
    expect(await ask([decision("d1", relayed)])).toBe(false);
    expect(h.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectProfileSlug: "decision",
        lifecycleMove: { intoTerminal: true, humanOnly: false },
        ownWorkOrganise: true,
      })
    );
  });

  it("one decision in the graph without the relay proof keeps the kind on its floor", async () => {
    expect(
      await ask([
        decision("d1", relayed),
        decision("d2", { decisionStatus: "accepted" }),
      ])
    ).toBe(true);
    expect(h.resolve.mock.calls[0]![0]).not.toHaveProperty("ownWorkOrganise");
  });

  it("a relayed decision born undecided carries no claim", async () => {
    expect(
      await ask([
        decision("d1", { answeredVia: "relayed", decisionStatus: "proposed" }),
      ])
    ).toBe(false);
    expect(h.resolve.mock.calls[0]![0]).not.toHaveProperty("ownWorkOrganise");
  });
});
