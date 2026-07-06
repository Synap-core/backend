import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — the channel firewall role (`branchPurpose`) has ONE write door.
 *
 * The delivery firewall keys off `channels.branchPurpose === 'client-comms'` to
 * keep bot/AI output out of a real client's conversation. That guarantee is only
 * as strong as the WRITE side: a single ungated `.set({ branchPurpose })` (this
 * is exactly how the relink + onboarding leaks happened) can flip a client-comms
 * channel to 'team' and route AI output straight to the client.
 *
 * So every UPDATE of branch_purpose must go through `setChannelBranchPurpose()`
 * (the one door, which enforces client-comms immutability; a DB trigger is the
 * floor beneath it). INSERTs are exempt — a fresh row goes NULL→role via
 * `.values({ branchPurpose })` and can never reclassify an existing client.
 *
 * If this fails: call `setChannelBranchPurpose({ channelId, branchPurpose })`
 * instead of writing `.set({ branchPurpose })` yourself. Do NOT add your file to
 * the allowlist.
 *
 * SCOPE: scans BOTH api/src AND database/src, because the door lives in
 * @synap/database and a leaker (e.g. ensure-external-channel) can too.
 */

// The ONE door — the only file permitted to `.set({ branchPurpose })`.
const ALLOWLIST_SUFFIX = "set-channel-branch-purpose.ts";

// A Drizzle UPDATE writing the firewall label: `.set({ … branchPurpose … })`.
const BANNED = /\.set\(\s*\{[^;]*?branchPurpose/s;

function tsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

describe("tripwire: channel branchPurpose has one write door", () => {
  it("no source file UPDATEs branchPurpose outside setChannelBranchPurpose()", () => {
    const roots = [
      join(process.cwd(), "src"), // api/src
      join(process.cwd(), "..", "database", "src"), // @synap/database
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const f of tsFiles(root)) {
        if (f.endsWith(ALLOWLIST_SUFFIX)) continue;
        if (BANNED.test(readFileSync(f, "utf8"))) {
          offenders.push(relative(process.cwd(), f));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
