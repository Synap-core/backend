/**
 * `entityDataNeighbors` — a FAILED relations read must reach the caller as a
 * failure, never as `[]` ("tied to nothing"). The web Connections section and
 * the REST `/graph` route both have to be able to say "couldn't load" instead
 * of rendering a confident empty state.
 *
 * Drives the REAL function with only its two seams mocked (the hub caller ctx
 * and the relations router), so the assertion is about what the fold does with
 * the router's answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getConnections: vi.fn(),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
  }),
}));
vi.mock("../../routers/hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: async () => ({}),
}));
vi.mock("../../routers/relations.js", () => ({
  relationsRouter: {
    createCaller: () => ({ getConnections: h.getConnections }),
  },
}));

import { entityDataNeighbors } from "./entity-data-graph.js";

beforeEach(() => {
  h.getConnections.mockReset();
});

describe("entityDataNeighbors — empty and failed are different facts", () => {
  it("a failed relations read REJECTS (it is not folded into [])", async () => {
    h.getConnections.mockRejectedValue(new Error("relations read failed"));
    await expect(
      entityDataNeighbors("u1", ["hub-protocol.read"], "e1", "w1")
    ).rejects.toThrow("relations read failed");
  });

  it("a successful read with no connections is a genuine []", async () => {
    h.getConnections.mockResolvedValue({ connections: [] });
    await expect(
      entityDataNeighbors("u1", ["hub-protocol.read"], "e1", "w1")
    ).resolves.toEqual([]);
    // Non-vacuity: the read actually ran through the router seam.
    expect(h.getConnections).toHaveBeenCalledWith({
      entityId: "e1",
      limit: 100,
      workspaceId: "w1",
    });
  });
});
