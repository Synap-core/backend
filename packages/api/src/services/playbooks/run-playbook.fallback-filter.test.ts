/**
 * A pinned playbook whose stored fallback filter cannot be read refuses the
 * run with a typed BAD_REQUEST naming the playbook: never a 500, and never a
 * pick from every record of the kind.
 *
 * The REAL run spine, pin choice and `findFallbackSubject` run; only the
 * playbook lookup is stubbed, and the database throws on any read, which
 * proves the filter is refused before anything is read.
 */
import { describe, it, expect, vi } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDb: async () => {
    throw new Error("NO_DB_READ");
  },
}));

const h = vi.hoisted(() => ({
  filter: undefined as unknown,
  playbook: (filter: unknown) => ({
    id: "pb-1",
    name: "Follow up the oldest deal",
    goalTemplate: "Follow up",
    subjectProfile: { profileSlug: "deal" },
    inputStrategy: { kind: "pinned", fallback: { filter } },
    metadata: {},
  }),
}));

vi.mock("./playbook-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRunnablePlaybook: async () => h.playbook(h.filter),
}));

const { runPlaybook } = await import("./run-playbook.js");

const INPUT = { playbookId: "pb-1", workspaceId: "ws-1", userId: "owner-1" };

async function refusal(filter: unknown): Promise<TRPCError> {
  h.filter = filter;
  const err = await runPlaybook(INPUT).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(TRPCError);
  return err as TRPCError;
}

describe("runPlaybook — an unreadable fallback filter", () => {
  it("an array filter: BAD_REQUEST naming the playbook, nothing read", async () => {
    const err = await refusal(["stage"]);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toMatch(
      /^Nothing ran: the subject fallback filter of "Follow up the oldest deal" cannot be read \(query node: filter must be an object or a JSON string, got an array/
    );
  });

  it("a string filter that is not JSON: BAD_REQUEST too", async () => {
    const err = await refusal('{"stage": "open"');
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toMatch(/not valid JSON after templating/);
  });

  it("a readable filter is not refused: the run goes on to read", async () => {
    h.filter = { stage: "open" };
    await expect(runPlaybook(INPUT)).rejects.toThrow("NO_DB_READ");
  });
});
