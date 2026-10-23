/**
 * R10 on PGlite — an unacknowledged "impossible" report on a goal escalates
 * to the goal's OWNER after 48 h, ONCE.
 *
 * Real: `escalateUnacknowledgedReports` → the `TRACK_REPORT_IS_DUE` claim
 * (UPDATE … RETURNING), the owner read (the owner row, else the starter), the
 * delegate's name. The notification door is the IoC slot (`NotificationService
 * .create` in api), stubbed to record what it was asked to write.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
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
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  projects,
  projectTracks,
  trackParticipants,
  users,
} from "@synap/database/schema";
import { escalateUnacknowledgedReports } from "./track-report-escalation.js";
import {
  registerNotificationCreator,
  type JobsNotificationInput,
} from "../utils/notification-creator.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "id"
        ? " default gen_random_uuid()"
        : c.name === "created_at" || c.name === "decided_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const sent: JobsNotificationInput[] = [];
const OWNER = "owner-1";
const STARTER = "starter-1";
const WS = randomUUID();

async function goalWithReport(opts: {
  hoursAgo: number;
  acknowledged?: boolean;
  withOwnerRow?: boolean;
}): Promise<{ trackId: string; participantId: string }> {
  const projectId = randomUUID();
  const trackId = randomUUID();
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, $3, 'P', 'active')`,
    [projectId, STARTER, WS]
  );
  await q(
    `insert into project_tracks (id, project_id, user_id, name, status) values ($1, $2, $3, 'Launch', 'active')`,
    [trackId, projectId, STARTER]
  );
  if (opts.withOwnerRow !== false) {
    await q(
      `insert into track_participants (track_id, principal_kind, principal_id, role, decided_by)
       values ($1, 'person', $2, 'owner', $2)`,
      [trackId, OWNER]
    );
  }
  const [row] = (
    await q<{ id: string }>(
      `insert into track_participants
         (track_id, principal_kind, principal_id, role, commitment, commitment_state,
          reported_reason, reported_at, acknowledged_at, decided_by)
       values ($1, 'person', 'del-1', 'delegate', 'Write the brief', 'reported_impossible',
               'No access', now() - ($2::int * interval '1 hour'),
               ${opts.acknowledged ? "now()" : "null"}, 'del-1')
       returning id`,
      [trackId, opts.hoursAgo]
    )
  ).rows;
  return { trackId, participantId: row!.id };
}

beforeAll(async () => {
  for (const t of [projects, projectTracks, trackParticipants, users]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(`insert into users (id, name) values ('del-1', 'Dana')`);
  registerNotificationCreator(async (input) => {
    sent.push(input);
    return randomUUID();
  });
}, 120_000);

beforeEach(() => {
  sent.length = 0;
});

describe("R10 — an unacknowledged impossible report escalates to the owner", () => {
  it("not before 48 h", async () => {
    const { participantId } = await goalWithReport({ hoursAgo: 47 });
    await escalateUnacknowledgedReports();
    expect(sent.filter((n) => n.data.participantId === participantId)).toEqual(
      []
    );
  });

  it("after 48 h: ONE notification to the owner, then never again for that report", async () => {
    const { trackId, participantId } = await goalWithReport({ hoursAgo: 49 });
    await escalateUnacknowledgedReports();
    const mine = () =>
      sent.filter((n) => n.data.participantId === participantId);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatchObject({
      type: "track.report_unacknowledged",
      userId: OWNER,
      workspaceId: WS,
      sourceType: "track",
      sourceId: trackId,
      data: {
        trackName: "Launch",
        delegateName: "Dana",
        commitment: "Write the brief",
        reason: "No access",
      },
    });
    expect(mine()[0]!.groupKey).toMatch(
      new RegExp(`^track-report:${participantId}:`)
    );
    await escalateUnacknowledgedReports();
    await escalateUnacknowledgedReports();
    expect(mine()).toHaveLength(1);
  });

  it("an acknowledged report never escalates", async () => {
    const { participantId } = await goalWithReport({
      hoursAgo: 72,
      acknowledged: true,
    });
    await escalateUnacknowledgedReports();
    expect(sent.filter((n) => n.data.participantId === participantId)).toEqual(
      []
    );
  });

  it("a goal with no owner row reads its starter (the backfill's rule)", async () => {
    const { participantId } = await goalWithReport({
      hoursAgo: 49,
      withOwnerRow: false,
    });
    await escalateUnacknowledgedReports();
    const mine = sent.filter((n) => n.data.participantId === participantId);
    expect(mine.map((n) => n.userId)).toEqual([STARTER]);
  });
});
