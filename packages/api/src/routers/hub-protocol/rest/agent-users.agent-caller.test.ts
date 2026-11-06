/**
 * Hub Protocol REST — an AGENT key may not mint agent keys or widen agent
 * governance (2026-10-06 centralisation audit).
 *
 * THE DEFECT. For an agent key, the hub auth middleware sets `userId` to the
 * linked HUMAN (`resolveKeyIdentity`) and `agentUserId` to the agent. Both
 * doors below authorised on `userId` alone:
 *  - POST /agent-users → `createNamedAgent({ createdByUserId: human })` returns
 *    the human's EXISTING agent of that type with a fresh key, so any agent
 *    could obtain a key AS any sibling agent (e.g. a trusted claude-code) and
 *    inherit its rules, trust and cap.
 *  - PATCH /agent-users/:id/governance → the "creator or pod admin" check passes
 *    as the human, so an agent could write its own auto-approve rules.
 *
 * WHAT IS ASSERTED: refusals write nothing (no mint, no rule sync, no posture
 * write); the legitimate callers still work — a human session mints and sets
 * governance.
 *
 * GOVERNANCE IS A PERSON'S ACT (audit 2026-10-28 F2). The door used to let an
 * agent "tighten". It was not tightening: `posture: null`, a different posture
 * and `autoApproveFor: []` each REVOKE the stored `propose` rows, so an
 * ask-first agent could switch itself (or a sibling agent of the same person)
 * back to the pod default and write unreviewed. Every body shape from an
 * agent credential (agent key or IS internal key) is now refused before any
 * read; the posture names are DERIVED from @synap/governance-policy so a new
 * posture is covered without editing this file. `synap init` / `synap
 * connect` set governance with the person's key (synap-cli targets.ts
 * `ensureAgentGovernance(cfg, …)`), so they are unaffected.
 *
 * NOT COVERED: the posture engine itself (postures never auto-approve past the
 * floors) — pinned in @synap/governance-policy postures tests.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  agentRow: null as Record<string, unknown> | null,
  updates: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = () => ({
    from: () => ({
      where: () => ({ limit: async () => (h.agentRow ? [h.agentRow] : []) }),
    }),
  });
  return {
    ...actual,
    db: {
      select: vi.fn(chain),
      update: vi.fn(() => {
        h.updates++;
        return { set: () => ({ where: async () => [] }) };
      }),
    },
  };
});

vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  syncAutoApproveRules: vi.fn(async () => undefined),
  applyAgentPosture: vi.fn(async () => ({ posture: "create-with-undo" })),
  readAgentGovernance: vi.fn(async () => null),
  readEffectiveAgentWriteMode: vi.fn(async () => null),
}));

vi.mock(
  "../../../services/agent-identity-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/agent-identity-service.js")
    >()),
    createNamedAgent: vi.fn(async () => ({
      agentUserId: AGENT,
      email: "a@synap.agent",
      apiKey: "synap_hub_test_x",
    })),
  })
);

// The proof-of-presence gate (review of 6 Nov: these doors are the Hub twins
// of agentUsers.create / agentUsers.setPosture). The gate itself is real on
// PGlite in services/presence/presence.pglite.test.ts; here it is a spy.
const presence = vi.hoisted(() => ({
  pass: { action: "agentUsers.create", userId: "h", proved: true },
  gate: vi.fn(),
}));
vi.mock("../../../services/presence/gate.js", () => ({
  passPresenceForAction: (args: unknown) => presence.gate(args),
}));

vi.mock("../../../utils/workspace-role.js", () => ({
  isPodAdmin: vi.fn(async () => false),
}));

// Whether the target is an APP's agent (PB4) is read for real on PGlite in
// services/pod-app.connections.pglite.test.ts; here it is a flag.
const appAgent = vi.hoisted(() => ({ is: false }));
vi.mock("../../../services/app-agent-floor.js", () => ({
  appAgentGovernanceDenial: async (
    _target: string,
    caller: { agentUserId?: string | null }
  ) =>
    caller.agentUserId && appAgent.is
      ? "An app's changes are governed by its owner"
      : null,
}));

import { AGENT_POSTURE_NAMES } from "@synap/governance-policy/postures";
import { db } from "@synap/database";
import { registerAgentUsersRoutes } from "./agent-users.js";
import { createNamedAgent } from "../../../services/agent-identity-service.js";
import {
  applyAgentPosture,
  readAgentGovernance,
  readEffectiveAgentWriteMode,
  syncAutoApproveRules,
} from "@synap/database/agent-governance";
import { AGENT_WRITE_MODE_CHOICES } from "@synap-core/types/agents";
import type { HubHono, HubVariables } from "./_shared.js";

const SIBLING = "33333333-3333-4333-8333-333333333333";

/** `true` = an agent key; `"is"` = the IS internal key (no agentUserId). */
function buildApp(asAgent: boolean | "is", asKey = false): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    c.set("userId", HUMAN);
    if (asKey) c.set("apiKeyId", "key-1");
    if (asAgent === true) c.set("agentUserId", AGENT);
    if (asAgent === "is") c.set("keyType", "is_internal");
    await next();
  });
  registerAgentUsersRoutes(app);
  return app;
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  presence.gate.mockResolvedValue({ verdict: null, pass: presence.pass });
  appAgent.is = false;
  h.updates = 0;
  h.agentRow = {
    id: AGENT,
    agentMetadata: { writesRequireProposal: true },
    createdByUserId: HUMAN,
  };
});

