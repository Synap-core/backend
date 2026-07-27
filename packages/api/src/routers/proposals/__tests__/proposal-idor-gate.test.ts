/**
 * Cross-context proposal IDOR gate — the leak a guessed proposal UUID exploited:
 *   resolveOrCreateChannel({contextObjectType:"proposal"}) blind-upsert →
 *   attacker-owned channel → hub-protocol/context.ts hydrates the proposal into
 *   the AI prompt (renderProposalForPrompt).
 *
 * The fix is (1) an `assertProposalVisibleTo` SSOT gate at the channel-bind
 * chokepoint, (2) a defense-in-depth re-check on the hydration side, and (3)
 * removing "proposal" from the service-key `/channels/by-context` REST door.
 *
 * (1)/(2)/(3) placement is proven statically (live PG isn't available in this
 * suite); the codec narrowing is proven EXECUTABLY against the real schema.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ChannelByContextRequestSchema } from "../../hub-protocol/rest/_codecs/channel.js";

const API_SRC = join(process.cwd(), "src");
function readSrc(rel: string): string {
  return readFileSync(join(API_SRC, rel), "utf8");
}

describe("by-context REST codec rejects proposal (executable)", () => {
  it("REJECTS contextObjectType 'proposal' (the IDOR surface)", () => {
    const r = ChannelByContextRequestSchema.safeParse({
      userId: "u1",
      contextObjectId: "p1",
      contextObjectType: "proposal",
    });
    expect(r.success).toBe(false);
  });

  it("still ACCEPTS entity / document / view", () => {
    for (const t of ["entity", "document", "view"] as const) {
      const r = ChannelByContextRequestSchema.safeParse({
        userId: "u1",
        contextObjectId: "o1",
        contextObjectType: t,
      });
      expect(r.success).toBe(true);
    }
  });
});

describe("assertProposalVisibleTo SSOT is the ONE gate", () => {
  it("proposals.get + proposals.source call it instead of inlining the membership check", () => {
    const src = readSrc("routers/proposals.ts");
    // Both readers route through the shared gate…
    const calls = src.match(/assertProposalVisibleTo\(/g) ?? [];
    // get + source + the import line reference = at least 2 call sites.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // …and the hand-inlined "Editor or higher role required to view this
    // proposal" duplication is gone from the router (now only in the SSOT util).
    expect(src).not.toContain(
      "Editor or higher role required to view this proposal"
    );
  });

  it("the SSOT is STRICTER than userVisibleWhere (does not reuse the weak predicate)", () => {
    const gate = readSrc("utils/proposal-visibility.ts");
    // Pod-wide ⇒ proposer-only; workspace ⇒ editor+ membership.
    expect(gate).toContain("sourceId");
    expect(gate).toMatch(/\["owner",\s*"admin",\s*"editor"\]/);
    // The weak predicate is named only in prose (for contrast), never imported.
    expect(gate).not.toMatch(/import[^;]*userVisibleWhere/);
  });
});

describe("channel-bind chokepoint gates a proposal bind", () => {
  it("resolve-or-create-channel THREAD branch calls assertProposalVisibleTo for proposals", () => {
    const src = readSrc("utils/resolve-or-create-channel.ts");
    const thread = src.slice(
      src.indexOf("channelType === ChannelType.THREAD"),
      src.indexOf("channelType === ChannelType.EXTERNAL")
    );
    expect(thread).toMatch(/contextObjectType === "proposal"/);
    expect(thread).toContain(
      "assertProposalVisibleTo(contextObjectId, userId)"
    );
  });
});

describe("hydration re-checks before injecting a proposal into the prompt", () => {
  it("context.ts gates renderProposalForPrompt behind assertProposalVisibleTo", () => {
    const src = readSrc("routers/hub-protocol/context.ts");
    // The gate CALL (not the import) precedes the hydration it guards.
    const gateIdx = src.indexOf(
      "assertProposalVisibleTo(thread.contextObjectId, threadUserId"
    );
    const renderIdx = src.indexOf(
      "renderProposalForPrompt(thread.contextObjectId)"
    );
    expect(gateIdx).toBeGreaterThan(-1);
    expect(renderIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(renderIdx);
  });
});
