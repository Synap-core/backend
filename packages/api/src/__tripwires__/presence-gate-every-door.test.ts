/**
 * TRIPWIRE — every door that APPROVES a proposal passes the proof-of-presence
 * gate (W3, founder decision of 4 Nov 2026: a session proves the account, not
 * the person; sensitive approvals need a fresh proof bound to that proposal).
 *
 * The doors are DERIVED from the source, never hand-listed: every non-test
 * file under `packages/api/src` that writes a proposal's status to APPROVED
 * (`to:`/`status: ProposalStatus.APPROVED`, or `settleProposal(…, "approved")`).
 * Each one must be:
 *   - `apply-approval.ts`, which calls the gate BEFORE the background hand-off
 *     and before any executor runs (checked by position); or
 *   - an approve EXECUTOR (`routers/proposals/executors/`, the share
 *     executors), which only `applyProposalApproval` dispatches; or
 *   - a "mark it approved" helper whose every caller is an executor or
 *     `apply-approval.ts` (callers derived by name); or
 *   - a door that calls `assertPresenceForApproval` itself (the pending-key
 *     pages through `approvePendingAgentKey`, `secretsVault.grantAIAccess`); or
 *   - listed in NOT_A_DOOR with the reason it approves nothing sensitive.
 *
 * And every key of `SENSITIVE_APPROVALS` names a real approval (a registered
 * executor key, or a type `apply-approval.ts` handles inline): a typo would
 * otherwise drop a sensitive type out of the gate in silence.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRESENCE_REQUEST_KINDS,
  SENSITIVE_APPROVALS,
  SENSITIVE_PROPOSAL_TYPE_PREFIXES,
} from "@synap-core/types/presence";

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      walk(full, out);
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !/\.(test|spec)\.ts$/.test(name)
    ) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC).map((f) => ({
  path: relative(SRC, f),
  src: readFileSync(f, "utf8"),
}));

const APPROVES =
  /(?:to|status):\s*ProposalStatus\.APPROVED\b|settleProposal\([^)]*"approved"/;
const GATE = /\bassertPresenceForApproval\(/;
const isExecutor = (p: string) =>
  p.startsWith("routers/proposals/executors/") ||
  p === "services/sharing/share-executors.ts";

/** Files that write APPROVED but are no approval door, and why. */
const NOT_A_DOOR: Record<string, string> = {
  "services/import/session.ts":
    "closes the import's own proposal once the person's import.apply (through applyProposalApproval) landed; an import is never sensitive",
  "services/guidelines/guideline-versions.ts":
    "its write (structureGuidelineApprovalDbDeps) runs only inside approveStructureGuidelineProposal, which applyProposalApproval calls after the gate; a structure guideline is not sensitive",
};

/**
 * The exported function (or const) that holds each APPROVED write: the
 * nearest `export … function NAME` / `export const NAME` above it.
 */
function enclosingExports(src: string): string[] {
  const names = new Set<string>();
  const writes = new RegExp(APPROVES.source, "g");
  for (const m of src.matchAll(writes)) {
    const before = src.slice(0, m.index);
    const decls = [
      ...before.matchAll(
        /export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/g
      ),
    ];
    const last = decls.at(-1);
    if (last) names.add(last[1]!);
  }
  return [...names];
}

