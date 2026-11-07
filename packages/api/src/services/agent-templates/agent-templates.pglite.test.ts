/**
 * Agent templates (catalog kind `agent`, founder decisions D8-D9), on PGlite
 * through the real pieces:
 *   installOfficialAgentTemplates — the catalog installs every OFFICIAL agent
 *                                   template on the pod, once, never over an
 *                                   installed one, never a retired one, never
 *                                   another source's;
 *   installAgentTemplate           — the one write: the source link's baseline
 *                                   is exactly what it wrote; a definition the
 *                                   pod would have to guess about is refused;
 *   loadInstalledAgentTemplates +
 *   resolveAgentTemplate           — the roster's seam reads the installed row
 *                                   (its catalog version, its wake);
 *   checkConnectTemplate +
 *   linkAgentToTemplate            — the connect door's template check, and a
 *                                   link written only where there is none.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  refuse: new Set<string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

// Synap's catalog signature is official-catalog-trust's own suite; here a
// slug in `h.refuse` is one the signed index does not vouch for.
vi.mock("../capabilities/official-catalog-trust.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertOfficialDefinition: async (input: { slug: string }) => {
      if (h.refuse.has(input.slug))
        throw new Error(
          `"${input.slug}" is not vouched for by Synap's signed index`
        );
    },
  };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import {
  agentConfigs,
  agentTemplates,
  cpCatalogCache,
  users,
} from "@synap/database/schema";
import { officialMarketSource } from "../capabilities/market-sources.js";
import { installOfficialAgentTemplates } from "./official.js";
import { installAgentTemplate } from "./install.js";
import { loadInstalledAgentTemplates } from "./installed.js";
import { checkConnectTemplate, linkAgentToTemplate } from "./link.js";
import { resolveAgentTemplate } from "../agent-dispatch/agent-wake.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : c.name === "aliases"
            ? ` default '[]'::jsonb`
            : c.name === "metadata"
              ? ` default '{}'::jsonb`
              : c.name === "practices"
                ? ` default '{"skills":[]}'::jsonb`
                : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const CLAUDE_CODE = {
  agent: {
    harness: "claude-code",
    worker: true,
    tried: true,
    detect: { bins: ["claude"] },
    wake: {
      program: "claude",
      args: ["-p", "{prompt}"],
      params: { prompt: { type: "text", required: true } },
    },
    practices: { skills: ["synap"] },
  },
  name: "Claude Code",
};
const HERMES = {
  agent: {
    harness: "hermes",
    worker: true,
    tried: false,
    wake: {
      program: "hermes",
      args: ["chat", "-q", "{prompt}"],
      params: { prompt: { type: "text", required: true } },
    },
  },
  name: "Hermes Agent",
};
const CURSOR = {
  agent: { harness: "cursor", worker: false, tried: true },
  name: "Cursor",
};

async function list(
  slug: string,
  definition: Record<string, unknown> | null,
  over: { source?: string; version?: string; retiredAt?: Date } = {}
) {
  await (h.db as any).insert(cpCatalogCache).values({
    source: over.source ?? officialMarketSource().cacheKey,
    kind: "agent",
    slug,
    name: (definition?.name as string) ?? slug,
    version: over.version ?? `h-${slug.padEnd(12, "0").slice(0, 12)}`,
    definition,
    retiredAt: over.retiredAt ?? null,
  });
}
const rows = async () =>
  (
    await q<{
      slug: string;
      harness: string;
      wake: unknown;
      metadata: {
        marketSource?: {
          packageVersion: string;
          baseline: Record<string, unknown>;
        };
      };
      name: string;
    }>(
      `select slug, harness, wake, metadata, name from agent_templates order by slug`
    )
  ).rows;

beforeAll(async () => {
  for (const t of [agentConfigs, agentTemplates, cpCatalogCache, users])
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  await h.client!.exec(
    `create unique index if not exists agent_templates_slug_unique on agent_templates (slug)`
  );
  // The preset upsert's conflict target (0390): the practices attach needs it.
  await h.client!.exec(
    `create unique index if not exists agent_configs_user_preset_unique on agent_configs (user_id, preset_key) where preset_key is not null`
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from agent_configs; delete from agent_templates; delete from cp_catalog_cache; delete from users;`
  );
  h.refuse.clear();
});

describe("D8 — the catalog installs every official agent template on the pod", () => {
  it("installs each listed official template with its source link: the baseline is exactly what it wrote", async () => {
    await list("claude-code", CLAUDE_CODE, { version: "h-aaaaaaaaaaaa" });
    await list("hermes", HERMES);
    await list("cursor", CURSOR);

    const report = await installOfficialAgentTemplates();
    expect(report.installed.sort()).toEqual([
      "claude-code",
      "cursor",
      "hermes",
    ]);
    expect(report.failed).toEqual([]);

    const [claude] = (await rows()).filter((r) => r.slug === "claude-code");
    expect(claude).toMatchObject({
      harness: "claude-code",
      name: "Claude Code",
    });
    expect(claude!.metadata.marketSource).toMatchObject({
      packageSlug: "claude-code",
      packageVersion: "h-aaaaaaaaaaaa",
    });
    expect(claude!.metadata.marketSource!.baseline).toEqual({
      name: "Claude Code",
      harness: "claude-code",
      aliases: [],
      worker: true,
      tried: true,
      detect: { bins: ["claude"] },
      wake: claude!.wake,
      practices: { skills: ["synap"] },
    });
  });

  it("never re-installs over an installed template: a person's edit stays", async () => {
    await list("claude-code", CLAUDE_CODE);
    await installOfficialAgentTemplates();
    await q(
      `update agent_templates set name = 'My Claude' where slug = 'claude-code'`
    );

    const again = await installOfficialAgentTemplates();
    expect(again.installed).toEqual([]);
    expect(again.existing).toEqual(["claude-code"]);
    expect((await rows())[0]!.name).toBe("My Claude");
  });

  it("never installs a retired template, nor another source's (those come through the marketplace)", async () => {
    await list("claude-code", CLAUDE_CODE, { retiredAt: new Date() });
    await list("hermes", HERMES, { source: "acme" });
    const report = await installOfficialAgentTemplates();
    expect(report.installed).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("one bad template is refused alone: a wake given as a shell line, a worker without a wake, an unvouched definition", async () => {
    await list("claude-code", CLAUDE_CODE);
    await list("shell", {
      agent: {
        harness: "shell",
        worker: true,
        tried: true,
        wake: "claude -p $PROMPT",
      },
    });
    await list("nowake", {
      agent: { harness: "nowake", worker: true, tried: true },
    });
    await list("undeclared", {
      agent: {
        harness: "undeclared",
        worker: true,
        tried: true,
        wake: { program: "x", args: ["{model}"], params: {} },
      },
    });
    await list("pathprog", {
      agent: {
        harness: "pathprog",
        worker: true,
        tried: true,
        wake: { program: "/usr/bin/x", args: [] },
      },
    });
    await list("hermes", HERMES);
    h.refuse.add("hermes");

    const report = await installOfficialAgentTemplates();
    expect(report.installed).toEqual(["claude-code"]);
    expect(
      Object.fromEntries(report.failed.map((f) => [f.slug, f.reason]))
    ).toEqual({
      shell: expect.stringContaining("never a shell line"),
      nowake: expect.stringContaining("needs a wake"),
      undeclared: expect.stringContaining("{model} is not declared"),
      pathprog: expect.stringContaining("bare program name"),
      hermes: expect.stringContaining("not vouched for"),
    });
    expect((await rows()).map((r) => r.slug)).toEqual(["claude-code"]);
  });
});

describe("the roster's seam reads the installed template", () => {
  it("version from the source link, wake from the row; a link wins over the type", async () => {
    await list("claude-code", CLAUDE_CODE, { version: "h-bbbbbbbbbbbb" });
    await list("cursor", CURSOR);
    await list("hermes", HERMES);
    await installOfficialAgentTemplates();
    const installed = await loadInstalledAgentTemplates();

    expect(
      resolveAgentTemplate({ agentType: "claude-code" }, installed)
    ).toEqual({
      slug: "claude-code",
      label: "Claude Code",
      version: "h-bbbbbbbbbbbb",
      wakes: true,
      wake: expect.objectContaining({
        program: "claude",
        args: ["-p", "{prompt}"],
      }),
    });
    // The block a runner reads to start the agent is the INSTALLED row's,
    // served as it was installed (the pod is the one source).
    expect(
      resolveAgentTemplate({ agentType: "hermes" }, installed)?.wake
    ).toMatchObject({
      program: "hermes",
      args: ["chat", "-q", "{prompt}"],
      params: { prompt: { type: "text", required: true } },
    });
    expect(
      resolveAgentTemplate({ agentType: "cursor" }, installed)
    ).toMatchObject({ wakes: false, wake: null });
    expect(
      resolveAgentTemplate(
        { agentType: "claude-code-devbox", templateSlug: "claude-code" },
        installed
      )?.version
    ).toBe("h-bbbbbbbbbbbb");
  });
});

describe("D9 — the connect door's template check, and the link", () => {
  it("a template for another program is refused; an alias or a not-yet-installed slug is accepted", async () => {
    await installAgentTemplate({
      slug: "claude-code",
      packageSlug: "claude-code",
      packageVersion: null,
      name: "Claude Code",
      definition: { agent: { ...CLAUDE_CODE.agent, aliases: ["claude"] } },
    });
    expect(await checkConnectTemplate("claude-code", "claude-code")).toBeNull();
    expect(await checkConnectTemplate("claude-code", "claude")).toBeNull();
    expect(await checkConnectTemplate("claude-code", "codex")).toBe(
      'The Claude Code template is for agents of type "claude-code", not "codex".'
    );
    expect(await checkConnectTemplate("hermes", "hermes")).toBeNull();
    expect(await checkConnectTemplate("Not A Slug", "codex")).toMatch(
      /kebab-case/
    );
    expect(await checkConnectTemplate(42, "codex")).toMatch(/kebab-case/);
  });

  it("links an agent that has no link, never re-points one that has, never to a template not installed", async () => {
    await installAgentTemplate({
      slug: "claude-code",
      packageSlug: "claude-code",
      packageVersion: null,
      name: "Claude Code",
      definition: CLAUDE_CODE,
    });
    await installAgentTemplate({
      slug: "codex",
      packageSlug: "codex",
      packageVersion: null,
      name: "Codex",
      definition: { agent: { harness: "codex", worker: false, tried: true } },
    });
    const id = randomUUID();
    await q(
      `insert into users (id, email, user_type, agent_type) values ($1, 'a@x', 'agent', 'claude-code')`,
      [id]
    );
    expect(await linkAgentToTemplate(id, "not-installed")).toBe(false);
    expect(await linkAgentToTemplate(id, "claude-code")).toBe(true);
    expect(await linkAgentToTemplate(id, "codex")).toBe(false);
    const { rows: r } = await q<{ agent_template_slug: string }>(
      `select agent_template_slug from users where id = $1`,
      [id]
    );
    expect(r[0]!.agent_template_slug).toBe("claude-code");
  });
});

describe("D4 — linking an agent attaches its template's practices", () => {
  const templatePresets = async (id: string) =>
    (
      await q<{ preset_label: string; skill_slugs: string[] }>(
        `select preset_label, skill_slugs from agent_configs where user_id = $1 and preset_key = 'template'`,
        [id]
      )
    ).rows;
  const agent = async (agentType: string) => {
    const id = randomUUID();
    await q(
      `insert into users (id, email, user_type, agent_type) values ($1, $2, 'agent', $3)`,
      [id, `${id}@x`, agentType]
    );
    return id;
  };
  const installClaude = () =>
    installAgentTemplate({
      slug: "claude-code",
      packageSlug: "claude-code",
      packageVersion: null,
      name: "Claude Code",
      definition: {
        ...CLAUDE_CODE,
        agent: {
          ...CLAUDE_CODE.agent,
          practices: { skills: ["synap", "system/synap/capture", "synap"] },
        },
      },
    });

  it("the link writes ONE `template` preset with the template's skills, in the same transaction", async () => {
    await installClaude();
    const id = await agent("claude-code");
    expect(await linkAgentToTemplate(id, "claude-code")).toBe(true);
    expect(await templatePresets(id)).toEqual([
      {
        preset_label: "From the Claude Code template",
        skill_slugs: ["synap", "system/synap/capture"],
      },
    ]);
  });

  it("a second link pass writes nothing; a person's edit of the preset is kept", async () => {
    await installClaude();
    const id = await agent("claude-code");
    await q(
      `insert into agent_configs (user_id, agent_type, preset_key, preset_label, skill_slugs) values ($1, 'claude-code', 'template', 'Mine', '["my-skill"]'::jsonb)`,
      [id]
    );
    expect(await linkAgentToTemplate(id, "claude-code")).toBe(true);
    expect(await linkAgentToTemplate(id, "claude-code")).toBe(false);
    expect(await templatePresets(id)).toEqual([
      { preset_label: "Mine", skill_slugs: ["my-skill"] },
    ]);
  });

  it("no link, no preset: a template not installed attaches nothing", async () => {
    const id = await agent("claude-code");
    expect(await linkAgentToTemplate(id, "claude-code")).toBe(false);
    expect(await templatePresets(id)).toEqual([]);
  });
});
