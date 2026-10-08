/**
 * ONE governed act: an already-decided verb's provider calls to its OWN tools
 * are never gated a second time — while a direct provider call is.
 *
 * ── THE GAP ─────────────────────────────────────────────────────────────────
 * Inside a code skill run AS an agent, `callProvider` re-entered the capability
 * gate on the TOOL for every non-GET call, on top of the gate the verb itself
 * had already cleared. An agent granted auto-run on a verb (or a person
 * approving the verb's proposal) still got a SECOND proposal for the same act
 * — the Claude Managed Agents start verb told its user to grant the tool too.
 * The canonical rule is one decision per user-visible act.
 *
 * ── WHAT RUNS FOR REAL ──────────────────────────────────────────────────────
 * `runResolvedSkill` (the shared POST-gate runner both doors call) with
 * `SANDBOX_LOCAL=1` → the real `isolated-vm` sandbox running the skill's code
 * → the real `callProvider` bridge → the real `triggerProviderAction` → the
 * real `gateCapabilityExecution` → the real vault handler. Stubbed: rows (db),
 * the grant / rule lookups (no grant, no rule), the proposal insert (recorded),
 * the vault decrypt, and `fetch` (the provider).
 *
 * NOT covered: the IS isolate path (`executeSkillViaIS`), which forwards no
 * agent identity, so its in-skill calls are decided as the operator and never
 * reach an agent gate at all.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const h = vi.hoisted(() => {
  const SKILL_ID = "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e";
  const TOOL_ID = "c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f";
  const OTHER_TOOL_ID = "d3e4f5a6-b7c8-4d9e-8f1a-2b3c4d5e6f70";
  const SECRET_ID = "e4f5a6b7-c8d9-4e0f-9a2b-3c4d5e6f7081";
  const tool = (id: string, name: string, approved = true) => ({
    id,
    name,
    kind: "external",
    approved,
    createdBy: "owner-1",
    credentialRef: `vault://${SECRET_ID}`,
    authBinding: "static",
    workspaceId: null,
    config: {
      baseUrl: "https://api.vendor.test",
      auth: { in: "header", name: "x-api-key", prefix: "" },
    },
    metadata: {},
  });
  return {
    SKILL_ID,
    TOOL_ID,
    OTHER_TOOL_ID,
    SECRET_ID,
    tools: [
      tool(TOOL_ID, "vendor_api"),
      tool(OTHER_TOOL_ID, "other_api"),
    ] as Array<ReturnType<typeof tool>>,
    requiresLinks: [] as Array<{ toolId: string }>,
    skillRow: null as Record<string, unknown> | null,
    proposals: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>,
    findGrant: vi.fn(),
    resolveRule: vi.fn(),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const schema = await import("@synap/database/schema");
  const select = () => {
    let table: unknown;
    const rows = (): unknown[] =>
      table === schema.links
        ? h.requiresLinks
        : table === schema.tools
          ? h.tools
          : [];
    const chain = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      where: (cond: unknown) => {
        // The tool lookup is by NAME: honour it so a call to `other_api`
        // resolves `other_api`, not the first row.
        if (table === schema.tools) {
          // Collect the bound string params of the drizzle condition (a
          // cyclic object graph — walked with a seen-set, never stringified).
          const strings = new Set<string>();
          const seen = new WeakSet<object>();
          const walk = (v: unknown, depth: number): void => {
            if (typeof v === "string") strings.add(v);
            if (!v || typeof v !== "object" || depth > 8 || seen.has(v)) return;
            seen.add(v);
            for (const x of Object.values(v as Record<string, unknown>))
              walk(x, depth + 1);
          };
          walk(cond, 0);
          const hit = h.tools.filter((t) => strings.has(t.name));
          const filtered = {
            ...chain,
            limit: async () => hit,
            then: (r: (v: unknown) => unknown) => r(hit),
          };
          return filtered;
        }
        return chain;
      },
      innerJoin: () => chain,
      orderBy: () => chain,
      limit: async () => rows(),
      then: (r: (v: unknown) => unknown) => r(rows()),
    };
    return chain;
  };
  const update = () => {
    const c = { set: () => c, where: async () => undefined };
    return c;
  };
  return {
    ...actual,
    getDb: async () => ({}),
    findCapabilityGrant: (...a: unknown[]) => h.findGrant(...a),
    resolveCapabilityGrant: async () => ({ ok: true }),
    db: {
      select,
      update,
      query: {
        skills: { findFirst: async () => h.skillRow },
        secrets: {
          findFirst: async () => ({
            userId: "owner-1",
            providerIntegrationId: null,
            accountHint: null,
            isPodWide: false,
          }),
        },
      },
    },
  };
});
vi.mock("@synap/database/agent-governance", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveGovernanceRule: (...a: unknown[]) => h.resolveRule(...a),
    resolveOriginTrust: async () => undefined,
  };
});
vi.mock("../../utils/vault-resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/vault-resolver.js")>();
  return { ...actual, resolveVaultSecret: async () => "sk-vendor-KEY" };
});
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: Record<string, unknown>) => {
    h.proposals.push(input);
    return { id: `prop-${h.proposals.length}` };
  },
}));
vi.mock("../../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: async (input: Record<string, unknown>) => {
    h.audits.push(input);
  },
}));
vi.mock("../../routers/hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHubProtocolCallerContext: async () => ({ userId: "owner-1" }),
}));
vi.mock("../capabilities/capability-registry.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  containerMemberKey: (kind: string, id: string) => `${kind}:${id}`,
  loadContainerRefs: async () => new Map(),
}));
vi.mock("../links/links-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCapabilityMemberParts: async () => [],
}));

const { runResolvedSkill } =
  await import("../capabilities/execute-capability.js");
const { triggerProviderAction } =
  await import("../../connectors/external-dispatch.js");

const fetchCalls: string[] = [];
const SKILL = {
  id: h.SKILL_ID,
  name: "vendor_start",
  kind: "code",
  providerSpec: null,
};
const codeCalling = (toolName: string) =>
  `const r = await callProvider('${toolName}', 'POST', '/v1/things', { a: 1 });\n` +
  `return r;`;
const asAgent = {
  userId: "owner-1",
  workspaceId: null,
  agentUserId: "agent-1",
};

let prevSandbox: string | undefined;
beforeAll(() => {
  prevSandbox = process.env.SANDBOX_LOCAL;
  process.env.SANDBOX_LOCAL = "1";
});
afterAll(() => {
  if (prevSandbox === undefined) delete process.env.SANDBOX_LOCAL;
  else process.env.SANDBOX_LOCAL = prevSandbox;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  h.proposals.length = 0;
  h.audits.length = 0;
  fetchCalls.length = 0;
  h.requiresLinks = [{ toolId: h.TOOL_ID }];
  h.tools.forEach((t) => (t.approved = true));
  h.findGrant.mockReset().mockResolvedValue({ ok: false });
  h.resolveRule.mockReset().mockResolvedValue(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify({ id: "thing-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
});

const runSkill = (code: string) => {
  h.skillRow = {
    id: h.SKILL_ID,
    name: "vendor_start",
    kind: "code",
    status: "active",
    approved: true,
    code,
    timeoutSeconds: 10,
    metadata: {},
  };
  return runResolvedSkill(SKILL as never, {}, asAgent);
};

describe("an already-decided verb's provider calls are ONE act", () => {
  it("a write to the verb's OWN required tool runs — no second proposal", async () => {
    const out = await runSkill(codeCalling("vendor_api"));
    expect(out.kind, JSON.stringify(out)).toBe("run");
    expect(
      h.proposals,
      "the verb's own provider call filed a second proposal"
    ).toEqual([]);
    expect(fetchCalls).toEqual(["https://api.vendor.test/v1/things"]);
    expect((out as { result: { status: number } }).result.status).toBe(200);
    // The provider audit names the verb the call was part of, and the agent.
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      agentUserId: "agent-1",
      data: { tool: "vendor_api", viaVerbSkillId: h.SKILL_ID },
    });
  });

  it("a write to a tool the verb does NOT declare is still gated (a proposal, nothing sent)", async () => {
    const out = await runSkill(codeCalling("other_api"));
    expect(out.kind).toBe("run");
    expect((out as { result: { proposed?: boolean } }).result.proposed).toBe(
      true
    );
    expect(h.proposals).toHaveLength(1);
    expect(h.proposals[0]).toMatchObject({
      targetId: h.OTHER_TOOL_ID,
      agentUserId: "agent-1",
    });
    expect(fetchCalls).toEqual([]);
  });

  it("an UNAPPROVED required tool keeps its enable floor — refused, nothing sent", async () => {
    h.tools[0]!.approved = false;
    const out = await runSkill(codeCalling("vendor_api"));
    expect(out.kind).toBe("error");
    expect((out as { message: string }).message).toMatch(/Nothing ran/);
    expect(fetchCalls).toEqual([]);
  });
});

describe("a DIRECT provider call (no verb decision) is still gated", () => {
  it("the tool-execute shape, as an agent with no grant → a proposal, nothing sent", async () => {
    const out = await triggerProviderAction({
      userId: "owner-1",
      provider: "vendor_api",
      method: "POST",
      path: "/v1/things",
      body: { a: 1 },
      agentUserId: "agent-1",
    });
    expect(out.proposed).toBe(true);
    expect(h.proposals).toHaveLength(1);
    expect(fetchCalls).toEqual([]);
  });
});
