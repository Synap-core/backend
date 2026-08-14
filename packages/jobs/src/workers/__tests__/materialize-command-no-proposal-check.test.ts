/**
 * SECURITY REGRESSION — `handleMaterialize` must refuse an unproven payload.
 *
 * HISTORY: this file began as a probe that PROVED an RCE. `handleMaterialize`
 * trusted its pg-boss payload absolutely — it never verified that a proposal
 * existed, that it was approved, or that `userId` could write to
 * `workspaceId`. For `subjectType: "command"` it handed `data.command` straight
 * to `execFileSync("/bin/sh", ["-c", command])` on the pod host. Combined with
 * `trpc.events.log` accepting a free-form `eventType`, any authenticated
 * session could append `command.execute.validated` and get a host shell.
 *
 * The probe really did execute the shell and write a file. These tests keep
 * that exact attack shape and now assert it is REFUSED — so the fix cannot
 * regress silently. If the shell ever runs again, case 1 fails loudly.
 *
 * The post-write `.completed` append is stubbed so the test writes nothing to
 * the developer's event log.
 */

import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventRepository } from "@synap/database";
import { handleMaterialize } from "../materializer.js";

const marker = join(tmpdir(), `synap-materializer-probe-${process.pid}.txt`);

vi.spyOn(EventRepository.prototype, "append").mockResolvedValue({} as never);

// The gate reads the proposal before doing anything. `proposalRow` is what the
// stubbed lookup returns, so each test controls the authority the worker sees
// without needing a database.
let proposalRow: Record<string, unknown> | undefined;

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      ...(actual.db as object),
      query: {
        proposals: { findFirst: vi.fn(async () => proposalRow) },
      },
    },
  };
});

function commandJob(data: Record<string, unknown>) {
  return {
    id: "job-1",
    name: "materialize",
    data: {
      eventId: "33333333-3333-4333-8333-333333333333",
      eventType: "command.execute.validated",
      subjectType: "command",
      action: "execute",
      subjectId: "11111111-1111-4111-8111-111111111111",
      userId: "attacker-user",
      workspaceId: undefined,
      data: { command: `printf 'pwned' > ${marker}`, ...data },
    },
  } as never;
}

beforeEach(() => {
  if (existsSync(marker)) rmSync(marker);
  proposalRow = undefined; // default: the id resolves to nothing
});

afterAll(() => {
  if (existsSync(marker)) rmSync(marker);
});

describe("handleMaterialize — proposal authority gate", () => {
  it("REFUSES a command payload that references no proposal (the original RCE)", async () => {
    await handleMaterialize(commandJob({}));

    expect(
      existsSync(marker),
      "SECURITY REGRESSION: shell ran without an approved proposal"
    ).toBe(false);
  });

  it("REFUSES when sourceProposalId does not resolve to a proposal", async () => {
    await handleMaterialize(
      commandJob({ sourceProposalId: "44444444-4444-4444-8444-444444444444" })
    );

    expect(
      existsSync(marker),
      "SECURITY REGRESSION: shell ran for a non-existent proposal"
    ).toBe(false);
  });

  it("REFUSES a non-string sourceProposalId", async () => {
    await handleMaterialize(commandJob({ sourceProposalId: 42 }));

    expect(
      existsSync(marker),
      "SECURITY REGRESSION: shell ran for a malformed sourceProposalId"
    ).toBe(false);
  });

  it("REFUSES when the proposal exists but is still PENDING", async () => {
    proposalRow = { id: "p1", status: "pending", workspaceId: "ws-1" };

    await handleMaterialize(commandJob({ sourceProposalId: "p1" }));

    expect(
      existsSync(marker),
      "SECURITY REGRESSION: shell ran for an unapproved proposal"
    ).toBe(false);
  });

  it("REFUSES when the proposal was REJECTED", async () => {
    proposalRow = { id: "p1", status: "rejected", workspaceId: "ws-1" };

    await handleMaterialize(commandJob({ sourceProposalId: "p1" }));

    expect(
      existsSync(marker),
      "SECURITY REGRESSION: shell ran for a rejected proposal"
    ).toBe(false);
  });

  // ── The other half of the contract ───────────────────────────────────────
  // The gate must not break real approvals. Both live emitters
  // (proposals/executors/catch-all.ts and .../workspace.ts) pass
  // `sourceProposalId`, so an approved proposal MUST still materialize.
  // Without these two cases the gate could silently disable every approval and
  // the suite would still be green.

  it("ALLOWS an APPROVED proposal to materialize", async () => {
    proposalRow = { id: "p1", status: "approved", workspaceId: "ws-1" };

    await handleMaterialize(commandJob({ sourceProposalId: "p1" }));

    expect(
      existsSync(marker),
      "REGRESSION: an approved proposal was refused — approvals are broken"
    ).toBe(true);
  });

  it("ALLOWS an AUTO_APPROVED proposal to materialize", async () => {
    proposalRow = { id: "p1", status: "auto_approved", workspaceId: "ws-1" };

    await handleMaterialize(commandJob({ sourceProposalId: "p1" }));

    expect(
      existsSync(marker),
      "REGRESSION: an auto-approved proposal was refused"
    ).toBe(true);
  });
});
