/**
 * The pending door on a REAL Postgres (PGlite): a package playbook create
 * filed twice by two `synap templates update` runs is ONE pending row.
 *
 * MEASURED DEFECT (live, 2026-11-16): every run filed a fresh pending
 * `create playbook` beside the last one (seven pending copies of three
 * playbooks, e.g. 31f2727d / fdd4f29f / f5f08937 for "Fix in code"). Diffing
 * two of them, the only difference left after the stripped per-attempt ids
 * was `data.data.metadata.marketSource.installedAt`, the install clock each
 * run stamps (`package-apply-post-workspace.ts` → `stampPlaybookMarketSource`).
 * The dedup hash read it, so create-dedup never matched.
 *
 * Each case rules out one wrong rule:
 *   - two runs whose creates differ ONLY in per-attempt plumbing AND the
 *     install clock → the second returns the first (`deduped`), one row;
 *   - a create that differs in a REAL field (a stage's goal) → its own row:
 *     the strip is one leaf, not the whole `marketSource` or the record;
 *   - a create whose `marketSource` names another package version → its own
 *     row: the rest of the source-link still tells creates apart.
 *
 * The payload is the live row's shape (f5f08937): the request envelope
 * `checkPermissionOrPropose` stores, the record one level down.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { proposals } from "../schema/proposals.js";
import { notifications } from "../schema/notifications.js";
import { messages } from "../schema/messages.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { channels } from "../schema/channels.js";
import { relations } from "../schema/relations.js";
import { insertPendingProposal } from "./insert-pending-proposal.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${["created_at", "updated_at", "timestamp"].includes(c.name) ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

let client: PGlite;
let db: ReturnType<typeof drizzle>;
const q = <T>(sql: string, params?: unknown[]) =>
  client.query<T>(sql, params).then((r) => r.rows);

const AGENT = "agent-template-updater";
const OWNER = "owner-user";
/** What one `synap templates update` run files for a package playbook. */
function templateCreate(run: {
  ws: string;
  installedAt: string;
  stageGoal?: string;
  packageVersion?: string;
}) {
  // Per-attempt plumbing, fresh on every run like the live rows.
  const minted = randomUUID();
  const stages = [
    {
      key: "fix-in-code",
      name: "Fix in code",
      goal: run.stageGoal ?? "Reproduce the finding and fix it at the root.",
      category: "started",
    },
  ];
  const record = {
    id: minted,
    name: "Fix in code",
    description: "The code work of fixing one finding.",
    goalTemplate: "Fix {{finding}}",
    scope: "session",
    status: "active",
    executor: "external-agent",
    stages,
    tools: [],
    metadata: {
      marketSource: {
        packageSlug: "builder-dev",
        packageVersion: run.packageVersion ?? "1.4.0",
        installedAt: run.installedAt,
        baseline: { scope: "session", stages, tools: [] },
      },
    },
  };
  return {
    workspaceId: run.ws,
    targetType: "playbook",
    targetId: minted,
    proposalType: "create",
    createdBy: OWNER,
    subjectUserId: OWNER,
    agentUserId: AGENT,
    data: {
      requestId: randomUUID(),
      correlationId: randomUUID(),
      requestedEventId: randomUUID(),
      source: "intelligence",
      sourceId: OWNER,
      targetType: "playbook",
      targetId: minted,
      targetName: "Fix in code",
      changeType: "create",
      workspaceId: run.ws,
      summary: 'Create Template "Fix in code"',
      authorshipMode: "delegated",
      // The duplicate door's answer differs run to run (the second run sees
      // the first as a candidate), as on the live rows.
      duplicateCheck: { status: "possible", candidates: [] },
      data: record,
    },
  };
}

/** Each case files in its own workspace, so one case's rows never move another's count. */
const pendingCount = async (ws: string) =>
  Number(
    (
      await q<{ n: string }>(
        `select count(*) as n from proposals where status = 'pending' and workspace_id = $1`,
        [ws]
      )
    )[0]!.n
  );

beforeAll(async () => {
  client = new PGlite();
  for (const t of [
    proposals,
    notifications,
    messages,
    focusSessions,
    channels,
    relations,
  ]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  db = drizzle(client, { schema: { focusSessions, channels, relations } });
}, 120_000);

describe("a package playbook create re-filed by a later install run", () => {
  it("two runs differing only in the install clock (and per-attempt ids) leave ONE pending row", async () => {
    const ws = randomUUID();
    const first = await insertPendingProposal(
      templateCreate({ ws, installedAt: "2026-11-15T09:00:00.000Z" }),
      db as never
    );
    const second = await insertPendingProposal(
      templateCreate({ ws, installedAt: "2026-11-16T21:30:00.000Z" }),
      db as never
    );
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.proposal.id).toBe(first.proposal.id);
    expect(await pendingCount(ws)).toBe(1);
    // The stored row keeps the stamp it was filed with: only the hash ignores it.
    const stored = first.proposal.data as {
      data: { metadata: { marketSource: { installedAt: string } } };
    };
    expect(stored.data.metadata.marketSource.installedAt).toBe(
      "2026-11-15T09:00:00.000Z"
    );
  });

  it("a create that changes a real field (a stage's goal) is NOT deduped", async () => {
    const ws = randomUUID();
    await insertPendingProposal(
      templateCreate({ ws, installedAt: "2026-11-15T09:00:00.000Z" }),
      db as never
    );
    const other = await insertPendingProposal(
      templateCreate({
        ws,
        installedAt: "2026-11-16T22:00:00.000Z",
        stageGoal: "Reproduce, fix, gate and open a draft pull request.",
      }),
      db as never
    );
    expect(other.deduped).toBe(false);
    expect(await pendingCount(ws)).toBe(2);
  });

  it("a create whose source-link names another package version is NOT deduped", async () => {
    const ws = randomUUID();
    await insertPendingProposal(
      templateCreate({ ws, installedAt: "2026-11-15T09:00:00.000Z" }),
      db as never
    );
    const other = await insertPendingProposal(
      templateCreate({
        ws,
        installedAt: "2026-11-16T22:05:00.000Z",
        packageVersion: "1.5.0",
      }),
      db as never
    );
    expect(other.deduped).toBe(false);
    expect(await pendingCount(ws)).toBe(2);
  });
});
