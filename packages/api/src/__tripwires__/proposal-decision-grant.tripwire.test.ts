import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — every door that DECIDES a proposal asks the key's grant first.
 *
 * `assertMayDecideProposal(verb)` (routers/proposals/review-authority.ts) is
 * the ONE check that a granted key holds `proposal.approve` / `proposal.reject`
 * (behaviour: routers/proposals/__tests__/proposal-decision-grant.test.ts).
 * A decision door that skips it lets a key granted "read documents" approve a
 * change with the human's authority. Three derived sets:
 *
 *  A. every MUTATION of the `proposals` tRPC router is classified — a decision
 *     (and then its FIRST statement is the gate, so it fires before any read)
 *     or not a decision, with the reason. A new mutation joins by existing.
 *  B. every router file that writes a decided status (`update(proposals)` +
 *     APPROVED / REJECTED / REVERTED) calls the gate. Executors are excluded:
 *     they run only under `applyProposalApproval`, which is in the set.
 *  C. every Hub REST `/proposals/:id/<action>` route delegates to a gated
 *     procedure (the MCP reject tool delegates to `reject` the same way), and
 *     every REVISE door (tRPC `revise`, MCP `synap_revise_proposal`, Hub tRPC
 *     `updateProposal` — derived: the router files that call the revise core)
 *     reaches `mergeProposalRevision`, whose locked read calls
 *     `assertMayReviseProposal` (approve right unless its agent authored it).
 *
 * NOT covered, measured: a revise door that writes `proposals.data` itself
 * instead of calling the core (proposals.ts writes `data` for item
 * dispositions, so a file-level scan cannot tell the two apart); a door outside `src/routers` that flips a status
 * directly (services/** system flows: cleanup packs, guest retention), and an
 * executor imported by something other than the approval registry.
 */

const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const DECIDES: Record<string, "approve" | "reject"> = {
  approve: "approve",
  batchApprove: "approve",
  revert: "approve", // executes writes with the reviewer's authority
  reject: "reject",
  batchReject: "reject",
  rejectItem: "reject",
  restoreItem: "reject",
  reopen: "reject",
};
/** Decisions whose key check needs the row, so it runs in a shared core. */
const DECIDES_IN_CORE: Record<string, string> = {
  revise:
    "rewrites what the reviewer approves — the revise core asks the key (assertMayReviseProposal): approve right, unless its agent authored the proposal",
};
const NOT_A_DECISION: Record<string, string> = {
  withdraw: "the PROPOSER retracting their own request — no review",
  submit: "files a proposal; deciding it is a separate door",
  createDocumentEdit: "files a document-edit proposal",
  muteRejectionCluster: "the viewer's own inbox preference",
  unmuteRejectionCluster: "the viewer's own inbox preference",
  askAi: "asks a question about a proposal; changes nothing",
};

function procedureSegments(source: string): Map<string, string> {
  const re = /^ {2}(\w+): \w*[pP]rocedure\b/gm;
  const hits = [...source.matchAll(re)];
  const out = new Map<string, string>();
  hits.forEach((m, i) => {
    out.set(m[1], source.slice(m.index!, hits[i + 1]?.index ?? source.length));
  });
  return out;
}

const gateFirst = (verb: string) =>
  new RegExp(
    String.raw`\.mutation\(async \(\{[^)]*\}\) => \{\s*assertMayDecideProposal\(\s*"${verb}"`
  );

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (
      e.name === "node_modules" ||
      e.name === "dist" ||
      e.name === "__tests__"
    )
      continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, acc);
    else if (e.name.endsWith(".ts") && !/\.test\.ts$/.test(e.name)) acc.push(p);
  }
  return acc;
}

