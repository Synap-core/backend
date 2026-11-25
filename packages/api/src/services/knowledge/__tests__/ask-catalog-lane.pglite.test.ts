/**
 * `ask`'s CATALOG lane, end to end on PGlite: the REAL `classifySubstrates`
 * cue → the REAL `findByIntent` (catalogs `skills` + `playbooks`) → the REAL
 * `searchInstructionSkills` and `matchSessionTemplate` SQL → answer items.
 *
 * Live defect (finding cb91b095, 2026-11-09): "How do I build a custom UI or
 * app for my sales pipeline workflow? Can I create new cells, dashboards or
 * HTML views?" was answered from stale notes. No `ask` lane read skills, so
 * the synap-ui skill — the one that answers it — never reached the answer.
 *
 * The skills are seeded the way `ensureSystemSkills` writes them (slug
 * `system/<package>/<file>`, name = the file's first heading, description =
 * its `_teaching.json` summary), alongside unrelated system skills that share
 * a word or two with the question, so the answer must come from ranking, not
 * from being the only row.
 *
 * Other lanes are stubbed empty (retrieval, library, pending, spaces); the
 * semantic lane is not under test here.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return {
    ...actual,
    db: d,
    getDb: async () => d,
    // Procedural and episodic stores are other lanes; empty here.
    knowledgeKeysRepository: { searchFullText: async () => [] },
    knowledgeRepository: { searchFacts: async () => [] },
  };
});
vi.mock("../../retrieval/retrieve.js", () => ({
  retrieve: async () => ({
    entities: [],
    understanding: { profileTypes: [], confidence: 0 },
    verdict: "empty",
    source: "hybrid",
  }),
}));
vi.mock("../../library/ask-lane.js", () => ({
  searchLibraryForAsk: async () => ({ items: [], readTextSearch: "ok" }),
}));
vi.mock("../../../utils/pending-capture-dedup.js", () => ({
  findPendingTextMatches: async () => [],
}));
vi.mock("../../discover/space-catalog.js", () => ({
  suggestSpacesForKinds: async () => ({ status: "unavailable" }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { ask } from "../ask.js";

const USER = randomUUID();
const PLAYBOOK = randomUUID();

const LIVE_QUESTION =
  "How do I build a custom UI or app for my sales pipeline workflow? Can I create new cells, dashboards or HTML views?";

/** As `ensureSystemSkills` projects them: [slug, name, description]. */
const SYSTEM_SKILLS: Array<[string, string, string]> = [
  ["system/synap-ui/skill", "Synap — UI generation", "Synap — UI generation"],
  [
    "system/synap-ui/four-builds",
    "The four builds",
    "The four things you can build: view, dashboard, widget, workspace.",
  ],
  [
    "system/synap-ui/widget-catalog",
    "Widget catalog",
    "Reference: which cells/widgets exist to draw from.",
  ],
  // Distractors that share words with the question ("create", "custom", "app").
  [
    "system/synap-schema/skill",
    "Synap — schema extension",
    "Define a new kind or add custom fields to an existing one.",
  ],
  [
    "system/synap/capture",
    "The one capture door",
    "Create entities, tasks and notes from text in one call.",
  ],
  [
    "system/synap-market/skill",
    "Synap market",
    "Install an app or capability package from the marketplace.",
  ],
  [
    "system/synap/focus-sessions",
    "Focus sessions",
    "Start, update and close a focus session.",
  ],
];

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.hasDefault && type === "jsonb"
          ? ` default '{}'::jsonb`
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.init();
  for (const table of Object.values(schema)) {
    try {
      getTableConfig(table as PgTable);
    } catch {
      continue;
    }
    await h.client!.exec(ddlFor(table as PgTable)).catch(() => undefined);
  }
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'u@x.test', 'U', 'human')`,
    [USER]
  );
  for (const [slug, name, description] of SYSTEM_SKILLS) {
    await q(
      `insert into skills (id, kind, scope, name, slug, description, status, approved, tags, topics)
       values ($1, 'instruction', 'pod', $2, $3, $4, 'active', true, '{}', '{}')`,
      [randomUUID(), name, slug, description]
    );
  }
  // A pod-wide playbook whose words meet the question (pod-wide config is
  // visible to every member through the playbooks VisibilityRule).
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, description, goal_template, status, scope,
       params, expected_outputs, stages, criteria, tools, guidance)
     values ($1, null, $2, 'Pipeline dashboard build', 'Build a dashboard for a sales pipeline',
       'Build the pipeline dashboard', 'active', 'session', '[]', '[]', '[]', '[]', '[]', '[]')`,
    [PLAYBOOK, USER]
  );
}, 120_000);

async function askIt(query: string) {
  return ask({
    query,
    userId: USER,
    workspaceId: null,
    catalog: [],
    limit: 10,
  });
}

describe("ask — the catalog lane answers how-to questions with the pod's own skills", () => {
  it("the live failing question returns the synap-ui skill as a source", async () => {
    const r = await askIt(LIVE_QUESTION);
    expect(r.routedTo).toContain("catalog");
    // Existing substrates are kept, not replaced.
    expect(r.routedTo).toEqual(
      expect.arrayContaining(["semantic", "procedural", "library", "catalog"])
    );
    const lane = r.answers.find((a) => a.substrate === "catalog");
    expect(lane?.status).toBe("ok");
    const items = lane!.items as Array<Record<string, string>>;
    const refs = items.map((i) => i.ref).filter(Boolean);
    expect(refs).toContain("system/synap-ui/skill");
    // A synap-ui skill leads the skill rows.
    expect(items[0]!.ref).toMatch(/^system\/synap-ui\//);
    const ui = items.find((i) => i.ref === "system/synap-ui/skill")!;
    expect(ui.kind).toBe("skill");
    expect(ui.open).toMatch(/\/open\//);
    // The playbook arm rides too.
    expect(items.some((i) => i.id === PLAYBOOK && i.kind === "playbook")).toBe(
      true
    );
    // Every other lane came back empty, so the catalog leads the answer.
    expect(r.primary).toBe("catalog");
    expect(r.answers[0]!.substrate).toBe("catalog");
    expect(r.degraded).toEqual([]);
  });

  it("a which-tool question with no how-to phrasing routes to the catalog too", async () => {
    const r = await askIt("which skill should I use for dashboards");
    expect(r.intent).toBe("catalog");
    const lane = r.answers.find((a) => a.substrate === "catalog");
    expect(
      (lane!.items as Array<Record<string, string>>).map((i) => i.ref)
    ).toContain("system/synap-ui/four-builds");
  });

  it("a question that is not how-to does not run the catalog lane", async () => {
    const r = await askIt("what do I know about Acme");
    expect(r.routedTo).not.toContain("catalog");
    expect(r.answers.some((a) => a.substrate === "catalog")).toBe(false);
  });
});
