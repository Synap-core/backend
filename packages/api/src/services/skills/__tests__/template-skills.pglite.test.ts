/**
 * Template skills — the INSTALL half, driven through the real applier on PGlite.
 *
 * A space's template declares `skills: [{ slug, when, mode }]`; `applyTemplateSkills`
 * resolves each to a pod-wide `system/…` skill and records the LINK in the
 * space's brief. This file proves the parts a live pod depends on:
 *
 *   • an APPROVED system skill is linked (the brief carries slug + mode + when);
 *   • a skill that is not approved, or not active, is NEVER linked — it is
 *     reported instead. A space is never told to use a skill the pod would
 *     refuse to load;
 *   • an unresolvable slug and a malformed declaration are reported distinctly,
 *     so an author can tell a typo from a skill still awaiting approval;
 *   • a ref the space already held (added by hand) is not dropped by a link pass.
 *
 * Real: `applyTemplateSkills`, the pglite skills/workspaces tables, the real
 * `WorkspaceRepository.replaceSpaceBrief` compare-and-set door. The EVENT STORE
 * is no-op'd — it is a side effect, not the thing under test, and asserting on
 * it would test the events table rather than the link.
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
  const db = drizzle(client, {
    schema: { skills: schema.skills, workspaces: schema.workspaces } as never,
  });
  return {
    ...actual,
    db,
    getDb: async () => db,
    // Any event-store method resolves to a no-op; see the header.
    eventRepository: new Proxy(
      {},
      { get: () => async () => undefined }
    ) as unknown,
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { skills, workspaces } from "@synap/database/schema";
import { applyTemplateSkills } from "../template-skills.js";

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

/** DDL for one Drizzle table — columns only (no FKs), enough for a real write. */
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
      else if (typeof d === "number" || typeof d === "boolean") def = ` default ${d}`;
      else if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (d && typeof d === "object" && !("queryChunks" in d))
        def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
    }
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const WS = randomUUID();

async function seedSkill(s: {
  slug: string;
  approved?: boolean;
  status?: string;
  kind?: string;
  workspaceId?: string | null;
}): Promise<void> {
  await h.client!.query(
    `insert into skills (id, user_id, slug, kind, scope, name, status, approved, workspace_id)
     values ($1,$2,$3,$4,'pod',$5,$6,$7,$8)`,
    [
      randomUUID(),
      "user-1",
      s.slug,
      s.kind ?? "instruction",
      s.slug,
      s.status ?? "active",
      s.approved ?? true,
      s.workspaceId ?? null,
    ]
  );
}

/** The brief's skills, read straight back out of the workspace row. */
async function briefSkills(): Promise<unknown> {
  const { rows } = await h.client!.query<{ skills: unknown }>(
    `select settings->'onboarding'->'skills' as skills from workspaces where id = $1`,
    [WS]
  );
  return rows[0]?.skills ?? null;
}

async function setBriefRaw(value: unknown): Promise<void> {
  await h.client!.query(
    `update workspaces set settings = jsonb_build_object('onboarding', $2::jsonb) where id = $1`,
    [WS, JSON.stringify(value)]
  );
}

beforeAll(async () => {
  await h.client!.exec(ddlFor(skills));
  await h.client!.exec(ddlFor(workspaces));
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
    [WS, "Probe space", "user-1"]
  );
  // The pod-wide, approved system skill a template may declare.
  await seedSkill({ slug: "system/synap/creative-director", approved: true });
  // Same skill, still awaiting approval — must never be linked.
  await seedSkill({ slug: "system/synap/draft-skill", approved: false });
  // Exists but deactivated.
  await seedSkill({ slug: "system/synap/asleep", status: "inactive" });
  // A WORKSPACE-scoped row with the same slug as a declared one: the pod-wide
  // one must win, since the declaration names a pod-wide system skill.
  await seedSkill({ slug: "system/synap/creative-director", workspaceId: WS });
});

