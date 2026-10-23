/**
 * The IS reads a user's skills through `skills.getSkills` (via
 * `GET /agent-skills/executable`). Builtin/declarative rows are excluded there
 * — and that exclusion must happen BEFORE the page limit, not after it.
 *
 * The defect this pins: one `limit: 100` page, filtered afterwards. 100 newer
 * builtin rows spent the whole page, the filter emptied it, and the user's
 * instruction skills and rules never reached the IS at all.
 *
 * The regular `skills.list` is replaced by an in-memory twin that honours
 * `kind` / `limit` / `offset` / newest-first exactly as the real query does, so
 * what is under test is how THIS door pages it.
 */

import { describe, it, expect, vi } from "vitest";

type Row = { id: string; kind: string; createdAt: Date };

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
const ROWS: Row[] = [
  // The page-spenders: 100 builtin rows, all NEWER than the user's own skills.
  ...Array.from({ length: 100 }, (_, i) => ({
    id: `builtin-${i}`,
    kind: "builtin",
    createdAt: at(1000 + i),
  })),
  { id: "declarative-1", kind: "declarative", createdAt: at(999) },
  { id: "rule-1", kind: "instruction", createdAt: at(20) },
  { id: "code-1", kind: "code", createdAt: at(10) },
  // More than one page of instruction rows: paging must reach every one.
  ...Array.from({ length: 101 }, (_, i) => ({
    id: `instruction-${i}`,
    kind: "instruction",
    createdAt: at(100 + i),
  })),
];

const listCalls: Array<Record<string, unknown>> = [];

vi.mock("../skills.js", () => ({
  skillsRouter: {
    createCaller: () => ({
      list: async (input: {
        kind?: string;
        limit?: number;
        offset?: number;
      }) => {
        listCalls.push(input);
        const limit = input.limit ?? 50;
        const offset = input.offset ?? 0;
        const skills = ROWS.filter((r) => !input.kind || r.kind === input.kind)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(offset, offset + limit);
        return { skills };
      },
    }),
  },
}));

vi.mock("./utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils.js")>()),
  createHubProtocolCallerContext: async () => ({}),
}));

vi.mock("./guard.js", () => ({ assertMayActAs: () => undefined }));

vi.mock("../../middleware/api-key-auth.js", async () => {
  const { publicProcedure } = await import("../../trpc.js");
  return {
    scopedProcedure: () =>
      publicProcedure.use(({ next }) =>
        next({ ctx: { userId: "user-1", scopes: [] } as never })
      ),
  };
});

const { skillsRouter } = await import("./skills.js");

describe("hub skills.getSkills — the kind filter runs before the limit", () => {
  it("returns the user's instruction + code skills even when 100 newer builtin rows exist", async () => {
    listCalls.length = 0;
    const out = (await skillsRouter
      .createCaller({} as never)
      .getSkills({ userId: "user-1", status: "active" })) as Row[];
    const ids = out.map((r) => r.id);

    expect(ids).toContain("rule-1");
    expect(ids).toContain("code-1");
    // Every instruction row, across more than one page.
    expect(ids.filter((id) => id.startsWith("instruction-"))).toHaveLength(101);
    // Never a builtin/declarative row.
    expect(
      out.every((r) => r.kind === "code" || r.kind === "instruction")
    ).toBe(true);
    // Newest first, as one list.
    const times = out.map((r) => r.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // Non-vacuity: the door actually asked the query to filter by kind.
    expect(listCalls.map((c) => c.kind)).toEqual(
      expect.arrayContaining(["code", "instruction"])
    );
  });
});
