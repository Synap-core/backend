/**
 * THE TITLE CONTRACT on `synap_capture`'s structured lane (plan 9992207a,
 * `c-title-contract`) — the door most knowledge entries were written through.
 *
 *  1. A title over the hard cap (200) is a structural problem: refused with
 *     its length, before any write or dry run.
 *  2. Every other title is written as sent, and the response carries
 *     `titleLint` per entity ref — on the dry run too, so `validate: true`
 *     shows what to rewrite before anything is stored. A flagged title never
 *     makes the dry run `invalid`.
 *
 * Driven through the real handler; only the DB-backed reads are faked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ dryRuns: 0 }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    resolveProjectPlacement: async () => ({ projectId: null, rung: null }),
    resolveIdentity: async () => ({ crossKindCandidates: [] }),
  };
});

vi.mock("../../../services/capture-agent/submit-capture-graph.js", () => ({
  dryRunCaptureGraph: async () => {
    h.dryRuns += 1;
    return {
      invalidEntities: [],
      unresolvedProfiles: [],
      relationsFailed: [],
      planProblems: [],
      planSteps: [],
      unmodeledProperties: [],
      entityCount: 2,
      relationCount: 0,
    };
  },
  submitCaptureGraph: async () => {
    throw new Error("a dry run must never submit");
  },
}));

import { captureHandlers } from "./capture.js";
import type { McpToolContext } from "./shared.js";

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_capture",
    args,
    userId: "user-owner",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    workspaceAccessible: true,
  } as unknown as McpToolContext;
}

type Result = { content: Array<{ text?: string }> };
const payload = (r: Result) => JSON.parse(r.content[0]!.text!);
const capture = (args: Record<string, unknown>) =>
  captureHandlers.synap_capture!(ctx(args)) as Promise<Result>;

beforeEach(() => {
  h.dryRuns = 0;
});

describe("synap_capture entities[] — the title contract", () => {
  it("refuses an over-cap title as a problem, naming its length, before any dry run", async () => {
    const out = payload(
      await capture({
        validate: true,
        entities: [
          { ref: "k1", profileSlug: "knowledge", title: "z".repeat(240) },
          {
            ref: "k2",
            profileSlug: "knowledge",
            title: "Grants deny by default",
          },
        ],
      })
    );
    expect(out.status).toBe("invalid");
    expect(out.problems.join(" ")).toMatch(
      /entity 'k1': title is 240 characters; the limit is 200/
    );
    expect(h.dryRuns).toBe(0);
  });

  it("reports titleLint per flagged ref on the dry run, without failing it", async () => {
    const claim =
      "Approving a connection on one computer revoked the key of every other computer that shared the claude-code identity.";
    const out = payload(
      await capture({
        validate: true,
        entities: [
          {
            ref: "cut",
            profileSlug: "knowledge",
            title: claim.slice(0, 72),
            properties: { knowledgeForm: "caution", ek_claim: claim },
          },
          {
            ref: "ok",
            profileSlug: "knowledge",
            title: "Grants deny by default",
          },
        ],
      })
    );
    expect(out.status).toBe("valid");
    expect(out.titleLint).toHaveLength(1);
    expect(out.titleLint[0]).toMatchObject({
      ref: "cut",
      title: claim.slice(0, 72),
    });
    expect(
      out.titleLint[0].issues.map((i: { code: string }) => i.code)
    ).toEqual(["truncated"]);
  });
});
