/**
 * Approval is the HUMAN step — every proposal-approve door refuses an AGENT
 * CALLER, by the one existing definition `isAgentCaller`
 * (`services/library/agent-door.ts`): an agent key (`agentUserId`) OR the
 * Intelligence Service's internal key (`keyType: "is_internal"`).
 *
 * The defect: the proposal doors floored on `agentUserId` alone. The IS key is
 * remapped to its OPERATOR (`userId` = the human) and — on the D4 delegation
 * path, and the legacy path with a "system"-owned key — carries NO
 * `agentUserId`, plus an explicit full-access `*` grant. So
 * `rejectAgentReviewer` let it through, `assertMayDecideProposal` let it
 * through (`*` names every verb), and the review ladder read a human: the IS
 * could approve (or revert) any proposal its operator could. The skill / tool
 * approve doors already refuse it (`rejectAgentApprover`, 0b6c09ba7).
 *
 * Layers, each tried on its own:
 *  - Hub REST `POST /proposals/:id/approve` and `/revert` (`rejectAgentReviewer`)
 *    and `POST /import/apply` WITH a `proposalId` (applying an import proposal
 *    IS approving it) refuse BEFORE any row is read;
 *  - the canonical floor `refuseAgentProposalApprover` — at the tRPC
 *    `proposals.approve` / `batchApprove` entry and inside
 *    `applyProposalApproval` (the ONE door behind both plus the import apply) —
 *    refuses an agent from ctx, from the server-side acting-agent ALS, or an
 *    `is_internal` ctx.
 *
 * The database is a probe: a refused request provably never read a row.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reached } = vi.hoisted(() => ({ reached: vi.fn() }));

const probe = (name: string): unknown =>
  new Proxy(() => undefined, {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      reached(`${name}.${String(prop)}`);
      throw new Error(`reached ${name}.${String(prop)}`);
    },
    apply: () => {
      reached(name);
      throw new Error(`reached ${name}()`);
    },
  });

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: probe("db"), getDb: probe("getDb") };
});
// The tRPC read-only-pod guard reads pod state; not what is under test.
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));
vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHubProtocolCallerContext: probe("createHubProtocolCallerContext"),
}));

const { runWithActingAgent } = await import("@synap/database");
const { registerProposalsRoutes } = await import("./proposals.js");
const { registerCaptureRoutes } = await import("./capture.js");
const { proposalsRouter } = await import("../../proposals.js");
const { applyProposalApproval } =
  await import("../../proposals/apply-approval.js");
import type { HubHono, HubVariables } from "./_shared.js";

const ID = "00000000-0000-4000-8000-000000000001";
const HUMAN = "human-1";
const AGENT = "agent-1";

type Who = { agentUserId?: string; keyType?: string };

function app(who: Who): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", HUMAN);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (who.agentUserId) c.set("agentUserId", who.agentUserId);
    if (who.keyType) c.set("keyType", who.keyType as never);
    await next();
  });
  registerProposalsRoutes(a);
  registerCaptureRoutes(a);
  return a;
}

const post = async (who: Who, path: string, body: unknown = {}) =>
  await app(who).request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const DOORS = [
  { door: "approve", path: `/proposals/${ID}/approve`, body: {} },
  { door: "revert", path: `/proposals/${ID}/revert`, body: {} },
  {
    door: "import/apply (proposalId)",
    path: `/import/apply`,
    body: { userId: HUMAN, source: "markdown", proposalId: ID },
  },
] as const;

const AGENT_CALLERS = [
  { who: "an agent key", caller: { agentUserId: AGENT } },
  { who: "the IS internal key", caller: { keyType: "is_internal" } },
] as const;

beforeEach(() => reached.mockClear());

describe("Hub REST proposal-approve doors refuse an agent caller", () => {
  for (const d of DOORS) {
    it.each(AGENT_CALLERS)(
      `${d.door}: $who → 403, nothing read`,
      async ({ caller }) => {
        const res = await post(caller, d.path, d.body);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string };
        // The CLI recognises the refusal by these words
        // (synap-cli credential-class.ts isAgentReviewRejection).
        expect(body.error).toMatch(/agent credential/i);
        expect(body.error).toMatch(/proposal/i);
        expect(reached).not.toHaveBeenCalled();
      }
    );

    it(`${d.door}: CONTROL — a human passes the door (reaches a read)`, async () => {
      const res = await post({}, d.path, d.body);
      expect(res.status).not.toBe(403);
      expect(reached).toHaveBeenCalled();
    });
  }

  it("import/apply WITHOUT a proposalId is not an approval — an agent is not refused at the door", async () => {
    const res = await post({ keyType: "is_internal" }, `/import/apply`, {
      userId: HUMAN,
      source: "markdown",
      operations: [{ type: "entity", title: "x" }],
    });
    expect(res.status).not.toBe(403);
    // Not vacuous: the request got past validation and the door to a read.
    expect(reached).toHaveBeenCalled();
  });
});

describe("the canonical approve floor refuses an agent caller", () => {
  const callerFor = (ctx: Record<string, unknown>) =>
    proposalsRouter.createCaller({
      authenticated: true,
      userId: HUMAN,
      ...ctx,
    } as never);

  it.each([
    { who: "ctx.agentUserId", ctx: { agentUserId: AGENT } },
    { who: "an is_internal ctx", ctx: { keyType: "is_internal" } },
  ])("proposals.approve with $who → FORBIDDEN, nothing read", async (t) => {
    await expect(
      callerFor(t.ctx).approve({ proposalId: ID })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(reached).not.toHaveBeenCalled();
  });

  it("proposals.approve under an acting agent (ALS) → FORBIDDEN, nothing read", async () => {
    await expect(
      runWithActingAgent(AGENT, () => callerFor({}).approve({ proposalId: ID }))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(reached).not.toHaveBeenCalled();
  });

  it("proposals.batchApprove with an is_internal ctx → each item FORBIDDEN, nothing read", async () => {
    const res = (await callerFor({ keyType: "is_internal" }).batchApprove({
      proposalIds: [ID],
    })) as { results: Array<Record<string, unknown>> };
    expect(res.results[0]).toMatchObject({
      success: false,
      errorCode: "FORBIDDEN",
    });
    expect(reached).not.toHaveBeenCalled();
  });

  it("CONTROL — a human reaches the proposal read", async () => {
    await expect(callerFor({}).approve({ proposalId: ID })).rejects.toThrow(
      /reached db/
    );
    expect(reached).toHaveBeenCalled();
  });

  it.each([
    { who: "an is_internal ctx", ctx: { keyType: "is_internal" }, als: false },
    { who: "an acting agent (ALS)", ctx: {}, als: true },
  ])(
    "applyProposalApproval (the one door behind approve/batch/import) with $who → FORBIDDEN before anything runs",
    async (t) => {
      const run = () =>
        applyProposalApproval({
          proposal: { id: ID, status: "pending", data: {} } as never,
          userId: HUMAN,
          input: { proposalId: ID },
          ctx: { authenticated: true, userId: HUMAN, ...t.ctx } as never,
        });
      await expect(
        t.als ? runWithActingAgent(AGENT, run) : run()
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(reached).not.toHaveBeenCalled();
    }
  );
});