describe("TRIPWIRE: every approve door passes the proof-of-presence gate", () => {
  const doors = FILES.filter((f) => APPROVES.test(f.src));

  it("derives a non-trivial set of doors (the scan works)", () => {
    expect(doors.map((d) => d.path)).toContain(
      "routers/proposals/apply-approval.ts"
    );
    expect(doors.length).toBeGreaterThan(10);
  });

  it("applyProposalApproval gates before the background hand-off and before any executor", () => {
    const src = FILES.find(
      (f) => f.path === "routers/proposals/apply-approval.ts"
    )!.src;
    const body = src.slice(
      src.indexOf("export async function applyProposalApproval(")
    );
    const gate = body.search(GATE);
    expect(
      gate,
      "applyProposalApproval must call assertPresenceForApproval"
    ).toBeGreaterThan(0);
    expect(gate).toBeLessThan(body.indexOf("handOffBackgroundApproval("));
    expect(gate).toBeLessThan(body.indexOf("applyProposalApprovalInner("));
  });

  it("every other door is an executor, an executor-only helper, a gated door, or not a door", () => {
    const ungated: string[] = [];
    for (const door of doors) {
      if (door.path === "routers/proposals/apply-approval.ts") continue;
      if (isExecutor(door.path)) continue;
      if (GATE.test(door.src)) continue;
      if (door.path in NOT_A_DOOR) continue;
      // A helper: every file that calls one of its exports must be an
      // executor or apply-approval.ts.
      const names = enclosingExports(door.src);
      const callers = FILES.filter(
        (f) =>
          f.path !== door.path &&
          names.some((n) => new RegExp(`\\b${n}\\(`).test(f.src))
      );
      const outside = callers.filter(
        (f) =>
          !isExecutor(f.path) &&
          f.path !== "routers/proposals/apply-approval.ts"
      );
      if (callers.length === 0 || outside.length > 0) {
        ungated.push(
          `${door.path}${outside.length ? ` (called from ${outside.map((o) => o.path).join(", ")})` : ""}`
        );
      }
    }
    expect(
      ungated,
      "These write a proposal APPROVED outside applyProposalApproval without assertPresenceForApproval. Gate them, or list them in NOT_A_DOOR with the reason."
    ).toEqual([]);
  });

  it("every sensitive key names a real approval", () => {
    const executorSrc = FILES.filter((f) => isExecutor(f.path))
      .map((f) => f.src)
      .join("\n");
    const applySrc = FILES.find(
      (f) => f.path === "routers/proposals/apply-approval.ts"
    )!.src;
    const missing = Object.keys(SENSITIVE_APPROVALS).filter((key) => {
      if (executorSrc.includes(`"${key}"`)) return false;
      const [target, type] = key.split("/");
      // A templated key (`workspace/${action}`) or a constant pair.
      if (type && executorSrc.includes(`\`${target}/\${`)) return false;
      if (key === "trusted_issuer/trusted_issuer.widen_scopes") {
        return !executorSrc.includes(
          "TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE"
        );
      }
      if (key === "vault/grant" || key === "settings.update") {
        return (
          !(executorSrc + applySrc).includes(`"${key}"`) &&
          !applySrc.includes(`"${key.split("/").pop()}"`)
        );
      }
      return true;
    });
    expect(missing, "sensitive keys no executor registers").toEqual([]);
    expect(Object.keys(SENSITIVE_PROPOSAL_TYPE_PREFIXES)).toEqual([
      "governance.",
    ]);
  });

  // ── W3 slice 2: decisions that settle no proposal ──────────────────────────

  /** Approve/decide mutations that are everyday (or no pod approval), and why. */
  const EVERYDAY_DECISIONS: Record<string, string> = {
    "routers/intelligence.ts approveProposal":
      "forwards to the AI service's own proposal list (hubProxyFetch); any pod write it leads to comes back through the pod's own approve doors",
  };

  /** Every tRPC mutation named approve…/…Approve…/decide…, with its body. */
  function decisionProcedures(): Array<{ key: string; body: string }> {
    const out: Array<{ key: string; body: string }> = [];
    for (const f of FILES.filter((x) => x.path.startsWith("routers/"))) {
      const starts = [...f.src.matchAll(/^ {2}([A-Za-z]+):\s*[A-Za-z.]+/gm)];
      starts.forEach((m, i) => {
        const name = m[1]!;
        if (!/(?:approve|Approve|decide|Decide)/.test(name)) return;
        const body = f.src.slice(m.index, starts[i + 1]?.index ?? undefined);
        if (!body.includes(".mutation(")) return;
        out.push({ key: `${f.path} ${name}`, body });
      });
    }
    return out;
  }

  it("every approve/decide mutation gates with a proof, applies through applyProposalApproval, or is listed as everyday", () => {
    const procs = decisionProcedures();
    expect(procs.map((p) => p.key)).toEqual(
      expect.arrayContaining([
        "routers/proposals.ts approve",
        "routers/api-keys.ts decideKeyRequest",
        "routers/trusted-issuers.ts approve",
      ])
    );
    const ungated = procs
      .filter(
        (p) =>
          !/\bassertPresenceFor(?:Request|Approval)\(|\bapplyProposalApproval\(|\bdecideOAuthAuthorization\(|\bsetSkillApproved\(/.test(
            p.body
          ) && !(p.key in EVERYDAY_DECISIONS)
      )
      .map((p) => p.key);
    expect(
      ungated,
      "Gate these with assertPresenceForRequest (services/presence/gate.ts), or list them in EVERYDAY_DECISIONS with the reason"
    ).toEqual([]);
    // The OAuth consent's decision function gates itself.
    expect(
      FILES.find((f) => f.path === "routers/oauth/consent.ts")!.src
    ).toMatch(/kind: "oauth_consent"/);
  });

  it("every request kind is gated by a door, and the skip hooks are held by their one door each", () => {
    const all = FILES.map((f) => f.src).join("\n");
    for (const kind of Object.keys(PRESENCE_REQUEST_KINDS)) {
      expect(all, `no door gates "${kind}"`).toMatch(
        new RegExp(`kind: "${kind}"`)
      );
    }
    const holders = (hook: string) =>
      FILES.filter((f) => f.src.includes(hook))
        .map((f) => f.path)
        .sort();
    expect(holders('presenceChecked: "oauth.consent",')).toEqual([
      "routers/oauth/consent.ts",
    ]);
    expect(holders('presenceChecked: "applyProposalApproval",')).toEqual([
      "routers/proposals/executors/agent.ts",
      "routers/proposals/executors/skill.ts",
    ]);
  });
});
