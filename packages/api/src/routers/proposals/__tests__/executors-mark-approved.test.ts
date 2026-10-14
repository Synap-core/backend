import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * An approved proposal must be MARKED approved by its executor.
 *
 * THE BUG THIS PINS: the `aiProvider` executors applied the change and pushed it
 * to the IS but never set `status: APPROVED`. The registry dispatch does not do
 * it for you — every other executor does it itself — so an approved provider
 * change stayed `pending` forever: still in the review queue, and re-approving
 * it re-ran the write. Observed live (proposal e388f1e5, row written, status
 * pending, reviewedBy null).
 */

const { updates, emitted } = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  emitted: [] as unknown[][],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    where: async () => [{ status: "pending" }],
    set: (v: Record<string, unknown>) => {
      updates.push(v);
      return { where: async () => undefined };
    },
  };
  return {
    ...actual,
    db: {
      select: () => chain,
      update: () => ({ set: chain.set }),
      insert: () => ({ values: async () => undefined }),
      delete: () => ({ where: async () => undefined }),
      query: { aiProviders: { findFirst: async () => null } },
    },
  };
});
vi.mock("../../../utils/push-providers-to-is.js", () => ({
  pushProvidersToIS: vi.fn(async () => undefined),
}));

import { proposalExecRegistry } from "../execution-registry.js";
import { registerAiProviderExecutors } from "../executors/ai-provider.js";
import { ProposalStatus } from "@synap/database/schema";
import { stripComments } from "../../../../../../scripts/strip-comments.mjs";

registerAiProviderExecutors();

function run(key: string, data: Record<string, unknown>) {
  const ex = proposalExecRegistry.resolve(key, key.split("/")[1]);
  expect(ex, key).toBeDefined();
  return ex!.execute({
    proposal: {
      id: "p1",
      targetType: "aiProvider",
      targetId: "t1",
      proposalType: key.split("/")[1]!,
      workspaceId: null,
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      data,
    },
    payload: null,
    userId: "human-1",
    input: { proposalId: "p1" },
    ctx: {} as never,
    deps: {
      reportProposalOutcome: vi.fn(),
      emitProposalReviewed: vi.fn((...a: unknown[]) => emitted.push(a)),
    } as never,
  });
}

beforeEach(() => {
  updates.length = 0;
  emitted.length = 0;
});

describe("aiProvider executors mark the proposal approved", () => {
  it("create: applies AND flips status, attributed to the approver", async () => {
    await run("aiProvider/create", {
      providerId: "freellmapi",
      name: "FreeLLMAPI",
      baseUrl: "http://eve-brain-freellmapi:3001/v1",
      priority: 90,
      enabled: true,
      models: [{ id: "auto", tier: "free" }],
    });
    const flip = updates.find((u) => u.status === ProposalStatus.APPROVED);
    expect(flip).toMatchObject({
      status: ProposalStatus.APPROVED,
      reviewedBy: "human-1",
    });
    expect(emitted).toContainEqual(["p1", null, "approved", "human-1"]);
  });

  it("delete: flips status too", async () => {
    await run("aiProvider/delete", { providerId: "freellmapi" });
    expect(updates.some((u) => u.status === ProposalStatus.APPROVED)).toBe(
      true
    );
  });
});

describe("convention: every executor file marks APPROVED", () => {
  // Derived, not hand-listed: a new executor joins by existing. A file that
  // registers an executor but never sets APPROVED leaves its proposals pending
  // forever — exactly the aiProvider defect.
  const dir = join(__dirname, "../executors");
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts")
  );
  const registering = files.filter((f) =>
    readFileSync(join(dir, f), "utf8").includes("registerProposalExecutor(")
  );

  it("scans a plausible number of executor files (non-vacuity)", () => {
    expect(registering.length).toBeGreaterThanOrEqual(20);
    expect(registering).toContain("ai-provider.ts");
  });

  const SETS_APPROVED = /status:\s*ProposalStatus\.APPROVED/;

  /**
   * An executor may delegate the flip to a `mark…Approved` helper (routers/**
   * may not touch `proposals` raw, so a new executor keeps the write in a
   * service). Accepted only when the executor CALLS a helper it imports from a
   * relative module that DEFINES that helper and itself sets APPROVED.
   * Granularity is the module, not the function body.
   */
  function delegatesApproval(src: string): boolean {
    const imports = src.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"(\.[^"]+)\.js"/g
    );
    for (const [, names, rel] of imports) {
      for (const name of names!.split(",").map((n) => n.trim())) {
        if (!/^mark\w*Approved$/.test(name)) continue;
        if (!new RegExp(`\\b${name}\\(`).test(src)) continue;
        const target = stripComments(
          readFileSync(join(dir, `${rel}.ts`), "utf8"),
          "ts"
        );
        if (
          new RegExp(`export async function ${name}\\b`).test(target) &&
          SETS_APPROVED.test(target)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  it("the delegation check can see a literal helper (self-check)", () => {
    const src = stripComments(
      readFileSync(join(dir, "trusted-issuer.ts"), "utf8"),
      "ts"
    );
    expect(SETS_APPROVED.test(src)).toBe(false);
    expect(delegatesApproval(src)).toBe(true);
  });

  it.each(registering)("%s sets status: ProposalStatus.APPROVED", (f) => {
    const src = stripComments(readFileSync(join(dir, f), "utf8"), "ts");
    expect(SETS_APPROVED.test(src) || delegatesApproval(src), f).toBe(true);
  });
});