describe("applyTemplateSkills — a declared skill is LINKED to the space", () => {
  it("links an approved system skill, carrying mode and when", async () => {
    const outcomes = await applyTemplateSkills({
      workspaceId: WS,
      userId: "user-1",
      skills: [
        {
          slug: "system/synap/creative-director",
          mode: "always",
          when: "any content ask",
        },
      ],
    });
    expect(outcomes).toEqual([
      { slug: "system/synap/creative-director", status: "linked" },
    ]);
    // The VALUE arrived, not merely a key: this is the install-links contract.
    expect(await briefSkills()).toEqual([
      {
        slug: "system/synap/creative-director",
        mode: "always",
        when: "any content ask",
      },
    ]);
  });

  it("resolves the `pkg/stem` form an author is likely to write", async () => {
    // `_teaching.json` names a skill `synap/creative-director`; the row the pod
    // seeds is `system/synap/creative-director`. A template may write either.
    //
    // BOUNDARY: a BARE stem does NOT resolve a nested system skill — there is
    // nothing to match `creative-director` against `system/<pkg>/creative-director`
    // without a suffix scan, which would be ambiguous across packages. The
    // applier matches exactly, or after prefixing `system/`.
    await setBriefRaw({});
    const outcomes = await applyTemplateSkills({
      workspaceId: WS,
      userId: "user-1",
      skills: [{ slug: "synap/creative-director", mode: "on-demand" }],
    });
    expect(outcomes[0]).toEqual({
      slug: "synap/creative-director",
      status: "linked",
    });
    expect(await briefSkills()).toEqual([
      { slug: "synap/creative-director", mode: "on-demand" },
    ]);
  });

  it("NEVER links an unapproved skill — reported, not written", async () => {
    await setBriefRaw({});
    const outcomes = await applyTemplateSkills({
      workspaceId: WS,
      userId: "user-1",
      skills: [{ slug: "system/synap/draft-skill", mode: "always" }],
    });
    expect(outcomes).toEqual([
      { slug: "system/synap/draft-skill", status: "unapproved", reason: expect.any(String) },
    ]);
    expect(await briefSkills()).toBeNull();
  });

  it("NEVER links a deactivated skill", async () => {
    await setBriefRaw({});
    const outcomes = await applyTemplateSkills({
      workspaceId: WS,
      userId: "user-1",
      skills: [{ slug: "system/synap/asleep", mode: "always" }],
    });
    expect(outcomes[0]!.status).toBe("unapproved");
    expect(await briefSkills()).toBeNull();
  });

  it("reports an unresolvable slug and a malformed declaration DISTINCTLY", async () => {
    await setBriefRaw({});
    const outcomes = await applyTemplateSkills({
      workspaceId: WS,
      userId: "user-1",
      skills: [
        { slug: "system/synap/nope", mode: "always" },
        { slug: "Not A Slug", mode: "always" },
        { slug: "system/synap/x", mode: "sometimes" },
      ],
    });
    expect(outcomes.map((o) => o.status)).toEqual([
      "invalid",
      "invalid",
      "unresolved",
    ]);
    expect(await briefSkills()).toBeNull();
  });

  it("keeps a ref the space already held (added by hand), declaration order first", async () => {
    await setBriefRaw({
      skills: [{ slug: "my/own-skill", mode: "on-demand" }],
    });
    await applyTemplateSkills({
      workspaceId: WS,
      userId: "user-1",
      skills: [{ slug: "system/synap/creative-director", mode: "always" }],
    });
    expect(await briefSkills()).toEqual([
      { slug: "system/synap/creative-director", mode: "always" },
      { slug: "my/own-skill", mode: "on-demand" },
    ]);
  });

  it("is idempotent — a second identical pass writes nothing new", async () => {
    const before = await briefSkills();
    await applyTemplateSkills({
      workspaceId: WS,
      userId: "user-1",
      skills: [{ slug: "system/synap/creative-director", mode: "always" }],
    });
    expect(await briefSkills()).toEqual(before);
  });
});
