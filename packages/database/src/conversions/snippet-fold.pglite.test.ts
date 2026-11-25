/**
 * REAL-POSTGRES (PGlite) test of the `devplane_prompt_snippet` -> `snippet`
 * fold, driven through the REAL ops of CONVERSION_MANIFEST (selected by the
 * `snippet.` opKey prefix), so it pins what the manifest ships, including its
 * ORDER. The fixture is the one real entity read on the founder pod
 * (2026-11-09): "Hand off to Claude Code", `snippetCategory: workflow`, a
 * `snippetDescription`, NO `snippetBody`.
 *
 * What it rules out:
 *   - the description is not dropped: with no body it becomes the body;
 *   - a snippet that has a body gets the description as its FIRST paragraph
 *     (blank line, then the body): nothing discarded, nothing doubled;
 *   - every category lands on `use: prompt`, the old key is stripped;
 *   - the entity ends up on the `snippet` profile, type `snippet`, pod-wide
 *     (workspace_id NULL);
 *   - every step refuses (nothing written) while the `snippet` system kind is
 *     not seeded yet;
 *   - a second run changes nothing.
 *
 * NEGATIVE CONTROL: moving `snippet.merge.devplane-prompt-snippet-into-snippet`
 * ahead of the three key moves in manifest.ts turns the body/use assertions
 * red (the moves select by the old slug); deleting the description op turns
 * the first test red.
 */

import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { runConversions } from "./engine.js";
import { CONVERSION_MANIFEST, type ConversionManifest } from "./manifest.js";

// ─── postgres.js-shaped `Sql` shim over PGlite ───────────────────────────────
// Same shim contract as engine.integration.test.ts: tagged templates become $N
// binds, nested fragments splice as SQL, `.begin` is a real BEGIN/COMMIT, and
// write results expose `.count`.
class Frag {
  constructor(
    readonly strings: readonly string[],
    readonly values: unknown[]
  ) {}
}

function flatten(frag: Frag): { text: string; params: unknown[] } {
  let text = "";
  const params: unknown[] = [];
  const walk = (strings: readonly string[], values: unknown[]) => {
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) {
        const v = values[i];
        if (v instanceof Frag) walk(v.strings, v.values);
        else {
          params.push(v);
          text += "$" + params.length;
        }
      }
    }
  };
  walk(frag.strings, frag.values);
  return { text, params };
}

function makePgliteSql(db: PGlite): Sql {
  const exec = async (text: string, params: unknown[]) => {
    const res = await db.query(text, params);
    const rows: any = res.rows ?? [];
    rows.count = (res as any).affectedRows ?? 0;
    return rows;
  };
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const frag: any = new Frag(strings as unknown as string[], values);
    frag.then = (resolve: any, reject: any) => {
      const { text, params } = flatten(frag);
      return exec(text, params).then(resolve, reject);
    };
    return frag;
  };
  sql.begin = async (fn: (tx: Sql) => Promise<unknown>) => {
    await exec("BEGIN", []);
    try {
      const r = await fn(sql);
      await exec("COMMIT", []);
      return r;
    } catch (e) {
      await exec("ROLLBACK", []);
      throw e;
    }
  };
  return sql as Sql;
}

const SCHEMA = `
CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_slug text,
  settings jsonb DEFAULT '{}'
);
CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  display_name text,
  profile_kind text DEFAULT 'kind',
  scope text DEFAULT 'system',
  entity_scope text DEFAULT 'pod',
  workspace_id uuid,
  is_active boolean DEFAULT true,
  applicable_kinds text[],
  ui_hints jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid,
  user_id uuid,
  workspace_id uuid,
  type text,
  properties jsonb DEFAULT '{}',
  deleted_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE entity_facets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid,
  profile_id uuid,
  user_id uuid,
  workspace_id uuid,
  status text,
  context_entity_id uuid,
  properties jsonb DEFAULT '{}',
  metadata jsonb DEFAULT '{}',
  created_by_kind text,
  deleted_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE property_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid,
  slug text,
  workspace_id uuid
);
CREATE TABLE profile_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid,
  property_def_id uuid
);
-- 0319 lifecycle columns, read by projectLifecycleColumns (the whole
-- manifest runs here).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS parent_profile_id uuid;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS status_category text;
ALTER TABLE entity_facets ADD COLUMN IF NOT EXISTS status_category text;
ALTER TABLE property_defs ADD COLUMN IF NOT EXISTS constraints jsonb DEFAULT '{}';
ALTER TABLE profile_properties ADD COLUMN IF NOT EXISTS is_lifecycle boolean DEFAULT false;
CREATE TABLE views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_profile_ids uuid[] DEFAULT '{}'
);
`;

const WS = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";

const SNIPPET_OPS: ConversionManifest = {
  version: 1,
  ops: CONVERSION_MANIFEST.ops.filter((o) => o.opKey.startsWith("snippet.")),
};

const OPERATOR = {
  dryRun: false,
  destructiveTail: true,
  deferDestructive: false,
  skipDeferred: false,
} as const;

