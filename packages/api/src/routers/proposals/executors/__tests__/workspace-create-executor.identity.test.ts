/**
 * `workspace/create` approval — template identity (0308).
 *
 * The incident (2026-10-06): `synap market update content-os` posted a
 * catalog definition with no `_meta.slug`; the approve executor fell back to
 * the PROPOSAL ROW ID as the idempotency key, matched nothing, and minted a
 * second, empty "Content OS". Pinned here, on the executor itself:
 *   - a template proposal with neither a slug nor an explicit key is REFUSED
 *     (BAD_REQUEST) before anything is materialized;
 *   - the slug is read from `packageSlug` OR the definition's `_meta.slug`, and
 *     IS the key when no explicit one was stored;
 *   - a freehand proposal (no template marker) still keys on its row id.
 *
 * `materializeWorkspaceCore` records its args then throws a sentinel, so the
 * post-materialize bookkeeping needs no stubbing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  materializeArgs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({ where: async () => [{ status: "pending" }] }),
      }),
    },
  };
});

vi.mock(
  "../../../../services/workspace-materialization-service.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../../services/workspace-materialization-service.js")
    >()),
    materializeWorkspaceCore: async (a: Record<string, unknown>) => {
      h.materializeArgs.push(a);
      throw new Error("SENTINEL_MATERIALIZED");
    },
  })
);

import { proposalExecRegistry } from "../../execution-registry.js";
import type { ProposalExecutorArgs } from "../../execution-registry.js";
import { registerWorkspaceExecutors } from "../workspace.js";

function args(data: Record<string, unknown>): ProposalExecutorArgs {
  return {
    proposal: {
      id: "row-123",
      targetType: "workspace",
      targetId: null,
      proposalType: "create",
      workspaceId: null,
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      data: { data },
    },
    payload: null,
    userId: "human-1",
    input: { proposalId: "row-123" },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps: {} as ProposalExecutorArgs["deps"],
  } as unknown as ProposalExecutorArgs;
}

function executor() {
  const ex = proposalExecRegistry.resolveExact("workspace/create");
  if (!ex) throw new Error("executor not registered: workspace/create");
  return ex;
}

beforeEach(() => {
  h.materializeArgs.length = 0;
  proposalExecRegistry._reset();
  registerWorkspaceExecutors();
});

describe("workspace/create approve — template identity", () => {
  it("a packages.apply proposal with no slug and no key is REFUSED — nothing materialized (the incident)", async () => {
    await expect(
      executor().execute(
        args({
          name: "Content OS",
          workspaceName: "Content OS",
          source: "packages.apply",
          definition: { workspaceName: "Content OS", _meta: { version: "h" } },
        })
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.materializeArgs).toEqual([]);
  });

  it("the definition's `_meta.slug` is the slug AND the key when none was stored", async () => {
    await expect(
      executor().execute(
        args({
          name: "Content OS",
          source: "packages.apply",
          definition: { _meta: { slug: "content-os" } },
        })
      )
    ).rejects.toThrow("SENTINEL_MATERIALIZED");
    expect(h.materializeArgs[0]).toMatchObject({
      packageSlug: "content-os",
      proposalId: "content-os",
    });
  });

  it("an explicit stored key wins over the slug", async () => {
    await expect(
      executor().execute(
        args({
          name: "Builder",
          packageSlug: "builder",
          proposalId: "builder-workspace-v1",
          definition: {},
        })
      )
    ).rejects.toThrow("SENTINEL_MATERIALIZED");
    expect(h.materializeArgs[0]).toMatchObject({
      packageSlug: "builder",
      proposalId: "builder-workspace-v1",
    });
  });

  it("a FREEHAND proposal (no template marker) still keys on its row id", async () => {
    await expect(
      executor().execute(args({ name: "Scratch", definition: {} }))
    ).rejects.toThrow("SENTINEL_MATERIALIZED");
    expect(h.materializeArgs[0]).toMatchObject({ proposalId: "row-123" });
    expect(h.materializeArgs[0].packageSlug).toBeUndefined();
  });
});
