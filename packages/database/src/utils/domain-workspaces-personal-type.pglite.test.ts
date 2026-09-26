/**
 * REAL-POSTGRES (PGlite) test for migration 0278: domain workspaces installed
 * from finance / hr / legal / internal-runbook become `personal` (domain homes)
 * — and NOTHING else changes.
 *
 * Applies the real migration file twice. The discriminating rows are the ones
 * a looser rule would also rewrite: the pod-admin console (operational, system
 * slug), `dev-dashboard` (operational by design), an already-personal finance
 * row, a SYSTEM row carrying a finance stamp (the one row the system_slug
 * guard decides), and a finance row identified only by the legacy
 * `settings.packageSlug` stamp (a column-only rule misses it).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = readFileSync(
  join(__dirname, "../../migrations/0278_domain_workspaces_personal_type.sql"),
  "utf8"
);

let pg: PGlite;

const ROWS: Array<{
  id: string;
  type: string;
  pkg: string | null;
  settings: Record<string, unknown>;
  system: string | null;
  expected: string;
}> = [
  {
    id: "finance",
    type: "operational",
    pkg: "finance",
    settings: {},
    system: null,
    expected: "personal",
  },
  {
    id: "hr",
    type: "operational",
    pkg: "hr",
    settings: {},
    system: null,
    expected: "personal",
  },
  {
    id: "legal",
    type: "operational",
    pkg: "legal",
    settings: {},
    system: null,
    expected: "personal",
  },
  {
    id: "runbook",
    type: "operational",
    pkg: "internal-runbook",
    settings: {},
    system: null,
    expected: "personal",
  },
  {
    id: "finance-legacy-stamp",
    type: "operational",
    pkg: null,
    settings: { packageSlug: "finance" },
    system: null,
    expected: "personal",
  },
  // A system workspace that happens to carry a domain stamp stays operational
  // — the ONLY row that exercises the system_slug guard.
  {
    id: "system-with-finance-stamp",
    type: "operational",
    pkg: "finance",
    settings: {},
    system: "finance-console",
    expected: "operational",
  },
  {
    id: "pod-admin",
    type: "operational",
    pkg: null,
    settings: { systemSlug: "pod-admin" },
    system: "pod-admin",
    expected: "operational",
  },
  {
    id: "dev-dashboard",
    type: "operational",
    pkg: "dev-dashboard",
    settings: {},
    system: null,
    expected: "operational",
  },
  {
    id: "agent-fleet",
    type: "agent",
    pkg: "agent-fleet",
    settings: {},
    system: null,
    expected: "agent",
  },
  {
    id: "finance-already",
    type: "personal",
    pkg: "finance",
    settings: {},
    system: null,
    expected: "personal",
  },
  {
    id: "crm",
    type: "personal",
    pkg: "crm",
    settings: {},
    system: null,
    expected: "personal",
  },
];

async function types(): Promise<Record<string, string>> {
  const { rows } = await pg.query<{ id: string; workspace_type: string }>(
    `SELECT id, workspace_type FROM workspaces ORDER BY id`
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.workspace_type]));
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE workspaces (
      id text PRIMARY KEY,
      workspace_type text NOT NULL DEFAULT 'personal',
      package_slug text,
      system_slug text,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz
    );
  `);
  for (const r of ROWS) {
    await pg.query(
      `INSERT INTO workspaces (id, workspace_type, package_slug, system_slug, settings) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [r.id, r.type, r.pkg, r.system, JSON.stringify(r.settings)]
    );
  }
});

describe("migration 0278 — domain workspaces personal type", () => {
  it("re-types exactly the four domain templates (column or legacy stamp), nothing else", async () => {
    await pg.exec(MIGRATION);
    expect(await types()).toEqual(
      Object.fromEntries(ROWS.map((r) => [r.id, r.expected]))
    );
  });

  it("is idempotent — a second run changes nothing", async () => {
    const before = await types();
    const res = await pg.query(
      `SELECT count(*)::int AS n FROM workspaces WHERE workspace_type = 'operational' AND system_slug IS NULL AND package_slug IN ('finance','hr','legal','internal-runbook')`
    );
    expect((res.rows[0] as { n: number }).n).toBe(0);
    await pg.exec(MIGRATION);
    expect(await types()).toEqual(before);
  });
});
