/**
 * A THING'S BLOCKERS on real SQL (PGlite), plan e7f753db §9:
 *
 *   - ONE batched read (`readThingBlockers` → `listBlockingSlots`) finds, for
 *     a set of things, every slot that holds each up: a person's owed slot on
 *     a session about the thing; an agent's slot ONLY when it declares
 *     `blocks`; a slot naming another thing in `blocks.entityId` blocks THAT
 *     thing, not its session's subject;
 *   - an agent's blocker on a closed session, a draft's ask-less slot, a
 *     delivered slot and another person's session block nothing;
 *   - statusOf returns the same `blocker`, and a hold never blocks;
 *   - the need-you read names the thing an ask holds up (`blockedThing`),
 *     with its status now and after, and the signal carries it with the
 *     session's subject.
 *
 * Only the lifecycle resolver is stubbed: every profile moves on LEAD.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const LEAD = {
  propertyDefId: "lifecycle",
  declaredOnProfileId: "p",
  unclassified: [],
  defaultStatus: null,
  options: [
    { key: "new", label: "New", category: "open" },
    { key: "researching", label: "Researching", category: "active" },
    { key: "contacted", label: "Contacted", category: "active" },
    { key: "on_hold", label: "On hold", category: "paused" },
    { key: "won", label: "Won", category: "done" },
  ],
};

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => holder.db,
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle() {
        return LEAD;
      }
      async getEffectiveLifecycles(ids: readonly string[]) {
        return new Map(ids.map((id) => [id, LEAD]));
      }
    },
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@synap/database/schema";
import {
  allSchemaTables,
  pgliteTableDdl,
} from "../../../__tests__/pglite-ddl.js";
import { readThingBlockers } from "../thing-blockers.js";
import { readStatusOf } from "../status-read.js";
import { listNeedsYouOwed } from "../../signals/needs-you-owed.js";
import { signalFromOwedSlot } from "../../signals/needs-you-union.js";
import { resolveScope } from "../../../utils/scope-filter.js";

const ME = "user-me";
const OTHER = "user-other";
const W = randomUUID();
const PERSON = randomUUID();
// Things.
const ADA = randomUUID(); // a person's ask on a session about her
const BOB = randomUUID(); // an agent's declared blocker
const CY = randomUUID(); // an agent's slot that declares nothing
const DEE = randomUUID(); // named by a slot on Ada's session
const EVE = randomUUID(); // only dead or foreign blockers
const FAY = randomUUID(); // paused under a hold, nothing else

let client: PGlite;
const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
const NOW = new Date().toISOString();

async function thing(id: string, title: string, status: string) {
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, title, status, properties, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, '{}'::jsonb, now(), now())`,
    [id, ME, W, PERSON, title, status]
  );
}

async function session(
  subject: string | null,
  outputs: unknown[],
  o: { status?: string; origin?: string; userId?: string } = {}
) {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, subject_entity_id, title, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'Work', 'Do it', $5, $6, $7::jsonb, '{}'::jsonb, now(), now(), now())`,
    [
      id,
      o.userId ?? ME,
      W,
      subject,
      o.status ?? "active",
      o.origin ?? "user",
      JSON.stringify(outputs),
    ]
  );
  return id;
}

const humanAsk = (label: string, extra: Record<string, unknown> = {}) => ({
  kind: "decision",
  label,
  owner: "human",
  status: "pending",
  blockedReason: "decision",
  owedSince: NOW,
  ask: { mode: "confirm" },
  ...extra,
});
const agentSlot = (label: string, extra: Record<string, unknown> = {}) => ({
  kind: "output",
  label,
  status: "pending",
  ...extra,
});

let S_ADA: string;

beforeAll(async () => {
  client = new PGlite();
  for (const t of allSchemaTables()) await client.exec(pgliteTableDdl(t));
  holder.db = drizzle(client, { schema });
  await q(
    `insert into workspaces (id, owner_id, name, workspace_type) values ($1, $2, 'Sales', 'personal')`,
    [W, ME]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), W, ME]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, 'person', 'Person', 'kind', 'workspace')`,
    [PERSON]
  );
  for (const [id, title] of [
    [ADA, "Ada"],
    [BOB, "Bob"],
    [CY, "Cy"],
    [DEE, "Dee"],
    [EVE, "Eve"],
  ] as const)
    await thing(id, title, "researching");
  await thing(FAY, "Fay", "on_hold");

  S_ADA = await session(ADA, [
    humanAsk("Send the invite?", {
      blockerKey: "not_connected",
      clearedBy: { intent: "request_connection" },
    }),
    // Names another thing: blocks Dee, not Ada.
    agentSlot("Intro Dee", {
      blocks: { entityId: DEE, to: "won" },
      blockerKey: "needs_intro",
      clearedBy: { capability: "email.send" },
    }),
  ]);
  await session(BOB, [
    agentSlot("LinkedIn invite", {
      blocks: {},
      blockerKey: "not_connected",
      clearedBy: { intent: "request_connection" },
    }),
  ]);
  // An agent's slot that declares nothing is its own work, never a blocker.
  await session(CY, [agentSlot("Research Cy")]);
  // Eve: an agent blocker on a CLOSED session, a draft's ask-less owed slot,
  // a delivered declared blocker, and another person's ask.
  await session(EVE, [agentSlot("Old", { blocks: {} })], { status: "closed" });
  await session(
    EVE,
    [humanAsk("Draft ask", { ask: undefined, blockedReason: "credential" })],
    { origin: "agent" }
  );
  await session(EVE, [agentSlot("Done", { blocks: {}, status: "done" })]);
  await session(EVE, [humanAsk("Theirs")], { userId: OTHER });
  // Fay: paused under a hold — a park, never a blocker.
  await q(
    `insert into lifecycle_transition_outbox (transition_id, transition, created_at) values ($1, $2::jsonb, now())`,
    [
      randomUUID(),
      JSON.stringify({
        transitionId: randomUUID(),
        subjectType: "entity",
        subjectId: FAY,
        to: "on_hold",
        category: "paused",
        userId: ME,
        workspaceId: W,
        recordedAt: NOW,
        hold: { resumeTo: "researching", since: NOW, on: "person" },
      }),
    ]
  );
});

const ask = (id: string, status = "researching") => ({
  id,
  status,
  lifecycle: LEAD as never,
});

describe("readThingBlockers — one batched read", () => {
  it("blocks each thing by what holds it up, and nothing else", async () => {
    const out = await readThingBlockers({ userId: ME }, [
      ask(ADA),
      ask(BOB),
      ask(CY),
      ask(DEE),
      ask(EVE),
    ]);
    expect(out.get(ADA)).toMatchObject({
      blocked: true,
      count: 1,
      ball: "me",
      why: { reason: "input", blockerKey: "not_connected" },
      unlocks: { to: "contacted", label: "Contacted" },
      clearedBy: { intent: "request_connection" },
      ref: { kind: "slot", id: S_ADA, label: "Send the invite?" },
    });
    expect(out.get(BOB)).toMatchObject({
      blocked: true,
      ball: "agent",
      why: { waitKind: "agent_work", blockerKey: "not_connected" },
      unlocks: { to: "contacted" },
    });
    expect(out.get(DEE)).toMatchObject({
      blocked: true,
      ball: "agent",
      why: { blockerKey: "needs_intro" },
      unlocks: { to: "won", label: "Won" },
      clearedBy: { capability: "email.send" },
    });
    expect(out.get(CY)?.blocked).toBe(false);
    expect(out.get(EVE)?.blocked).toBe(false);
  });
});

describe("statusOf — the same blocker", () => {
  it("returns it for a thing; a hold never blocks", async () => {
    const answers = await readStatusOf(ME, [ADA, FAY]);
    const ada = answers.find((a) => a.id === ADA) as {
      blocker?: { blocked: boolean; why?: { blockerKey: string | null } };
      nextMove?: { to?: string };
    };
    expect(ada.blocker).toMatchObject({
      blocked: true,
      why: { blockerKey: "not_connected" },
    });
    // The wait leads the move, and it keeps the next status (`to`).
    expect(ada.nextMove?.to).toBe("contacted");
    const fay = answers.find((a) => a.id === FAY) as {
      blocker?: { blocked: boolean };
      waitingOn?: unknown;
    };
    // Discriminating: the hold IS read (it is Fay's waiting-on) and still
    // does not block — a pause is the status, never an overlay.
    expect(fay.waitingOn).toEqual([
      expect.objectContaining({ reason: "input" }),
    ]);
    expect(fay.blocker).toMatchObject({ blocked: false });
  });
});

describe("need-you — the thing an ask holds up", () => {
  it("names the thing, its status now and after, and the signal carries it", async () => {
    const slots = await listNeedsYouOwed({
      userId: ME,
      scope: resolveScope({}, { workspaceId: [] }),
      limit: 50,
    });
    const slot = slots.find((s) => s.label === "Send the invite?");
    expect(slot?.blockedThing).toEqual({
      thing: { id: ADA, name: "Ada" },
      statusNow: { key: "researching", label: "Researching" },
      statusNext: { key: "contacted", label: "Contacted" },
    });
    const signal = signalFromOwedSlot(slot!);
    expect(signal.subjectEntityId).toBe(ADA);
    expect(signal.blocks).toEqual(slot!.blockedThing);
    expect(signal.blockerKey).toBe("not_connected");
    expect(signal.clearedBy).toEqual({ intent: "request_connection" });
  });
});
