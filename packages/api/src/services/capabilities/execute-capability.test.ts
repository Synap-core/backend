import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the two external execution tiers so we can assert WHICH one the shared
// post-gate runner dispatches to per skill kind. TIER 0 (builtin) is asserted via
// the real BUILTIN_VERBS registry.
vi.mock("./execute-provider-verb.js", () => ({
  executeProviderVerb: vi.fn(async () => ({ ran: "provider" })),
}));
// executeSkillViaIS ALWAYS returns the SkillExecutionResult envelope
// `{success, result?, error?}` — the runner UNWRAPS `.result` on success.
vi.mock("../skills/execute-skill-via-is.js", () => ({
  executeSkillViaIS: vi.fn(async () => ({
    success: true,
    result: { ran: "is" },
  })),
}));
// Partial-mock the DB package so the stale-target preflight is deterministic and
// DB-free: only getWorkspaceMembership is overridden; everything else stays real.
vi.mock("@synap/database", async (importActual) => {
  const actual = await importActual<typeof import("@synap/database")>();
  return { ...actual, getWorkspaceMembership: vi.fn() };
});

import {
  runResolvedSkill,
  capabilityVerbHasExternalEffect,
  assertApprovalTargetResolves,
  type ResolvedSkillRow,
} from "./execute-capability.js";
import { BUILTIN_VERBS } from "./builtin-verbs.js";
import { executeProviderVerb } from "./execute-provider-verb.js";
import { executeSkillViaIS } from "../skills/execute-skill-via-is.js";
import { getWorkspaceMembership } from "@synap/database";

const ctx = { userId: "u1", workspaceId: null };

function row(overrides: Partial<ResolvedSkillRow>): ResolvedSkillRow {
  return {
    id: "s1",
    name: "verb",
    kind: "code",
    providerSpec: null,
    ...overrides,
  };
}

describe("runResolvedSkill — the single post-gate kind-branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(BUILTIN_VERBS)) delete BUILTIN_VERBS[k];
  });

  it("TIER 0: builtin with a registered handler runs it in-process (no IS, no provider)", async () => {
    const handler = vi.fn(async () => ({ ran: "builtin" }));
    BUILTIN_VERBS["channel.create"] = handler;
    const out = await runResolvedSkill(
      row({ kind: "builtin", name: "channel.create" }),
      { a: 1 },
      ctx
    );
    expect(out).toEqual({
      kind: "run",
      skillId: "s1",
      result: { ran: "builtin" },
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(executeProviderVerb).not.toHaveBeenCalled();
    expect(executeSkillViaIS).not.toHaveBeenCalled();
  });

  it("TIER 0: builtin with NO registered handler returns not_found (never falls through to the IS)", async () => {
    const out = await runResolvedSkill(
      row({ kind: "builtin", name: "unknown.verb" }),
      {},
      ctx
    );
    expect(out.kind).toBe("not_found");
    expect(executeSkillViaIS).not.toHaveBeenCalled();
    expect(executeProviderVerb).not.toHaveBeenCalled();
  });

  it("TIER 1: declarative WITH providerSpec routes to executeProviderVerb + threads connectionSelector", async () => {
    const spec = { tool: "google", method: "GET", pathTemplate: "/x" };
    const out = await runResolvedSkill(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row({ kind: "declarative", providerSpec: spec as any }),
      { q: 1 },
      { ...ctx, connectionSelector: { connectionId: "c1" } }
    );
    expect(out).toEqual({
      kind: "run",
      skillId: "s1",
      result: { ran: "provider" },
    });
    expect(executeProviderVerb).toHaveBeenCalledOnce();
    expect(executeSkillViaIS).not.toHaveBeenCalled();
    const call = vi.mocked(executeProviderVerb).mock.calls[0];
    expect(call[2]).toMatchObject({
      connectionSelector: { connectionId: "c1" },
    });
  });

  it("TIER 1: declarative WITHOUT providerSpec fails explicitly (never reaches the IS)", async () => {
    const out = await runResolvedSkill(
      row({ kind: "declarative", providerSpec: null }),
      {},
      ctx
    );
    expect(out.kind).toBe("not_found");
    expect(executeProviderVerb).not.toHaveBeenCalled();
    expect(executeSkillViaIS).not.toHaveBeenCalled();
  });

  it("TIER 2: code routes to the IS isolate", async () => {
    const out = await runResolvedSkill(row({ kind: "code" }), {}, ctx);
    expect(out).toEqual({ kind: "run", skillId: "s1", result: { ran: "is" } });
    expect(executeSkillViaIS).toHaveBeenCalledOnce();
    expect(executeProviderVerb).not.toHaveBeenCalled();
  });

  it("TIER 2: instruction also routes to the IS path", async () => {
    const out = await runResolvedSkill(row({ kind: "instruction" }), {}, ctx);
    expect(out.kind).toBe("run");
    expect(executeSkillViaIS).toHaveBeenCalledOnce();
  });
});

