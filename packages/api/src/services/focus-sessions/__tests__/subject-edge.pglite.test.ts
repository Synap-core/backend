/**
 * OUTPUT → SUBJECT EDGE on a real Postgres (PGlite): a satisfied slot that
 * declares `relationToSubject` gets `output --type--> subject` through the
 * relation door, ONCE; a relation type the workspace does not define is
 * RECORDED on the slot (never thrown); `"none"` means no edge. The relation
 * door itself (`relations.create` — governance, placement) has its own suites
 * and is replaced by a recorder that inserts the row it would write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  client: undefined as unknown,
  creates: [] as Array<Record<string, unknown>>,
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => h.db,
    getWorkspaceMembership: async () => ({ role: "owner" }),
  };
  Object.defineProperty(mocked, "db", { get: () => h.db, enumerable: true });
  return mocked;
});
vi.mock("../../../routers/relations.js", () => ({
  relationsRouter: {
    createCaller: () => ({
      create: async (input: Record<string, unknown>) => {
        h.creates.push(input);
        const id = randomUUID();
        await (h.client as PGlite).query(
          `insert into relations (id, user_id, source_entity_id, target_entity_id, type) values ($1,'u',$2,$3,$4)`,
          [id, input.sourceEntityId, input.targetEntityId, input.type]
        );
        return { id, status: "created" };
      },
    }),
  },
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  entities,
  focusSessions,
  proposals,
  relations,
  relationDefs,
} from "@synap/database";
import { linkSatisfiedOutputsToSubject } from "../subject-edge.js";
import { satisfyExpectedOutputs } from "../satisfy-expected-output.js";

const WS = randomUUID();
const SUBJECT = randomUUID();
const OUTPUT = randomUUID();
const PROPOSAL = randomUUID();

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
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
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}


async function fresh(slots: unknown[]) {
  const client = new PGlite();
  for (const t of [entities, focusSessions, proposals, relations, relationDefs]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  h.client = client;
  h.db = drizzle(client, {
    schema: { entities, focusSessions, proposals, relations, relationDefs },
  });
  for (const [id, type] of [
    [SUBJECT, "idea"],
    [OUTPUT, "post"],
  ]) {
    await client.query(
      `insert into entities (id, user_id, workspace_id, type, title) values ($1,'u',$2,$3,'x')`,
      [id, WS, type]
    );
  }
  await client.query(
    `insert into relation_defs (id, slug, display_name, workspace_id, user_id) values ($1,'made_for','Made for',$2,'u')`,
    [randomUUID(), WS]
  );
  await client.query(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_by) values ($1,'approved','create','entity',$2,'{}'::jsonb,'agent')`,
    [PROPOSAL, OUTPUT]
  );
  const SESSION = randomUUID();
  await client.query(
    `insert into focus_sessions (id, user_id, workspace_id, goal, subject_entity_id, expected_outputs) values ($1,'u',$2,'g',$3,$4::jsonb)`,
    [SESSION, WS, SUBJECT, JSON.stringify(slots)]
  );
  return { client, SESSION };
}

async function slotsOf(client: PGlite, id: string) {
  const r = await client.query<{ expected_outputs: Array<Record<string, any>> }>(
    `select expected_outputs from focus_sessions where id = $1`,
    [id]
  );
  return r.rows[0]!.expected_outputs;
}

beforeEach(() => {
  h.creates = [];
});

describe("linkSatisfiedOutputsToSubject", () => {
  it("writes output --made_for--> subject for an approved slot, once, and stamps the receipt", async () => {
    const { client, SESSION } = await fresh([
      { kind: "post", label: "Post", status: "done", satisfiedByProposalId: PROPOSAL, relationToSubject: "made_for" },
    ]);
    const out = await linkSatisfiedOutputsToSubject({ sessionId: SESSION });
    expect(h.creates).toEqual([
      expect.objectContaining({ sourceEntityId: OUTPUT, targetEntityId: SUBJECT, type: "made_for" }),
    ]);
    expect(out[0]!.edge).toMatchObject({ status: "linked", relationType: "made_for", outputEntityId: OUTPUT });
    const [slot] = await slotsOf(client, SESSION);
    expect(slot!.subjectEdge).toMatchObject({ status: "linked", outputEntityId: OUTPUT });
    expect(slot!.subjectEdge.relationId).toBeTruthy();
    // Idempotent: the receipt makes a second pass a no-op.
    await linkSatisfiedOutputsToSubject({ sessionId: SESSION });
    expect(h.creates).toHaveLength(1);
  });

  it("an undefined relation type is RECORDED on the slot, never thrown", async () => {
    const { client, SESSION } = await fresh([
      { kind: "post", label: "Post", status: "done", satisfiedByProposalId: PROPOSAL, relationToSubject: "derived_from" },
    ]);
    await expect(linkSatisfiedOutputsToSubject({ sessionId: SESSION })).resolves.toBeDefined();
    expect(h.creates).toEqual([]);
    const [slot] = await slotsOf(client, SESSION);
    expect(slot!.subjectEdge).toMatchObject({ status: "skipped", reason: "relation_type_not_defined" });
    expect(slot!.status).toBe("done");
  });

  it("'none', a pending slot, and an evidence ref all behave", async () => {
    const { client, SESSION } = await fresh([
      { kind: "post", label: "A", status: "done", relationToSubject: "none", satisfiedByProposalId: PROPOSAL },
      { kind: "post", label: "B", relationToSubject: "made_for" },
      {
        kind: "post",
        label: "C",
        status: "done",
        relationToSubject: "made_for",
        satisfiedByEvidence: { kind: "ref", id: `entity:${OUTPUT}`, at: "2026-10-08T00:00:00.000Z" },
      },
    ]);
    await linkSatisfiedOutputsToSubject({ sessionId: SESSION });
    const slots = await slotsOf(client, SESSION);
    expect(slots[0]!.subjectEdge).toBeUndefined();
    expect(slots[1]!.subjectEdge).toBeUndefined();
    expect(slots[2]!.subjectEdge).toMatchObject({ status: "linked" });
    expect(h.creates).toHaveLength(1);
  });

  it("an edge that already exists is reused, not duplicated", async () => {
    const { client, SESSION } = await fresh([
      { kind: "post", label: "Post", status: "done", satisfiedByProposalId: PROPOSAL, relationToSubject: "made_for" },
    ]);
    const existing = randomUUID();
    await client.query(
      `insert into relations (id, user_id, source_entity_id, target_entity_id, type) values ($1,'u',$2,$3,'made_for')`,
      [existing, OUTPUT, SUBJECT]
    );
    await linkSatisfiedOutputsToSubject({ sessionId: SESSION });
    expect(h.creates).toEqual([]);
    const [slot] = await slotsOf(client, SESSION);
    expect(slot!.subjectEdge).toMatchObject({ status: "linked", relationId: existing });
  });

  it("SEAM: the approval satisfy door itself writes the edge after stamping done", async () => {
    const { client, SESSION } = await fresh([
      { kind: "post", label: "Post", relationToSubject: "made_for" },
    ]);
    const r = await satisfyExpectedOutputs({
      sessionId: SESSION,
      targetType: "entity",
      entityProfileSlug: "post",
      proposalId: PROPOSAL,
    });
    expect(r.satisfied).toEqual(["Post"]);
    const [slot] = await slotsOf(client, SESSION);
    expect(slot!.status).toBe("done");
    expect(slot!.subjectEdge).toMatchObject({ status: "linked", outputEntityId: OUTPUT });
    expect(h.creates).toHaveLength(1);
  });
});
