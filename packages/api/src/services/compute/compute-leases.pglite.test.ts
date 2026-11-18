/**
 * COMPUTE LEASES through the ONE post-gate runner (`runResolvedSkill`, used by
 * a direct run AND an approved `capability.run`) and the TTL sweeper, on a
 * real Postgres (PGlite). Only the code-skill sandbox is a stub (what a
 * provider's start and destroy return).
 *
 *  - a start without its terms, or whose release verb is missing, is refused
 *    and leaves no lease (nothing is called);
 *  - a start writes its lease BEFORE the provider, and settles it: active
 *    with the machine's id, not_started when the start failed, unknown when
 *    it returned no id;
 *  - the sweeper destroys an active lease past its TTL through the declared
 *    release verb, as the starter, with no gate, and records it on the lease
 *    and on the start's proposal; a lease not yet due is left alone;
 *  - a failed release stays active with its error, and is retried;
 *  - a manual destroy closes the lease of the machine it names; a stop does
 *    not.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  sandbox: (_args: { skillId: string; parameters: unknown }) =>
    ({ success: true, result: {} }) as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
const runSkillMock = vi.hoisted(() => vi.fn());
vi.mock("../skills/run-skill.js", () => ({
  runSkill: runSkillMock,
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  runResolvedSkill,
  type ResolvedSkillRow,
} from "../capabilities/execute-capability.js";
import { releaseExpiredComputeLeases } from "./release-expired-leases.js";

const OWNER = "owner-1";
const PROVISION_ID = "00000000-0000-4000-8000-0000000000a1";
const RELEASE_ID = "00000000-0000-4000-8000-0000000000b2";
const PROPOSAL_ID = "00000000-0000-4000-8000-0000000000c3";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${columns.join(", ")});`;
}

let pg: PGlite;
let db: any;

const provisionSkill: ResolvedSkillRow = {
  id: PROVISION_ID,
  name: "cloud_create_server",
  kind: "code",
  providerSpec: null,
  metadata: { compute: { releaseVerb: "cloud_delete_server" } },
  parameters: null,
  executionMode: "sync",
  intent: "provision_compute",
  inputMap: null,
};

const releaseSkill: ResolvedSkillRow = {
  id: RELEASE_ID,
  name: "cloud_delete_server",
  kind: "code",
  providerSpec: null,
  metadata: { compute: { modes: ["destroy"] } },
  parameters: null,
  executionMode: "sync",
  intent: "release_compute",
  inputMap: null,
};

const start = (params: Record<string, unknown>, proposalId?: string) =>
  runResolvedSkill(provisionSkill, params, {
    userId: OWNER,
    workspaceId: null,
    ...(proposalId
      ? { provenance: { agentUserId: "agent-1", proposalId } }
      : {}),
  });

async function leases() {
  const r = await pg.query<{
    id: string;
    state: string;
    resource_id: string | null;
    expires_at: Date;
    release_attempts: number;
    last_release_error: string | null;
    proposal_id: string | null;
    release_verb: string;
    agent_user_id: string | null;
  }>(`select * from compute_leases order by created_at`);
  return r.rows;
}

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [
    schema.skills,
    schema.links,
    schema.workspaces,
    schema.workspaceMembers,
    schema.podMembers,
    schema.users,
    schema.computeLeases,
    schema.proposals,
  ]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  await pg.exec(
    `insert into users (id, email) values ('${OWNER}', 'o@example.test')`
  );
  db = drizzle(pg, { schema });
  holder.db = db;
  await db.insert(schema.skills).values({
    id: RELEASE_ID,
    name: "cloud_delete_server",
    userId: OWNER,
    scope: "user",
    status: "active",
    approved: true,
    kind: "code",
    intent: "release_compute",
    metadata: { compute: { modes: ["destroy"] } },
  });
}, 120_000);
afterAll(async () => pg?.close());

beforeEach(async () => {
  await pg.exec(`delete from compute_leases; delete from proposals;`);
  runSkillMock.mockReset();
  runSkillMock.mockImplementation(async (args: { skillId: string; parameters: unknown }) =>
    holder.sandbox(args)
  );
  holder.sandbox = ({ skillId }) =>
    skillId === PROVISION_ID
      ? { success: true, result: { resourceId: 4711, ip: "203.0.113.7" } }
      : { success: true, result: { action: { status: "running" } } };
});

describe("a compute start through runResolvedSkill", () => {
  it("is refused without its time to live, and nothing is called or recorded", async () => {
    const out = await start({ maxSpendCents: 300 });
    expect(out).toMatchObject({ kind: "error" });
    expect((out as { message: string }).message).toMatch(/ttlMinutes/);
    expect(runSkillMock).not.toHaveBeenCalled();
    expect(await leases()).toEqual([]);
  });

  it("is refused when its release verb is not installed, and nothing is called", async () => {
    const out = await runResolvedSkill(
      {
        ...provisionSkill,
        metadata: { compute: { releaseVerb: "nobody_releases_this" } },
      },
      { ttlMinutes: 60, maxSpendCents: 300 },
      { userId: OWNER, workspaceId: null }
    );
    expect(out).toMatchObject({ kind: "error" });
    expect((out as { message: string }).message).toMatch(/not installed/);
    expect(runSkillMock).not.toHaveBeenCalled();
    expect(await leases()).toEqual([]);
  });

  it("writes its lease and settles it active with the machine's id", async () => {
    const before = Date.now();
    const out = await start(
      { ttlMinutes: 120, maxSpendCents: 300, size: "cx22" },
      PROPOSAL_ID
    );
    expect(out.kind).toBe("run");
    const report = (out as { result: { computeLease: Record<string, unknown> } })
      .result.computeLease;
    expect(report).toMatchObject({ state: "active", resourceId: "4711" });
    const [lease] = await leases();
    expect(lease).toMatchObject({
      state: "active",
      resource_id: "4711",
      release_verb: "cloud_delete_server",
      proposal_id: PROPOSAL_ID,
      agent_user_id: "agent-1",
    });
    const ttlMs = new Date(lease!.expires_at).getTime() - before;
    expect(ttlMs).toBeGreaterThanOrEqual(120 * 60_000 - 5_000);
    expect(ttlMs).toBeLessThanOrEqual(120 * 60_000 + 5_000);
    // The provider got the run's own parameters, terms included.
    expect(runSkillMock.mock.calls[0]![0].parameters).toMatchObject({
      size: "cx22",
      ttlMinutes: 120,
    });
  });

  it("a failed start leaves its lease not_started", async () => {
    holder.sandbox = () => ({ success: false, error: "quota exceeded" });
    const out = await start({ ttlMinutes: 60, maxSpendCents: 100 });
    expect(out.kind).toBe("error");
    expect((await leases())[0]!.state).toBe("not_started");
  });

  it("a start that returns no machine id is unknown: a person must look", async () => {
    holder.sandbox = () => ({ success: true, result: { ok: true } });
    const out = await start({ ttlMinutes: 60, maxSpendCents: 100 });
    expect(out.kind).toBe("run");
    expect((await leases())[0]!.state).toBe("unknown");
  });
});

describe("the TTL sweeper", () => {
  it("destroys a lease past its TTL through the declared release verb, and records it", async () => {
    await pg.query(
      `insert into proposals (id, target_type, target_id, proposal_type, status, data)
       values ($1, 'capability', $2, 'capability.run', 'approved', '{"summary":"Start"}'::jsonb)`,
      [PROPOSAL_ID, PROVISION_ID]
    );
    await start({ ttlMinutes: 60, maxSpendCents: 300 }, PROPOSAL_ID);
    // A second lease, not yet due, must be left alone.
    await start({ ttlMinutes: 600, maxSpendCents: 300 });
    runSkillMock.mockClear();

    const result = await releaseExpiredComputeLeases({
      now: new Date(Date.now() + 61 * 60_000),
    });
    expect(result).toEqual({ due: 1, released: 1, failed: 0 });
    expect(runSkillMock).toHaveBeenCalledTimes(1);
    expect(runSkillMock.mock.calls[0]![0]).toMatchObject({
      skillId: RELEASE_ID,
      userId: OWNER,
      parameters: { resourceId: "4711", mode: "destroy" },
    });
    const rows = await leases();
    expect(rows.map((r) => r.state)).toEqual(["released", "active"]);
    const proposal = await pg.query<{ data: Record<string, any> }>(
      `select data from proposals where id = $1`,
      [PROPOSAL_ID]
    );
    expect(proposal.rows[0]!.data.summary).toBe("Start");
    expect(proposal.rows[0]!.data.computeRelease).toMatchObject({
      status: "released",
      mode: "destroy",
      resourceId: "4711",
      reason: "ttl",
    });

    // Released once: the next tick has nothing to do.
    expect(
      await releaseExpiredComputeLeases({
        now: new Date(Date.now() + 61 * 60_000),
      })
    ).toEqual({ due: 0, released: 0, failed: 0 });
  });

  it("a failed release stays active with its error, and is tried again", async () => {
    await start({ ttlMinutes: 60, maxSpendCents: 300 });
    holder.sandbox = () => ({ success: false, error: "provider down" });
    const later = new Date(Date.now() + 61 * 60_000);
    expect(await releaseExpiredComputeLeases({ now: later })).toEqual({
      due: 1,
      released: 0,
      failed: 1,
    });
    let [lease] = await leases();
    expect(lease).toMatchObject({
      state: "active",
      release_attempts: 1,
      last_release_error: "provider down",
    });
    holder.sandbox = () => ({ success: true, result: {} });
    expect(await releaseExpiredComputeLeases({ now: later })).toEqual({
      due: 1,
      released: 1,
      failed: 0,
    });
    [lease] = await leases();
    expect(lease).toMatchObject({ state: "released", release_attempts: 2 });
  });
});

describe("a manual release", () => {
  it("a destroy closes the lease of the machine it names", async () => {
    await start({ ttlMinutes: 60, maxSpendCents: 300 });
    const out = await runResolvedSkill(
      releaseSkill,
      { resourceId: "4711", mode: "destroy" },
      { userId: OWNER, workspaceId: null }
    );
    expect(out.kind).toBe("run");
    expect((await leases())[0]!.state).toBe("released");
  });

  it("a stop through a destroy-only verb is refused and the lease stays", async () => {
    await start({ ttlMinutes: 60, maxSpendCents: 300 });
    runSkillMock.mockClear();
    const out = await runResolvedSkill(
      releaseSkill,
      { resourceId: "4711", mode: "stop" },
      { userId: OWNER, workspaceId: null }
    );
    expect(out.kind).toBe("error");
    expect(runSkillMock).not.toHaveBeenCalled();
    expect((await leases())[0]!.state).toBe("active");
  });
});