describe("POST /agent-users", () => {
  it("refuses an agent key and mints nothing", async () => {
    const res = await buildApp(true).request(
      "/agent-users",
      json("POST", { name: "x", agentType: "claude-code" })
    );
    expect(res.status).toBe(403);
    expect(vi.mocked(createNamedAgent)).not.toHaveBeenCalled();
  });

  it("still mints for a human caller", async () => {
    const res = await buildApp(false).request(
      "/agent-users",
      json("POST", { name: "Terminal agent", agentType: "claude" })
    );
    expect(res.status).toBe(201);
    expect(vi.mocked(createNamedAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByUserId: HUMAN,
        presence: presence.pass,
      })
    );
  });

  it("GUARDRAIL: asks the gate for agentUsers.create, bound to this body", async () => {
    await buildApp(false).request(
      "/agent-users",
      json("POST", { name: "Terminal agent", agentType: "claude" })
    );
    expect(presence.gate).toHaveBeenCalledWith({
      userId: HUMAN,
      path: "agentUsers.create",
      input: { name: "Terminal agent", agentType: "claude" },
      proof: null,
      keyCaller: false,
      door: "POST /agent-users",
    });
  });

  it("GUARDRAIL: a refusal from the gate mints nothing, and carries its code", async () => {
    presence.gate.mockRejectedValueOnce(refusedNoProof());
    const res = await buildApp(false, true).request(
      "/agent-users",
      json("POST", { name: "Terminal agent", agentType: "claude" })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "PRESENCE_REQUIRED" });
    expect(vi.mocked(createNamedAgent)).not.toHaveBeenCalled();
    expect(presence.gate).toHaveBeenCalledWith(
      expect.objectContaining({ keyCaller: true })
    );
  });

  it("a malformed proof is a bad request, and the gate is never asked", async () => {
    const res = await buildApp(false).request(
      "/agent-users",
      json("POST", { name: "x", agentType: "claude", presence: { kind: "no" } })
    );
    expect(res.status).toBe(400);
    expect(presence.gate).not.toHaveBeenCalled();
    expect(vi.mocked(createNamedAgent)).not.toHaveBeenCalled();
  });
});

/** What the gate throws under `enforce` with no proof. */
function refusedNoProof(): Error {
  return Object.assign(new Error("This needs the person, not a key."), {
    code: "FORBIDDEN",
    cause: { reasonCode: "PRESENCE_REQUIRED" },
  });
}

