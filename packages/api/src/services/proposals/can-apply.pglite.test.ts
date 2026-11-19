/**
 * THE ONE FILING CHECK, through the real door (plan 8032a127 D1).
 *
 * Every API door files a pending proposal through `createPendingProposalRow`
 * (`createPendingProposal` here), and that row now asks `proposalCannotApply`
 * first: a proposal its approval would refuse is refused with the approval's
 * own sentence and code, and NO row is written. Driven on PGlite with every
 * @synap/database table, so the door, the check and the row are proven
 * against each other rather than against a mock.
 *
 * Kinds covered here: `command/execute` (the materializer's
 * `commandPolicyRefusal`), `focus_session/update` (the approval's
 * `detectServerStampedWrites`) and `playbook/create` (the definition check,
 * read unmocked: a `subjectProfile` that names no profile), all in the
 * request envelope every `checkPermissionOrPropose` door stores. The recipe
 * run is the seam test `execute-capability.recipe-at-filing.test.ts`; that a
 * read which fails files as before is `can-apply.test.ts`.
 *
 * `createProposal`'s mapping of the refusal to the gate's `{ denied }` is
 * `utils/permission-check.can-apply.real-gate.pglite.test.ts`.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
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

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { createPendingProposal } from "../../utils/permission-check.js";
import { ProposalCannotApplyError } from "./can-apply.js";

const WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
});

type Db = { transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T> };

/** The request envelope `checkPermissionOrPropose` stores (`createProposal`). */
const envelope = (
  targetType: string,
  changeType: string,
  data: Record<string, unknown>
) => ({ requestId: randomUUID(), targetType, changeType, data });

/**
 * File ONE pending proposal through the real door, inside a transaction (as
 * `createProposal` does, so the notifications are skipped).
 */
async function file(input: {
  targetType: string;
  targetId: string;
  proposalType: string;
  data: Record<string, unknown>;
}) {
  const db = h.db as unknown as Db;
  return db.transaction(async (tx) =>
    createPendingProposal(
      { userId: "human-1", workspaceId: WS, ...input },
      tx as Parameters<typeof createPendingProposal>[1]
    )
  );
}

async function rowsFor(targetId: string): Promise<number> {
  const { rows } = await h.client!.query<{ n: number }>(
    `select count(*)::int as n from proposals where target_id = $1`,
    [targetId]
  );
  return rows[0]!.n;
}

describe("the one filing check, at createPendingProposal", () => {
  it("a command the materializer would refuse is refused when filed: its sentence, its code, NO row", async () => {
    const targetId = randomUUID();
    const err = await file({
      targetType: "command",
      targetId,
      proposalType: "execute",
      data: envelope("command", "execute", { command: "echo $(whoami)" }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProposalCannotApplyError);
    expect(err).toMatchObject({
      code: "BAD_REQUEST",
      reasonCode: "COMMAND_REFUSED",
      message:
        "Shell substitution (backticks, $()) is not allowed. Run commands directly.",
    });
    expect(await rowsFor(targetId)).toBe(0);
  });

  it("a command that can run is filed as before", async () => {
    const targetId = randomUUID();
    const row = await file({
      targetType: "command",
      targetId,
      proposalType: "execute",
      data: envelope("command", "execute", { command: "ls -la" }),
    });
    expect(row.status).toBe("pending");
    expect(await rowsFor(targetId)).toBe(1);
  });

  it("a session update that changes a server stamp is refused when filed, NO row", async () => {
    const sessionId = randomUUID();
    await h.client!.query(
      `insert into focus_sessions (id, expected_outputs) values ($1, $2::jsonb)`,
      [sessionId, JSON.stringify([{ label: "Report", status: "pending" }])]
    );
    const err = await file({
      targetType: "focus_session",
      targetId: sessionId,
      proposalType: "update",
      data: envelope("focus_session", "update", {
        expectedOutputs: [{ label: "Report", status: "done" }],
      }),
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reasonCode: "SERVER_STAMPED_FIELD" });
    expect((err as Error).message).toMatch(/"Report"\.status/);
    expect(await rowsFor(sessionId)).toBe(0);
  });

  it("a session update that round-trips the stored stamp is filed", async () => {
    const sessionId = randomUUID();
    await h.client!.query(
      `insert into focus_sessions (id, expected_outputs) values ($1, $2::jsonb)`,
      [sessionId, JSON.stringify([{ label: "Report", status: "pending" }])]
    );
    await file({
      targetType: "focus_session",
      targetId: sessionId,
      proposalType: "update",
      data: envelope("focus_session", "update", {
        expectedOutputs: [{ label: "Report", status: "pending", why: "x" }],
      }),
    });
    expect(await rowsFor(sessionId)).toBe(1);
  });

  it("a playbook whose subject kind names no profile is refused when filed: the definition check's NOT_FOUND, read unmocked, NO row", async () => {
    const targetId = randomUUID();
    const err = await createPendingProposal({
      userId: "human-1",
      workspaceId: WS,
      targetType: "playbook",
      targetId,
      proposalType: "create",
      data: envelope("playbook", "create", {
        name: "Qualify a lead",
        goalTemplate: "Qualify the lead",
        stages: [],
        subjectProfile: { profileSlug: "no-such-kind" },
      }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProposalCannotApplyError);
    expect(err).toMatchObject({
      code: "BAD_REQUEST",
      reasonCode: "INVALID_PLAYBOOK",
      message: expect.stringContaining('Unknown profile: "no-such-kind"'),
    });
    expect(await rowsFor(targetId)).toBe(0);
  });

  it("a kind with no entry is filed as before", async () => {
    const targetId = randomUUID();
    await file({
      targetType: "entity",
      targetId,
      proposalType: "create",
      data: envelope("entity", "create", { title: "a note" }),
    });
    expect(await rowsFor(targetId)).toBe(1);
  });
});