// TRIPWIRE: a FAILED run must surface as the dedicated `kind:"error"` channel,
// NEVER as a `kind:"run"` carrying a `success:false` envelope in `result`. This
// was the root bug — a code-skill failure rode through as data, burning the
// at-most-once claim in the approve-executor and leaking the error string into
// enrichment writes. Callers now branch on ONE failure kind.
describe('runResolvedSkill — the ONE failure channel (kind:"error")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(BUILTIN_VERBS)) delete BUILTIN_VERBS[k];
  });

  it('TIER 2: a FAILED code skill returns kind:"error" (never kind:"run" carrying success:false)', async () => {
    vi.mocked(executeSkillViaIS).mockResolvedValueOnce({
      success: false,
      error: "provider 400: not in your plan",
    });
    const out = await runResolvedSkill(row({ kind: "code" }), {}, ctx);
    expect(out).toEqual({
      kind: "error",
      message: "provider 400: not in your plan",
    });
    // The failure must NOT be laundered into a run result.
    expect(out.kind).not.toBe("run");
  });

  it('TIER 2: a code-skill PROVIDER failure carries errorClass/providerRef onto kind:"error" (P1 self-healing chip)', async () => {
    // The bug this locks: a 401 from an in-skill callProvider used to return a
    // kind:"error" with NO classification, so the capability.run executor could
    // never persist data.failure → the frontend showed a raw toast instead of a
    // "Reconnect <provider>" chip. The IS now rides errorClass/providerRef on the
    // SkillExecutionResult envelope (from HubApiError.body); this must survive the
    // mapping here, EXACTLY as the declarative branch already does.
    vi.mocked(executeSkillViaIS).mockResolvedValueOnce({
      success: false,
      error:
        "callProvider failed: Hub API error: 400 Bad Request — provider call failed (status 401)",
      errorClass: "auth",
      providerRef: "unipile",
    });
    const out = await runResolvedSkill(row({ kind: "code" }), {}, ctx);
    expect(out).toMatchObject({
      kind: "error",
      errorClass: "auth",
      providerRef: "unipile",
    });
    // Guard against a vacuous pass: the classification must be PRESENT, not just
    // "not wrong". (out is narrowed to the error member.)
    if (out.kind !== "error") throw new Error("expected kind:error");
    expect(out.errorClass).toBe("auth");
    expect(out.providerRef).toBe("unipile");
  });

  it("TIER 2: a SUCCESSFUL code skill UNWRAPS the envelope's .result", async () => {
    vi.mocked(executeSkillViaIS).mockResolvedValueOnce({
      success: true,
      result: { enriched: { name: "Acme" } },
    });
    const out = await runResolvedSkill(row({ kind: "code" }), {}, ctx);
    expect(out).toEqual({
      kind: "run",
      skillId: "s1",
      result: { enriched: { name: "Acme" } },
    });
  });

  it('TIER 1: a declarative provider ERROR envelope returns kind:"error"', async () => {
    vi.mocked(executeProviderVerb).mockResolvedValueOnce({
      success: false,
      error: "google: invalid_grant",
    });
    const spec = { tool: "google", method: "GET", pathTemplate: "/x" };
    const out = await runResolvedSkill(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row({ kind: "declarative", providerSpec: spec as any }),
      {},
      ctx
    );
    expect(out).toEqual({ kind: "error", message: "google: invalid_grant" });
  });

  it('TIER 1: a declarative PROPOSED envelope is NOT an error (stays kind:"run")', async () => {
    // An unapproved declarative WRITE comes back as a proposed envelope
    // (success:false + proposed:true) — it must flow through as a run so the
    // caller can surface the review inline, never be misread as a failure.
    const proposed = {
      success: false,
      proposed: true,
      proposalId: "p1",
    };
    vi.mocked(executeProviderVerb).mockResolvedValueOnce(proposed);
    const spec = { tool: "google", method: "POST", pathTemplate: "/x" };
    const out = await runResolvedSkill(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row({ kind: "declarative", providerSpec: spec as any }),
      {},
      ctx
    );
    expect(out).toEqual({ kind: "run", skillId: "s1", result: proposed });
  });
});

