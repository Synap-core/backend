/**
 * TRIPWIRE — a background job never writes the "rejected" verdict on a
 * proposal.
 *
 * `rejected` is a person's answer. A job that relabels a row as rejected makes
 * every reader (the review history, the poll an agent reads, the agent
 * scorecard's reject rate) report a decision nobody made. A lapse has its own
 * status, `expired`, written by the stale-proposal door in `@synap/database`.
 *
 * It happened: `vault-grant-expiry` (retired 2026-10-28, finding 73ac3ee8) set
 * `status = rejected, rejectionReason = 'expired'` on APPROVED `vault.request`
 * proposals once `data.ttl` minutes had passed. Access never read that status
 * (the grant row carries its own `expiresAt`), `ttl` is always set (the request
 * defaults it to 60), so a PERMANENT grant's approval read "rejected" after an
 * hour. Its queue stays in `RETIRED_QUEUES` so the schedule a live pod still
 * holds is unscheduled at boot instead of minting jobs nobody consumes.
 *
 * Scanned set: every non-test `.ts` under `packages/jobs/src`, comments
 * stripped, derived by walking the tree (a new worker joins by existing).
 *
 * LIMIT: a text scan. It catches a `status: ProposalStatus.REJECTED` /
 * `status: "rejected"` property and a raw SQL `status = 'rejected'`. It does not
 * catch a status built in a variable first, nor a write from another package
 * that a job calls (`@synap/api` reject doors are the person's, and are not
 * reachable from here without an import this scan does not follow).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const REJECT_WRITE =
  /\bstatus\s*:\s*(?:ProposalStatus\.REJECTED\b|["']rejected["'])|\bstatus\s*=\s*'rejected'/;

const FILES = walk(SRC).map((p) => ({
  path: relative(SRC, p),
  code: stripComments(readFileSync(p, "utf8"), "ts"),
}));

describe("no background job writes a proposal's 'rejected' verdict", () => {
  it("non-vacuity: the walk sees the jobs package and a sibling status write", () => {
    expect(FILES.length).toBeGreaterThan(100);
    // The scan can still see a proposal status WRITE of the same shape: the
    // automation door records its AUTO_APPROVED receipt this way.
    expect(
      FILES.some((f) =>
        /\bstatus\s*:\s*ProposalStatus\.AUTO_APPROVED\b/.test(f.code)
      )
    ).toBe(true);
    // The regex matches each literal shape it hunts.
    expect(REJECT_WRITE.test("status: ProposalStatus.REJECTED,")).toBe(true);
    expect(REJECT_WRITE.test(`status: "rejected",`)).toBe(true);
    expect(REJECT_WRITE.test("SET status = 'rejected'")).toBe(true);
    // ...and not a read of it.
    expect(
      REJECT_WRITE.test("eq(proposals.status, ProposalStatus.REJECTED)")
    ).toBe(false);
  });

  it("no jobs source writes status 'rejected'", () => {
    const offenders = FILES.filter((f) => REJECT_WRITE.test(f.code)).map(
      (f) => f.path
    );
    expect(
      offenders,
      "A job writes a proposal's 'rejected' status. Rejection is a person's decision; a lapse is 'expired' (the stale-proposal door in @synap/database). See this file's header."
    ).toEqual([]);
  });

  it("the retired vault-grant-expiry queue is unscheduled at boot, never worked or scheduled", () => {
    const workersIdx = FILES.find(
      (f) => f.path === join("workers", "index.ts")
    )!;
    const cron = FILES.find((f) => f.path === "cron.ts")!;
    const retired =
      /const RETIRED_QUEUES: string\[\] = \[([\s\S]*?)\n\];/.exec(
        workersIdx.code
      )?.[1] ?? "";
    expect(retired).toContain('"vault-grant-expiry"');
    // The retirement loop still walks that list.
    expect(workersIdx.code).toMatch(
      /for \(const name of RETIRED_QUEUES\)[\s\S]{0,80}boss\.unschedule\(name\)/
    );
    expect(cron.code).not.toMatch(/vault-grant-expiry|VAULT_GRANT_EXPIRY/);
    expect(workersIdx.code.replace(retired, "")).not.toMatch(
      /vault-grant-expiry|VAULT_GRANT_EXPIRY/
    );
  });
});
