/**
 * `slug` must survive the read path that ends at `synap skill list`.
 *
 * The chain is `GET /api/hub/agent-skills/executable` → hub `skills.getSkills`
 * → tRPC `skills.list` → `ctx.db.query.skills.findMany`. `slug` is the ref
 * `synap skill approve` / `synap_load_skill` resolve, and the CLI prints it
 * (`s.slug ?? s.name`) — so if any link in that chain narrows the projection,
 * the identifier a user copies off the listing silently degrades to the NAME,
 * which no other command can resolve. Verified present live on 2026-09-03
 * (`biz/business-plan`, `system/synap-market/install`, …), and pinned here so
 * it stays that way.
 *
 * The stub REPRODUCES the regression on demand: it honours a `columns:`
 * projection exactly as drizzle would, so narrowing `skills.list` — the one
 * edit that would break this without breaking a typecheck — fails this test.
 */

import { describe, it, expect } from "vitest";
import { skillsRouter } from "./skills.js";

const ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "biz/business-plan",
  name: "Business plan from a decision journal",
  kind: "instruction",
  scope: "pod",
  status: "active",
  approved: true,
  userId: "user-1",
  workspaceId: null,
  metadata: { autoLoad: false },
};

function callerWithDb() {
  const ctx = {
    authenticated: true,
    userId: "user-1",
    db: {
      query: {
        skills: {
          findMany: async (opts?: { columns?: Record<string, boolean> }) => {
            // Drizzle semantics: an explicit `columns` map projects. No map =
            // every column. Modelling it is what makes a narrowing regression
            // reproducible here instead of only in production.
            if (!opts?.columns) return [ROW];
            return [
              Object.fromEntries(
                Object.entries(ROW).filter(([k]) => opts.columns?.[k] === true)
              ),
            ];
          },
        },
      },
    },
  };
  return skillsRouter.createCaller(ctx as never);
}

describe("skills.list projects slug", () => {
  it("returns the slug the CLI prints and load_skill resolves", async () => {
    const result = await callerWithDb().list({ limit: 50, offset: 0 });
    expect(result.skills).toHaveLength(1);
    expect((result.skills[0] as unknown as { slug?: string | null }).slug).toBe(
      "biz/business-plan"
    );
  });
});
