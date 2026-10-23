/**
 * WHO IS ON A GOAL on PGlite (work model W3, 0346) — the REAL participants
 * door (`changeTrackParticipants` → `applyTrackParticipantChange`), the REAL
 * close door (`setTrackStatus` → `applyTrackStatus` → `assertGoalCloser`), the
 * REAL `track/update` and `track/assign_agent` approval replays, the REAL
 * access registry, and the REAL 0346 migration (CHECKs, one-owner / one-judge
 * indexes, the upsert's conflict target).
 *
 * What is pinned, each by an input where the wrong rule and the right one
 * DISAGREE:
 *   - only the judge's close applies — the OWNER is refused once a judge is
 *     named (a rule "owner or judge" would admit them);
 *   - an approver who is not the judge is refused on replay, the judge's
 *     approval applies and stamps the judge as `verdictBy`;
 *   - a delegate WITH WRITE ACCESS (an editor) cannot add participants — the
 *     project write floor alone would admit them;
 *   - an agent's acceptance of its own commitment applies; an agent cannot
 *     accept for a person, not even for the person it acts for (a rule
 *     "actor.userId is the delegate" would admit it);
 *   - D5-A: an agent on a goal's participants, linked to ANOTHER person, still
 *     reads neither the goal nor its sessions; and the door refuses to add it.
 *
 * Stubbed, only at infrastructure seams: `checkPermissionOrPropose` (an
 * agent's FORCED write and its hand-off propose; any other agent write is
 * granted, as the pod's default `@reversible` rule does; a person is
 * granted — the call is what is asserted), THE route (`route()` answers from
 * a fixed agent → person table), `createLinks`, `emitSideEffects`, the
 * EventRepository append.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migration = (f: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../../database/migrations/${f}`, import.meta.url)
    ),
    "utf8"
  );
const M0317 = migration("0317_project_tracks_live_name_unique.sql");
const M0344 = migration("0344_track_lifecycle_and_verdict.sql");
const M0346 = migration("0346_track_participants.sql");

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  permCalls: [] as Array<Record<string, unknown>>,
  /** agent id → the person it acts for (THE route's answer, stubbed). */
  actsFor: new Map<string, string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client, {
    schema: {
      focusSessions: actual.focusSessions as never,
      projectTracks: actual.projectTracks as never,
      playbooks: actual.playbooks as never,
      projects: actual.projects as never,
      workspaceMembers: actual.workspaceMembers as never,
      trackParticipants: actual.trackParticipants as never,
    },
  });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    EventRepository: class {
      async append() {}
    },
  };
});

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.permCalls.push(opts);
    const propose =
      opts.agentUserId &&
      (opts.forcePropose === true ||
        opts.action === "assign_agent" ||
        // A close is human-only: always a proposal for an agent (W1).
        (opts.lifecycleMove as { humanOnly?: boolean } | undefined)
          ?.humanOnly === true);
    if (propose) {
      return {
        granted: false,
        proposalId: randomUUID(),
        proposalType: `${opts.subjectType}.${opts.action}`,
        summary: "",
        reasoning: "",
        reviewPath: "/open/x",
        reviewUrl: "https://pod/open/x",
      };
    }
    return { granted: true };
  },
  proposedMessageFor: (_t: string, fallback: string) => fallback,
}));

vi.mock("../../agent-dispatch/route.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    route: async (work: {
      ownerId: string;
      selector?: { agentUserId: string };
    }) => {
      const id = work.selector?.agentUserId ?? "";
      return h.actsFor.get(id) === work.ownerId
        ? { kind: "routed", agentUserId: id, via: "selector", reach: "pull" }
        : {
            kind: "refused",
            reason: "not_owned",
            agentUserId: id,
            reach: "pull",
          };
    },
  };
});

