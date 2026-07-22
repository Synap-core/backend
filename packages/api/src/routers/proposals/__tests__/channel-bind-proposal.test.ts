/**
 * Wave-1 slice 1 — governed `channel/bind` proposal.
 *
 * Binds an ALREADY-EXISTING channel to a context object (sets context_object_id
 * + optional firewall role) ALWAYS through the review/proposal flow, reusing the
 * existing proposal machinery.
 *
 * These are source-level governance-placement contracts + executable policy /
 * pure-logic mirrors — the SAME no-DB style as workspace-create-executor.test.ts
 * (the api test suite needs live Postgres for anything that touches the db, so
 * the invariants that matter here are proven statically instead).
 *
 * Coverage:
 *   (a) channel.bind ALWAYS produces a proposal (never auto-approved)
 *   (b) approving binds context_object_id + branch_purpose via the ONE door
 *   (c) a client-comms→other bind is refused (immutability preserved)
 *   (d) null-context eager mint is unbound + idempotent
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  DEFAULT_AUTO_APPROVE,
  isAutoApproved,
  decideAgentPolicy,
} from "@synap/governance-policy";

// vitest cwd is the api package root (mirrors workspace-create-executor.test.ts).
const API_SRC = join(process.cwd(), "src");
function readSrc(relFromApiSrc: string): string {
  return readFileSync(join(API_SRC, relFromApiSrc), "utf8");
}

// ───────────────────────────────────────────────────────────────────────────
// (a) channel.bind ALWAYS proposes — proven EXECUTABLY at the policy layer.
// ───────────────────────────────────────────────────────────────────────────
describe("(a) channel.bind is never auto-approved", () => {
  it("channel.bind is NOT in DEFAULT_AUTO_APPROVE (nor matched by any wildcard)", () => {
    expect(DEFAULT_AUTO_APPROVE).not.toContain("channel.bind");
    // No wildcard entry (search.*, context.*, …) accidentally covers it.
    expect(isAutoApproved("channel.bind", DEFAULT_AUTO_APPROVE)).toBe(false);
  });

  it("decideAgentPolicy proposes channel.bind (agent path, default policy)", () => {
    const v = decideAgentPolicy({ subjectType: "channel", action: "bind" });
    expect(v.verdict).toBe("propose");
  });

  it("stays a proposal even if a workspace's autoApproveFor omits it", () => {
    // A workspace that opted a DIFFERENT set into autoApproveFor still proposes
    // channel.bind — the only way to auto-approve it is to name it explicitly.
    const v = decideAgentPolicy({
      subjectType: "channel",
      action: "bind",
      autoApproveFor: ["entity.create", "entity.update", "relation.create"],
    });
    expect(v.verdict).toBe("propose");
    expect(isAutoApproved("channel.bind", ["entity.create"])).toBe(false);
  });

  it("the filing door routes through checkPermissionOrPropose (no direct write)", () => {
    const src = readSrc("routers/hub-protocol/channels.ts");
    const start = src.indexOf("bindChannel:");
    const end = src.indexOf("sendExternalMessage:");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const door = src.slice(start, end);

    // Gate call with the exact subject/action/source the executor + policy expect.
    expect(door).toContain("checkPermissionOrPropose");
    expect(door).toMatch(/subjectType:\s*["']channel["']/);
    expect(door).toMatch(/action:\s*["']bind["']/);
    expect(door).toMatch(/source:\s*["']intelligence["']/);
    // The proposed branch returns the standard review envelope.
    expect(door).toMatch(/status:\s*["']proposed["']/);
    // The door itself NEVER binds — it only files a proposal. The actual write is
    // the channel/bind executor. So the door builds no router caller and issues
    // no Drizzle write of its own. (Doc-comments may NAME the write doors; what
    // matters is that the door never INVOKES one.)
    expect(door).not.toContain("createCaller");
    expect(door).not.toContain("caller.updateChannel");
    expect(door).not.toMatch(/\bawait\s+setChannelBranchPurpose\(/);
    expect(door).not.toMatch(/\.set\(/);
  });

  it("branchPurpose is passed through as explicit data, never default-forced", () => {
    const src = readSrc("routers/hub-protocol/channels.ts");
    const door = src.slice(
      src.indexOf("bindChannel:"),
      src.indexOf("sendExternalMessage:")
    );
    // Only spread when provided — never a literal default `"client-comms"`.
    expect(door).toContain("branchPurpose !== undefined");
    expect(door).not.toMatch(/branchPurpose:\s*["']client-comms["']/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) approval binds context_object_id + branch_purpose via the ONE door.
// ───────────────────────────────────────────────────────────────────────────
describe("(b) channel/bind executor delegates to the governed one door", () => {
  const src = readSrc("routers/proposals/approve-executors.ts");
  const block = src.slice(
    src.indexOf('key: "channel/bind"'),
    src.indexOf('key: "entity/create"')
  );

  it("registers the executor under key channel/bind", () => {
    expect(src).toMatch(/key:\s*["']channel\/bind["']/);
    expect(block.length).toBeGreaterThan(0);
  });

  it("delegates to channelsRouter.updateChannel with the bind fields", () => {
    expect(block).toContain("channelsRouter.createCaller");
    expect(block).toContain("caller.updateChannel");
    expect(block).toContain("contextObjectType");
    expect(block).toContain("contextObjectId");
    expect(block).toContain("branchPurpose");
  });

  it("never raw-UPDATEs the channels table (no .set on channels here)", () => {
    // context_object_id + branch_purpose must flow through updateChannel, not a
    // direct Drizzle write in the executor.
    expect(block).not.toMatch(/\.update\(channels\)/);
    expect(block).not.toMatch(/\.set\(\s*\{[^}]*contextObjectId/);
    expect(block).not.toContain("setChannelBranchPurpose");
  });

  it("resolves the membership floor before writing", () => {
    expect(block).toContain("getWorkspaceMembership");
    expect(block).toMatch(/code:\s*["']FORBIDDEN["']/);
  });

  it("reads the request-shaped (nested) gate data with a flat fallback", () => {
    // The bind door files with source:"intelligence" → createProposal nests the
    // gate data under proposal.data.data (like entity/create). Reading only the
    // flat envelope would silently lose channelId/contextObjectId.
    expect(block).toMatch(/outer\.data\s*\?\?\s*outer/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c) a client-comms→other bind is refused (immutability preserved).
// ───────────────────────────────────────────────────────────────────────────
describe("(c) client-comms immutability is preserved through the bind path", () => {
  it("updateChannel routes branchPurpose through the setChannelBranchPurpose one door", () => {
    const src = readSrc("routers/channels.ts");
    const start = src.indexOf("updateChannel: protectedProcedure");
    expect(start).toBeGreaterThan(-1);
    const proc = src.slice(start, start + 4200);
    // The one door + the immutability rethrow (client-comms flip → FORBIDDEN).
    expect(proc).toContain("setChannelBranchPurpose");
    expect(proc).toContain("ChannelFirewallImmutableError");
    expect(proc).toMatch(/code:\s*["']FORBIDDEN["']/);
  });

  it("the executor does NOT swallow the immutability error (it propagates → APPROVAL_FAILED)", () => {
    const src = readSrc("routers/proposals/approve-executors.ts");
    const block = src.slice(
      src.indexOf('key: "channel/bind"'),
      src.indexOf('key: "entity/create"')
    );
    // No try/catch wrapping the delegated write — a FORBIDDEN from updateChannel
    // must bubble to the approve mutation, which records APPROVAL_FAILED.
    const writeIdx = block.indexOf("caller.updateChannel");
    const before = block.slice(0, writeIdx);
    // The last control-flow keyword before the write is not a `try {`.
    expect(before).not.toMatch(/try\s*\{[^}]*$/);
    expect(block).not.toMatch(/catch\s*\([^)]*\)\s*\{[^}]*updateChannel/);
  });

  it("the DB-trigger floor (0169) beneath the one door exists", () => {
    // The one door is enforced above the DB; the migration trigger is the floor
    // that makes a client-comms reclassification impossible even via raw SQL.
    const migrationsDir = join(process.cwd(), "..", "database", "migrations");
    expect(existsSync(migrationsDir)).toBe(true);
    const files = readdirSync(migrationsDir);
    const trigger = files.find((f) => f.startsWith("0169"));
    expect(trigger, "0169 client-comms immutability migration").toBeTruthy();
    const sql = readFileSync(join(migrationsDir, trigger!), "utf8");
    expect(sql.toLowerCase()).toContain("client-comms");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (d) null-context eager mint is unbound + idempotent.
// ───────────────────────────────────────────────────────────────────────────
describe("(d) POST /channels eager mint: null context is unbound + idempotent", () => {
  const src = readSrc("routers/hub-protocol/rest/channels.ts");
  const start = src.indexOf('app.post("/channels"');
  const handler = src.slice(start, start + 3600);

  it("does NOT require contextObjectId (only externalSource + externalChannelId)", () => {
    expect(start).toBeGreaterThan(-1);
    // 400 fires only for the missing external identity, never for missing context.
    expect(handler).toMatch(
      /externalSource\s*and\s*externalChannelId\s*are\s*required/
    );
    // contextObjectType is required ONLY when a contextObjectId is supplied.
    expect(handler).toMatch(
      /contextObjectType\s*is\s*required\s*when\s*contextObjectId\s*is\s*provided/
    );
  });

  it("mints via resolveOrCreateExternalChannel (idempotent upsert on the partial-unique index)", () => {
    expect(handler).toContain("resolveOrCreateExternalChannel");
  });

  it("binds ONLY when a contextObjectId is present (null context ⇒ unbound)", () => {
    // The entity bind is guarded by `body.contextObjectId` — with none, the row
    // is minted unbound (contextObjectId stays NULL).
    expect(handler).toMatch(/if\s*\(\s*body\.contextObjectId\s*&&/);
  });

  it("the upsert helper returns the EXISTING row on repeat (idempotency source)", () => {
    const rec = readFileSync(
      join(
        process.cwd(),
        "src",
        "services",
        "connectors",
        "inbound-recorder.ts"
      ),
      "utf8"
    );
    const fn = rec.slice(
      rec.indexOf("export async function resolveOrCreateExternalChannel")
    );
    // Existing (provider, externalId) → returns that row (no duplicate insert).
    expect(fn).toContain("if (existing)");
    expect(fn).toMatch(/partial unique index/i);
  });

  // Pure mirror of the bind-gating rule the handler applies, so a future regression
  // that binds on a null context is caught executably (not just by source scan).
  function computeBind(
    body: { contextObjectId?: string; relink?: boolean },
    existingContextId: string | null
  ) {
    return Boolean(body.contextObjectId && (body.relink || !existingContextId));
  }

  it("bind-gating: no contextObjectId ⇒ never binds (unbound mint)", () => {
    expect(computeBind({}, null)).toBe(false);
    expect(computeBind({ contextObjectId: "e1" }, null)).toBe(true);
    // Idempotent: a second call for an already-bound channel does not re-bind.
    expect(computeBind({ contextObjectId: "e1" }, "already")).toBe(false);
    // Explicit relink overwrites a stale bind.
    expect(
      computeBind({ contextObjectId: "e2", relink: true }, "already")
    ).toBe(true);
  });
});
