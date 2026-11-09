/**
 * Agent template UPDATES on PGlite: a newer catalog version of an installed
 * agent template is the same field-level keep/drop diff every standalone kind
 * gets (kind `agent` of `reconcile-standalone-configs-to-templates.ts`),
 * written through its governed door (`updateAgentTemplate`). Rows are
 * installed by the real `installAgentTemplate`, so the baseline is the one
 * install writes. Stubbed: the catalog lookup and its signature, the pod
 * owner, and governance (a stub that proposes an agent's write when the door
 * asks for it with `forcePropose`, and grants everything else).
 *
 * Pinned:
 *  - the plan's state per field: untouched → updates, the person's edit →
 *    yours, both changed → both;
 *  - the start-up pass advances untouched fields, keeps the person's, and
 *    never applies `wake` (a manual field): it stays in the plan, and the
 *    version is not stamped, so the update stays listed;
 *  - a person's apply applies `wake`; a `wake.program` change is refused, and
 *    "mine" keeps it;
 *  - an agent's apply of `wake` is proposed and writes nothing; of a field
 *    that is not a person's it goes to the gate as any write does;
 *  - a malformed update is refused at the write;
 *  - approving the agent's proposal replays the door as the approver.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  catalogs: {} as Record<string, Record<string, unknown>>,
  owner: "00000000-0000-4000-8000-0000000000aa",
  gate: [] as Array<Record<string, unknown>>,
  approved: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
  };
});
// Governance stub: an agent's write the door flags `forcePropose` is
// proposed; every other write is granted (so the flag is what decides).
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
    h.gate.push(opts);
    return opts.agentUserId && opts.forcePropose
      ? { granted: false, proposalId: "11111111-1111-4111-8111-111111111111" }
      : { granted: true };
  }),
}));
vi.mock("../capabilities/marketplace-install.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lookupCatalogEntry: async (_kind: string, slug: string) =>
    h.catalogs[slug] ?? null,
}));
vi.mock(
  "../capabilities/official-catalog-trust.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    admitOfficialDefinition: async () => ({ admitted: true }),
  })
);
vi.mock("../capabilities/pod-owner.js", () => ({
  resolvePodOwnerUserId: async () => h.owner,
  resolvePodAdminUserIds: async () => [h.owner],
}));
vi.mock("../package-updates/capability-update-proposal.js", () => ({
  isPackageUpdateProposalApproved: async () => false,
  markPackageUpdateProposalApproved: async (id: string) => {
    h.approved.push(id);
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import type { Context } from "../../types/context.js";
import {
  HELD_FOR_A_PERSON,
  reconcileStandaloneConfigsToTemplates,
} from "../capabilities/reconcile-standalone-configs-to-templates.js";
import { readMarketSource } from "../capabilities/market-source.js";
import {
  getPackageUpdatePlan,
  listPackageUpdates,
} from "../package-updates/plan.js";
import { applyPackageUpdate } from "../package-updates/apply.js";
import { listPackageUpdateReceipts } from "../package-updates/receipts.js";
import { installAgentTemplate } from "./install.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";
import { registerPackageUpdateExecutors } from "../../routers/proposals/executors/package-update.js";

const AGENT = randomUUID();

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
      c.name === "created_at" ||
      c.name === "updated_at" ||
      c.name === "timestamp"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const WAKE_CLAUDE = {
  program: "claude",
  args: ["-p", "{prompt}"],
  params: { prompt: { type: "text", required: true } },
};
const CLAUDE_V1 = {
  name: "Claude Code",
  agent: {
    harness: "claude-code",
    worker: true,
    tried: false,
    detect: { bins: ["claude"] },
    wake: WAKE_CLAUDE,
    practices: { skills: ["synap"] },
  },
};
// The catalog's next version: `tried` (untouched on the pod) advances,
// `detect` was edited by both, `wake` changes its arguments.
const CLAUDE_V2 = {
  name: "Claude Code",
  agent: {
    ...CLAUDE_V1.agent,
    tried: true,
    detect: { bins: ["claude"], homePaths: [".claude"] },
    wake: { ...WAKE_CLAUDE, args: ["-p", "{prompt}", "--verbose"] },
  },
};
const WAKE_HERMES = {
  program: "hermes",
  args: ["chat", "-q", "{prompt}"],
  params: { prompt: { type: "text", required: true } },
};
const HERMES_V1 = {
  name: "Hermes Agent",
  agent: { harness: "hermes", worker: true, tried: true, wake: WAKE_HERMES },
};
const hermes = (agent: Record<string, unknown>) => ({
  name: "Hermes Agent",
  agent: { ...HERMES_V1.agent, ...agent },
});
const WAKE_HERMES_V2 = { ...WAKE_HERMES, args: ["chat", "-Q", "{prompt}"] };

const catalog = (version: string, definition: Record<string, unknown>) => ({
  source: "https://cp.example",
  version,
  name: definition.name,
  definition,
});

let CLAUDE_ID = "";
let HERMES_ID = "";

interface Row {
  name: string;
  tried: boolean;
  aliases: string[];
  detect: unknown;
  wake: unknown;
  practices: unknown;
  metadata: Record<string, unknown>;
}
async function row(id: string): Promise<Row> {
  const { rows } = await q<Row>(
    `select name, tried, aliases, detect, wake, practices, metadata from agent_templates where id = $1`,
    [id]
  );
  return rows[0]!;
}

const person = (): Context =>
  ({
    db,
    authenticated: true,
    userId: h.owner,
    workspaceId: null,
    workspaceRole: "owner",
  }) as unknown as Context;
const agent = (): Context =>
  ({ ...person(), agentUserId: AGENT }) as unknown as Context;

const fieldState = async (slug: string) =>
  Object.fromEntries(
    (await getPackageUpdatePlan(slug)).rows[0]!.fields.map((f) => [
      f.key,
      f.state,
    ])
  );

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  // install's conflict target.
  await h.client!.exec(
    `create unique index agent_templates_slug_unique on agent_templates (slug)`
  );
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [h.owner]);
  registerPackageUpdateExecutors();
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from agent_templates; delete from events;`);
  h.gate.length = 0;
  h.approved.length = 0;
  const install = async (slug: string, def: Record<string, unknown>) => {
    const res = await installAgentTemplate({
      slug,
      packageSlug: slug,
      packageVersion: "h-1",
      name: def.name as string,
      definition: def,
    });
    if (res.status !== "installed") throw new Error(`install ${slug}`);
    return res.id;
  };
  CLAUDE_ID = await install("claude-code", CLAUDE_V1);
  HERMES_ID = await install("hermes", HERMES_V1);
  // The person's own edits since install.
  await q(
    `update agent_templates set practices = $1::jsonb, detect = $2::jsonb where id = $3`,
    [
      JSON.stringify({ skills: ["synap", "house-style"] }),
      JSON.stringify({ bins: ["claude", "claude-code"] }),
      CLAUDE_ID,
    ]
  );
  h.catalogs = {
    "claude-code": catalog("h-2", CLAUDE_V2),
    hermes: catalog("h-2", hermes({ wake: WAKE_HERMES_V2 })),
  };
});

describe("the update plan of an agent template", () => {
  it("names each field's state: untouched updates, the person's stays yours, both changed", async () => {
    const plan = await getPackageUpdatePlan("claude-code");
    expect(plan).toMatchObject({
      kind: "agent",
      comparedBy: "field",
      installedVersion: "h-1",
      latestVersion: "h-2",
      counts: { updates: 2, yours: 1, both: 1, same: 6 },
      needs: "choice",
    });
    expect(plan.rows[0]).toMatchObject({ rowKind: "agent", rowId: CLAUDE_ID });
    expect(await fieldState("claude-code")).toEqual({
      name: "same",
      harness: "same",
      aliases: "same",
      worker: "same",
      tried: "updates",
      detect: "both",
      wake: "updates",
      practices: "yours",
      toolProfile: "same",
      toolGroups: "same",
    });
    const wake = plan.rows[0]!.fields.find((f) => f.key === "wake")!;
    expect(wake.label).toBe("How a computer starts it");
    expect(wake.desired).toEqual(CLAUDE_V2.agent.wake);
  });

  it("is listed among the pod's updates", async () => {
    const list = await listPackageUpdates();
    expect(list.updates.map((u) => u.slug).sort()).toEqual([
      "claude-code",
      "hermes",
    ]);
    expect(list.installed.find((p) => p.slug === "hermes")).toMatchObject({
      kind: "agent",
      hasUpdate: true,
    });
  });
});

describe("the start-up pass", () => {
  it("advances the untouched field, keeps the person's, and never applies wake", async () => {
    const report = await reconcileStandaloneConfigsToTemplates({
      packageSlugs: ["claude-code"],
      receipt: { source: "automatic" },
    });
    expect(report.updated).toEqual([
      expect.objectContaining({
        kind: "agent",
        id: CLAUDE_ID,
        reason: "updated: [tried]",
      }),
    ]);
    expect(report.ownerOwnedSkipped[0]!.reason).toBe(
      "owner-owned (left alone): [detect,practices]; conflicted (the catalog changed them too): [detect]; yours only: [practices]"
    );
    expect(report.skipped.map((e) => e.reason)).toEqual([
      `${HELD_FOR_A_PERSON}: [wake]`,
    ]);

    const r = await row(CLAUDE_ID);
    expect(r.tried).toBe(true);
    expect(r.wake).toEqual(WAKE_CLAUDE);
    expect(r.practices).toEqual({ skills: ["synap", "house-style"] });
    expect(r.detect).toEqual({ bins: ["claude", "claude-code"] });
    const source = readMarketSource(r.metadata)!;
    expect(source.baseline.tried).toBe(true);
    expect(source.baseline.wake).toEqual(WAKE_CLAUDE);

    // The wake change still waits for a person.
    expect((await fieldState("claude-code")).wake).toBe("updates");
    const [receipt] = await listPackageUpdateReceipts({ slug: "claude-code" });
    expect(receipt).toMatchObject({
      source: "automatic",
      changes: [
        {
          rowKind: "agent",
          rowId: CLAUDE_ID,
          field: "tried",
          before: false,
          after: true,
        },
      ],
    });
  });

  it("a catalog wake change alone: nothing applied, no version stamped, still listed", async () => {
    const report = await reconcileStandaloneConfigsToTemplates({
      packageSlugs: ["hermes"],
    });
    expect(report.updated).toEqual([]);
    expect(report.skipped.map((e) => e.reason)).toEqual([
      `${HELD_FOR_A_PERSON}: [wake]`,
    ]);
    const r = await row(HERMES_ID);
    expect(r.wake).toEqual(WAKE_HERMES);
    expect(readMarketSource(r.metadata)!.packageVersion).toBe("h-1");
    const listed = (await listPackageUpdates()).updates.find(
      (u) => u.slug === "hermes"
    );
    expect(listed).toMatchObject({ counts: { updates: 1 } });
  });

  it("a catalog that gives Hermes a tool surface: applied at start-up, as an untouched field (d812debd)", async () => {
    h.catalogs = {
      ...h.catalogs,
      hermes: catalog(
        "h-2",
        hermes({ toolProfile: "entry", toolGroups: ["read"] })
      ),
    };
    const report = await reconcileStandaloneConfigsToTemplates({
      packageSlugs: ["hermes"],
    });
    expect(report.updated).toEqual([
      expect.objectContaining({
        id: HERMES_ID,
        reason: "updated: [toolGroups,toolProfile]",
      }),
    ]);
    const { rows } = await q<{ tool_profile: string; tool_groups: unknown }>(
      `select tool_profile, tool_groups from agent_templates where id = $1`,
      [HERMES_ID]
    );
    expect(rows[0]).toEqual({ tool_profile: "entry", tool_groups: ["read"] });
  });

  it("applying the surface to the template writes no key: existing agents' keys list what they listed (d812debd)", async () => {
    const hermesAgent = randomUUID();
    await q(
      `insert into users (id, email, agent_type) values ($1, $2, 'hermes')`,
      [hermesAgent, `${hermesAgent}@x.test`]
    );
    await q(
      `insert into api_keys (id, user_id, key_type, tool_profile, tool_groups)
       values ($1, $2, 'hub_inbound', 'entry', '{}'), ($3, $2, 'hub_inbound', null, '{}')`,
      [randomUUID(), hermesAgent, randomUUID()]
    );
    const keys = () =>
      q(`select * from api_keys order by id`).then((r) => r.rows);
    const before = await keys();
    expect(before.length).toBeGreaterThanOrEqual(2);

    h.catalogs = {
      ...h.catalogs,
      hermes: catalog(
        "h-2",
        hermes({ toolProfile: "entry", toolGroups: ["read"] })
      ),
    };
    const report = await reconcileStandaloneConfigsToTemplates({
      packageSlugs: ["hermes"],
    });
    // The template row did change…
    expect(report.updated.map((e) => e.reason)).toEqual([
      "updated: [toolGroups,toolProfile]",
    ]);
    // …and not one key did.
    expect(await keys()).toEqual(before);
  });

  it("a template installed before 0407: its baseline lacks the surface; 0407 fills it, and the same update applies", async () => {
    // The row as an earlier build installed it: no surface in the baseline.
    await q(
      `update agent_templates
       set metadata = metadata #- '{marketSource,baseline,toolProfile}' #- '{marketSource,baseline,toolGroups}'
       where id = $1`,
      [HERMES_ID]
    );
    h.catalogs = {
      ...h.catalogs,
      hermes: catalog(
        "h-2",
        hermes({ toolProfile: "entry", toolGroups: ["read"] })
      ),
    };
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../database/migrations/0407_agent_template_tool_surface.sql",
          import.meta.url
        )
      ),
      "utf8"
    );
    await h.client!.exec(sql.slice(sql.indexOf("UPDATE")));
    const report = await reconcileStandaloneConfigsToTemplates({
      packageSlugs: ["hermes"],
    });
    expect(report.ownerOwnedSkipped).toEqual([]);
    expect(report.updated.map((e) => e.reason)).toEqual([
      "updated: [toolGroups,toolProfile]",
    ]);
  });

  it("the dry run says the same as the plan, wake held (PARITY)", async () => {
    const report = await reconcileStandaloneConfigsToTemplates({
      dryRun: true,
      packageSlugs: ["hermes"],
    });
    expect(report.updated).toEqual([]);
    expect(report.skipped.map((e) => e.reason)).toEqual([
      `${HELD_FOR_A_PERSON}: [wake]`,
    ]);
    expect((await fieldState("hermes")).wake).toBe("updates");
  });
});

describe("a person's apply", () => {
  it("applies the wake change and writes a receipt", async () => {
    const res = await applyPackageUpdate(person(), {
      slug: "hermes",
      expectedVersion: "h-2",
    });
    expect(res.status).toBe("applied");
    const receipt = res.status === "applied" ? res.receipt! : null!;
    expect(receipt.changes).toEqual([
      {
        rowKind: "agent",
        rowId: HERMES_ID,
        field: "wake",
        before: WAKE_HERMES,
        after: WAKE_HERMES_V2,
      },
    ]);
    const r = await row(HERMES_ID);
    expect(r.wake).toEqual(WAKE_HERMES_V2);
    expect(readMarketSource(r.metadata)!.packageVersion).toBe("h-2");
    expect(
      (await listPackageUpdates()).updates.map((u) => u.slug)
    ).not.toContain("hermes");
  });

  it("a catalog change of wake.program is refused and writes nothing; 'mine' keeps it", async () => {
    h.catalogs.hermes = catalog(
      "h-3",
      hermes({ wake: { ...WAKE_HERMES, program: "hermes-agent" } })
    );
    await expect(
      applyPackageUpdate(person(), { slug: "hermes", expectedVersion: "h-3" })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("wake.program hermes → hermes-agent"),
    });
    expect((await row(HERMES_ID)).wake).toEqual(WAKE_HERMES);
    expect(await listPackageUpdateReceipts()).toEqual([]);

    const kept = await applyPackageUpdate(person(), {
      slug: "hermes",
      expectedVersion: "h-3",
      choices: { [`${HERMES_ID}:wake`]: "mine" },
    });
    expect(kept).toEqual({ status: "applied", receipt: null });
    expect((await row(HERMES_ID)).wake).toEqual(WAKE_HERMES);
    expect((await fieldState("hermes")).wake).toBe("yours");
  });

  it("a malformed update is refused at the write and writes nothing", async () => {
    h.catalogs.hermes = catalog("h-4", hermes({ aliases: ["Not Kebab"] }));
    expect((await fieldState("hermes")).aliases).toBe("updates");
    await expect(
      applyPackageUpdate(person(), { slug: "hermes", expectedVersion: "h-4" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("aliases must be kebab-case slugs"),
    });
    expect((await row(HERMES_ID)).aliases).toEqual([]);
    // The start-up pass reports it, never forces it.
    const report = await reconcileStandaloneConfigsToTemplates({
      packageSlugs: ["hermes"],
    });
    expect(report.conflicts[0]!.reason).toContain(
      "aliases must be kebab-case slugs"
    );
    expect((await row(HERMES_ID)).aliases).toEqual([]);
  });
});

describe("an agent's apply", () => {
  it("of wake is proposed and writes nothing; approving it replays the door as the person", async () => {
    const res = await applyPackageUpdate(agent(), {
      slug: "hermes",
      expectedVersion: "h-2",
    });
    expect(res).toEqual({
      status: "proposed",
      proposalIds: ["11111111-1111-4111-8111-111111111111"],
    });
    expect((await row(HERMES_ID)).wake).toEqual(WAKE_HERMES);
    expect(await listPackageUpdateReceipts()).toEqual([]);

    // The gate's proposal, as the approval reads it (nested at `data.data`).
    const filed = h.gate.at(-1)!;
    expect(filed).toMatchObject({
      subjectType: "agentTemplate",
      action: "update",
      agentUserId: AGENT,
      forcePropose: true,
    });
    const executor = proposalExecRegistry.resolveExact("agentTemplate/update")!;
    const deps = {
      reportProposalOutcome: vi.fn(),
      emitProposalReviewed: vi.fn(),
    };
    const result = await executor.execute({
      proposal: {
        id: "11111111-1111-4111-8111-111111111111",
        targetType: "agentTemplate",
        proposalType: "update",
        targetId: HERMES_ID,
        workspaceId: null,
        agentUserId: AGENT,
        sourceMessageId: null,
        data: {
          targetType: "agentTemplate",
          changeType: "update",
          data: filed.data,
        },
      },
      payload: null,
      userId: h.owner,
      input: { proposalId: "11111111-1111-4111-8111-111111111111" },
      ctx: person(),
      deps,
    } as never);
    expect(result).toEqual({ success: true });
    const r = await row(HERMES_ID);
    expect(r.wake).toEqual(WAKE_HERMES_V2);
    expect(readMarketSource(r.metadata)!.packageVersion).toBe("h-2");
    expect(h.approved).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(deps.emitProposalReviewed).toHaveBeenCalled();
  });

  it("of a field that is not a person's goes to the gate as any write does", async () => {
    h.catalogs.hermes = catalog("h-5", hermes({ tried: false }));
    const res = await applyPackageUpdate(agent(), {
      slug: "hermes",
      expectedVersion: "h-5",
    });
    expect(res.status).toBe("applied");
    expect(h.gate.at(-1)).toMatchObject({
      agentUserId: AGENT,
      forcePropose: false,
    });
    expect((await row(HERMES_ID)).tried).toBe(false);
  });
});