vi.mock("../../links/links-service.js", () => ({
  createLinks: async () => [],
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: async () => {},
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import {
  channels,
  channelMembers,
  focusSessions,
  links,
  notifications,
  playbooks,
  podMembers,
  projectMembers,
  projects,
  proposals,
  users,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import {
  getTrack,
  listTracks,
  loadTrackView,
  setTrackStatus,
  startTrack,
  type TrackActor,
} from "../tracks-service.js";
import { changeTrackParticipants } from "../track-participants.js";
import { loadGoalJudge } from "../track-participant-store.js";
import { AccessContext, scopedDb } from "../../../access/index.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { registerTrackExecutors } from "../../../routers/proposals/executors/track.js";
import type { ProposalExecutorArgs } from "../../../routers/proposals/execution-registry.js";

const OWNER = "owner-1";
const JUDGE = "judge-1";
const STAFFER = "staffer-1"; // an EDITOR of the space, on the goal as a delegate
const DELEGATE = "delegate-1"; // a viewer of the space
const OUTSIDER = "outsider-1"; // not in the space
const AGENT_A = "agent-a"; // acts for OWNER
const AGENT_A2 = "agent-a2"; // acts for OWNER
const AGENT_D = "agent-d"; // acts for DELEGATE
const AGENT_X = "agent-x"; // acts for OUTSIDER
const WS = randomUUID();
const PROJECT = randomUUID();

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
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : c.name === "metadata" || c.name === "settings"
            ? " default '{}'::jsonb"
            : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const person = (userId: string): TrackActor => ({ userId });
const agentOf = (userId: string, agentUserId: string): TrackActor => ({
  userId,
  agentUserId,
  isHubProtocol: true,
});

async function goal(name: string): Promise<string> {
  const res = await startTrack({
    projectId: PROJECT,
    name,
    actor: person(OWNER),
  });
  if (res.status === "proposed") throw new Error("unexpected proposal");
  return res.track.id;
}

type Row = {
  id: string;
  principal_id: string;
  principal_kind: string;
  role: string;
  commitment_state: string | null;
  decided_by: string;
};
async function rows(trackId: string): Promise<Row[]> {
  return (
    await q<Row>(
      `select id, principal_id, principal_kind, role, commitment_state, decided_by
         from track_participants where track_id = $1 order by created_at, role`,
      [trackId]
    )
  ).rows;
}
async function rowOf(trackId: string, principalId: string, role: string) {
  return (await rows(trackId)).find(
    (r) => r.principal_id === principalId && r.role === role
  );
}

async function add(
  trackId: string,
  actor: TrackActor,
  principalId: string,
  role: "judge" | "delegate" | "integrator",
  commitment?: string
) {
  return changeTrackParticipants({
    trackId,
    actor,
    change: {
      op: "add",
      principalId,
      role,
      ...(commitment ? { commitment } : {}),
    },
  });
}

async function replay(
  key: string,
  trackId: string,
  data: Record<string, unknown>,
  approver: string,
  agentUserId: string | null,
  subjectUserId: string | null = null
) {
  const proposalId = randomUUID();
  return proposalExecRegistry.resolveExact(key)!.execute({
    proposal: {
      id: proposalId,
      targetType: "track",
      targetId: trackId,
      proposalType: key.split("/")[1],
      workspaceId: WS,
      agentUserId,
      subjectUserId,
      sourceMessageId: null,
      data: { data },
    },
    userId: approver,
    input: { proposalId },
    deps: {
      reportProposalOutcome: () => {},
      emitProposalReviewed: () => {},
    },
  } as unknown as ProposalExecutorArgs);
}

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    users,
    workspaces,
    workspaceMembers,
    podMembers,
    projectMembers,
    links,
    playbooks,
    projects,
    channels,
    channelMembers,
    notifications,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await h.client!.exec(`
    create table project_tracks (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      user_id text not null,
      playbook_id uuid references playbooks(id) on delete set null,
      name text not null,
      definition_snapshot jsonb not null default '{}'::jsonb,
      method_version text not null default '1',
      current_stage text,
      status text not null default 'active'
        check (status in ('active','paused','completed','archived')),
      params jsonb not null default '{}'::jsonb,
      stage_history jsonb not null default '[]'::jsonb,
      direction text,
      kpi jsonb,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await h.client!.exec(M0317);
  await h.client!.exec(M0344);
  // The REAL table: CHECKs, one owner / one judge, the upsert's target.
  await h.client!.exec(M0346);

  for (const [id, type, createdBy] of [
    [OWNER, "human", null],
    [JUDGE, "human", null],
    [STAFFER, "human", null],
    [DELEGATE, "human", null],
    [OUTSIDER, "human", null],
    [AGENT_A, "agent", OWNER],
    [AGENT_A2, "agent", OWNER],
    [AGENT_D, "agent", DELEGATE],
    [AGENT_X, "agent", OUTSIDER],
  ] as const) {
    await q(
      `insert into users (id, email, name, user_type, created_by_user_id) values ($1, $2, $3, $4, $5)`,
      [id, `${id}@example.test`, id, type, createdBy]
    );
  }
  h.actsFor.set(AGENT_A, OWNER);
  h.actsFor.set(AGENT_A2, OWNER);
  h.actsFor.set(AGENT_D, DELEGATE);
  h.actsFor.set(AGENT_X, OUTSIDER);

  await q(
    `insert into workspaces (id, name, workspace_type, owner_id) values ($1, 'Builder', 'personal', $2)`,
    [WS, OWNER]
  );
  for (const [userId, role] of [
    [OWNER, "owner"],
    [JUDGE, "editor"],
    [STAFFER, "editor"],
    [DELEGATE, "viewer"],
  ]) {
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)`,
      [WS, userId, role]
    );
  }
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, $3, 'Launch', 'active')`,
    [PROJECT, OWNER, WS]
  );
  registerTrackExecutors();
}, 120_000);

beforeEach(() => {
  h.permCalls.length = 0;
});

describe("a goal is born with its owner; the read shows who is on it", () => {
  it("startTrack seeds the owner row; the judge defaults to the owner", async () => {
    const id = await goal("Born with an owner");
    expect(await rows(id)).toMatchObject([
      { principal_id: OWNER, principal_kind: "person", role: "owner" },
    ]);
    expect(await loadGoalJudge((await getTrack(id, person(OWNER)))!)).toBe(
      OWNER
    );
  });

  it("the track read returns participants — role, commitment, state, silent since", async () => {
    const id = await goal("Read who is on it");
    await add(id, person(OWNER), DELEGATE, "delegate", "Write the brief");
    await add(id, person(OWNER), JUDGE, "judge");
    const view = await loadTrackView(
      (await getTrack(id, person(OWNER)))!,
      person(OWNER)
    );
    expect(view.participants?.map((p) => p.role)).toEqual([
      "owner",
      "judge",
      "delegate",
    ]);
    const delegate = view.participants!.find((p) => p.role === "delegate")!;
    expect(delegate).toMatchObject({
      principalId: DELEGATE,
      principalKind: "person",
      commitment: "Write the brief",
      commitmentState: "proposed",
      decidedBy: OWNER,
    });
    // Owes something ⇒ silent since it was added (no answer, no session yet).
    expect(delegate.silentSince).toBe(delegate.createdAt);
    // Owner and judge owe nothing: no silence is measured for them.
    expect(
      view.participants!.find((p) => p.role === "judge")!.silentSince
    ).toBeNull();
  });
});

describe("only the judge closes the goal", () => {
  it("with no judge named, the owner's close applies", async () => {
    const id = await goal("Owner judges");
    const res = await setTrackStatus({
      trackId: id,
      status: "completed",
      verdict: "met",
      actor: person(OWNER),
    });
    expect(res.status).toBe("updated");
  });

  it("with a judge named, the OWNER is refused and the judge's close applies", async () => {
    const id = await goal("Judge closes");
    await add(id, person(OWNER), JUDGE, "judge");
    await expect(
      setTrackStatus({
        trackId: id,
        status: "completed",
        verdict: "met",
        actor: person(OWNER),
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("Only this goal's judge can close it"),
    });
    expect(
      (
        await q<{ status: string }>(
          `select status from project_tracks where id = $1`,
          [id]
        )
      ).rows[0]!.status
    ).toBe("active");

    const res = await setTrackStatus({
      trackId: id,
      status: "completed",
      verdict: "met",
      actor: person(JUDGE),
    });
    expect(res.status).toBe("updated");
  });

  it("a drop stays W1's rule: any person with write access, the judge not required", async () => {
    const id = await goal("Owner drops");
    await add(id, person(OWNER), JUDGE, "judge");
    const res = await setTrackStatus({
      trackId: id,
      status: "archived",
      verdict: "no_longer_needed",
      actor: person(OWNER),
    });
    expect(res.status).toBe("updated");
  });

  it("an agent's close is a proposal; an approver who is not the judge is refused on replay, the judge's approval applies", async () => {
    const id = await goal("Agent proposes the close");
    await add(id, person(OWNER), JUDGE, "judge");
    const res = await setTrackStatus({
      trackId: id,
      status: "completed",
      verdict: "met",
      actor: agentOf(OWNER, AGENT_A),
    });
    expect(res.status).toBe("proposed");
    const data = h.permCalls.at(-1)!.data as Record<string, unknown>;

    await expect(
      replay("track/update", id, data, OWNER, AGENT_A)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const before = (
      await q<{ status: string }>(
        `select status from project_tracks where id = $1`,
        [id]
      )
    ).rows[0]!;
    expect(before.status).toBe("active");

    await replay("track/update", id, data, JUDGE, AGENT_A);
    const after = (
      await q<{ status: string; verdict_by: string }>(
        `select status, verdict_by from project_tracks where id = $1`,
        [id]
      )
    ).rows[0]!;
    expect(after).toEqual({ status: "completed", verdict_by: JUDGE });
  });
});

describe("who may change who is on a goal", () => {
  it("a delegate with WRITE access to the space cannot add participants; the owner and the judge can", async () => {
    const id = await goal("Staffing");
    await add(id, person(OWNER), STAFFER, "delegate", "Ship the page");
    await expect(
      add(id, person(STAFFER), DELEGATE, "delegate", "Review it")
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only this goal's owner or judge changes who is on it.",
    });
    expect(await rowOf(id, DELEGATE, "delegate")).toBeUndefined();

    await add(id, person(OWNER), JUDGE, "judge");
    await add(id, person(JUDGE), DELEGATE, "delegate", "Review it");
    expect(await rowOf(id, DELEGATE, "delegate")).toMatchObject({
      commitment_state: "proposed",
      decided_by: JUDGE,
    });
  });

  it("the judge is a person; naming a new judge replaces the old; the owner stays", async () => {
    const id = await goal("Judges");
    await expect(
      add(id, person(OWNER), AGENT_A, "judge")
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await add(id, person(OWNER), JUDGE, "judge");
    await add(id, person(OWNER), STAFFER, "judge");
    expect(
      (await rows(id))
        .filter((r) => r.role === "judge")
        .map((r) => r.principal_id)
    ).toEqual([STAFFER]);
    const owner = (await rowOf(id, OWNER, "owner"))!;
    await expect(
      changeTrackParticipants({
        trackId: id,
        actor: person(OWNER),
        change: { op: "remove", participantId: owner.id },
      })
    ).rejects.toMatchObject({ message: "A goal always keeps its owner." });
  });

  it("a person who cannot see the goal is refused (a participant row grants no read)", async () => {
    const id = await goal("Outsider");
    await expect(
      add(id, person(OWNER), OUTSIDER, "delegate", "Help")
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("cannot see this goal's project"),
    });
  });

  it("an agent changing anyone else is FORCED to a proposal; the approver must be owner or judge", async () => {
    const id = await goal("Agent staffs");
    const res = await add(
      id,
      agentOf(OWNER, AGENT_A),
      DELEGATE,
      "delegate",
      "Review it"
    );
    expect(res.status).toBe("proposed");
    const call = h.permCalls.at(-1)!;
    expect(call).toMatchObject({
      subjectType: "track",
      action: "update",
      forcePropose: true,
    });
    expect(await rowOf(id, DELEGATE, "delegate")).toBeUndefined();
    const data = call.data as Record<string, unknown>;

    await expect(
      replay("track/update", id, data, STAFFER, AGENT_A, OWNER)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await replay("track/update", id, data, OWNER, AGENT_A, OWNER);
    expect(await rowOf(id, DELEGATE, "delegate")).toMatchObject({
      commitment_state: "proposed",
      decided_by: AGENT_A,
    });
  });

  it("an agent handing the goal to ANOTHER agent goes through the hand-off gate (track/assign_agent)", async () => {
    const id = await goal("Hand-off");
    const res = await add(
      id,
      agentOf(OWNER, AGENT_A),
      AGENT_A2,
      "delegate",
      "Draft the copy"
    );
    expect(res.status).toBe("proposed");
    const call = h.permCalls.at(-1)!;
    expect(call).toMatchObject({
      subjectType: "track",
      action: "assign_agent",
      data: {
        id,
        addAgentId: AGENT_A2,
        role: "delegate",
        commitment: "Draft the copy",
      },
    });
    expect(call.forcePropose).toBeUndefined();
    await replay(
      "track/assign_agent",
      id,
      call.data as Record<string, unknown>,
      OWNER,
      AGENT_A,
      OWNER
    );
    expect(await rowOf(id, AGENT_A2, "delegate")).toMatchObject({
      principal_kind: "agent",
      commitment_state: "proposed",
      decided_by: AGENT_A,
    });
  });
});

describe("a delegate answers their OWN commitment", () => {
  it("an agent's acceptance of its own commitment applies (governed, not forced)", async () => {
    const id = await goal("Agent accepts");
    await add(id, person(OWNER), AGENT_A, "delegate", "Draft the copy");
    const row = (await rowOf(id, AGENT_A, "delegate"))!;
    const res = await changeTrackParticipants({
      trackId: id,
      actor: agentOf(OWNER, AGENT_A),
      change: { op: "move", participantId: row.id, move: "accept" },
    });
    expect(res.status).toBe("updated");
    expect(h.permCalls.at(-1)!.forcePropose).toBeUndefined();
    expect(await rowOf(id, AGENT_A, "delegate")).toMatchObject({
      commitment_state: "accepted",
      decided_by: AGENT_A,
    });
  });

  it("an agent cannot accept for a person — not even for the person it acts for", async () => {
    const id = await goal("Agent for a person");
    await add(id, person(OWNER), DELEGATE, "delegate", "Review it");
    const row = (await rowOf(id, DELEGATE, "delegate"))!;
    // AGENT_D acts FOR the delegate: `actor.userId` IS the delegate.
    await expect(
      changeTrackParticipants({
        trackId: id,
        actor: agentOf(DELEGATE, AGENT_D),
        change: { op: "move", participantId: row.id, move: "accept" },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rowOf(id, DELEGATE, "delegate"))!.commitment_state).toBe(
      "proposed"
    );
    // The person themself may.
    const res = await changeTrackParticipants({
      trackId: id,
      actor: person(DELEGATE),
      change: { op: "move", participantId: row.id, move: "accept" },
    });
    expect(res.status).toBe("updated");
  });

  it("counter needs words; impossible only after accepting; the report is acknowledged by the owner, never by an agent", async () => {
    const id = await goal("Report");
    await add(id, person(OWNER), DELEGATE, "delegate", "Review it");
    const row = (await rowOf(id, DELEGATE, "delegate"))!;
    const move = (
      actor: TrackActor,
      m: "accept" | "counter" | "decline" | "report_impossible",
      text?: string
    ) =>
      changeTrackParticipants({
        trackId: id,
        actor,
        change: {
          op: "move",
          participantId: row.id,
          move: m,
          ...(text ? { text } : {}),
        },
      });
    await expect(move(person(DELEGATE), "counter")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      move(person(DELEGATE), "report_impossible", "No access")
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await move(person(DELEGATE), "accept");
    await move(person(DELEGATE), "report_impossible", "No access to the CMS");
    const reported = (
      await q<{
        commitment_state: string;
        reported_reason: string;
        reported_at: string | null;
      }>(
        `select commitment_state, reported_reason, reported_at from track_participants where id = $1`,
        [row.id]
      )
    ).rows[0]!;
    expect(reported.commitment_state).toBe("reported_impossible");
    expect(reported.reported_reason).toBe("No access to the CMS");
    expect(reported.reported_at).not.toBeNull();
    // A report is a declined commitment, never the goal's verdict (R1).
    expect(
      (
        await q<{ status: string; verdict: string | null }>(
          `select status, verdict from project_tracks where id = $1`,
          [id]
        )
      ).rows[0]
    ).toEqual({ status: "active", verdict: null });

    const ack = (actor: TrackActor) =>
      changeTrackParticipants({
        trackId: id,
        actor,
        change: { op: "acknowledge", participantId: row.id },
      });
    await expect(ack(agentOf(OWNER, AGENT_A))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(ack(person(DELEGATE))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // The R10 escalation that fired for this report leaves Needs you.
    await q(
      `insert into notifications (user_id, type, category, priority, title, body, source_type, source_id, group_key, status)
       values ($1, 'track.report_unacknowledged', 'data', 'high', 't', 'b', 'track', $2, $3, 'unread')`,
      [
        OWNER,
        id,
        `track-report:${row.id}:${new Date(reported.reported_at!).toISOString()}`,
      ]
    );
    await ack(person(OWNER));
    expect(
      (
        await q<{ acknowledged_at: string | null }>(
          `select acknowledged_at from track_participants where id = $1`,
          [row.id]
        )
      ).rows[0]!.acknowledged_at
    ).not.toBeNull();
    expect(
      (
        await q<{ status: string }>(
          `select status from notifications where group_key like $1`,
          [`track-report:${row.id}:%`]
        )
      ).rows.map((r) => r.status)
    ).toEqual(["actioned"]);
  });
});

describe("D5-A — being on a goal grants no read", () => {
  it("the door refuses an agent that acts for ANOTHER person", async () => {
    const id = await goal("Foreign agent");
    await expect(
      add(id, person(OWNER), AGENT_X, "delegate", "Help")
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("does not act for the person"),
    });
  });

  it("an agent ON the goal, linked to another person, still reads neither the goal nor its sessions", async () => {
    const id = await goal("Read floor");
    // Written past the door on purpose: the read floor must hold on its own.
    await q(
      `insert into track_participants (track_id, principal_kind, principal_id, role, commitment, commitment_state, decided_by)
       values ($1, 'agent', $2, 'delegate', 'Help', 'accepted', $3)`,
      [id, AGENT_X, OWNER]
    );
    const session = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, status, goal, agent_ids, started_at, updated_at)
       values ($1, $2, $3, $4, $5, 'active', 'Work', ARRAY[$6]::text[], now(), now())`,
      [session, OWNER, WS, PROJECT, id, AGENT_X]
    );
    const foreign = agentOf(OUTSIDER, AGENT_X);
    expect(await getTrack(id, foreign)).toBeNull();
    expect(await listTracks({ projectId: PROJECT, actor: foreign })).toBeNull();
    const sessionRow = await scopedDb(AccessContext.from(foreign)).findFirst(
      focusSessions,
      { where: eq(focusSessions.id, session) }
    );
    expect(sessionRow ?? null).toBeNull();

    // Non-vacuity: the owner reads both through the same doors.
    expect(await getTrack(id, person(OWNER))).not.toBeNull();
    expect(
      await scopedDb(AccessContext.from(person(OWNER))).findFirst(
        focusSessions,
        { where: eq(focusSessions.id, session) }
      )
    ).toBeTruthy();
  });
});
