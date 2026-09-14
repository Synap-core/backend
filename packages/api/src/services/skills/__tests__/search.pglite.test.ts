/**
 * Instruction-skill search — driven through the REAL query on PGlite, and
 * through the real `GET /agent-skills` route.
 *
 * The defect this pins (live pod, 2026-09-14): the route paged by name FIRST
 * and filtered `q` in JS over that page, so `q=session&limit=10` returned 0 of
 * 6 real matches and `total` was the page length. The fixture therefore puts
 * every match AFTER a page of alphabetically-earlier non-matching skills — the
 * post-page filter and the SQL filter disagree exactly there.
 *
 * Real: `searchInstructionSkills`, `visibleSkillsWhere` + `ruleNotExpiredWhere`,
 * `registerAgentSkillsRoutes`. Tables are generated from the Drizzle definition.
 * Not covered here: the workspace tier of visibility (needs workspace
 * membership tables; `visibleSkillsWhere` has its own suites).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, { schema: { skills: schema.skills } as never }),
  };
});

import { getTableConfig } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import { skills } from "@synap/database/schema";
import { searchInstructionSkills, skillQueryTerms } from "../search.js";
import { registerAgentSkillsRoutes } from "../../../routers/hub-protocol/rest/agent-skills.js";
import type { HubHono } from "../../../routers/hub-protocol/rest/_shared.js";

const USER = "user-1";
const OTHER = "user-2";

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
  slug?: string;
  description?: string;
  topics?: string[];
  tags?: string[];
  userId?: string;
  scope?: "pod" | "user" | "workspace";
  kind?: string;
  status?: string;
  approved?: boolean;
  category?: string;
  metadata?: unknown;
};

async function seed(s: Seed): Promise<void> {
  await h.client!.query(
    `insert into skills (id, user_id, slug, kind, scope, name, description, topics, tags, status, approved, category, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      randomUUID(),
      s.userId ?? USER,
      s.slug ?? `test/${s.name.toLowerCase().replace(/\W+/g, "-")}`,
      s.kind ?? "instruction",
      s.scope ?? "pod",
      s.name,
      s.description ?? "generic filler text",
      s.topics ?? [],
      s.tags ?? [],
      s.status ?? "active",
      s.approved ?? true,
      s.category ?? null,
      s.metadata === undefined ? null : JSON.stringify(s.metadata),
    ]
  );
}

const FILLERS = 25;

beforeAll(async () => {
  await h.client!.exec(ddlForSkills());
  // A full page of alphabetically-FIRST non-matches.
  for (let i = 1; i <= FILLERS; i++) {
    await seed({ name: `Alpha filler ${String(i).padStart(2, "0")}` });
  }
  // Visible session matches — all sort after every filler.
  await seed({ name: "Zeta session guide", topics: ["session"] });
  await seed({ name: "Zeta recap", description: "recap a session at the end" });
  await seed({ name: "Zeta deep work", tags: ["sessions"] });
  // Multi-word targets.
  await seed({
    name: "Zulu project creator",
    description: "create a project quickly",
  });
  await seed({
    name: "Xray project board",
    description: "a board for the project",
  });
  // Wildcard discriminators: an unescaped `%`/`_` would also match the twin.
  await seed({ name: "Percent 100% done" });
  await seed({ name: "Plain 1005 done" });
  await seed({ name: "under_score skill" });
  await seed({ name: "underXscore skill" });
  // Invisible / not-servable session rows — each must stay out.
  await seed({ name: "Zz session private", scope: "user", userId: OTHER });
  await seed({ name: "Zz session unapproved", approved: false });
  await seed({ name: "Zz session inactive", status: "inactive" });
  await seed({ name: "Zz session code", kind: "code" });
  await seed({
    name: "Zz session expired rule",
    category: "rule",
    metadata: { rule: { expiresAt: "2000-01-01T00:00:00.000Z" } },
  });
  // Visible to its owner: proves the user tier is not simply dropped.
  await seed({ name: "Zz session mine", scope: "user", userId: USER });
});

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("searchInstructionSkills — filters before paging", () => {
  it("finds matches beyond the first page, and total is the real count", async () => {
    const { rows, total } = await searchInstructionSkills({
      userId: USER,
      q: "session",
      limit: 2,
    });
    expect(rows).toHaveLength(2);
    expect(total).toBe(4);
    for (const r of rows) expect(r.name).not.toMatch(/^Alpha filler/);
  });

  it("total without q counts every servable row, not the page", async () => {
    const { rows, total } = await searchInstructionSkills({
      userId: USER,
      limit: 5,
    });
    expect(rows).toHaveLength(5);
    // fillers + 3 session + 2 project + 4 wildcard + "mine"
    expect(total).toBe(FILLERS + 10);
  });

  it("excludes other users' private, unapproved, inactive, code and expired rows", async () => {
    const { rows, total } = await searchInstructionSkills({
      userId: USER,
      q: "session",
      limit: 200,
    });
    expect(new Set(names(rows))).toEqual(
      new Set([
        "Zeta session guide",
        "Zeta recap",
        "Zeta deep work",
        "Zz session mine",
      ])
    );
    expect(total).toBe(4);
  });

  it("a multi-word query matches by terms and ranks the fuller match first", async () => {
    const { rows, total } = await searchInstructionSkills({
      userId: USER,
      q: "how to create a project",
      limit: 10,
    });
    expect(names(rows)).toEqual(["Zulu project creator", "Xray project board"]);
    expect(total).toBe(2);
  });

  it("treats LIKE wildcards in user input literally", async () => {
    const pct = await searchInstructionSkills({
      userId: USER,
      q: "100%",
      limit: 50,
    });
    expect(names(pct.rows)).toEqual(["Percent 100% done"]);
    const bare = await searchInstructionSkills({
      userId: USER,
      q: "%",
      limit: 50,
    });
    expect(names(bare.rows)).toEqual(["Percent 100% done"]);
    expect(bare.total).toBe(1);
    const under = await searchInstructionSkills({
      userId: USER,
      q: "under_score",
      limit: 50,
    });
    expect(names(under.rows)).toEqual(["under_score skill"]);
  });

  it("keeps the topic filter as an AND with the text match", async () => {
    const { rows, total } = await searchInstructionSkills({
      userId: USER,
      q: "session",
      topic: "session",
      limit: 50,
    });
    expect(names(rows)).toEqual(["Zeta session guide"]);
    expect(total).toBe(1);
  });
});

describe("skillQueryTerms", () => {
  it("drops stopwords, stems lightly, and never returns nothing for real input", () => {
    expect(skillQueryTerms("Capturing sessions")).toEqual([
      "captur",
      "session",
    ]);
    expect(skillQueryTerms("how to create a project")).toEqual([
      "creat",
      "project",
    ]);
    expect(skillQueryTerms("how to")).toEqual(["how", "to"]);
    expect(skillQueryTerms("gmail_send")).toEqual(["gmail_send"]);
    expect(skillQueryTerms("   ")).toEqual([]);
  });
});

describe("GET /agent-skills — the wire", () => {
  function app(): HubHono {
    const a = new OpenAPIHono() as unknown as HubHono;
    a.use("*", async (c, next) => {
      c.set("userId", USER);
      c.set("scopes", ["hub-protocol.read"]);
      await next();
    });
    registerAgentSkillsRoutes(a);
    return a;
  }

  it("returns matches past page one with the real total", async () => {
    const res = await app().request("/agent-skills?q=session&limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: { name: string }[];
      total: number;
    };
    expect(body.skills).toHaveLength(2);
    expect(body.total).toBe(4);
  });
});
