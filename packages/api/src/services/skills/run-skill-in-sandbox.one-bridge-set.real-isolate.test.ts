/**
 * ONE BRIDGE SET (R1): the pod sandbox does everything the IS sandbox did, so
 * the pod can become the only runtime with no regression. Ported from the IS
 * executor (`skills-executor.ts`) and its tests (`skills-executor.regression`,
 * `.session-provenance`, `.delegation`):
 *   - the parameter check before any code runs (IS `buildZodSchema`)
 *   - dry-run: writes and sends recorded, never performed (IS `recordedEffects`)
 *   - `propose.entity` `content`
 *   - the run's session on a governed provider write
 *   - `runtimeVersion` on the result
 *   - identity is the run's, never the skill's input
 *
 * Runs the REAL isolated-vm isolate, the REAL stdlib and the REAL bridges
 * through `runSkillInSandbox`. Stubbed: the skill row (db), the hub caller (a
 * recorder), `triggerProviderAction` (a recorder), the vault, `fetch`.
 *
 * SKIPPED, by name, where the native addon is not built (Node 20). It runs on
 * the devbox gate tree (Node 22).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return {
    skillRow: null as Record<string, unknown> | null,
    trigger: vi.fn(),
    createEntity: vi.fn(),
    getEntities: vi.fn(),
    findGrant: vi.fn(),
    resolveSecret: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    findRedeemableGrant: (...a: unknown[]) => h.findGrant(...a),
    resolveVaultSecret: (...a: unknown[]) => h.resolveSecret(...a),
    db: {
      query: {
        skills: { findFirst: async () => h.skillRow },
        secrets: { findFirst: async () => ({ userId: "owner-1" }) },
      },
    },
  };
});
vi.mock("../../routers/hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHubProtocolCallerContext: async () => ({}),
}));
vi.mock("../../routers/hub-protocol/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hubProtocolRouter: {
    createCaller: () => ({
      entities: {
        createEntity: (...a: unknown[]) => h.createEntity(...a),
        getEntities: (...a: unknown[]) => h.getEntities(...a),
      },
    }),
  },
}));
vi.mock("../../connectors/external-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  triggerProviderAction: (...a: unknown[]) => h.trigger(...a),
}));

const ivmLoads = await import("isolated-vm").then(
  () => true,
  () => false
);
const { runSkillInSandbox, SKILL_RUNTIME_VERSION } =
  await import("./run-skill-in-sandbox.js");

const OPERATOR = "owner-1";
const AGENT = "agent-1";
const SECRET_REF = "vault://11111111-1111-4111-8111-111111111111";

function skill(code: string, over: Record<string, unknown> = {}) {
  h.skillRow = {
    id: "skill-1",
    name: "probe",
    kind: "code",
    status: "active",
    approved: true,
    code,
    timeoutSeconds: 10,
    metadata: { allowedHosts: ["api.allowed.test"] },
    parameters: null,
    ...over,
  };
}

function run(extra: Parameters<typeof runSkillInSandbox>[0] | object = {}) {
  return runSkillInSandbox({
    skillId: "skill-1",
    userId: OPERATOR,
    workspaceId: null,
    agentUserId: AGENT,
    ...extra,
  });
}

beforeEach(() => {
  h.trigger.mockReset().mockResolvedValue({
    success: true,
    status: 201,
    headers: {},
    body: { id: "thing-1" },
  });
  h.createEntity.mockReset().mockResolvedValue({
    status: "proposed",
    proposalId: "prop-1",
    id: undefined,
    message: "queued for review",
  });
  h.getEntities.mockReset().mockResolvedValue({ entities: [{ id: "e1" }] });
  h.findGrant
    .mockReset()
    .mockResolvedValue({ ok: true, grantId: "g1", execMode: "auto" });
  h.resolveSecret.mockReset().mockResolvedValue("sk-REAL");
  h.fetch
    .mockReset()
    .mockImplementation(async () => new Response("hello", { status: 200 }));
  vi.stubGlobal("fetch", h.fetch);
});

describe.skipIf(!ivmLoads)(
  "R1 one bridge set, in the REAL isolate (skipped where the isolated-vm native addon is not built)",
  () => {
    describe("the arguments are checked against `parameters` before any code runs (IS buildZodSchema)", () => {
      const declared = { keywords: "string", limit: "number?" };
      const code = `await hubProtocol.getEntities({ limit: 1 }); return "ran";`;

      it("a missing required field: refused, the code never ran", async () => {
        skill(code, { parameters: declared });
        const out = await run({ parameters: {} });
        expect(out.success).toBe(false);
        expect(out.error).toMatch(
          /^Parameter validation failed: .*missing required keywords/
        );
        expect(h.getEntities).not.toHaveBeenCalled();
      });

      it("a wrong type: refused, the code never ran", async () => {
        skill(code, { parameters: declared });
        const out = await run({ parameters: { keywords: 123 } });
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/keywords should be string, got number/);
        expect(h.getEntities).not.toHaveBeenCalled();
      });

      it('a string-encoded number ("5", how CLI/HTTP callers send it) runs, as it did on the IS', async () => {
        skill(code, { parameters: declared });
        const out = await run({ parameters: { keywords: "x", limit: "5" } });
        expect(out.error).toBeUndefined();
        expect(out.result).toBe("ran");
      });
    });

    describe("runtimeVersion", () => {
      it("a successful run states the stdlib version it booted", async () => {
        skill(`return 1;`);
        const out = await run();
        expect(out.success).toBe(true);
        expect(SKILL_RUNTIME_VERSION).toBe(1);
        expect(out.runtimeVersion).toBe(SKILL_RUNTIME_VERSION);
      });
    });

    describe("propose.entity carries `content`", () => {
      it("the Markdown body reaches the governed createEntity door", async () => {
        skill(
          `return await propose.entity({ profileSlug: "knowledge", title: "Routes", content: "## Why\\n\\nStatic first." });`
        );
        const out = await run();
        expect(out.error).toBeUndefined();
        expect(h.createEntity).toHaveBeenCalledTimes(1);
        expect(h.createEntity.mock.calls[0]![0]).toMatchObject({
          userId: OPERATOR,
          agentUserId: AGENT,
          profileSlug: "knowledge",
          title: "Routes",
          content: "## Why\n\nStatic first.",
        });
        expect(out.result).toMatchObject({
          status: "proposed",
          proposalId: "prop-1",
        });
      });

      it("a non-string content is refused before any write", async () => {
        skill(
          `return await propose.entity({ profileSlug: "note", title: "T", content: 42 });`
        );
        const out = await run();
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/content must be a string/);
        expect(h.createEntity).not.toHaveBeenCalled();
      });
    });

    describe("dry-run: writes and sends are recorded, never performed", () => {
      const code = `
        const secret = await secrets.get("${SECRET_REF}");
        const fetched = await host.fetch("https://api.allowed.test/v1/x", { method: "POST" });
        const refused = await host.fetch("https://elsewhere.test/v1/x");
        const called = await callProvider("vendor_api", "POST", "/v1/things", { a: 1 });
        const proposed = await propose.entity({ profileSlug: "note", title: "T", content: "Body" });
        const read = await hubProtocol.getEntities({ limit: 1 });
        return { secret, fetched, refused, called, proposed, read };
      `;

      it("records every intended effect, performs none, keeps reads and guards real", async () => {
        skill(code);
        const out = await run({ dryRun: true });
        expect(out.error).toBeUndefined();
        expect(out.dryRunEffects).toEqual([
          {
            kind: "fetch",
            url: "https://api.allowed.test/v1/x",
            method: "POST",
          },
          {
            kind: "callProvider",
            provider: "vendor_api",
            method: "POST",
            path: "/v1/things",
            body: { a: 1 },
          },
          {
            kind: "propose.entity",
            profileSlug: "note",
            title: "T",
            content: "Body",
          },
        ]);
        const r = out.result as Record<string, Record<string, unknown>>;
        expect(r.secret).toBe("dry-run-secret");
        expect(r.refused).toMatchObject({ error: "domain_not_approved" });
        expect(r.called).toEqual({
          status: 200,
          headers: {},
          body: { dryRun: true },
        });
        expect(r.proposed).toEqual({
          status: "dry-run",
          proposalId: "dry:1",
          proposedEntityId: "dry:1",
        });
        // Reads are real.
        expect(r.read).toEqual({ entities: [{ id: "e1" }] });
        // Nothing was performed: no provider call, no proposal, no request,
        // no decrypt (and so no grant use spent).
        expect(h.trigger).not.toHaveBeenCalled();
        expect(h.createEntity).not.toHaveBeenCalled();
        expect(h.fetch).not.toHaveBeenCalled();
        expect(h.resolveSecret).not.toHaveBeenCalled();
        // The grant check itself ran, for the acting agent.
        expect(h.findGrant).toHaveBeenCalledWith(
          "secret",
          "11111111-1111-4111-8111-111111111111",
          { agentUserId: AGENT, workspaceId: null }
        );
      });

      it("an ungranted secret answers null in a dry-run, as it would live", async () => {
        h.findGrant.mockResolvedValue({ ok: false, code: "no_grant" });
        skill(`return await secrets.get("${SECRET_REF}");`);
        const out = await run({ dryRun: true });
        expect(out.success).toBe(true);
        expect(out.result).toBeNull();
      });

      it("the same skill LIVE performs every effect and reports no dryRunEffects (non-vacuity)", async () => {
        skill(code);
        const out = await run();
        expect(out.error).toBeUndefined();
        expect(out).not.toHaveProperty("dryRunEffects");
        expect(h.trigger).toHaveBeenCalledTimes(1);
        expect(h.createEntity).toHaveBeenCalledTimes(1);
        expect(h.fetch).toHaveBeenCalledTimes(1);
        expect(h.resolveSecret).toHaveBeenCalledTimes(1);
      });
    });

    describe("the run's session rides the governed provider write (IS session-provenance)", () => {
      it("an agent's write carries the run's sessionId", async () => {
        skill(
          `return await callProvider("vendor_api", "POST", "/v1/things", {});`
        );
        await run({ sessionId: "sess-1" });
        expect(h.trigger).toHaveBeenCalledTimes(1);
        expect(h.trigger.mock.calls[0]![0]).toMatchObject({
          agentUserId: AGENT,
          sessionId: "sess-1",
        });
      });

      it("a read carries neither the agent nor the session", async () => {
        skill(`return await callProvider("vendor_api", "GET", "/v1/things");`);
        await run({ sessionId: "sess-1" });
        const input = h.trigger.mock.calls[0]![0] as Record<string, unknown>;
        expect(input).not.toHaveProperty("agentUserId");
        expect(input).not.toHaveProperty("sessionId");
      });

      it("no session: none is synthesised", async () => {
        skill(
          `return await callProvider("vendor_api", "POST", "/v1/things", {});`
        );
        await run();
        const input = h.trigger.mock.calls[0]![0] as Record<string, unknown>;
        expect(input.agentUserId).toBe(AGENT);
        expect(input).not.toHaveProperty("sessionId");
      });
    });

    describe("identity is the run's, never the skill's input (IS delegation)", () => {
      it("propose.entity ignores a userId / agentUserId / source the skill passes", async () => {
        skill(
          `return await propose.entity({ profileSlug: "note", title: "T", userId: "evil-user", agentUserId: "evil-agent", source: "user" });`
        );
        await run();
        expect(h.createEntity.mock.calls[0]![0]).toMatchObject({
          userId: OPERATOR,
          agentUserId: AGENT,
          source: "intelligence",
        });
      });

      it("callProvider ignores an agentUserId / sessionId the skill passes in opts", async () => {
        skill(
          `return await callProvider("vendor_api", "POST", "/v1/things", {}, { agentUserId: "evil-agent", sessionId: "evil-session", userId: "evil-user" });`
        );
        await run({ sessionId: "sess-1" });
        expect(h.trigger.mock.calls[0]![0]).toMatchObject({
          userId: OPERATOR,
          agentUserId: AGENT,
          sessionId: "sess-1",
        });
      });
    });
  }
);
