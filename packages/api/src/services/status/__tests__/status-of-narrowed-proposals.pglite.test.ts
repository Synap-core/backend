/**
 * The proposal floor of the narrowed `work` projection (D7), on real SQL
 * (PGlite): `readableWorkProposalIds` keeps a gate's proposal for a key
 * narrowed by its grant only when the access layer's proposal rule, which ANDs
 * the key's grant, reads it. The gate proposals themselves are read by
 * session id with no grant clause (`session-gates.ts`), so a proposal of
 * another space (or a pod-wide one) filed against the session must not reach a
 * key pinned to one space.
 *
 *   - CONTROL: with no grant (a person) every proposal of the answers is read,
 *     so the grant is what removes the foreign one;
 *   - a key pinned to the session's space, holding `proposal.read`, reads
 *     that space's proposal only: the other space's and the pod-wide one are
 *     not in the set;
 *   - a key pinned to the space WITHOUT `proposal.read` reads none;
 *   - the ids are taken from the gates of every item of every answer, and an
 *     answer with no gate reads nothing (no query).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual, getDb: async () => holder.db };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithGrant, type KeyGrant } from "@synap/database";
import { readableWorkProposalIds } from "../status-of-narrowed-proposals.js";

const ME = "user-me";
const W1 = randomUUID();
const W2 = randomUUID();
const P_OWN = randomUUID(); // filed in the session's space
const P_OTHER_SPACE = randomUUID(); // filed in another space of the same person
const P_POD_WIDE = randomUUID(); // no space

let client: PGlite;
const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

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

const gateOf = (proposalId: string) => ({
  stageKey: "draft",
  state: "pending",
  proposalId,
});
/** An answer as `readStatusOf` shapes it, with the gates of one session. */
const answerWith = (...proposalIds: string[]) => ({
  id: "e1",
  work: {
    items: [{ sessionId: "s1", gates: { status: "ok", items: proposalIds.map(gateOf) } }],
    truncated: false,
  },
});

const pin = (...permissions: string[]): KeyGrant => ({
  scopes: [{ permissions, workspaceIds: [W1] }],
  clientId: null,
});

beforeAll(async () => {
  client = new PGlite();
  const tables = (Object.values(schema) as unknown[]).filter(
    (t): t is PgTable => is(t, PgTable)
  );
  expect(tables.length).toBeGreaterThan(50);
  for (const t of tables) await client.exec(ddlFor(t));
  holder.db = drizzle(client, { schema });

  for (const w of [W1, W2]) {
    await q(
      `insert into workspaces (id, owner_id, name, workspace_type) values ($1, $2, 'Space', 'personal')`,
      [w, ME]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), w, ME]
    );
  }
  await q(
    `insert into pod_members (id, user_id) values ($1, $2)`,
    [randomUUID(), ME]
  ).catch(() => undefined);
  for (const [id, ws] of [
    [P_OWN, W1],
    [P_OTHER_SPACE, W2],
    [P_POD_WIDE, null],
  ] as const) {
    await q(
      `insert into proposals (id, workspace_id, status, proposal_type, target_type, target_id, data, created_at, updated_at)
       values ($1, $2, 'pending', 'focus_session.approve_stage', 'focus_session', $3, '{}'::jsonb, now(), now())`,
      [id, ws, randomUUID()]
    );
  }
}, 120_000);

describe("readableWorkProposalIds", () => {
  it("CONTROL: with no grant, every proposal the answers name is read", async () => {
    const ids = await readableWorkProposalIds(ME, [
      answerWith(P_OWN, P_OTHER_SPACE, P_POD_WIDE),
    ]);
    expect([...ids].sort()).toEqual(
      [P_OWN, P_OTHER_SPACE, P_POD_WIDE].sort()
    );
  });

  it("a key pinned to the session's space reads that space's proposal only", async () => {
    const ids = await runWithGrant(pin("proposal.read", "session.read"), () =>
      readableWorkProposalIds(ME, [answerWith(P_OWN, P_OTHER_SPACE, P_POD_WIDE)])
    );
    expect([...ids]).toEqual([P_OWN]);
  });

  it("a pinned key without proposal.read reads none", async () => {
    const ids = await runWithGrant(pin("session.read"), () =>
      readableWorkProposalIds(ME, [answerWith(P_OWN, P_OTHER_SPACE)])
    );
    expect([...ids]).toEqual([]);
  });

  it("takes the ids from every item of every answer, and reads nothing when there is no gate", async () => {
    const ids = await runWithGrant(pin("proposal.read"), () =>
      readableWorkProposalIds(ME, [
        answerWith(P_OTHER_SPACE),
        answerWith(P_OWN),
        { id: "e2", work: { items: [{ sessionId: "s2", gates: { status: "ok", items: [] } }] } },
        { id: "e3" },
      ])
    );
    expect([...ids]).toEqual([P_OWN]);
    expect([...(await readableWorkProposalIds(ME, [{ id: "e3" }]))]).toEqual(
      []
    );
  });
});
