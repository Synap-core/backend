import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  ListProposalsQuerySchema,
  PROPOSAL_SUMMARY_MAX,
  PROPOSAL_VIEWS,
  ProposalBasicSchema,
  toProposalBasic,
} from "../routers/hub-protocol/rest/_codecs/proposal.js";

/**
 * TRIPWIRE — the LIST-vs-GET `view` split (AIP-157) must stay opt-in and
 * single-definition.
 *
 * Two properties are load-bearing:
 *
 *  1. **The default is FULL.** AIP-157: "having a partial response be the
 *     default can degrade the effectiveness of declarative clients" — and the
 *     generated Hub client is exactly such a client. A caller that sends no
 *     `view` must get today's payload unchanged.
 *  2. **BASIC never fabricates and never grows unbounded.** The summary is only
 *     ever LIFTED from data the server already holds, and it is capped
 *     server-side — the 283,737-char / 33-row MCP regression came from exactly
 *     the un-capped direction.
 */

const restSrc = readFileSync(
  new URL("../routers/hub-protocol/rest/proposals.ts", import.meta.url),
  "utf-8"
);
const mcpSrc = readFileSync(
  new URL("../routers/mcp/adapter.ts", import.meta.url),
  "utf-8"
);

const ROW = {
  id: "p1",
  proposalType: "entity.create",
  targetType: "entity",
  targetId: "e1",
  status: "auto_approved",
  workspaceId: "w1",
  createdAt: "2026-08-03T00:00:00.000Z",
  correlationId: "c1",
  sessionId: "s1",
  agentUserId: "a1",
  data: { summary: "Created Acme Corp", huge: "x".repeat(50_000) },
};

describe("tripwire: proposal `view` projection", () => {
  it("`full` is the FIRST/default view and `view` is optional on the query", () => {
    expect(PROPOSAL_VIEWS[0]).toBe("full");
    // Absent `view` must parse — an omitted param is the default path.
    const parsed = ListProposalsQuerySchema.parse({});
    expect(parsed.view).toBeUndefined();
  });

  it("the REST handler treats an absent `view` as `full` and branches ONLY on basic", () => {
    // Source-level assertion (the handler itself needs a DB + auth context to
    // exercise): the default literal is `full`, and the only projection branch
    // is an explicit `=== "basic"`. Any other default would silently change the
    // response for every existing caller.
    expect(restSrc).toContain('c.req.query("view") ?? "full"');
    expect(restSrc).toContain('if (rawView === "basic")');
  });

  it("BASIC drops `data` entirely", () => {
    const basic = toProposalBasic(ROW) as Record<string, unknown>;
    expect("data" in basic).toBe(false);
    // And the declared schema has no `data` key either — a view is a permanent
    // ratchet, so `data` must never be added to it.
    expect(Object.keys(ProposalBasicSchema.shape)).not.toContain("data");
  });

  it("BASIC lifts the author's summary and caps it server-side", () => {
    expect(toProposalBasic(ROW).summary).toBe("Created Acme Corp");
    const long = toProposalBasic({
      ...ROW,
      data: { summary: "y".repeat(5_000) },
    });
    expect(long.summary?.length).toBe(PROPOSAL_SUMMARY_MAX);
  });

  it("BASIC prefers data.quality.summary over data.summary", () => {
    expect(
      toProposalBasic({
        ...ROW,
        data: { summary: "fallback", quality: { summary: "authored" } },
      }).summary
    ).toBe("authored");
  });

  it("BASIC OMITS summary when the proposal has none — never an empty string, never generated", () => {
    const none = toProposalBasic({ ...ROW, data: {} }) as Record<
      string,
      unknown
    >;
    expect("summary" in none).toBe(false);
    const empty = toProposalBasic({
      ...ROW,
      data: { summary: "" },
    }) as Record<string, unknown>;
    expect("summary" in empty).toBe(false);
  });

  it("BASIC output validates against its own declared schema", () => {
    expect(() => ProposalBasicSchema.parse(toProposalBasic(ROW))).not.toThrow();
  });

  it('the MCP `detail:"summary"` path uses the SAME projection, not a second one', () => {
    expect(mcpSrc).toContain("toProposalBasic");
    // The hand-rolled summarizer that drifted from REST must not come back.
    expect(mcpSrc).not.toContain("quality.summary ?? data.summary");
  });
});
