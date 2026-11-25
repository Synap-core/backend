/**
 * A PROSE rule (decision D1, founder, 20 Nov 2026, proposal 8d04d49e: a rule
 * is a guideline PUSHED into every piece of work in its scope; one store,
 * `skills`, `category: "rule"`) on the REAL queries, on PGlite.
 *
 * 1. PUSHED — the backend half. A pod agent's turn gets its rules from the IS
 *    `dynamic-skill-loader`, which reads `GET /agent-skills/executable` → hub
 *    `skills.getSkills` → tRPC `skills.list` (kind instruction, status active,
 *    approved) and puts every row with `category === "rule"` in its STANDING
 *    RULES tier, rendering `metadata.rule.intent` or, absent, the BODY
 *    (synap-intelligence-service `tools/dynamic-skill-loader.ts` `isRule`,
 *    `renderRule`). What this file pins is that the door feeds a prose rule in
 *    scope to the IS with its category and body, and keeps one out of scope or
 *    unapproved out — the one injection path, no second one.
 * 2. `sameNameSkill` counts a prose rule as a twin (it is written through the
 *    skill doors) and still leaves a rule-loop rule out.
 *
 * Real: `skills.list`, hub `skills.getSkills`, `visibleSkillsWhere`,
 * `ruleNotExpiredWhere`, `sameNameSkill`. Tables come from the Drizzle
 * definition. Not covered: the workspace tier of visibility (needs membership
 * tables; `visibleSkillsWhere` has its own suites).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema: { skills: schema.skills } as never });
  return { ...actual, db: h.db };
});

const USER = "user-1";
const OTHER = "user-2";

// The hub door builds its tRPC context from the key; here it is the user's
// context over the PGlite database, so `skills.list` runs its real query.
vi.mock("../../routers/hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHubProtocolCallerContext: async (userId: string) => ({
    db: h.db,
    authenticated: true,
    userId,
    user: null,
    session: null,
    req: undefined,
    workspaceId: null,
    agentUserId: null,
  }),
}));
vi.mock("../../routers/hub-protocol/guard.js", () => ({
  assertMayActAs: () => undefined,
}));
vi.mock("../../middleware/api-key-auth.js", async () => {
  const { publicProcedure } = await import("../../trpc.js");
  return {
    scopedProcedure: () =>
      publicProcedure.use(({ next }) =>
        next({ ctx: { userId: USER, scopes: [] } as never })
      ),
  };
});

import { getTableConfig } from "drizzle-orm/pg-core";
import { skills } from "@synap/database/schema";

const { skillsRouter: hubSkillsRouter } =
  await import("../../routers/hub-protocol/skills.js");
const { sameNameSkill } = await import("../skills/same-name-skill.js");

type ColumnLike = {
  name: string;
  primary: boolean;
  notNull: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function ddlForSkills(): string {
  const cfg = getTableConfig(skills);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const raw = c.getSQLType();
    const isArray = raw.endsWith("[]");
    const base = raw.replace(/\[\]$/, "").replace(/\(.*\)/, "");
    const type =
      /^(text|uuid|jsonb|boolean|integer|timestamp with time zone|timestamp)$/.test(
        base
      )
        ? base
        : "text";
    let def = "";
    if (c.hasDefault) {
      const d = c.default;
      if (isArray) def = " default '{}'";
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (typeof d === "string")
        def = ` default '${d.replace(/'/g, "''")}'`;
      else if (d && typeof d === "object" && !("queryChunks" in d))
        def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
    }
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

type Seed = {
  name: string;
  body?: string;
  userId?: string;
  scope?: "pod" | "user" | "workspace";
  kind?: string;
  approved?: boolean;
  category?: string | null;
  metadata?: unknown;
};

async function seed(s: Seed): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into skills (id, user_id, slug, kind, scope, name, body, status, approved, category, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10)`,
    [
      id,
      s.userId ?? USER,
      `rules/${s.name.toLowerCase().replace(/\W+/g, "-")}`,
      s.kind ?? "instruction",
      s.scope ?? "pod",
      s.name,
      s.body ?? `${s.name}: always do the thing.`,
      s.approved ?? true,
      s.category === undefined ? "rule" : s.category,
      s.metadata === undefined ? null : JSON.stringify(s.metadata),
    ]
  );
  return id;
}

let podProse = "";
let mineProse = "";
let loopRule = "";

beforeAll(async () => {
  await h.client!.exec(ddlForSkills());
  podProse = await seed({
    name: "Shared tree",
    body: "Never stash in a shared tree.",
    metadata: { autoLoad: false },
  });
  mineProse = await seed({ name: "My own rule", scope: "user" });
  loopRule = await seed({
    name: "Tag every new lead",
    metadata: {
      rule: {
        v: 1,
        intent: "Tag every new lead",
        scope: { kind: "pod" },
        behaviours: [],
      },
    },
  });
  // Out of the feed, each for its own reason.
  await seed({ name: "Someone else's rule", scope: "user", userId: OTHER });
  await seed({ name: "Unapproved rule", approved: false });
  await seed({ name: "Plain teaching skill", category: null });
});

describe("a prose rule in scope reaches the IS feed (the one push door)", () => {
  it("is returned by hub skills.getSkills with its category and body", async () => {
    const rows = (await hubSkillsRouter.createCaller({} as never).getSkills({
      userId: USER,
      status: "active",
      approved: true,
    })) as unknown as Array<{
      id: string;
      category: string | null;
      body: string | null;
      metadata: Record<string, unknown> | null;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));

    // The IS's own test for a rule: `category === "rule"` (or `metadata.rule`).
    const prose = byId.get(podProse);
    expect(prose?.category).toBe("rule");
    expect(prose?.metadata?.rule).toBeUndefined();
    expect(prose?.body).toBe("Never stash in a shared tree.");
    expect(byId.get(mineProse)?.category).toBe("rule");
    // A rule-loop rule still rides the same door.
    expect(byId.has(loopRule)).toBe(true);

    // Scope and approval still floor what is pushed.
    const names = rows.map((r) => (r as unknown as { name: string }).name);
    expect(names).not.toContain("Someone else's rule");
    expect(names).not.toContain("Unapproved rule");
  });
});

describe("sameNameSkill", () => {
  it("finds a prose rule as the twin of a new skill", async () => {
    const twin = await sameNameSkill({ userId: USER, name: "Shared tree" });
    expect(twin?.id).toBe(podProse);
  });

  it("still leaves a rule-loop rule out", async () => {
    const twin = await sameNameSkill({
      userId: USER,
      name: "Tag every new lead",
    });
    expect(twin).toBeNull();
  });
});
