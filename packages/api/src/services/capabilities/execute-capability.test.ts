import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the two external execution tiers so we can assert WHICH one the shared
// post-gate runner dispatches to per skill kind. TIER 0 (builtin) is asserted via
// the real BUILTIN_VERBS registry.
vi.mock("./execute-provider-verb.js", () => ({
  executeProviderVerb: vi.fn(async () => ({ ran: "provider" })),
}));
vi.mock("../skills/execute-skill-via-is.js", () => ({
  executeSkillViaIS: vi.fn(async () => ({ ran: "is" })),
}));

import {
  runResolvedSkill,
  type ResolvedSkillRow,
} from "./execute-capability.js";
import { BUILTIN_VERBS } from "./builtin-verbs.js";
import { executeProviderVerb } from "./execute-provider-verb.js";
import { executeSkillViaIS } from "../skills/execute-skill-via-is.js";

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
