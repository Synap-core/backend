/**
 * The ONE default-workspace lookup is ORDERED and FLOORED (RV1 S7): never a
 * system or archived workspace, earliest joined first, with an id tie-break so
 * the answer is the same on every call (the bootstrap retries idempotently).
 * Rendered through drizzle's real PgDialect — no database needed.
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { findUserDefaultWorkspaceId } from "./user-default-workspace.js";

function recorder() {
  const seen: { where?: unknown; orderBy: unknown[] } = { orderBy: [] };
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    where: (w: unknown) => {
      seen.where = w;
      return chain;
    },
    orderBy: (...o: unknown[]) => {
      seen.orderBy = o;
      return chain;
    },
    limit: async () => [{ workspaceId: "ws-1" }],
  };
  return { db: { select: () => chain } as never, seen };
}

const render = (x: unknown) => new PgDialect().sqlToQuery(x as never).sql;

describe("findUserDefaultWorkspaceId", () => {
  it("floors out system + archived workspaces", async () => {
    const { db, seen } = recorder();
    expect(await findUserDefaultWorkspaceId(db, "u")).toBe("ws-1");
    const where = render(seen.where);
    expect(where).toContain(`"system_slug" is null`);
    expect(where).toContain(`"archived_at" is null`);
  });

  it("orders earliest-joined first with a workspace-id tie-break (deterministic)", async () => {
    const { db, seen } = recorder();
    await findUserDefaultWorkspaceId(db, "u");
    expect(seen.orderBy.map(render)).toEqual([
      `"workspace_members"."joined_at" asc`,
      `"workspace_members"."workspace_id" asc`,
    ]);
  });
});
