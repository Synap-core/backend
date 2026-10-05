/**
 * REAL-POSTGRES (PGlite) test of the W11 Content × Brand folds, driven by the
 * REAL ops from CONVERSION_MANIFEST (no hand-built op objects), so it pins what
 * the manifest actually ships — including its ORDER, which is load-bearing:
 *
 *   - social-post → the shared `post`: the entity-link `post-platform` lands on
 *     `post-account` (never in post's string `post-platform` label), `scheduled-at`
 *     on `publish-date`, the lifecycle statuses on post's vocabulary, and
 *     `failed` survives as `publish-outcome = "failed"` (plan D12) with no
 *     lifecycle status claimed for it;
 *   - content-template → the shared `brand-template`, its engine-valued
 *     `template-kind` becoming the output kind `video`;
 *   - a pre-existing Content OS `post` is untouched (the folds are slug-scoped).
 *
 * NEGATIVE CONTROL (2026-10-05): moving `w11.merge.social-post-into-post` ahead
 * of the four social-post renames/remap in manifest.ts turns the social-post
 * assertions red (the slug-scoped key moves then select nothing).
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
CREATE TABLE views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_profile_ids uuid[] DEFAULT '{}'
);
`;

const WS_SOCIAL = "11111111-1111-1111-1111-111111111111";
const WS_STUDIO = "33333333-3333-3333-3333-333333333333";
const WS_CONTENT = "44444444-4444-4444-4444-444444444444";
const USER = "22222222-2222-2222-2222-222222222222";
const ACCOUNT = "55555555-5555-5555-5555-555555555555";

const W11: ConversionManifest = {
  version: 1,
  ops: CONVERSION_MANIFEST.ops.filter((o) => o.opKey.startsWith("w11.")),
};

async function setupPod(opts: { sharedPost?: boolean } = {}) {
  const db = new PGlite();
  await db.exec(SCHEMA);
  const q = async (text: string, params: unknown[] = []) =>
    (await db.query(text, params)).rows as any[];
  const profile = async (slug: string, scope: string, ws: string | null) =>
    (
      await q(
        `INSERT INTO profiles (slug, display_name, profile_kind, scope, entity_scope, workspace_id)
         VALUES ($1,$1,'kind',$2,'workspace',$3) RETURNING id`,
        [slug, scope, ws]
      )
    )[0].id as string;
  const entity = async (
    profileId: string,
    type: string,
    ws: string,
    props: object
  ) =>
    (
      await q(
        `INSERT INTO entities (profile_id, user_id, workspace_id, type, properties)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [profileId, USER, ws, type, JSON.stringify(props)]
      )
    )[0].id as string;

  // Without a shared `post`, a Content OS install declares it at workspace
  // scope — the pod the template reconcile has not promoted yet.
  const post =
    opts.sharedPost === false
      ? await profile("post", "workspace", WS_CONTENT)
      : await profile("post", "shared", null);
  const socialPost = await profile("social-post", "workspace", WS_SOCIAL);
  const brandTemplate = await profile("brand-template", "shared", null);
  const contentTemplate = await profile(
    "content-template",
    "workspace",
    WS_STUDIO
  );

  const ids = {
    post,
    socialPost,
    brandTemplate,
    contentTemplate,
    draft: await entity(socialPost, "social-post", WS_SOCIAL, {
      "post-status": "draft",
      "post-platform": ACCOUNT,
      "scheduled-at": "2026-10-10",
      "post-content": "hello",
    }),
    failed: await entity(socialPost, "social-post", WS_SOCIAL, {
      "post-status": "failed",
    }),
    published: await entity(socialPost, "social-post", WS_SOCIAL, {
      "post-status": "published",
    }),
    contentOsPost: await entity(post, "post", WS_CONTENT, {
      "post-status": "Idea",
      "post-platform": "LinkedIn",
    }),
    template: await entity(contentTemplate, "content-template", WS_STUDIO, {
      "template-kind": "hyperframes",
      "aspect-ratio": "9:16",
    }),
  };
  return { sql: makePgliteSql(db), q, ids, profile };
}

async function propsOf(
  q: (t: string, p?: unknown[]) => Promise<any[]>,
  id: string
) {
  const [row] = await q(
    `SELECT profile_id, type, properties FROM entities WHERE id = $1`,
    [id]
  );
  return row as {
    profile_id: string;
    type: string;
    properties: Record<string, unknown>;
  };
}

describe("W11 Content × Brand folds (real manifest ops, real planner)", () => {
  it("ships the folds deferred at boot, in a non-empty, ordered set", () => {
    expect(W11.ops.map((o) => o.opKey)).toEqual([
      "w11.post.social-platform-to-account",
      "w11.post.social-scheduled-to-publish-date",
      "w11.post.social-status-aside",
      "w11.post.social-status-fold",
      "w11.merge.social-post-into-post",
      "w11.content.template-kind-aside",
      "w11.merge.content-template-into-brand-template",
      "w11.content.template-engine-to-kind",
    ]);
    expect(W11.ops.every((o) => o.deferAtBoot === true)).toBe(true);
  });

  it("folds social-post into the shared post and content-template into brand-template", async () => {
    const { sql, q, ids } = await setupPod();
    const summary = await runConversions(sql, W11, {
      dryRun: false,
      destructiveTail: true,
    });
    for (const r of summary.results) {
      expect(r.error ?? null, `${r.opKey}: ${r.error ?? ""}`).toBeNull();
    }

    const draft = await propsOf(q, ids.draft);
    expect(draft.profile_id).toBe(ids.post);
    expect(draft.type).toBe("post");
    expect(draft.properties).toEqual({
      "post-status": "In Draft",
      "post-account": ACCOUNT,
      "publish-date": "2026-10-10",
      "post-content": "hello",
    });

    // D12: failed is an outcome, not a lifecycle stage.
    const failed = await propsOf(q, ids.failed);
    expect(failed.profile_id).toBe(ids.post);
    expect(failed.properties).toEqual({ "publish-outcome": "failed" });

    const published = await propsOf(q, ids.published);
    expect(published.properties).toEqual({ "post-status": "Published" });

    // Slug-scoped: a Content OS post keeps its string platform label + status.
    const contentOs = await propsOf(q, ids.contentOsPost);
    expect(contentOs.properties).toEqual({
      "post-status": "Idea",
      "post-platform": "LinkedIn",
    });

    const template = await propsOf(q, ids.template);
    expect(template.profile_id).toBe(ids.brandTemplate);
    expect(template.type).toBe("brand-template");
    expect(template.properties).toEqual({
      "template-kind": "video",
      "aspect-ratio": "9:16",
    });

    const retired = await q(
      `SELECT slug, is_active FROM profiles WHERE id = ANY($1::uuid[]) ORDER BY slug`,
      [[ids.socialPost, ids.contentTemplate]]
    );
    expect(retired).toEqual([
      { slug: "content-template", is_active: false },
      { slug: "social-post", is_active: false },
    ]);
  });

  it("REFUSES before any write while the shared post is missing, then completes once it exists", async () => {
    const { sql, q, ids, profile } = await setupPod({ sharedPost: false });
    const snapshot = async () =>
      q(`SELECT id, profile_id, properties FROM entities ORDER BY id`);
    const before = await snapshot();

    const refused = await runConversions(sql, W11, {
      dryRun: false,
      destructiveTail: true,
    });
    expect(refused.hadError).toBe(true);
    // Halts at the FIRST key move — never reaches the merge.
    expect(refused.results.map((r) => [r.opKey, r.status])).toEqual([
      ["w11.post.social-platform-to-account", "error"],
    ]);
    expect(refused.results[0]!.error).toContain(
      "requires the 'post' canonical"
    );
    // Nothing moved: no social-post row holds post's keys.
    expect(await snapshot()).toEqual(before);
    const appliedRows = await q(
      `SELECT op_key FROM "_conversions" WHERE error IS NULL AND dry_run = false`
    );
    expect(appliedRows).toEqual([]);

    // A dry run reports the same refusal.
    const dry = await runConversions(sql, W11, {
      dryRun: true,
      destructiveTail: false,
    });
    expect(dry.results[0]!.status).toBe("error");

    // The reconcile promotes post to shared → the same chain now completes.
    const sharedPost = await profile("post", "shared", null);
    const done = await runConversions(sql, W11, {
      dryRun: false,
      destructiveTail: true,
    });
    for (const r of done.results) {
      expect(r.error ?? null, `${r.opKey}: ${r.error ?? ""}`).toBeNull();
    }
    const draft = await propsOf(q, ids.draft);
    expect(draft.profile_id).toBe(sharedPost);
    expect(draft.properties).toEqual({
      "post-status": "In Draft",
      "post-account": ACCOUNT,
      "publish-date": "2026-10-10",
      "post-content": "hello",
    });

    // Idempotent: a third run skips every ledgered op and changes nothing.
    const settled = await snapshot();
    const again = await runConversions(sql, W11, {
      dryRun: false,
      destructiveTail: true,
    });
    expect(again.results.every((r) => r.status === "skipped")).toBe(true);
    expect(await snapshot()).toEqual(settled);
  });

  it("runs as a clean no-op on a pod with no social-post data and no shared post", async () => {
    const { sql, q } = await setupPod({ sharedPost: false });
    await q(`DELETE FROM entities`);
    const summary = await runConversions(sql, W11, {
      dryRun: false,
      destructiveTail: true,
    });
    for (const r of summary.results) {
      expect(r.error ?? null, `${r.opKey}: ${r.error ?? ""}`).toBeNull();
    }
  });
});
