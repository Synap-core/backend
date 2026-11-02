/**
 * `synap_declare_lifecycle` → `profile/declare_lifecycle` — declaring a
 * lifecycle on an EXISTING kind, on a real Postgres (PGlite).
 *
 * Driven through the REAL MCP handler and the REAL approval executor
 * (`insertPendingProposal` is shimmed to the same INSERT on PGlite — its own
 * client is unreachable here). Nothing governs by mock: the door has no gate
 * to mock, it files a PENDING proposal for every caller. These pin:
 *   - the door PROPOSES and writes no schema (no field, no flag);
 *   - approval creates the kind's base `status` field with categorised
 *     options (enum derived by the one mapper), flips `is_lifecycle`, sets the
 *     initial status, and the one lifecycle reader then resolves it; existing
 *     records keep no status (the declaration moves nobody);
 *   - an option with a category that is not one of the five is refused and
 *     files nothing;
 *   - a kind that already declares a lifecycle is REFUSED (never replaced),
 *     and a lifecycle declared between filing and approval refuses at
 *     approval, leaving the schema as it was;
 *   - authority on the LOADED kind: a non-member cannot file.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  drizzleDb: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const d = drizzle(client, { schema });
  h.drizzleDb = d;
  return {
    ...actual,
    db: d,
    getDb: async () => d,
    // `insertPendingProposal` binds @synap/database's OWN postgres.js client,
    // which the barrel `db` swap never reaches — stubbed to the same INSERT on
    // PGlite (the pod-hygiene suite's shim).
    insertPendingProposal: async (input: {
      workspaceId: string | null;
      targetType: string;
      targetId: string;
      proposalType: string;
      data: Record<string, unknown>;
      createdBy: string | null;
      proposedByUserId?: string | null;
      subjectUserId?: string | null;
      agentUserId?: string | null;
    }) => {
      const id = randomUUID();
      const { rows } = await client.query(
        `insert into proposals (id, status, workspace_id, target_type, target_id, proposal_type, data,
           created_by, proposed_by_user_id, subject_user_id, agent_user_id, created_at, updated_at)
         values ($1,'pending',$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,now(),now()) returning *`,
        [
          id,
          input.workspaceId,
          input.targetType,
          input.targetId,
          input.proposalType,
          JSON.stringify(input.data),
          input.createdBy,
          input.proposedByUserId ?? null,
          input.subjectUserId ?? null,
          input.agentUserId ?? null,
        ]
      );
      return { proposal: { ...(rows[0] as object), id }, deduped: false };
    },
  };
});
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));

import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { ProfileResolutionService, declareLifecycle } from "@synap/database";
import { capabilityHandlers } from "../../../routers/mcp/handlers/capability.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { registerPodHygieneExecutors } from "../../../routers/proposals/executors/pod-hygiene.js";

const MIGRATION_0319 = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../database/migrations/0319_lifecycle_columns.sql"
  ),
  "utf8"
);

const ADMIN = randomUUID();
const OUTSIDER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const POD_ADMIN_WS = randomUUID();
const FINDING = randomUUID(); // agent-made shared kind, no status field
const TICKET = randomUUID(); // already declares a lifecycle
const RACE = randomUUID(); // gains a lifecycle between filing and approval
const RACE_STAGE_DEF = randomUUID();
const OLD_FINDING_1 = randomUUID();
const OLD_FINDING_2 = randomUUID();

const FINDING_OPTIONS = [
  { key: "open", category: "open", label: "Open" },
  { key: "fixing", category: "active", label: "Fixing" },
  { key: "fixed", category: "done", label: "Fixed" },
  { key: "verified", category: "done", label: "Verified" },
  { key: "wont_fix", category: "lost", label: "Won't fix" },
  { key: "superseded", category: "lost", label: "Superseded" },
];

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
/** The table as the schema declares it: columns, simple defaults, composite keys. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (!Array.isArray(d)) def = ` default '${JSON.stringify(d)}'`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  const pk = cfg.primaryKeys[0];
  if (pk)
    cols.push(
      `primary key (${pk.columns.map((c) => `"${c.name}"`).join(", ")})`
    );
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const declareTool = (userId: string, args: Record<string, unknown>) =>
  capabilityHandlers.synap_declare_lifecycle!({
    toolName: "synap_declare_lifecycle",
    args,
    userId,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: AGENT,
  } as never).then(
    (r) =>
      JSON.parse(
        (r as { content: Array<{ text: string }> }).content[0]!.text
      ) as Record<string, unknown>
  );

async function approve(proposalId: string, targetId: string) {
  const row = (
    await q<{ data: unknown; workspace_id: string | null }>(
      `select data, workspace_id from proposals where id = $1`,
      [proposalId]
    )
  ).rows[0]!;
  return proposalExecRegistry.resolve("profile/declare_lifecycle")!.execute({
    proposal: {
      id: proposalId,
      targetType: "profile",
      targetId,
      proposalType: "declare_lifecycle",
      workspaceId: row.workspace_id,
      subjectUserId: ADMIN,
      data: row.data,
    },
    payload: row.data,
    userId: ADMIN,
    input: { proposalId },
    ctx: {},
    deps: { reportProposalOutcome: vi.fn(), emitProposalReviewed: vi.fn() },
  } as never);
}

const statusDefsOf = (profileId: string) =>
  q<{ id: string; constraints: Record<string, unknown>; slug: string }>(
    `select id, slug, constraints from property_defs where profile_id = $1 and slug = 'status'`,
    [profileId]
  ).then((r) => r.rows);
const lifecycleLinksOf = (profileId: string) =>
  q<{ property_def_id: string; default_value: unknown }>(
    `select property_def_id, default_value from profile_properties where profile_id = $1 and is_lifecycle`,
    [profileId]
  ).then((r) => r.rows);
const proposalsFor = (profileId: string) =>
  q<{ id: string; status: string }>(
    `select id, status from proposals where target_id = $1`,
    [profileId]
  ).then((r) => r.rows);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await h.client!.exec(MIGRATION_0319);

  await q(
    `insert into workspaces (id, name, owner_id, settings, system_slug) values
      ($1,'Builder',$3,'{}'::jsonb,null),($2,'Pod admin',$3,'{}'::jsonb,'pod-admin')`,
    [WS, POD_ADMIN_WS, ADMIN]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
      ($1,$3,$4,'owner'),($2,$5,$4,'admin')`,
    [randomUUID(), randomUUID(), WS, ADMIN, POD_ADMIN_WS]
  );
  await q(
    `insert into profiles (id, slug, display_name, scope, profile_kind, is_active, workspace_id, user_id)
     values ($1,'finding','Finding','shared','kind',true,$4,null),
            ($2,'ticket','Ticket','shared','kind',true,$4,null),
            ($3,'race-kind','Race kind','shared','kind',true,$4,null)`,
    [FINDING, TICKET, RACE, WS]
  );
  // `ticket` already declares a lifecycle on its own base `status`.
  const ticketStatus = randomUUID();
  await q(
    `insert into property_defs (id, slug, profile_id, workspace_id, value_type, constraints) values
      ($1,'status',$2,null,'string',$3::jsonb),
      ($4,'stage',$5,null,'string',$6::jsonb)`,
    [
      ticketStatus,
      TICKET,
      JSON.stringify({
        enum: ["todo", "done"],
        enumOptions: [
          { key: "todo", category: "open" },
          { key: "done", category: "done" },
        ],
      }),
      RACE_STAGE_DEF,
      RACE,
      JSON.stringify({
        enum: ["new", "shipped"],
        enumOptions: [
          { key: "new", category: "open" },
          { key: "shipped", category: "done" },
        ],
      }),
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values
      ($1,$2,true),($3,$4,false)`,
    [TICKET, ticketStatus, RACE, RACE_STAGE_DEF]
  );
  // Two findings that exist before the declaration, with no status.
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties) values
      ($1,$3,$4,$5,'finding','Old finding 1','{"severity":"high"}'::jsonb),
      ($2,$3,$4,$5,'finding','Old finding 2','{}'::jsonb)`,
    [OLD_FINDING_1, OLD_FINDING_2, ADMIN, WS, FINDING]
  );
  registerPodHygieneExecutors();
}, 120_000);

describe("synap_declare_lifecycle — always a proposal, applied on approval", () => {
  it("proposes, writes no schema, then approval declares the lifecycle", async () => {
    const res = await declareTool(ADMIN, {
      profileId: FINDING,
      options: FINDING_OPTIONS,
      initialStatus: "open",
      reasoning: "findings need a status so open ones can be counted",
    });
    expect(res).toMatchObject({
      status: "proposed",
      profileSlug: "finding",
      property: "status",
      initialStatus: "open",
    });
    const proposalId = res.proposalId as string;

    // Filed PENDING, by the agent, titled once, with the review rows.
    const row = (
      await q<{
        status: string;
        target_type: string;
        proposal_type: string;
        agent_user_id: string | null;
        data: { summary: string; properties: Record<string, unknown> };
      }>(
        `select status, target_type, proposal_type, agent_user_id, data from proposals where id = $1`,
        [proposalId]
      )
    ).rows[0]!;
    expect(row).toMatchObject({
      status: "pending",
      target_type: "profile",
      proposal_type: "declare_lifecycle",
      agent_user_id: AGENT,
    });
    expect(row.data.summary).toBe('Declare lifecycle "finding"');
    expect(row.data.properties.kind).toBe("Finding (finding)");
    expect(String(row.data.properties.options)).toContain(
      "wont_fix = Won't fix (lost)"
    );
    // Nothing applied yet.
    expect(await statusDefsOf(FINDING)).toEqual([]);
    expect(await lifecycleLinksOf(FINDING)).toEqual([]);

    // A second filing does not stack a duplicate.
    expect(
      await declareTool(ADMIN, { profileId: FINDING, options: FINDING_OPTIONS })
    ).toEqual({ status: "already_pending", proposalId });

    const applied = await approve(proposalId, FINDING);
    expect(applied).toMatchObject({
      success: true,
      effect: { applied: "verified", subject: "property_defs" },
    });

    // The kind's own base field, options categorised, enum derived.
    const defs = await statusDefsOf(FINDING);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.constraints.enum).toEqual([
      "open",
      "fixing",
      "fixed",
      "verified",
      "wont_fix",
      "superseded",
    ]);
    // The flag is flipped on the link, with the initial status.
    const links = await lifecycleLinksOf(FINDING);
    expect(links).toHaveLength(1);
    expect(links[0]!.property_def_id).toBe(defs[0]!.id);
    expect(links[0]!.default_value).toBe("open");

    // The one reader resolves it.
    const effective = await new ProfileResolutionService(
      h.drizzleDb as never
    ).getEffectiveLifecycle(FINDING);
    expect(effective).toMatchObject({
      propertySlug: "status",
      initialStatus: "open",
      unclassified: [],
    });
    expect(effective!.options.map((o) => `${o.key}:${o.category}`)).toEqual([
      "open:open",
      "fixing:active",
      "fixed:done",
      "verified:done",
      "wont_fix:lost",
      "superseded:lost",
    ]);

    // Existing findings keep no status: the declaration moves nobody.
    const old = await q<{
      status: string | null;
      status_category: string | null;
    }>(`select status, status_category from entities where id in ($1,$2)`, [
      OLD_FINDING_1,
      OLD_FINDING_2,
    ]);
    expect(old.rows).toEqual([
      { status: null, status_category: null },
      { status: null, status_category: null },
    ]);

    expect((await proposalsFor(FINDING))[0]!.status).toBe("approved");
    // Re-approving is a no-op.
    await expect(approve(proposalId, FINDING)).resolves.toMatchObject({
      alreadyApproved: true,
    });
  });

  it("refuses an option whose category is not one of the five, and files nothing", async () => {
    const res = await declareTool(ADMIN, {
      profileId: RACE,
      property: "phase",
      options: [
        { key: "open", category: "open" },
        { key: "fixed", category: "resolved" },
      ],
    });
    expect(res.status).toBe("refused");
    expect((res.reasons as string[]).join(" ")).toMatch(
      /"fixed" needs a category \(one of open, active, paused, done, lost\)/
    );
    expect(await proposalsFor(RACE)).toEqual([]);
  });

  it("refuses a kind that already declares a lifecycle, naming the door that changes it", async () => {
    const res = await declareTool(ADMIN, {
      profileId: TICKET,
      options: [{ key: "todo", category: "open" }],
    });
    expect(res.status).toBe("refused");
    expect((res.reasons as string[])[0]).toMatch(
      /already declares "status" as its lifecycle \(todo, done\).*changeLifecycleOptions/
    );
    expect(await proposalsFor(TICKET)).toEqual([]);
  });

  it("a lifecycle declared between filing and approval refuses at approval; the schema is left as it was", async () => {
    const res = await declareTool(ADMIN, {
      profileId: RACE,
      options: [
        { key: "new", category: "open" },
        { key: "done", category: "done" },
      ],
    });
    expect(res.status).toBe("proposed");
    // Meanwhile a template declares `stage` as the kind's lifecycle.
    await expect(
      declareLifecycle(h.drizzleDb as never, {
        profileId: RACE,
        propertySlug: "stage",
      })
    ).resolves.toMatchObject({ status: "declared" });

    await expect(approve(res.proposalId as string, RACE)).rejects.toMatchObject(
      { code: "PRECONDITION_FAILED" }
    );
    expect(await statusDefsOf(RACE)).toEqual([]);
    const links = await lifecycleLinksOf(RACE);
    expect(links.map((l) => l.property_def_id)).toEqual([RACE_STAGE_DEF]);
  });

  it("a non-member cannot file on the kind", async () => {
    await expect(
      declareTool(OUTSIDER, { profileId: TICKET, options: FINDING_OPTIONS })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an unknown kind is NOT_FOUND", async () => {
    await expect(
      declareTool(ADMIN, { profileId: randomUUID(), options: FINDING_OPTIONS })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