async function setupPod(opts: { seeded?: boolean } = {}) {
  const db = new PGlite();
  await db.exec(SCHEMA);
  const sql = makePgliteSql(db);
  const q = async (text: string, params: unknown[] = []) =>
    (await db.query(text, params)).rows as any[];
  const profile = async (slug: string, entityScope: string) =>
    (
      await q(
        `INSERT INTO profiles (slug, display_name, profile_kind, scope, entity_scope, workspace_id)
         VALUES ($1,$1,'kind','system',$2,NULL) RETURNING id`,
        [slug, entityScope]
      )
    )[0].id as string;
  const old = await profile("devplane_prompt_snippet", "workspace");
  const snippet =
    opts.seeded === false ? null : await profile("snippet", "pod");
  const entity = async (title: string, props: object) =>
    (
      await q(
        `INSERT INTO entities (profile_id, user_id, workspace_id, type, properties)
         VALUES ($1,$2,$3,'devplane_prompt_snippet',$4) RETURNING id`,
        [old, USER, WS, JSON.stringify({ title, ...props })]
      )
    )[0].id as string;
  return { db, sql, q, old, snippet, entity };
}

const errorsOf = (s: { results: Array<{ opKey: string; error?: string }> }) =>
  s.results.filter((r) => r.error).map((r) => `${r.opKey}: ${r.error}`);

describe("snippet.* fold of devplane_prompt_snippet", () => {
  it("moves the real entity: description becomes the body, category becomes use, pod-wide", async () => {
    const { db, sql, q, snippet, entity } = await setupPod();
    const real = await entity("Hand off to Claude Code", {
      snippetCategory: "workflow",
      snippetDescription:
        "Playbook (executor external-agent) that makes the Claude Code routine hand-off discoverable and runnable.",
    });
    const s = await runConversions(sql, SNIPPET_OPS, OPERATOR);
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);

    const [row] = await q(
      `SELECT profile_id, type, workspace_id, properties FROM entities WHERE id = $1`,
      [real]
    );
    expect(row.profile_id).toBe(snippet);
    expect(row.type).toBe("snippet");
    expect(row.workspace_id).toBeNull();
    // The drained kind is deactivated by the destructive tail (row kept).
    expect(
      (
        await q(
          `SELECT is_active FROM profiles WHERE slug = 'devplane_prompt_snippet'`
        )
      )[0].is_active
    ).toBe(false);
    expect(row.properties).toEqual({
      title: "Hand off to Claude Code",
      body: "Playbook (executor external-agent) that makes the Claude Code routine hand-off discoverable and runnable.",
      use: "prompt",
    });
    await db.close();
  });

  it("puts the description first, then a blank line, then the body", async () => {
    const { db, sql, q, entity } = await setupPod();
    const id = await entity("Deploy", {
      snippetBody: "Deploy @{arg:app}",
      snippetDescription: "General deploy",
      snippetCategory: "deploy",
    });
    const s = await runConversions(sql, SNIPPET_OPS, OPERATOR);
    expect(errorsOf(s)).toEqual([]);
    const [row] = await q(`SELECT properties FROM entities WHERE id = $1`, [
      id,
    ]);
    expect(row.properties.body).toBe("General deploy\n\nDeploy @{arg:app}");
    expect(row.properties.use).toBe("prompt");
    expect(row.properties.snippetDescription).toBeUndefined();
    // Nothing was discarded, so nothing is counted as a conflict.
    const desc = s.results.find((r) =>
      r.opKey.endsWith("description-into-body")
    );
    expect(desc?.counts.entitiesKeyConflicts).toBeUndefined();
    await db.close();
  });

  it("does not double a description the body already opens with", async () => {
    const { db, sql, q, entity } = await setupPod();
    const id = await entity("Re-run", {
      snippetBody: "General deploy\n\nDeploy @{arg:app}",
      snippetDescription: "General deploy",
    });
    const s = await runConversions(sql, SNIPPET_OPS, OPERATOR);
    expect(errorsOf(s)).toEqual([]);
    const [row] = await q(`SELECT properties FROM entities WHERE id = $1`, [
      id,
    ]);
    expect(row.properties.body).toBe("General deploy\n\nDeploy @{arg:app}");
    await db.close();
  });

  it("refuses every step while the snippet kind is not seeded, and writes nothing", async () => {
    const { db, sql, q, entity } = await setupPod({ seeded: false });
    const id = await entity("x", {
      snippetBody: "b",
      snippetCategory: "debug",
    });
    const s = await runConversions(sql, SNIPPET_OPS, OPERATOR);
    expect(errorsOf(s).length).toBeGreaterThan(0);
    const [row] = await q(
      `SELECT type, properties FROM entities WHERE id = $1`,
      [id]
    );
    expect(row.type).toBe("devplane_prompt_snippet");
    expect(row.properties.snippetBody).toBe("b");
    await db.close();
  });

  it("is idempotent: a second run changes nothing", async () => {
    const { db, sql, q, entity } = await setupPod();
    const id = await entity("x", {
      snippetDescription: "d",
      snippetCategory: "audit",
    });
    await runConversions(sql, SNIPPET_OPS, OPERATOR);
    const first = (await q(`SELECT * FROM entities WHERE id = $1`, [id]))[0];
    const again = await runConversions(sql, SNIPPET_OPS, OPERATOR);
    expect(errorsOf(again)).toEqual([]);
    const second = (await q(`SELECT * FROM entities WHERE id = $1`, [id]))[0];
    expect(second.properties).toEqual(first.properties);
    expect(second.profile_id).toBe(first.profile_id);
    await db.close();
  });
});
