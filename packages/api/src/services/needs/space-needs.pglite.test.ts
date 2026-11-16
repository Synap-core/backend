/**
 * A SPACE'S NEEDS, on a real Postgres (PGlite), through the real services and
 * doors (0426, founder decisions D2 and D3):
 *   - the needs a space declares come from its playbooks' and automations'
 *     `need:` refs, each empty with the installed providers that declare they
 *     fill it, or filled with its provider;
 *   - `applySpaceNeedBinding` binds once per (space, need), rebinds by
 *     revoking, clears, and refuses an unknown need, a provider of another
 *     space, a provider that cannot fill it; the binding is shared by the
 *     space (another member reads it), and stays out of other spaces;
 *   - the governed door applies for a person and PROPOSES for an agent
 *     (nothing bound), and the `workspace/bind_need` executor applies that
 *     proposal as the approver;
 *   - the template-install reconcile binds a need exactly one installed
 *     provider fills, leaves a need with several for the person, and says
 *     plainly when no catalog pack fills one;
 *   - `requires` need refs become the bound provider's key, an unfilled one
 *     stays as written.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  gate: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      h.gate.push(opts);
      return opts.agentUserId
        ? {
            granted: false,
            proposalId: randomUUID(),
            proposalType: "workspace.bind_need",
            summary: "Fill need",
            reasoning: "",
            reviewPath: "/open/x",
            reviewUrl: "https://pod.example/open/x",
          }
        : { granted: true };
    },
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import {
  applySpaceNeedBinding,
  readSpaceNeedBindings,
  resolveRequiresNeeds,
  SpaceNeedBindError,
} from "./space-needs.js";
import {
  reconcileSpaceNeeds,
  workspaceNeedCoverage,
} from "./space-need-coverage.js";
import { bindSpaceNeedThroughGate } from "./space-need-door.js";
import { registerNeedsRoutes } from "../../routers/hub-protocol/rest/needs.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";
import type { ProposalExecutorArgs } from "../../routers/proposals/execution-registry.js";
import { registerWorkspaceExecutors } from "../../routers/proposals/executors/workspace.js";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";

const PERSON = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const OTHER_WS = randomUUID();
const GH = randomUUID(); // fills code-host and gate, in WS
const STRIPE = randomUUID(); // fills payments, in WS
const PADDLE = randomUUID(); // fills payments too, pod-wide
const ELSEWHERE = randomUUID(); // fills code-host, in another space
const PLAIN = randomUUID(); // fills nothing, pod-wide

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await q(`INSERT INTO workspaces (id, owner_id, name) VALUES ($1, $3, 'Builder'), ($2, $3, 'Other')`, [
    WS,
    OTHER_WS,
    PERSON,
  ]);
  const cap = (id: string, ws: string | null, name: string, key: string, fills?: string[]) =>
    q(
      `INSERT INTO capabilities (id, workspace_id, created_by, name, template_key, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [id, ws, PERSON, name, key, JSON.stringify(fills ? { fills } : {})]
    );
  await cap(GH, WS, "GitHub", "github", ["code-host", "gate"]);
  await cap(STRIPE, WS, "Stripe", "stripe", ["payments"]);
  await cap(PADDLE, null, "Paddle", "paddle", ["payments"]);
  await cap(ELSEWHERE, OTHER_WS, "GitLab", "gitlab", ["code-host"]);
  await cap(PLAIN, null, "Plain", "plain");
  await q(
    `INSERT INTO playbooks (id, workspace_id, created_by, name, goal_template, tools, requires, status)
     VALUES ($1, $2, $3, 'Ship a change', 'Ship it', $4::jsonb, $5::jsonb, 'active'),
            ($6, $2, $3, 'Archived', 'Old', $7::jsonb, '[]'::jsonb, 'archived')`,
    [
      randomUUID(),
      WS,
      PERSON,
      JSON.stringify(["get_entity", "need:code-host", "need:payments"]),
      JSON.stringify(["need:deploy-target"]),
      randomUUID(),
      JSON.stringify(["need:analytics"]),
    ]
  );
  registerWorkspaceExecutors();
}, 60_000);

describe("a space's declared needs and their state", () => {
  it("are the active processes' need refs, each empty with its candidates", async () => {
    const r = await workspaceNeedCoverage(WS);
    expect(r.needs.map((n) => n.need)).toEqual(["code-host", "payments", "deploy-target"]);
    // An archived playbook declares nothing.
    expect(r.needs.map((n) => n.need)).not.toContain("analytics");
    expect(r.empty).toEqual(["code-host", "payments", "deploy-target"]);
    const byNeed = Object.fromEntries(r.needs.map((n) => [n.need, n]));
    // A provider of another space is never a candidate.
    expect(byNeed["code-host"]!.candidates).toEqual([{ capabilityId: GH, name: "GitHub" }]);
    expect(byNeed["payments"]!.candidates.map((c) => c.name).sort()).toEqual(["Paddle", "Stripe"]);
  });
});

describe("applySpaceNeedBinding — once per space, shared, governed by its own floors", () => {
  it("binds, reads back, says unchanged, rebinds by revoking, clears", async () => {
    const first = await applySpaceNeedBinding({
      workspaceId: WS,
      need: "gate",
      providerCapabilityId: GH,
      userId: PERSON,
    });
    expect(first).toMatchObject({ status: "bound", need: "gate", providerName: "GitHub" });
    const read = await readSpaceNeedBindings(WS);
    expect(read.get("gate")).toMatchObject({ providerCapabilityId: GH, providerName: "GitHub", setBy: PERSON });
    // The binding is the SPACE's: another space reads nothing.
    expect((await readSpaceNeedBindings(OTHER_WS)).size).toBe(0);
    // An alias names the same seat.
    expect(
      await applySpaceNeedBinding({ workspaceId: WS, need: "ci", providerCapabilityId: GH, userId: PERSON })
    ).toEqual({ status: "unchanged", need: "gate", providerCapabilityId: GH });
    const cleared = await applySpaceNeedBinding({
      workspaceId: WS,
      need: "gate",
      providerCapabilityId: null,
      userId: PERSON,
    });
    expect(cleared).toMatchObject({ status: "cleared", replaced: first.status === "bound" ? first.bindingId : null });
    expect((await readSpaceNeedBindings(WS)).has("gate")).toBe(false);
    const rows = await q<{ state: string }>(
      `SELECT state FROM installation_bindings WHERE workspace_id = $1 AND need_key = 'gate' ORDER BY created_at`,
      [WS]
    );
    // History is kept: the old row is revoked, never deleted.
    expect(rows.rows.map((r) => r.state)).toEqual(["revoked"]);
  });

  it("refuses an unknown need, a provider of another space, a provider that cannot fill it", async () => {
    const attempt = (need: string, provider: string, servesIntent?: () => Promise<boolean>) =>
      applySpaceNeedBinding({
        workspaceId: WS,
        need,
        providerCapabilityId: provider,
        userId: PERSON,
        ...(servesIntent ? { servesIntent } : {}),
      });
    await expect(attempt("code-hots", GH)).rejects.toMatchObject({ code: "UNKNOWN_NEED" });
    await expect(attempt("code-host", ELSEWHERE)).rejects.toMatchObject({ code: "PROVIDER_OUTSIDE_SPACE" });
    await expect(attempt("code-host", PLAIN, async () => false)).rejects.toMatchObject({
      code: "PROVIDER_CANNOT_FILL",
    });
    await expect(attempt("code-host", randomUUID())).rejects.toBeInstanceOf(SpaceNeedBindError);
    // A provider that declares no fill but serves one of the need's intents may fill it.
    await expect(attempt("analytics", PLAIN, async () => true)).resolves.toMatchObject({ status: "bound" });
  });
});

describe("the governed door", () => {
  it("a person applies at once; an agent proposes and nothing is bound", async () => {
    const before = h.gate.length;
    const applied = await bindSpaceNeedThroughGate({
      userId: PERSON,
      workspaceId: WS,
      need: "payments",
      providerCapabilityId: STRIPE,
    });
    expect(applied).toMatchObject({ status: "applied", result: { status: "bound", providerName: "Stripe" } });
    expect(h.gate[before]).toMatchObject({ subjectType: "workspace", action: "bind_need", workspaceId: WS });

    const proposed = await bindSpaceNeedThroughGate({
      userId: PERSON,
      agentUserId: AGENT,
      workspaceId: WS,
      need: "payments",
      providerCapabilityId: PADDLE,
    });
    expect(proposed.status).toBe("proposed");
    expect((await readSpaceNeedBindings(WS)).get("payments")?.providerCapabilityId).toBe(STRIPE);
  });

  it("Hub PUT answers 202 for an agent and 200 applied for a person", async () => {
    const app = (agent?: string) => {
      const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
      a.use("*", async (c, next) => {
        c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
        c.set("userId", PERSON);
        if (agent) c.set("agentUserId", agent);
        await next();
      });
      registerNeedsRoutes(a);
      return a;
    };
    const put = (a: HubHono, need: string, providerCapabilityId: string | null) =>
      a.request(`/workspaces/${WS}/needs/${need}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerCapabilityId }),
      });
    const viaAgent = await put(app(AGENT), "code-host", GH);
    expect(viaAgent.status).toBe(202);
    expect(await viaAgent.json()).toMatchObject({ status: "proposed", reviewUrl: expect.any(String) });
    expect((await readSpaceNeedBindings(WS)).has("code-host")).toBe(false);

    const viaPerson = await put(app(), "code-host", GH);
    expect(viaPerson.status).toBe(200);
    expect(await viaPerson.json()).toMatchObject({ status: "applied", result: { status: "bound" } });
    expect((await put(app(), "nope", GH)).status).toBe(400);
    expect((await put(app(), "code-host", ELSEWHERE)).status).toBe(400);
  });

  it("the workspace/bind_need executor applies an approved proposal as the approver", async () => {
    const proposalId = randomUUID();
    const data = { need: "deploy-target", providerCapabilityId: PLAIN };
    await q(
      `INSERT INTO proposals (id, target_type, target_id, proposal_type, data, status, revision_history, workspace_id, created_at, updated_at)
       VALUES ($1, 'workspace', $2, 'bind_need', $3::jsonb, 'pending', '[]'::jsonb, $2, now(), now())`,
      [proposalId, WS, JSON.stringify({ data })]
    );
    const executor = proposalExecRegistry.resolve("workspace/bind_need", "bind_need");
    expect(executor, "workspace/bind_need executor").toBeDefined();
    // PLAIN declares no fill: the executor asks the registry whether it serves
    // one of the need's intents. It does not, so the approval is refused.
    await expect(
      executor!.execute(execArgs(proposalId, data))
    ).rejects.toThrow(/cannot fill the need "Deploy target"/);
    expect((await readSpaceNeedBindings(WS)).has("deploy-target")).toBe(false);

    const ok = { need: "gate", providerCapabilityId: GH };
    await q(`UPDATE proposals SET data = $2::jsonb WHERE id = $1`, [proposalId, JSON.stringify({ data: ok })]);
    await executor!.execute(execArgs(proposalId, ok));
    expect((await readSpaceNeedBindings(WS)).get("gate")?.setBy).toBe(PERSON);
    const status = await q<{ status: string }>(`SELECT status FROM proposals WHERE id = $1`, [proposalId]);
    expect(status.rows[0]!.status).toBe("approved");
  });
});

function execArgs(proposalId: string, data: Record<string, unknown>): ProposalExecutorArgs {
  return {
    proposal: {
      id: proposalId,
      targetType: "workspace",
      targetId: WS,
      proposalType: "bind_need",
      workspaceId: WS,
      sessionId: null,
      projectId: null,
      agentUserId: AGENT,
      sourceMessageId: null,
      data: { data },
    },
    payload: data,
    userId: PERSON,
    input: { proposalId },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps: {
      db: null,
      emitProposalReviewed: () => {},
      reportProposalOutcome: () => {},
      stampProjectMembership: async () => {},
      resolveMessagingAccountForPlatform: async () => null,
    },
  } as unknown as ProposalExecutorArgs;
}

describe("the template-install reconcile and requires", () => {
  it("leaves filled needs, binds the one candidate, leaves a choice, says when none exists", async () => {
    // Start from a space whose code-host is empty again and payments has two candidates.
    await applySpaceNeedBinding({ workspaceId: WS, need: "code-host", providerCapabilityId: null, userId: PERSON });
    await applySpaceNeedBinding({ workspaceId: WS, need: "payments", providerCapabilityId: null, userId: PERSON });
    const report = await reconcileSpaceNeeds({ workspaceId: WS, userId: PERSON });
    const step = (need: string) => report.steps.find((s) => s.need === need);
    expect(step("code-host")).toMatchObject({ action: "bound", providerCapabilityId: GH });
    expect(step("payments")).toMatchObject({ action: "choose" });
    // No catalog pack fills deploy-target (the cache is empty): said plainly.
    expect(step("deploy-target")?.action).toMatch(/no_provider|failed/);
    expect((await readSpaceNeedBindings(WS)).get("code-host")?.providerCapabilityId).toBe(GH);
  });

  it("a requires need becomes the bound provider's key; an unfilled one stays as written", async () => {
    expect(
      await resolveRequiresNeeds(["media-ffmpeg", "need:code-host", "need:deploy-target"], WS)
    ).toEqual(["media-ffmpeg", "github", "need:deploy-target"]);
    expect(await resolveRequiresNeeds(["need:code-host"], null)).toEqual(["need:code-host"]);
  });
});