describe("PATCH /agent-users/:id/governance", () => {
  const patch = (
    asAgent: boolean | "is",
    body: unknown,
    target: string = AGENT
  ) =>
    buildApp(asAgent).request(
      `/agent-users/${target}/governance`,
      json("PATCH", body)
    );

  // Every body the door accepts from a person. Posture names come from the
  // policy package, never a hand list.
  const BODIES: Array<[string, Record<string, unknown>]> = [
    ["clearing to the pod default (posture null)", { posture: null }],
    ...AGENT_POSTURE_NAMES.map((name): [string, Record<string, unknown>] => [
      `the named posture "${name}"`,
      { posture: name },
    ]),
    ["an empty auto-approve list", { autoApproveFor: [] }],
    ["a non-empty auto-approve list", { autoApproveFor: ["entity.create"] }],
    ["writesRequireProposal true", { writesRequireProposal: true }],
    ["writesRequireProposal false", { writesRequireProposal: false }],
  ];

  it("derives at least one posture name (the list is not empty)", () => {
    expect(AGENT_POSTURE_NAMES.length).toBeGreaterThan(0);
  });

  it.each(
    BODIES.flatMap(([label, body]) => [
      [`agent key, itself, ${label}`, true, AGENT, body] as const,
      [`agent key, a sibling agent, ${label}`, true, SIBLING, body] as const,
      [`IS internal key, ${label}`, "is", AGENT, body] as const,
    ])
  )(
    "F2: refuses %s, and reads and writes nothing",
    async (_l, asAgent, target, body) => {
      h.agentRow = { ...h.agentRow!, id: target };
      const res = await patch(asAgent, body, target);
      expect(res.status).toBe(403);
      expect(vi.mocked(applyAgentPosture)).not.toHaveBeenCalled();
      expect(vi.mocked(syncAutoApproveRules)).not.toHaveBeenCalled();
      expect(h.updates).toBe(0);
      expect(vi.mocked(db.select)).not.toHaveBeenCalled();
    }
  );

  it("the human creator still sets ask-first", async () => {
    const res = await patch(false, { posture: AGENT_POSTURE_NAMES[0] });
    expect(res.status).toBe(200);
    expect(vi.mocked(applyAgentPosture)).toHaveBeenCalled();
  });

  it("PB4: the human owner still sets an app's agent", async () => {
    appAgent.is = true;
    const res = await patch(false, { posture: null });
    expect(res.status).toBe(200);
    expect(vi.mocked(applyAgentPosture)).toHaveBeenCalled();
  });

  it("still lets the human creator widen", async () => {
    const res = await patch(false, {
      autoApproveFor: ["entity.create"],
      writesRequireProposal: false,
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(syncAutoApproveRules)).toHaveBeenCalled();
  });

  it("GUARDRAIL: asks the gate for agentUsers.setPosture, bound to this agent and body", async () => {
    await patch(false, { posture: null });
    expect(presence.gate).toHaveBeenCalledWith({
      userId: HUMAN,
      path: "agentUsers.setPosture",
      input: { posture: null, agentUserId: AGENT },
      proof: null,
      keyCaller: false,
      door: "PATCH /agent-users/:agentUserId/governance",
    });
  });

  it.each(BODIES)(
    "GUARDRAIL: a refusal from the gate writes nothing (%s)",
    async (_label, body) => {
      presence.gate.mockRejectedValueOnce(refusedNoProof());
      const res = await patch(false, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "PRESENCE_REQUIRED" });
      expect(vi.mocked(applyAgentPosture)).not.toHaveBeenCalled();
      expect(vi.mocked(syncAutoApproveRules)).not.toHaveBeenCalled();
      expect(h.updates).toBe(0);
    }
  );
});

describe("GET /agent-users/:id/governance", () => {
  it("hands a person the pod's ONE write-mode list, each with the posture to PATCH", async () => {
    vi.mocked(readAgentGovernance).mockResolvedValueOnce({
      posture: "ask-first",
      configured: true,
    } as never);
    const res = await buildApp(false).request(
      `/agent-users/${AGENT}/governance`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      posture: string;
      writeModeChoices: Array<{
        mode: string;
        label: string;
        line: string;
        recommended: boolean;
        posture: string | null;
      }>;
    };
    expect(body.posture).toBe("ask-first");
    expect(body.writeModeChoices.map((c) => c.mode)).toEqual(
      AGENT_WRITE_MODE_CHOICES.map((c) => c.mode)
    );
    expect(
      body.writeModeChoices.map((c) => [c.mode, c.posture, c.recommended])
    ).toEqual([
      ["pod-default", null, true],
      ["create-with-undo", "create-with-undo", false],
      ["ask-first", "ask-first", false],
    ]);
  });

  it("says how its writes REALLY land: the computer's mode when it is stricter", async () => {
    vi.mocked(readAgentGovernance).mockResolvedValueOnce({
      posture: null,
      configured: false,
    } as never);
    vi.mocked(readEffectiveAgentWriteMode).mockResolvedValueOnce({
      writeMode: "ask-first",
      line: "Every change asks you first.",
      decidedBy: "computer",
      computerUserId: null,
    });
    const res = await buildApp(false).request(
      `/agent-users/${AGENT}/governance`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effective: unknown };
    expect(body.effective).toMatchObject({
      writeMode: "ask-first",
      decidedBy: "computer",
    });
  });
});
