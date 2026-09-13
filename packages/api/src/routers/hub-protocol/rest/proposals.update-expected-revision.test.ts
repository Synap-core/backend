/**
 * PATCH /proposals/:id — the REST edge the IS `update_proposal` tool calls.
 *
 * Decision E: the reviser's `expectedRevision` must reach the Hub procedure (and
 * from there `mergeProposalRevision`, whose own suite proves the CONFLICT), and a
 * CONFLICT must come back as HTTP 409 so the agent can tell "the proposal changed
 * since the comment" from a server fault.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  conflict: false,
}));

vi.mock("./_shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_shared.js")>()),
  getCaller: async () => ({
    proposals: {
      updateProposal: async (input: Record<string, unknown>) => {
        h.calls.push(input);
        if (h.conflict) {
          throw new TRPCError({ code: "CONFLICT", message: "changed since" });
        }
        return { success: true, proposalId: input.proposalId };
      },
    },
  }),
  resolveProposalId: async (_u: string, id: string) => id,
}));

const { registerProposalsRoutes } = await import("./proposals.js");

const PROPOSAL = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";

function buildApp() {
  const app = new OpenAPIHono<{
    Variables: { scopes: string[]; userId: string };
  }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.write"]);
    c.set("userId", "user-1");
    await next();
  });
  registerProposalsRoutes(app as never);
  return app;
}

const patch = (body: Record<string, unknown>) =>
  buildApp().request(`/proposals/${PROPOSAL}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.calls.length = 0;
  h.conflict = false;
});

describe("PATCH /proposals/:id expectedRevision", () => {
  it("forwards expectedRevision to the Hub updateProposal procedure", async () => {
    const res = await patch({
      data: { title: "B" },
      summary: "s",
      expectedRevision: 3,
    });
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([
      {
        proposalId: PROPOSAL,
        data: { title: "B" },
        summary: "s",
        expectedRevision: 3,
      },
    ]);
  });

  it("answers 409 when the revise is refused as stale", async () => {
    h.conflict = true;
    const res = await patch({ data: { title: "B" }, expectedRevision: 1 });
    expect(res.status).toBe(409);
  });
});
