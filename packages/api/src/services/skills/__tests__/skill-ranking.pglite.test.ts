/**
 * Skill ranking (S1), the ONE term matcher's SQL↔JS parity (S3), and the
 * `synap_load_skill` catalog/resolver lens (S2) — all through the REAL queries
 * on PGlite. Tables are generated from the Drizzle definitions.
 *
 * Fixture groups are isolated by owner: each ranking group's rows are
 * `scope:"user"` rows of its own user, so a group's gated candidate set is its
 * own rows plus the few pod rows of the catalog group (whose text matches no
 * ranking term).
 *
 * Real: `searchInstructionSkills`, `sqlTermMatch`/`rankByTerms`,
 * `visibleSkillsWhere` (incl. the workspace-membership tier and rule expiry),
 * `loadSkillCatalog`, `resolveSkillContent`.
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import { registerAgentSkillsRoutes } from "../../../routers/hub-protocol/rest/agent-skills.js";
import type { HubHono } from "../../../routers/hub-protocol/rest/_shared.js";
import { reservedSkillSlugReason } from "../reserved-slug.js";
import {
  skills,
  workspaces,
  workspaceMembers,
  podMembers,
  users,
  projectMembers,
} from "@synap/database/schema";
import { searchInstructionSkills } from "../search.js";
import { rankByTerms } from "../../../utils/term-match.js";
import {
  loadSkillCatalog,
  resolveSkillContent,
} from "../../capability-briefs/load-skill.js";

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
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

const RANK_USER = randomUUID();
const GATE_USER = randomUUID();
const CAT_USER = randomUUID();
const OTHER = randomUUID();
const WS_MEMBER = randomUUID();
const WS_STRANGER = randomUUID();

type Seed = {
  name: string;
  slug?: string;
  description?: string;
  topics?: string[];
  tags?: string[];
  userId: string;
  scope: "pod" | "user" | "workspace";
  workspaceId?: string;
  approved?: boolean;
  category?: string;
  metadata?: unknown;
  body?: string;
  skillGroup?: string;
};

async function seed(s: Seed): Promise<void> {
  await h.client!.query(
    `insert into skills (id, user_id, workspace_id, slug, kind, scope, name, description, topics, tags, status, approved, category, metadata, body, skill_group)
     values ($1,$2,$3,$4,'instruction',$5,$6,$7,$8,$9,'active',$10,$11,$12,$13,$14)`,
    [
      randomUUID(),
      s.userId,
      s.workspaceId ?? null,
      s.slug ?? `f/${s.name.toLowerCase().replace(/\W+/g, "-")}`,
      s.scope,
      s.name,
      s.description ?? "generic filler text",
      s.topics ?? [],
      s.tags ?? [],
      s.approved ?? true,
      s.category ?? null,
      s.metadata === undefined ? null : JSON.stringify(s.metadata),
      s.body ?? `${s.name} body`,
      s.skillGroup ?? null,
    ]
  );
}

const EXPIRED = { rule: { expiresAt: "2000-01-01T00:00:00.000Z" } };

beforeAll(async () => {
  for (const t of [
    skills,
    workspaces,
    workspaceMembers,
    podMembers,
    users,
    projectMembers,
  ] as PgTable[]) {
    await h.client!.exec(ddlFor(t));
  }

  // ── S1 group: the live 'create a project' shape ──────────────────────────
  // Six rows hit the generic stem `creat` (four in the NAME); two hit
  // `project` in the DESCRIPTION only; no row hits both.
  const rank = (name: string, extra: Partial<Seed> = {}) =>
    seed({ name, userId: RANK_USER, scope: "user", ...extra });
  await rank("Creating views", { description: "views over data" });
  await rank("Creating profiles", { description: "define kinds" });
  await rank("Creating the base app", { description: "starter app" });
  await rank("Creative loop", { description: "iterate on ideas" });
  await rank("Arranging bento", { description: "create bento layouts" });
  await rank("Workspaces", {
    description: "create a workspace lens",
    topics: ["creating"],
  });
  await rank("Lenses and threads", {
    description: "organise work into a project",
  });
  await rank("Scoping guide", { description: "attach a project to captures" });
  await rank("Rank filler one");
  await rank("Rank filler two");

  // ── Gated-weights group ──────────────────────────────────────────────────
  // Visible: `zork` is RARE (1 row), `blip` is in 3 NAMES. Invisible: 35 rows
  // full of `zork`. Weighted over the gated set, the zork row wins; weighted
  // over the whole table, zork looks common and the blip rows win.
  const gate = (name: string, extra: Partial<Seed> = {}) =>
    seed({ name, userId: GATE_USER, scope: "user", ...extra });
  await gate("Alpha note", { description: "zork reference" });
  await gate("Blip one");
  await gate("Blip two");
  await gate("Blip three");
  for (let i = 1; i <= 6; i++) await gate(`Gate filler ${i}`);
  for (let i = 1; i <= 30; i++) {
    await seed({ name: `Zork private ${i}`, userId: OTHER, scope: "user" });
  }
  for (let i = 1; i <= 5; i++) {
    await seed({
      name: `Zork unapproved ${i}`,
      userId: OTHER,
      scope: "pod",
      approved: false,
    });
  }

  // ── S2 catalog group ─────────────────────────────────────────────────────
  await h.client!.query(
    `insert into workspaces (id, owner_id, settings) values ($1,$2,'{}'::jsonb),($3,$2,'{}'::jsonb)`,
    [WS_MEMBER, OTHER, WS_STRANGER]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id) values ($1,$2,$3)`,
    [randomUUID(), WS_MEMBER, CAT_USER]
  );
  await seed({
    name: "Alpha system",
    slug: "system/synap/alpha-guide",
    userId: OTHER,
    scope: "pod",
    skillGroup: "core",
    body: "ALPHA BODY",
  });
  await seed({
    name: "Shared pod",
    slug: "team/shared-guide",
    userId: OTHER,
    scope: "pod",
    body: "SHARED BODY",
  });
  await seed({
    name: "Member workspace",
    slug: "ws/member-guide",
    userId: OTHER,
    scope: "workspace",
    workspaceId: WS_MEMBER,
    body: "WS BODY",
  });
  await seed({
    name: "Stranger workspace",
    slug: "ws2/hidden-guide",
    userId: OTHER,
    scope: "workspace",
    workspaceId: WS_STRANGER,
  });
  await seed({
    name: "Mine live",
    slug: "mine/live-guide",
    userId: CAT_USER,
    scope: "user",
  });
  await seed({
    name: "Mine expired",
    slug: "mine/expired-rule",
    userId: CAT_USER,
    scope: "user",
    category: "rule",
    metadata: EXPIRED,
  });
  await seed({
    name: "Other private",
    slug: "other/private-guide",
    userId: OTHER,
    scope: "user",
    body: "PRIVATE BODY",
  });

  // ── Resolver ref handling (CAT_USER-owned so no other group's set moves) ──
  // Inserted in the order a missing ORDER BY would return them (heap order).
  const refRow = (slug: string, body: string) =>
    seed({ name: `Ref ${slug}`, slug, userId: CAT_USER, scope: "user", body });
  await refRow("b/dup-guide", "B DUP BODY");
  await refRow("a/dup-guide", "A DUP BODY");
  await refRow("a/solo", "SUFFIX SOLO BODY");
  await refRow("solo", "EXACT SOLO BODY");

  // ── Shadowing: seeded system skills vs pod skills named after their stems ─
  // Pod rows that sort BEFORE `system/…` and match the bare ref exactly or by
  // suffix — the two ways a pod member could shadow system text.
  const pod = (slug: string, body: string) =>
    seed({ name: `Pod ${slug}`, slug, userId: OTHER, scope: "pod", body });
  await pod("system/synap/writes", "SYSTEM WRITES BODY");
  await pod("writes", "SHADOW BARE BODY");
  await pod("a/writes", "SHADOW SUFFIX BODY");
  await pod("system/synap/escalation-ladder", "SYSTEM LADDER BODY");
});

function skillsApp(userId: string): HubHono {
  const app = new OpenAPIHono() as unknown as HubHono;
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerAgentSkillsRoutes(app);
  return app;
}

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("S1 — rarer query words weigh more", () => {
  it("'create a project' ranks the project skills above every create-* skill", async () => {
    const { rows, total } = await searchInstructionSkills({
      userId: RANK_USER,
      q: "create a project",
      limit: 10,
    });
    expect(total).toBe(8);
    expect(names(rows).slice(0, 2)).toEqual([
      "Lenses and threads",
      "Scoping guide",
    ]);
    expect(new Set(names(rows).slice(2))).toEqual(
      new Set([
        "Creating views",
        "Creating profiles",
        "Creating the base app",
        "Creative loop",
        "Arranging bento",
        "Workspaces",
      ])
    );
  });

  it("measures rarity over the gated candidate set, not the whole table", async () => {
    const { rows, total } = await searchInstructionSkills({
      userId: GATE_USER,
      q: "zork blip",
      limit: 10,
    });
    expect(total).toBe(4);
    expect(names(rows)[0]).toBe("Alpha note");
  });
});

describe("S3 — one matcher: SQL and JS rank identically", () => {
  const cases: Array<[string, string]> = [
    ["create a project", RANK_USER],
    ["zork blip", GATE_USER],
    ["creating guide", RANK_USER],
    ["guide", CAT_USER],
  ];

  it.each(cases)("%s", async (q, userId) => {
    // The gated candidate set, in the SQL tie-break order (name, id).
    const all = await searchInstructionSkills({ userId, limit: 200 });
    expect(all.rows.length).toBeGreaterThanOrEqual(3);
    const sql = await searchInstructionSkills({ userId, q, limit: 200 });
    const js = rankByTerms(q, all.rows, (r) => ({
      primary: [r.name, r.slug ?? ""],
      secondary: [...(r.topics ?? []), ...(r.tags ?? [])],
      tertiary: r.description,
    }));
    expect(sql.rows.length).toBeGreaterThan(0);
    expect(names(js.map((r) => r.item))).toEqual(names(sql.rows));
    expect(sql.total).toBe(js.length);
  });
});

describe("SECURITY — synap_load_skill never hands over another user's private skill", () => {
  it("another user's user-scope skill is NOT loadable by slug; own and pod skills are", async () => {
    expect(await resolveSkillContent("other/private-guide", CAT_USER)).toMatch(
      /^No skill found/
    );
    expect(await resolveSkillContent("mine/live-guide", CAT_USER)).toBe(
      "Mine live body"
    );
    expect(await resolveSkillContent("team/shared-guide", CAT_USER)).toBe(
      "SHARED BODY"
    );
    // The owner still loads it — the fixture row is real and servable.
    expect(await resolveSkillContent("other/private-guide", OTHER)).toBe(
      "PRIVATE BODY"
    );
  });
});

describe("resolveSkillContent — ref is literal and resolution is deterministic", () => {
  it("LIKE wildcards in the ref are literal: '%' and '_' load nothing", async () => {
    for (const ref of ["%", "_", "%guide"]) {
      expect(await resolveSkillContent(ref, CAT_USER)).toMatch(
        /^No skill found/
      );
    }
  });

  it("several suffix matches resolve to the first by slug, not heap order", async () => {
    expect(await resolveSkillContent("dup-guide", CAT_USER)).toBe("A DUP BODY");
  });

  it("an exact slug beats a suffix match that sorts before it", async () => {
    expect(await resolveSkillContent("solo", CAT_USER)).toBe("EXACT SOLO BODY");
  });
});

describe("S2 — synap_load_skill uses the one skill lens", () => {
  it("catalog lists pod (system + shared), own, and member-workspace skills; never a stranger workspace, another user's private skill, or an expired rule", async () => {
    const catalog = await loadSkillCatalog(CAT_USER, {
      workspaceId: WS_MEMBER,
    });
    for (const slug of [
      "system/synap/alpha-guide",
      "team/shared-guide",
      "ws/member-guide",
      "mine/live-guide",
    ]) {
      expect(catalog).toContain(`${slug} — `);
    }
    for (const slug of [
      "ws2/hidden-guide",
      "other/private-guide",
      "mine/expired-rule",
    ]) {
      expect(catalog).not.toContain(slug);
    }
  });

  it("without a workspace lens the workspace tier is absent", async () => {
    const catalog = await loadSkillCatalog(CAT_USER);
    expect(catalog).toContain("team/shared-guide — ");
    expect(catalog).not.toContain("ws/member-guide");
  });

  it("the resolver hands over exactly what the catalog advertises", async () => {
    expect(
      await resolveSkillContent("ws/member-guide", CAT_USER, {
        workspaceId: WS_MEMBER,
      })
    ).toBe("WS BODY");
    for (const ref of ["mine/expired-rule", "ws2/hidden-guide"]) {
      expect(await resolveSkillContent(ref, CAT_USER)).toMatch(
        /^No skill found/
      );
    }
  });
});

describe("SECURITY — a pod skill cannot shadow a seeded system skill", () => {
  it("a bare ref resolves to the system skill, never to a same-stem pod skill", async () => {
    for (const ref of ["writes", "writes.md"]) {
      expect(await resolveSkillContent(ref, CAT_USER)).toBe(
        "SYSTEM WRITES BODY"
      );
    }
  });

  it("an explicit full slug still resolves to exactly that skill", async () => {
    expect(await resolveSkillContent("a/writes", CAT_USER)).toBe(
      "SHADOW SUFFIX BODY"
    );
    expect(await resolveSkillContent("system/synap/writes", CAT_USER)).toBe(
      "SYSTEM WRITES BODY"
    );
  });

  const post = (path: string, body: unknown) =>
    skillsApp(CAT_USER).request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("the create door refuses the system/ namespace with a reason code", async () => {
    const res = await post("/agent-skills", {
      slug: "system/synap/new-guide",
      name: "x",
      body: "x",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "system_namespace_reserved",
    });
  });

  it("the create and import doors refuse a slug naming a system stem", async () => {
    for (const slug of ["escalation-ladder", "synap/escalation-ladder"]) {
      const res = await post("/agent-skills", { slug, name: "x", body: "x" });
      expect(res.status, slug).toBe(409);
      expect(await res.json()).toMatchObject({ code: "system_stem_collision" });
    }
    const imported = await post("/agent-skills/import", {
      userId: CAT_USER,
      skill: { slug: "escalation-ladder", name: "x" },
      documents: [],
    });
    expect(imported.status).toBe(409);
    expect(await imported.json()).toMatchObject({
      code: "system_stem_collision",
    });
  });

  it("a namespaced slug that names no system skill is not reserved", async () => {
    expect(await reservedSkillSlugReason("team/escalation-ladder")).toBeNull();
  });
});

describe("S4 — search results say why they matched", () => {
  it("GET /agent-skills?q= carries the hit terms (rarest first) and fields per row", async () => {
    const res = await skillsApp(RANK_USER).request(
      "/agent-skills?q=create%20a%20project&limit=10"
    );
    const body = (await res.json()) as {
      skills: {
        name: string;
        match?: { terms: string[]; fields: string[] };
      }[];
    };
    expect(body.skills[0]?.name).toBe("Lenses and threads");
    expect(body.skills[0]?.match).toEqual({
      terms: ["project"],
      fields: ["description"],
    });
    expect(body.skills.find((s) => s.name === "Creating views")?.match).toEqual(
      { terms: ["creat"], fields: ["name"] }
    );
  });

  it("an unsearched list carries no match", async () => {
    const res = await skillsApp(RANK_USER).request("/agent-skills?limit=3");
    const body = (await res.json()) as { skills: { match?: unknown }[] };
    expect(body.skills.length).toBeGreaterThan(0);
    for (const s of body.skills) expect(s.match).toBeUndefined();
  });
});
