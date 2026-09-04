/**
 * CAPTURE-DOOR SESSION PARITY.
 *
 * Two doors reach `capture.execute` and both attribute the capture to a focus
 * session — but they used to carry different TRUST:
 *
 *   MCP   `handlers/capture.ts` → resolveSessionHandle (ownership-checked)
 *                               → forwarded as `input.sessionId`
 *   tRPC  the Relay app          → `input.sessionId` straight off the body,
 *                                  a bare `z.string().uuid()` nothing validated
 *
 * Both land on the SAME field, so the weaker door set the real floor: a caller
 * could stamp another user's session onto the capture proposal, the
 * `session --produced--> entity` links, and the workspace/project placement
 * rungs. That user's session graph would then show an edge to a foreign entity.
 *
 * `resolveVerifiedSessionId` is the one door that closes it. Its behaviour is
 * exercised directly; the wiring (that both callers actually reach it, and that
 * no raw body handle survives downstream) is asserted against the source,
 * because driving `capture.execute` end to end needs Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// `ownsFocusSession` is called from INSIDE its own module, so an ESM
// `vi.spyOn` on the namespace does not intercept it — the binding is direct.
// The mock therefore goes one layer down, at the only thing that decides the
// answer: whether the DB finds a `focus_sessions` row for (id, userId).
const h = vi.hoisted(() => ({ rows: [] as { id: string }[], queries: 0 }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              h.queries += 1;
              return h.rows;
            },
          }),
        }),
      }),
    },
  };
});

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { resolveVerifiedSessionId } from "./hub-protocol/_middleware/session.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER = "user-owner";
const OWNED = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";

/** "the ownership query found a row" / "it found nothing". */
const dbFinds = (found: boolean) => {
  h.rows = found ? [{ id: OWNED }] : [];
};

beforeEach(() => {
  h.rows = [];
  h.queries = 0;
});

describe("resolveVerifiedSessionId", () => {
  it("keeps a header handle without paying for a second ownership round-trip", async () => {
    expect(await resolveVerifiedSessionId(OWNER, OWNED, undefined)).toBe(OWNED);
    expect(h.queries).toBe(0);
  });

  it("accepts a BODY handle the caller owns — the Relay door's only handle", async () => {
    dbFinds(true);
    expect(await resolveVerifiedSessionId(OWNER, undefined, OWNED)).toBe(OWNED);
    expect(h.queries).toBe(1);
  });

  it("DROPS a body handle belonging to someone else", async () => {
    dbFinds(false);
    expect(
      await resolveVerifiedSessionId(OWNER, undefined, FOREIGN)
    ).toBeUndefined();
    expect(h.queries).toBe(1);
  });

  it("drops a body handle that is not a uuid before touching the database", async () => {
    dbFinds(true); // would PASS if the shape check did not run first
    expect(
      await resolveVerifiedSessionId(OWNER, undefined, "not-a-uuid")
    ).toBeUndefined();
    expect(h.queries).toBe(0);
  });

  it("is null for a human caller with no session anywhere", async () => {
    expect(
      await resolveVerifiedSessionId(OWNER, undefined, undefined)
    ).toBeUndefined();
    expect(await resolveVerifiedSessionId(OWNER, null, null)).toBeUndefined();
  });

  // The floor is DROP, never THROW: a capture the user meant to make must not
  // fail because a session closed or a stale id was cached client-side.
  it("never throws on a foreign handle — attribution degrades, the write survives", async () => {
    dbFinds(false);
    await expect(
      resolveVerifiedSessionId(OWNER, undefined, FOREIGN)
    ).resolves.toBeUndefined();
  });
});

