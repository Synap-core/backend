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
    // The forwarded key is still `sessionId`; since A1 (2026-09-14) the same
    // spread may also carry `sessionSource` (explicit vs derived session).
    expect(mcpSrc).toMatch(
      /sessionId \? \{ sessionId(?:, sessionSource: ctx\.sessionSource)? \} : \{\}/
    );
  });

  it("capture.execute resolves the handle through the one door, once", () => {
    // Scoped to execute's OWN body: `capture.structure` legitimately verifies
    // the same handle for its run-cap pre-check, so a file-wide count would
    // read that second VERIFIED call as the defect.
    const start = captureSrc.indexOf("\n  execute: podProcedure");
    const end = captureSrc.indexOf("\n  executeWithSchema: podProcedure");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const executeSrc = captureSrc.slice(start, end);
    expect(executeSrc).toContain(
      "const sessionId = await resolveVerifiedSessionId("
    );
    // Exactly ONE call site inside execute — a second, unverified read of the
    // body field is the whole defect coming back.
    expect(executeSrc.match(/resolveVerifiedSessionId\(/g)?.length).toBe(1);
  });

  it("every file-wide read of the body handle goes through the verified door", () => {
    // Each `resolveVerifiedSessionId(` call passes `input.sessionId` as an
    // argument; any OTHER raw read must be one of the known safe forwards.
    const calls = captureSrc.match(/resolveVerifiedSessionId\(/g)?.length ?? 0;
    expect(calls).toBeGreaterThanOrEqual(1);
    const rawReads = captureSrc
      .split("\n")
      .filter((l) => /input\.sessionId/.test(l) && !/^\s*\/\//.test(l));
    const knownSafe = rawReads.filter(
      (l) =>
        /^\s*input\.sessionId,?\s*$/.test(l) || // an argument to the verified door
        /input\.sessionId \?\? ctx\.sessionId \?\? null/.test(l) || // execute's requested handle, verified next line
        /bodyHandle: input\.sessionId \?\? null/.test(l) || // structure's intake run verifies bodyHandle
        // answerFollowUp: `claimCaptureQuestion` loads the session WHERE userId =
        // caller and NOT_FOUNDs any miss before the re-run reads it again.
        /^\s*sessionId: input\.sessionId,\s*$/.test(l) ||
        /restructureInput\(claim\.refine, input\.answer, input\.sessionId\)/.test(
          l
        )
    );
    // Those two forms must stay inside answerFollowUp, after the ownership claim.
    const answerSrc = captureSrc.slice(
      captureSrc.indexOf("\n  answerFollowUp: podProcedure")
    );
    expect(answerSrc.indexOf("claimCaptureQuestion(")).toBeGreaterThan(0);
    expect(answerSrc.indexOf("claimCaptureQuestion(")).toBeLessThan(
      answerSrc.indexOf("restructureInput(claim.refine")
    );
    expect(
      rawReads.filter((l) => /^\s*sessionId: input\.sessionId,\s*$/.test(l))
        .length
    ).toBe(1);
    expect(rawReads.length).toBeGreaterThan(0);
    expect(rawReads).toEqual(knownSafe);
  });

  it("no raw input.sessionId survives downstream of that resolution", () => {
    // Every consumer — the capture proposal, the produced-links, the placement
    // rungs — must read the VERIFIED local, not the body field. A single
    // straggler reintroduces the whole leak.
    // Start AFTER the resolution's own argument list — `input.sessionId` is
    // legitimately named there, as its input.
    // Scoped to the END of capture.execute: later procedures (answerFollowUp)
    // own their session read, pinned by the file-wide test above.
    const call = "const sessionId = await resolveVerifiedSessionId(";
    const executeEnd = captureSrc.indexOf(
      "\n  executeWithSchema: podProcedure"
    );
    expect(executeEnd).toBeGreaterThan(captureSrc.indexOf(call));
    const after = captureSrc.slice(
      captureSrc.indexOf(");", captureSrc.indexOf(call)),
      executeEnd
    );
    expect(after.length).toBeGreaterThan(1000);
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
