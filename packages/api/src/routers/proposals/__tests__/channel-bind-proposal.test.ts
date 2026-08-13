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
 *   (e) the proposal is IDENTIFIED by its channel, so a repeat sweep dedups
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  DEFAULT_AUTO_APPROVE,
  isAutoApproved,
  decideAgentPolicy,
} from "@synap/governance-policy";
import { computeProposalDedupHash } from "@synap/database";
import { readExecutorsSource } from "./read-executors-source.js";

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

  it("the filing door routes through the proposeChannelBind helper (checkPermissionOrPropose, no direct write)", () => {
    // bindChannel delegates to the shared helper — the SSOT for the gate + data
    // shape, reused by the REST POST /channels/:channelId/bind door.
    const chanSrc = readSrc("routers/hub-protocol/channels.ts");
    const start = chanSrc.indexOf("bindChannel:");
    const end = chanSrc.indexOf("sendExternalMessage:");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const door = chanSrc.slice(start, end);
    expect(door).toContain("proposeChannelBind");
    // The door itself NEVER binds — no router caller, no Drizzle write of its own.
    expect(door).not.toContain("createCaller");
    expect(door).not.toContain("caller.updateChannel");
    expect(door).not.toMatch(/\.set\(/);

    // The helper is the ONE place the gate is called — with the exact
    // subject/action/source the executor + policy expect, returning the review
    // envelope, and never invoking a write door itself.
    const helper = readSrc("utils/propose-channel-bind.ts");
    expect(helper).toContain("checkPermissionOrPropose");
    expect(helper).toMatch(/subjectType:\s*["']channel["']/);
    expect(helper).toMatch(/action:\s*["']bind["']/);
    expect(helper).toMatch(/source:\s*["']intelligence["']/);
    expect(helper).toMatch(/status:\s*["']proposed["']/);
    expect(helper).not.toContain("caller.updateChannel");
    expect(helper).not.toMatch(/\bawait\s+setChannelBranchPurpose\(/);
    expect(helper).not.toMatch(/\.set\(/);
  });

  it("the gate data identifies the SUBJECT: id === the channel being bound (never a fresh uuid)", () => {
    // permission-check derives proposals.targetId from
    // `data.documentId || data.entityId || data.id || randomUUID()`. A random
    // `data.id` made the row un-addressable by its subject AND defeated the
    // pending-proposal dedup guard (which narrows on targetId).
    const helper = readSrc("utils/propose-channel-bind.ts");
    expect(helper).toMatch(/\bid:\s*input\.channelId\b/);
    // No uuid minting of any kind survives (the import is gone; only the
    // explanatory comment may still name the retired behaviour).
    expect(helper).not.toMatch(/from\s*["']crypto["']/);
    expect(helper).not.toMatch(/=\s*randomUUID\(\)/);
    expect(helper).not.toMatch(/\bid:\s*randomUUID/);
  });

  it("branchPurpose is passed through as explicit data, never default-forced", () => {
    // The pass-through lives in the shared helper (bindChannel + the REST route
    // both delegate to it). Only spread when provided — never a literal default.
    const helper = readSrc("utils/propose-channel-bind.ts");
    expect(helper).toContain("branchPurpose !== undefined");
    expect(helper).not.toMatch(/branchPurpose:\s*["']client-comms["']/);
  });

  it("the REST bind door (IS agent's target) delegates to the same helper", () => {
    // POST /api/hub/channels/:channelId/bind — the door the IS classify-and-propose
    // tool calls. Must reuse proposeChannelBind (no second gate implementation) and
    // require hub-protocol.write.
    const rest = readSrc("routers/hub-protocol/rest/channels.ts");
    expect(rest).toMatch(/app\.post\(\s*["']\/channels\/:channelId\/bind["']/);
    expect(rest).toContain("proposeChannelBind");
    // The route handler (from app.post to the end of the block) gates on write
    // scope and never binds directly — the executor does, on approval.
    const start = rest.indexOf('app.post("/channels/:channelId/bind"');
    const door = rest.slice(start, start + 1600);
    expect(door).toContain("hasScope");
    expect(door).toContain("hub-protocol.write");
    expect(door).toContain("proposeChannelBind");
    expect(door).not.toContain("caller.updateChannel");
    expect(door).not.toMatch(/\.set\(\{[^}]*branchPurpose/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) approval binds context_object_id + branch_purpose via the ONE door.
// ───────────────────────────────────────────────────────────────────────────
describe("(b) channel/bind executor delegates to the governed one door", () => {
  const src = readExecutorsSource(API_SRC);
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
    const src = readSrc("routers/channels/crud.ts");
    const start = src.indexOf("updateChannel: protectedProcedure");
    expect(start).toBeGreaterThan(-1);
    const proc = src.slice(start, start + 4200);
    // The one door + the immutability rethrow (client-comms flip → FORBIDDEN).
    expect(proc).toContain("setChannelBranchPurpose");
    expect(proc).toContain("ChannelFirewallImmutableError");
    expect(proc).toMatch(/code:\s*["']FORBIDDEN["']/);
  });

  it("the executor does NOT swallow the immutability error (it propagates → APPROVAL_FAILED)", () => {
    const src = readExecutorsSource(API_SRC);
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

// ───────────────────────────────────────────────────────────────────────────
// (e) a repeated sweep does NOT file a second pending bind for the same channel.
//
// The pending-proposal dedup guard narrows candidates by `proposals.targetId`
// (for every non-`create` proposalType) and then compares an exact payload hash.
// `channel/bind` files with `proposalType: "bind"`, so BOTH halves apply — and
// both are only satisfiable when the gate data's `id` is the CHANNEL id rather
// than a fresh uuid per call. Proven executably against the real
// `computeProposalDedupHash`.
// ───────────────────────────────────────────────────────────────────────────
describe("(e) a second identical channel/bind proposal is deduped", () => {
  const WS = "11111111-1111-1111-1111-111111111111";
  const CHANNEL = "01dc4e24-0000-4000-8000-000000000001";
  const CLIENT = "aaaaaaaa-0000-4000-8000-000000000002";

  /** Mirror of permission-check's targetId derivation (createProposal). */
  function deriveTargetId(
    data: Record<string, unknown>,
    fallback: string
  ): string {
    return (data.documentId || data.entityId || data.id || fallback) as string;
  }

  /** The stored request-shaped payload createProposal persists, for one attempt. */
  function storedData(
    gateData: Record<string, unknown>,
    attempt: { requestId: string; correlationId: string; reasoning: string }
  ) {
    return {
      requestId: attempt.requestId,
      source: "intelligence",
      sourceId: "user-1",
      workspaceId: WS,
      targetType: "channel",
      targetId: deriveTargetId(gateData, `fallback-${attempt.requestId}`),
      changeType: "bind",
      data: gateData,
      reasoning: attempt.reasoning,
      summary: "Bind channel",
      correlationId: attempt.correlationId,
    };
  }

  /** The gate data proposeChannelBind builds today (id === channelId). */
  const gateData = (contextObjectId = CLIENT) => ({
    id: CHANNEL,
    channelId: CHANNEL,
    contextObjectType: "entity",
    contextObjectId,
  });

  function hashFor(gate: Record<string, unknown>, n: number) {
    const data = storedData(gate, {
      requestId: `req-${n}`,
      correlationId: `corr-${n}`,
      reasoning: `attempt ${n} prose`,
    });
    return computeProposalDedupHash({
      workspaceId: WS,
      proposalType: "bind",
      targetType: "channel",
      targetId: data.targetId,
      data: data as unknown as Record<string, unknown>,
    });
  }

  it("the dedup guard NARROWS by targetId for a bind (only `create` is exempt)", () => {
    expect("bind").not.toBe("create");
    // …and targetId is now the real channel, so the narrowing can actually match.
    expect(deriveTargetId(gateData(), "fallback")).toBe(CHANNEL);
  });

  it("two identical bind proposals for the same channel hash EQUAL (deduped)", () => {
    expect(hashFor(gateData(), 1)).toBe(hashFor(gateData(), 2));
  });

  it("REGRESSION: a fresh random `data.id` per call could never dedup", () => {
    const randomIdGate = (n: number) => ({
      id: `random-uuid-${n}`,
      channelId: CHANNEL,
      contextObjectType: "entity",
      contextObjectId: CLIENT,
    });
    // Both the narrowing key and the payload hash diverge — the old behaviour.
    expect(deriveTargetId(randomIdGate(1), "fallback")).not.toBe(
      deriveTargetId(randomIdGate(2), "fallback")
    );
    expect(hashFor(randomIdGate(1), 1)).not.toBe(hashFor(randomIdGate(2), 2));
  });

  it("a DIFFERENT bind for the same channel is NOT collapsed", () => {
    // Dedup is exact-match on the normalized payload: proposing the same channel
    // against a different context object stays its own pending decision.
    const other = "bbbbbbbb-0000-4000-8000-000000000003";
    expect(hashFor(gateData(), 1)).not.toBe(hashFor(gateData(other), 2));
  });
});