describe("both doors reach the same verified handle", () => {
  const captureSrc = readFileSync(join(HERE, "capture.ts"), "utf8");
  const mcpSrc = readFileSync(join(HERE, "mcp/handlers/capture.ts"), "utf8");

  it("the MCP door forwards its session under the SAME field name the body uses", () => {
    // Parity is only real because both doors land on `input.sessionId`. If the
    // MCP door invented its own field, the tRPC check would guard nothing.
    expect(mcpSrc).toMatch(/sessionId \? \{ sessionId \} : \{\}/);
  });

  it("capture.execute resolves the handle through the one door, once", () => {
    expect(captureSrc).toContain(
      "const sessionId = await resolveVerifiedSessionId("
    );
    // Exactly ONE call site — a second, unverified read of the body field is
    // the whole defect coming back.
    expect(captureSrc.match(/resolveVerifiedSessionId\(/g)?.length).toBe(1);
  });

  it("no raw input.sessionId survives downstream of that resolution", () => {
    // Every consumer — the capture proposal, the produced-links, the placement
    // rungs — must read the VERIFIED local, not the body field. A single
    // straggler reintroduces the whole leak.
    // Start AFTER the resolution's own argument list — `input.sessionId` is
    // legitimately named there, as its input.
    const call = "const sessionId = await resolveVerifiedSessionId(";
    const after = captureSrc.slice(
      captureSrc.indexOf(");", captureSrc.indexOf(call))
    );
    expect(after).not.toContain("input.sessionId");
  });
});

describe("capture.execute stamps threadId onto the proposal", () => {
  const captureSrc = readFileSync(join(HERE, "capture.ts"), "utf8");
  const mcpSrc = readFileSync(join(HERE, "mcp/handlers/capture.ts"), "utf8");
  const executeSrc = captureSrc.slice(
    captureSrc.indexOf("  execute: podProcedure"),
    captureSrc.indexOf("  executeWithSchema:")
  );

  it("execute input accepts optional threadId uuid", () => {
    const inputBlock = executeSrc.slice(0, executeSrc.indexOf(".mutation("));
    expect(inputBlock).toMatch(
      /threadId:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/
    );
  });

  it("forwards input.threadId into checkPermissionOrPropose", () => {
    // Anchored on the CALL, not on the assignment statement: the gate is now
    // reached through a ternary (an empty capture has no batch to derive a
    // gate pair from, so it never calls the gate at all). The assertion below
    // is unchanged — this only stops the anchor from pinning a formatting
    // detail of the surrounding statement.
    const start = executeSrc.indexOf("await checkPermissionOrPropose({");
    expect(start).toBeGreaterThan(-1);
    const permCall = executeSrc.slice(
      start,
      executeSrc.indexOf("});", start) + 3
    );
    expect(permCall).toMatch(/threadId:\s*input\.threadId/);
  });

  it("returns threadId on both proposed and granted execute responses", () => {
    const proposed = executeSrc.slice(
      executeSrc.indexOf('if ("proposalId" in perm)'),
      executeSrc.indexOf("Identity-first:")
    );
    expect(proposed).toMatch(/threadId:\s*input\.threadId/);
    const grantedReturn = executeSrc.slice(executeSrc.lastIndexOf("return {"));
    expect(grantedReturn).toMatch(/threadId:\s*input\.threadId/);
  });

  it("auto-approved recorder also receives threadId so receipts land on the channel", () => {
    const start = executeSrc.indexOf("await createAutoApprovedProposal({");
    expect(start).toBeGreaterThan(-1);
    const call = executeSrc.slice(start, start + 2500);
    expect(call).toMatch(/threadId:\s*input\.threadId/);
  });

  it("MCP opens a capture RUN channel before execute and passes channel.id as threadId", () => {
    const execIdx = mcpSrc.indexOf(
      "const executed = await captureCaller.execute({"
    );
    expect(execIdx).toBeGreaterThan(-1);
    const before = mcpSrc.slice(0, execIdx);
    const execCall = mcpSrc.slice(execIdx, mcpSrc.indexOf("});", execIdx) + 3);
    expect(before).toMatch(/openProcessChannel\(/);
    expect(before).toMatch(/flowType:\s*["']capture["']/);
    expect(before).toMatch(/idempotencyKey:\s*["']user-input["']/);
    expect(execCall).toMatch(/threadId:\s*channel\.id/);
  });

  it("MCP posts an assistant receipt after execute and does not wait for approval", () => {
    const execIdx = mcpSrc.indexOf(
      "const executed = await captureCaller.execute({"
    );
    const after = mcpSrc.slice(execIdx);
    expect(after).toMatch(/openProcessChannel\(/);
    expect(after).toMatch(/Queued for your review/);
    expect(after).toMatch(/Saved \$\{/);
    expect(after).not.toMatch(/waitForApproval|await.*approv/i);
  });
});