describe("A — proposals router: every mutation is classified, every decision gates first", () => {
  const segments = procedureSegments(read("routers/proposals.ts"));
  const mutations = [...segments]
    .filter(([, seg]) => seg.includes(".mutation("))
    .map(([name]) => name);

  it("sees the router (non-vacuity)", () => {
    expect(segments.size).toBeGreaterThanOrEqual(20);
    expect(mutations).toContain("approve");
    expect(mutations).toContain("reject");
    expect(mutations.length).toBeGreaterThanOrEqual(12);
  });

  it("no mutation is unclassified", () => {
    const classified = new Set([
      ...Object.keys(DECIDES),
      ...Object.keys(DECIDES_IN_CORE),
      ...Object.keys(NOT_A_DECISION),
    ]);
    expect(mutations.filter((m) => !classified.has(m))).toEqual([]);
    expect([...classified].filter((c) => !mutations.includes(c))).toEqual([]);
  });

  it.each(
    Object.entries(DECIDES)
      .filter(([, verb]) => verb === "reject")
      .map(([name]) => name)
  )(
    "%s reaches assertCanReviewProposal (an agent key rejects only its own)",
    (name) => {
      expect(segments.get(name)).toMatch(/\bassertCanReviewProposal\(\{/);
    }
  );

  it.each(Object.entries(DECIDES))(
    "%s asks for proposal.%s as its first statement",
    (name, verb) => {
      expect(segments.get(name)).toMatch(gateFirst(verb));
    }
  );
});

describe("B — every router file that writes a decided status calls the gate", () => {
  const writers = tsFiles(join(SRC, "routers"))
    .filter((f) => !f.includes(`${join("proposals", "executors")}`))
    .filter((f) => {
      const s = readFileSync(f, "utf8");
      return (
        s.includes("update(proposals)") &&
        /ProposalStatus\.(APPROVED|REJECTED|REVERTED)\b/.test(s)
      );
    })
    .map((f) => relative(SRC, f));

  it("finds the known writers (non-vacuity)", () => {
    expect(writers).toEqual(
      expect.arrayContaining([
        "routers/proposals.ts",
        "routers/proposals/apply-approval.ts",
        "routers/secrets-vault.ts",
      ])
    );
  });

  it.each(writers)("%s calls assertMayDecideProposal", (file) => {
    expect(read(file)).toMatch(
      /assertMayDecideProposal\(\s*"(approve|reject)"/
    );
  });
});

describe("C — Hub REST decision routes delegate to a gated procedure", () => {
  const restDir = join(SRC, "routers/hub-protocol/rest");
  const routes = tsFiles(restDir).flatMap((f) => {
    const s = readFileSync(f, "utf8");
    const hits = [
      ...s.matchAll(/app\.(?:post|patch|put)\(\s*"\/proposals\/:id\/(\w+)"/g),
    ];
    return hits.map((m, i) => ({
      action: m[1],
      body: s.slice(m.index!, hits[i + 1]?.index ?? s.length),
    }));
  });

  it("sees approve, reject and revert (non-vacuity)", () => {
    expect(routes.map((r) => r.action)).toEqual(
      expect.arrayContaining(["approve", "reject", "revert"])
    );
  });

  it.each(routes.map((r) => [r.action, r.body] as const))(
    "/proposals/:id/%s calls a gated procedure",
    (_action, body) => {
      const called = [...body.matchAll(/caller\.(\w+)\(/g)].map((m) => m[1]);
      expect(called.some((c) => c in DECIDES)).toBe(true);
    }
  );
});

describe("C — every revise door reaches the revise core, which asks the key", () => {
  const core = read("services/proposals/proposals-service.ts");
  const start = core.indexOf("export async function mergeProposalRevision(");
  const coreBody = core.slice(start, core.indexOf("\nexport ", start + 1));
  const callsCore = /\b(mergeProposalRevision|reviseProposal)\s*\(/;
  const reviseDoors = tsFiles(join(SRC, "routers"))
    .filter((f) => callsCore.test(readFileSync(f, "utf8")))
    .map((f) => relative(SRC, f));

  it("sees the three revise doors and the core (non-vacuity)", () => {
    expect(start).toBeGreaterThan(-1);
    expect(reviseDoors).toEqual(
      expect.arrayContaining([
        "routers/proposals.ts",
        "routers/mcp/handlers/build.ts",
        "routers/hub-protocol/proposals.ts",
      ])
    );
  });

  it("the core asks the key on the locked row, as a statement of its own", () => {
    expect(coreBody).toMatch(/^ {4}assertMayReviseProposal\(existing\);$/m);
  });

  it("the helper exempts only the authoring agent, then needs approve", () => {
    const ra = read("routers/proposals/review-authority.ts");
    const at = ra.indexOf("export function assertMayReviseProposal(");
    const body = ra.slice(at, ra.indexOf("\n}\n", at));
    // D3 (S7, 2026-10-20): the approve right is checked on the proposal's own
    // space / project / object, so a key's resource pins apply.
    expect(body).toMatch(
      /if \(actingAgentUserId && proposal\.agentUserId === actingAgentUserId\) return;\s*(\/\/[^\n]*\s*)*assertMayDecideProposal\("approve", "revise", grant, \{\s*workspaceId: proposal\.workspaceId/
    );
  });
});
