/**
 * `synap_create_workspace` granted reply — `status` is the HONEST outcome
 * (`materializeReportStatus`), never the literal "created": an idempotent
 * re-hit of the same template used to reply `status:"created"` beside
 * `materializeStatus:"reused"`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  created: true,
  verdict: { action: "create" } as Record<string, unknown>,
  verdictArgs: null as null | Record<string, unknown>,
  materialized: 0,
  materializeArgs: null as null | Record<string, unknown>,
}));

vi.mock("../../../services/workspace-creation-service.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../services/workspace-creation-service.js")
  >()),
  checkOneSpacePerDomain: async (a: Record<string, unknown>) => {
    h.verdictArgs = a;
    return h.verdict;
  },
}));

vi.mock("../../../utils/permission-check.js", async (orig) => ({
  ...(await orig<typeof import("../../../utils/permission-check.js")>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));

// The ONE template apply (layers, finisher) is pinned on PGlite by the
// contract suite, where this door runs its six scenarios.
vi.mock("../../../services/template-apply/index.js", () => ({
  applyTemplate: async (a: Record<string, unknown>) => (
    h.materialized++,
    (h.materializeArgs = a),
    {
      workspaceId: "ws-1",
      outcome: h.created ? "created" : "unchanged",
      materializeStatus: h.created ? "created" : "reused",
      dependencies: [],
      layer2: { status: "skipped" },
      finished: null,
      warning: null,
    }
  ),
}));

import { workspaceHandlers } from "./workspace.js";
import type { McpToolContext } from "./shared.js";

const create = async (definition: Record<string, unknown> = {}) => {
  const res = await workspaceHandlers.synap_create_workspace!({
    toolName: "synap_create_workspace",
    args: { name: "Brand Library", definition },
    userId: "u1",
    agentUserId: "agent-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
  } as McpToolContext);
  const block = res.content?.[0] as { text: string };
  return JSON.parse(block.text) as Record<string, unknown>;
};

beforeEach(() => {
  h.created = true;
  h.verdict = { action: "create" };
  h.verdictArgs = null;
  h.materialized = 0;
  h.materializeArgs = null;
});

describe("synap_create_workspace — reply status is the outcome", () => {
  it("a new workspace replies created", async () => {
    expect(await create()).toMatchObject({
      status: "created",
      materializeStatus: "created",
      created: true,
    });
  });

  it("an idempotent re-hit replies reused — never status created", async () => {
    h.created = false;
    expect(await create()).toMatchObject({
      status: "reused",
      materializeStatus: "reused",
      created: false,
      workspaceId: "ws-1",
    });
  });
});

describe("synap_create_workspace — one space per domain", () => {
  it("asks the verdict with the requested name — no caller kind", async () => {
    await create();
    expect(h.verdictArgs).toEqual({
      userId: "u1",
      packageSlug: undefined,
      idempotencyKey: undefined,
      workspaceName: "Brand Library",
    });
  });

  it("a refused verdict replies the typed `exists` result and materializes nothing", async () => {
    const reply = {
      status: "exists",
      workspaceId: "ws-brand",
      workspaceName: "Brand Library",
      matchedBy: "name",
      guidance: "use it — project_use_workspace + file_into_project",
    };
    h.verdict = { action: "refuse", reply };
    expect(await create()).toEqual(reply);
    expect(h.materialized).toBe(0);
  });
});

describe("synap_create_workspace — template identity (0308)", () => {
  it("a catalog definition's `_meta.slug` is threaded as the package slug and the key", async () => {
    await create({ _meta: { slug: "brand-library" } });
    expect(h.verdictArgs).toMatchObject({
      packageSlug: "brand-library",
      idempotencyKey: "brand-library",
    });
    expect(h.materializeArgs).toMatchObject({
      identity: { packageSlug: "brand-library", proposalId: "brand-library" },
    });
  });
});
