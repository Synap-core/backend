/**
 * A human-owned decision slot on a CLOSED, playbook-origin (`kind: run`),
 * NULL-workspace, project-filed session — the exact shape the founder reported
 * as "I can't find this" (session efb6f3c5, 2026-09-27) — driven through the
 * REAL `signals.list` / `signals.count` procedures on PGlite.
 *
 * Why this shape, field by field (each is a lens something could drop it on):
 *  - status `closed`   — the reaper closed the run; the slot is still owed
 *                        (`retirementForClose` retires on `cancelled` only).
 *  - origin `playbook` — derives `kind: run`, which every `kind: 'work'`
 *                        session list excludes.
 *  - workspace NULL    — a pod-personal session; a workspace-string lens
 *                        (`workspace_id = X`) never matches it.
 *  - project set       — the project lens must still reach it.
 *  - `ref.url`         — an external artifact; the row must still address the
 *                        SESSION (where the answer verbs are), never the URL.
 *  - a `session.needs_you` notification — folds into the slot row, so the
 *                        decision is one row, not zero and not two.
 *
 * The pod's read was already correct for this shape; the defect was on the
 * browser's Home (it listed sessions, not slots — see `home-model.ts`
 * `homeOwedSlotRows`). This pins that the pod keeps delivering the row every
 * surface now renders, and that the row NAMES the decision.
 *
 * Stubbed, as in `signals.needs-you-session-pointer.pglite.test.ts`:
 * `proposals.groups` (proposal half not under test) and the project review
 * count (project scope only, returns 0).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        focusSessions: actual.focusSessions as never,
        notifications: actual.notifications as never,
        messages: actual.messages as never,
      },
    }),
  };
});

vi.mock("./proposals.js", () => ({
  proposalsRouter: {
    createCaller: () => ({
      groups: async () => ({ groups: [], distinct: 0, scanTruncated: false }),
    }),
  },
}));

vi.mock("../services/projects/project-needs-you.js", () => ({
  countProjectSessionsAwaitingReview: async () => ({
    review: 0,
    truncated: false,
  }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { db, focusSessions, notifications, messages } from "@synap/database";
import { signalsRouter } from "./signals.js";

const USER = "user-1";
const PROJECT = randomUUID();
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" || c.name === "timestamp" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const LABEL =
  "Validate round-2 plan: 9 decisions (enforcement, identity, cap, asking you, playbook offer, live updates, shared sessions, @ai principal, connector blocker)";

/** The founder's slot, verbatim in shape (the pod's `synap_get_session`). */
const FOUNDER_SLOT = {
  ref: {
    url: "https://claude.ai/code/artifact/9ed62a26-8fd8-4414-a61a-7d4a0da27a1f",
  },
  why: "Each decision has options + a recommendation in the recap doc; tick or rewrite them.",
  kind: "decision",
  label: LABEL,
  owner: "human",
  status: "pending",
  owedSince: "2026-09-25T12:58:38.299Z",
  blockedReason: "decision",
};

async function seedFounderSession(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, origin, playbook_id, template_id, goal, title, status, current_stage, expected_outputs, agent_ids, metadata, criteria, created_at, updated_at, started_at, closed_at)
     values ($1, $2, null, $3, 'playbook', $4, $7, 'Agents live in sessions', 'Agents live in sessions + shell polish', 'closed', 'finishing', $5::jsonb, $6, '{}'::jsonb, '[]'::jsonb, now(), now(), now(), now())`,
    [
      id,
      USER,
      PROJECT,
      randomUUID(),
      JSON.stringify([
        { kind: "code", label: "Session page polish", status: "done" },
        FOUNDER_SLOT,
      ]),
      [],
      randomUUID(),
    ]
  );
  // The handoff announcement the one producer writes for this slot.
  await q(
    `insert into notifications (id, user_id, type, category, priority, title, body, source_type, source_id, actions, status, created_at)
     values ($1, $2, 'session.needs_you', 'ai', 'high', 'Needs you', '', 'session', $3, '[]'::jsonb, 'unread', now())`,
    [randomUUID(), USER, id]
  );
  return id;
}

const caller = () =>
  signalsRouter.createCaller({
    db,
    authenticated: true,
    userId: USER,
  } as never);

describe("signals: an owed decision on a closed, run-kind, null-workspace, project session", () => {
  beforeAll(async () => {
    for (const t of [focusSessions, notifications, messages]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from focus_sessions; delete from notifications; delete from messages;"
    );
  });

  it("the pod-wide needs-you list carries it as ONE row that names the decision and addresses the session", async () => {
    const s = await seedFounderSession();
    const { signals } = await caller().list({ lens: "needs-you" });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "owed-slot",
      title: LABEL,
      blockedReason: "decision",
      slotKind: "decision",
      // The session, where the answer verbs live — not the external doc.
      target: { kind: "session", id: s },
    });
  });

  it("the Synap project's needs-you list and badge carry it too (project lens, no workspace)", async () => {
    const s = await seedFounderSession();
    const { signals } = await caller().list({
      lens: "needs-you",
      projectId: PROJECT,
    });
    expect(signals.map((x) => [x.kind, x.title, x.target?.id])).toEqual([
      ["owed-slot", LABEL, s],
    ]);

    const c = await caller().count({ projectId: PROJECT });
    expect(c.blocked).toBe(1);
  });

  it("the pod-wide count states it once (the handoff notification folds into the slot)", async () => {
    await seedFounderSession();
    const c = await caller().count({});
    expect(c.blocked).toBe(1);
    expect(c.needsYou).toBe(1);
  });
});
