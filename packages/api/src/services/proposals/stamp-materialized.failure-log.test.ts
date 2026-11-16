/**
 * A materialization that fails under its receipt leaves its cause in the
 * server log, under the receipt's id (finding 7ca4953f, 16 Nov 2026: 4 of 44
 * failed rows said only "an internal error occurred"). The approve door
 * already logs its failures with the proposal id (`dispatchProposalApproval`);
 * this path logged nothing. Redacted like that door's line: a log is shipped.
 */

import { describe, it, expect, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
}));

import { runMaterializationUnderReceipt } from "./stamp-materialized.js";

const TOKEN = "sk-live-AbCdEf0123456789XYZ";

describe("runMaterializationUnderReceipt logs the cause of a failure", () => {
  it("names the receipt, the class and the redacted cause with its stack", async () => {
    const fakeDb = {
      update: () => ({
        set: () => ({ where: async () => undefined }),
      }),
    } as unknown as Parameters<typeof runMaterializationUnderReceipt>[2];

    await expect(
      runMaterializationUnderReceipt(
        { id: "receipt-1", data: {} },
        async () => {
          throw new Error(`Upstream 500, Authorization: Bearer ${TOKEN}`);
        },
        fakeDb
      )
    ).rejects.toThrow();

    const line = warn.mock.calls.find(
      ([, msg]) => msg === "materialization under a receipt failed"
    );
    expect(line).toBeDefined();
    const fields = line![0] as Record<string, unknown>;
    expect(fields.proposalId).toBe("receipt-1");
    expect(fields.errorClass).toBe("unknown");
    expect(fields.err).toContain("Upstream 500");
    expect(fields.stack).toContain("stamp-materialized.failure-log.test");
    expect(JSON.stringify(fields)).not.toContain(TOKEN);
  });
});
