/**
 * A contacts import whose names the pod already holds APPLIES — analyze →
 * apply through the real governed door, on PGlite.
 *
 * MEASURED (live dry run, 2026-10-23): the pod held 13 people with exactly the
 * name of an imported row and analyze linked none. Approving would have run
 * each through `entities.create`'s weak same-name gate → CONFLICT → the whole
 * 2,800-op proposal refused. The four shapes, invented names:
 *   - Ada: pod person with the SAME LinkedIn URL (registered signal);
 *   - Bram: pod person with a name only;
 *   - Cyra: pod person with an email only (no LinkedIn URL);
 *   - Dov: pod person with a DIFFERENT LinkedIn URL;
 *   - Eli: twice in the file, two LinkedIn URLs.
 *
 * Real: CSV parse → plan refine → adapter → `planImportIdentities` +
 * `lookupImportIdentityCandidates` (PGlite) → the proposal row →
 * `ImportOrchestrator.apply` → `applyProposalApproval` → the composite
 * materializer → `entities.create` (weak gate, strong merge) / `entities.update`
 * / facet attach. Stubbed: the IS table planner (returns the live shape), the
 * governance gate (granted), review authority (allowed), audit, events, the run
 * session and intake staging.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  bulk: vi.fn(),
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
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
    previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
    // The pending row, written as the SSOT insert writes it.
    createPendingProposal: vi.fn(
      async (input: {
        userId: string;
        workspaceId: string | null;
        targetType: string;
        targetId: string;
        proposalType: string;
        data: Record<string, unknown>;
      }) => {
        const id = randomUUID();
        await h.client!.query(
          `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by, subject_user_id, comments, revision_history, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6::jsonb,'pending',$7,$7,'[]'::jsonb,'[]'::jsonb,now(),now())`,
          [
            id,
            input.workspaceId,
            input.targetType,
            input.targetId,
            input.proposalType,
            JSON.stringify(input.data),
            input.userId,
          ]
        );
        return { id };
      }
    ),
  };
});
// Review authority has its own suites; the owner approving is not under test.
vi.mock("../routers/proposals/review-authority.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  computeCanReviewApproval: vi.fn(async () => ({
    allowed: true,
    reason: "owner",
  })),
}));
vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: randomUUID() })),
}));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: async () => {},
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../utils/intelligence-routing.js", () => ({
  resolveIntelligenceService: vi.fn(async () => ({
    client: { analyzeBulkMapping: h.bulk },
  })),
}));
vi.mock("./import/session.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveImportSession: vi.fn(async () => ({
    sessionId: null,
    sessionSource: "none",
    requestedSessionIgnored: false,
  })),
}));
vi.mock("./intake/record-import-intake.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordImportIntake: vi.fn(async () => null),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { normalizeIdentitySignal } from "@synap/database";
import { ImportOrchestrator } from "./import-orchestrator.js";

const OWNER = randomUUID();
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
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const li = (slug: string) => `https://www.linkedin.com/in/${slug}`;
const ctx = () => ({
  workspaceId: null,
  userId: OWNER,
  trpcCtx: { authenticated: true, userId: OWNER, workspaceId: null },
});

const CSV = [
  "First Name,Last Name,URL,Email Address,Company,Position",
  `Ada,Quill,${li("ada-quill")},,,CTO`,
  `Bram,Oko,${li("bram-oko")},,,Founder`,
  `Cyra,Dell,${li("cyra-dell")},,,Designer`,
  `Dov,Ash,${li("dov-ash-2")},,,Engineer`,
  `Eli,Twin,${li("eli-twin-1")},,,Analyst`,
  `Eli,Twin,${li("eli-twin-2")},,,Writer`,
  `Fay,New,${li("fay-new")},,,Coach`,
].join("\n");

const PLAN = {
  rowEntityType: "contact",
  titleColumn: "First Name",
  columnMappings: [
    "First Name",
    "Last Name",
    "URL",
    "Email Address",
    "Company",
    "Position",
  ].map((header) => ({
    header,
    slug: header.toLowerCase().replace(/\s+/g, "-"),
    valueType: "string",
    scope: "primary",
    label: header,
    isNew: true,
    confidence: 0.9,
    reasoning: "",
  })),
  warnings: [],
  overallConfidence: 0.9,
};

const ids = {
  ada: randomUUID(),
  bram: randomUUID(),
  cyra: randomUUID(),
  dov: randomUUID(),
};
let PERSON = "";

async function seedPerson(
  id: string,
  title: string,
  properties: Record<string, unknown>
) {
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, version, created_at, updated_at)
     values ($1,$2,null,$3,'person',$4,$5::jsonb,1,now(),now())`,
    [id, OWNER, PERSON, title, JSON.stringify(properties)]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  // ON CONFLICT targets need their unique indexes (plain-column ones).
  for (const t of byName.values()) {
    const cfg = getTableConfig(t);
    const uniques = [
      ...cfg.indexes
        .filter((i) => i.config.unique && !i.config.where)
        .map((i) => i.config.columns),
      ...cfg.uniqueConstraints.map((u) => u.columns),
    ];
    for (const cols of uniques) {
      const names = (cols as Array<{ name?: string }>).map((c) => c.name);
      if (names.some((n) => !n)) continue;
      await h.client!.exec(
        `create unique index if not exists "u_${cfg.name}_${names.join("_")}" on "${cfg.name}" (${names.map((n) => `"${n}"`).join(", ")});`
      );
    }
  }
  await q(`insert into users (id, email) values ($1, 'owner@x.test')`, [OWNER]);
  const profile = async (
    slug: string,
    kind: "kind" | "role",
    applicable: string[] | null
  ) =>
    (
      await q<{ id: string }>(
        `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, applicable_kinds)
         values (gen_random_uuid(),$1,$1,$2,'system','pod',null,true,'{}'::jsonb,$3) returning id`,
        [slug, kind, applicable]
      )
    ).rows[0]!.id;
  PERSON = await profile("person", "kind", null);
  await profile("company", "kind", null);
  await profile("contact", "role", ["person"]);
  for (const slug of ["linkedinUrl", "email", "role", "jobTitle"]) {
    const def = (
      await q<{ id: string }>(
        `insert into property_defs (id, slug, profile_id, workspace_id, value_type, constraints, ui_hints, created_at, updated_at)
         values (gen_random_uuid(),$1,$2,null,'string','{}'::jsonb,'{}'::jsonb,now(),now()) returning id`,
        [slug, PERSON]
      )
    ).rows[0]!.id;
    await q(
      `insert into profile_properties (profile_id, property_def_id, required, display_order, is_lifecycle)
       values ($1,$2,false,0,false)`,
      [PERSON, def]
    );
  }
  await seedPerson(ids.ada, "Ada Quill", { linkedinUrl: li("ada-quill") });
  await q(
    `insert into entity_identity_signals (id, entity_id, signal_type, signal_value, source, created_at)
     values (gen_random_uuid(),$1,'linkedin_url',$2,'test',now())`,
    [ids.ada, normalizeIdentitySignal("linkedin_url", li("ada-quill"))]
  );
  await seedPerson(ids.bram, "Bram Oko", {});
  await seedPerson(ids.cyra, "Cyra Dell", { email: "cyra@example.org" });
  await seedPerson(ids.dov, "Dov Ash", { linkedinUrl: li("dov-ash-1") });
  h.bulk.mockResolvedValue(PLAN);
}, 120_000);

const people = async () =>
  (
    await q<{ id: string; title: string; properties: Record<string, unknown> }>(
      `select id, title, properties from entities where type = 'person' and deleted_at is null order by title, created_at`
    )
  ).rows;

describe("a contacts import over people the pod already holds", () => {
  it("analyze links, flags and separates; approval applies; the counts are right", async () => {
    const analyzed = (await new ImportOrchestrator(ctx()).analyze({
      source: "csv",
      items: [{ path: "Connections.csv", content: CSV }],
    })) as Awaited<ReturnType<ImportOrchestrator["analyze"]>> & {
      identities?: {
        linkedBySignal: number;
        matchedByName: number;
        separate: number;
      };
    };
    expect(analyzed.proposalId).toBeTruthy();
    expect(analyzed.identities).toMatchObject({
      linkedBySignal: 1, // Ada (same URL)
      matchedByName: 2, // Bram (name only), Cyra (email only)
      separate: 2, // Dov (other URL), the second Eli
    });

    const before = (await people()).length; // 4 seeded
    const applied = (await new ImportOrchestrator(ctx()).apply({
      source: "csv",
      proposalId: analyzed.proposalId!,
    })) as { success?: boolean };
    expect(applied.success ?? true).toBe(true);

    const after = await people();
    // Created: Dov (2nd), Eli ×2, Fay. Linked (no new row): Ada, Bram, Cyra.
    expect(after.length - before).toBe(4);
    expect(after.filter((p) => p.title === "Dov Ash")).toHaveLength(2);
    expect(after.filter((p) => p.title === "Eli Twin")).toHaveLength(2);
    // Filled where empty, never overwritten.
    const cyra = after.find((p) => p.id === ids.cyra)!;
    expect(cyra.properties.linkedinUrl).toBe(li("cyra-dell"));
    expect(cyra.properties.email).toBe("cyra@example.org");
    // The contact role reaches the linked people too.
    const { rows: roles } = await q<{ entity_id: string }>(
      `select entity_id from entity_facets where deleted_at is null`
    );
    for (const id of [ids.ada, ids.bram, ids.cyra]) {
      expect(roles.map((r) => r.entity_id)).toContain(id);
    }
    const { rows } = await q<{ status: string }>(
      `select status from proposals where id = $1`,
      [analyzed.proposalId]
    );
    expect(rows[0]!.status).toBe("approved");
  }, 120_000);
});
