/**
 * Outcomes / inputs / unattached — REACHABILITY through the real read door.
 *
 * Drives `focusSessions.outputs` (the canonical per-session read the browser
 * room and Relay call) against PGlite: real `listSessionOutputs`, real
 * three-ledger join, real `readCriteria`, real `session_evaluations` table
 * (created by its shipped migration, 0267), real projection
 * (`projectSessionOutcomes`). Nothing is hand-built between the stored row and
 * the asserted wire value, so deleting the door's projection, its criteria
 * read or its evaluations read fails exactly this file.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  artifacts,
  links,
  proposals,
  entities,
  documents,
  views,
  automations,
  playbooks,
  channels,
  channelMembers,
  users,
  podMembers,
  projectMembers,
  workspaces,
  workspaceMembers,
} from "@synap/database";
import { focusSessionsRouter } from "../../../routers/focus-sessions.js";

const USER = "user-1";
const DOC_DECK = randomUUID();
const DOC_STRAY = randomUUID();
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

describe("focusSessions.outputs — outcomes / inputs / unattached reach the wire", () => {
  beforeAll(async () => {
    for (const t of [
      focusSessions,
      artifacts,
      links,
      proposals,
      entities,
      documents,
      views,
      automations,
      playbooks,
      channels,
      channelMembers,
      users,
      podMembers,
      projectMembers,
      workspaces,
      workspaceMembers,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../../../../database/migrations/0267_session_criteria_and_evaluations.sql"
        ),
        "utf8"
      )
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  it("projects the stored slots, criteria, evaluations and artifacts", async () => {
    const id = randomUUID();
    // A LEGACY slot set: no keys stored, written straight to the column.
    const slots = [
      { kind: "document", label: "Pitch deck" },
      {
        kind: "report",
        label: "Lead list",
        owner: "human",
        blockedReason: "decision",
        why: "Include agencies outside France?",
        owedSince: "2026-10-01T10:00:00.000Z",
      },
      {
        kind: "playbook_param",
        label: "Answer: Region",
        paramName: "region",
        owner: "human",
        blockedReason: "decision",
        owedSince: "2026-10-01T10:00:00.000Z",
      },
    ];
    const criteria = [
      {
        key: "typecheck",
        statement: "Typecheck passes",
        check: { kind: "evidence" },
      },
    ];
    await q(
      `insert into focus_sessions (id, user_id, goal, status, expected_outputs, criteria, agent_ids, metadata, created_at, updated_at, started_at)
       values ($1, $2, 'Find leads', 'active', $3::jsonb, $4::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
      [id, USER, JSON.stringify(slots), JSON.stringify(criteria)]
    );
    await q(
      `insert into session_evaluations (session_id, user_id, criterion_key, verdict, evaluator_kind)
       values ($1, $2, 'typecheck', 'pass', 'evidence')`,
      [id, USER]
    );
    for (const [docId, label] of [
      [DOC_DECK, "Pitch deck"],
      [DOC_STRAY, null],
    ] as const) {
      await q(
        `insert into artifacts (id, session_id, kind, ref_id, title, origin_kind, state, props, created_at)
         values ($1, $2, 'document', $3, 'Doc', 'agent', 'working', $4::jsonb, now())`,
        [
          randomUUID(),
          id,
          docId,
          JSON.stringify(label ? { expectedLabel: label } : {}),
        ]
      );
    }

    const caller = focusSessionsRouter.createCaller({
      authenticated: true,
      userId: USER,
    } as never);
    const res = await caller.outputs({ sessionId: id });

    expect(
      res.outcomes.map((o) => ({
        key: o.key,
        source: o.source,
        state: o.state.state,
        met: o.met,
        evidence: o.evidence.map((e) => e.refId),
      }))
    ).toEqual([
      {
        key: "pitch-deck",
        source: "slot",
        state: "working",
        met: false,
        evidence: [DOC_DECK],
      },
      {
        key: "lead-list",
        source: "slot",
        state: "needs_you",
        met: false,
        evidence: [],
      },
      {
        key: "typecheck",
        source: "criterion",
        state: "done",
        met: true,
        evidence: [],
      },
    ]);
    expect(
      res.inputs.map((i) => ({
        key: i.key,
        need: i.need,
        blocks: i.blocksOutcomeKey,
      }))
    ).toEqual([
      { key: "lead-list", need: "decision", blocks: "lead-list" },
      { key: "answer-region", need: "param", blocks: null },
    ]);
    expect(res.unattached.map((u) => u.refId)).toEqual([DOC_STRAY]);
    expect(res.outcomeCounts).toEqual({ met: 1, total: 3 });
    // Additive: the join's own fields are still there.
    expect(res.outputs).toHaveLength(2);
    expect(res.pendingExpected.map((e) => e.label)).toEqual([
      "Lead list",
      "Answer: Region",
    ]);
  });
});