// STALE-TARGET PREFLIGHT: the ONE membership check shared by the proposal-approval
// external executors AND the inline auto-run door. A phantom / lost-membership
// workspace must short-circuit into `target_missing` (→ P1 recovery chip) BEFORE
// any at-most-once claim or provider call; pod-wide (null workspace) has nothing to
// check and passes. Runs against the real test DB (no mock — a non-existent
// (workspace,user) pair is a genuine non-membership).
describe("assertApprovalTargetResolves — stale-target preflight", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pod-wide (null workspace) always resolves — no membership read", async () => {
    expect(await assertApprovalTargetResolves(null, "u1")).toBeNull();
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
  });

  it("a workspace the user is NOT a member of → target_missing", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValueOnce(null);
    const out = await assertApprovalTargetResolves("ws-1", "u1");
    expect(out).toMatchObject({ errorClass: "target_missing" });
    expect(out?.errorClass).toBe("target_missing");
  });

  it("a workspace the user IS a member of → resolves (null), never blocks a live run", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getWorkspaceMembership).mockResolvedValueOnce({
      role: "owner",
    } as any);
    expect(await assertApprovalTargetResolves("ws-1", "u1")).toBeNull();
  });
});

// The governance mirror MUST agree with execute-provider-verb's `isReadMethod`:
// a declarative READ has no irreversible external effect (skips the at-most-once
// receipt); a WRITE does. For GraphQL that read/write notion keys off the
// OPERATION (all GraphQL is a POST), never the HTTP method.
describe("capabilityVerbHasExternalEffect — read/write classification", () => {
  const decl = (providerSpec: unknown) =>
    ({ kind: "declarative", name: "v", providerSpec }) as Pick<
      ResolvedSkillRow,
      "kind" | "name" | "providerSpec"
    >;

  it("builtin is never an external send", () => {
    expect(
      capabilityVerbHasExternalEffect({
        kind: "builtin",
        name: "feed.post",
        providerSpec: null,
      })
    ).toBe(false);
  });

  it("code may send externally → true", () => {
    expect(
      capabilityVerbHasExternalEffect({
        kind: "code",
        name: "x",
        providerSpec: null,
      })
    ).toBe(true);
  });

  it("REST GET = read (false), REST POST = write (true)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(
      capabilityVerbHasExternalEffect(decl({ method: "GET" } as any))
    ).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(
      capabilityVerbHasExternalEffect(decl({ method: "POST" } as any))
    ).toBe(true);
  });

  it("GraphQL keys off operation, NOT the (always-POST) method", () => {
    const gql = (operation?: string) => ({
      method: "POST",
      pathTemplate: "/graphql",
      transport: "graphql",
      graphql: { query: "query { x }", ...(operation ? { operation } : {}) },
    });
    // read
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(capabilityVerbHasExternalEffect(decl(gql("query") as any))).toBe(
      false
    );
    // explicit write
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(capabilityVerbHasExternalEffect(decl(gql("mutation") as any))).toBe(
      true
    );
    // default (omitted) is fail-closed → write
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(capabilityVerbHasExternalEffect(decl(gql() as any))).toBe(true);
  });
});
