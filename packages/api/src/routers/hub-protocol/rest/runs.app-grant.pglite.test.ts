/**
 * GET /runs/:id for an app key pinned to its space (plan 08e4fba7 §3.5): the
 * app that ran a ONE-SHOT action reads its record ("how this was made": the
 * prompt, what it was made of, model, tokens, cost), and nothing else.
 *
 * Before: the door was not in the grant fence, so every app key got
 * GRANT_DOOR_UNSUPPORTED (grant-door-fence.test.ts pins the admission). Now a
 * key that does not read every subject of the detail (`runDetailReadable`)
 * gets `readRunRecordForKey`: the run row through `scopedDb` (subject
 * `playbook`) and its subject through the entity read floor, both with the
 * grant ANDed; the rest said withheld.
 *
 * Through the REAL route on PGlite, the grant set as the auth middleware sets
 * it (`runWithGrant`). Rows sit where the candidate rules DISAGREE:
 *   - a one-shot run about a note in the app's space, one about a note in
 *     another space, from a playbook in the app's space: a read that checked
 *     the run alone would show the other space's prompt;
 *   - a one-shot run from a playbook in another space: a read without the
 *     grant on the run row would show it;
 *   - an agent (session) run: the app gets no turns, no session;
 *   - ANOTHER MEMBER of the same space (review of the lean-runs wave): the
 *     run row is space-visible, but its record (the prompt: the subject's
 *     document, the creator's past drafts and reject reasons) is the
 *     creator's alone, on the full detail, the app-key read and the list's
 *     subject lens and column.
 * Cannot see: the fence wiring in the auth middleware (its own tests), a real
 * Postgres.
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
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { grantOfScope, runWithGrant } from "@synap/database";
import "../../../access/grant-read.js";
import type { HubHono, HubVariables } from "./_shared.js";

const { registerRunsRoutes } = await import("./runs.js");

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const OWNER = randomUUID();
const MEMBER = randomUUID(); // another member of the app's space
const APP_SPACE = randomUUID(); // the space the app was granted
const ELSEWHERE = randomUUID(); // the person's other space
const NOTE_KIND = randomUUID();
const PB_IN = randomUUID(); // a one-shot playbook in the app's space
const PB_OUT = randomUUID(); // one in the other space
const NOTE_IN = randomUUID();
const NOTE_OUT = randomUUID();
const GEN_IN = randomUUID(); // about NOTE_IN, from PB_IN
const GEN_ABOUT_OUT = randomUUID(); // about NOTE_OUT, from PB_IN
const GEN_PB_OUT = randomUUID(); // about NOTE_IN, from PB_OUT (run in ELSEWHERE)
const AGENT_RUN = randomUUID(); // a session run, from PB_IN
const SESSION = randomUUID();
const SECRET = "the other space's draft";

function generation(subjectId: string, text: string) {
  return {
    subjectId,
    lands: { target: "subject_document_section", section: "Caption" },
    context: [
      { kind: "method", chars: 400 },
      { kind: "subject", id: subjectId, chars: 120 },
    ],
    prompt: { system: "Write it.", text, chars: 9 + text.length },
    model: "anthropic/claude-haiku-5-5",
    inputTokens: 2_100,
    cachedInputTokens: null,
    outputTokens: 240,
    totalTokens: 2_340,
    costUsd: 0.0031,
    finishReason: "stop",
    outputChars: 900,
  };
}

const pinned = (...permissions: string[]) =>
  grantOfScope({ permissions, workspaceIds: [APP_SPACE] } as never);
const FULL = grantOfScope({ permissions: ["*"] } as never);

async function request(
  path: string,
  grant: unknown,
  userId: string
): Promise<{ status: number; body: Record<string, any> }> {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerRunsRoutes(app);
  const res = await runWithGrant(grant as never, () => app.request(path));
  return { status: res.status, body: JSON.parse(await res.text()) };
}

const get = (
  id: string,
  grant: unknown,
  flowType = "playbook",
  userId = OWNER
) => request(`/runs/${id}?flowType=${flowType}`, grant, userId);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => is(v, PgTable)
  );
  expect(tables.map((t) => getTableConfig(t).name)).toEqual(
    expect.arrayContaining([
      "playbook_runs",
      "playbooks",
      "entities",
      "workspaces",
      "workspace_members",
    ])
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, name, user_type) values ($1, 'o@test', 'Owner', 'human')`,
    [OWNER]
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'm@test', 'Member', 'human')`,
    [MEMBER]
  );
  for (const [ws, name] of [
    [APP_SPACE, "Studio"],
    [ELSEWHERE, "Elsewhere"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1, $2, $3, '{}'::jsonb)`,
      [ws, name, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'member')`,
    [randomUUID(), APP_SPACE, MEMBER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1, 'note', 'Note', 'kind', 'system', 'workspace', true, '{}'::jsonb, null)`,
    [NOTE_KIND]
  );
  for (const [id, ws] of [
    [NOTE_IN, APP_SPACE],
    [NOTE_OUT, ELSEWHERE],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1, $2, $3, $4, 'note', 'n', '{}'::jsonb, '{}'::jsonb)`,
      [id, OWNER, ws, NOTE_KIND]
    );
  }
  for (const [id, ws] of [
    [PB_IN, APP_SPACE],
    [PB_OUT, ELSEWHERE],
  ] as const) {
    await q(
      `insert into playbooks (id, name, goal_template, workspace_id, status, version, executor, created_by, updated_at)
       values ($1, 'Caption', 'g', $2, 'active', 1, 'generate', $3, now())`,
      [id, ws, OWNER]
    );
  }
  const run = async (
    id: string,
    pb: string,
    ws: string,
    gen: unknown,
    sessionId: string | null = null
  ) =>
    q(
      `insert into playbook_runs (id, workspace_id, playbook_id, session_id, executor, status, generation, started_at, created_by)
       values ($1, $2, $3, $4, $5, 'proposed', $6::jsonb, now(), $7)`,
      [
        id,
        ws,
        pb,
        sessionId,
        sessionId ? "is-agent" : "generate",
        gen === null ? null : JSON.stringify(gen),
        OWNER,
      ]
    );
  await run(GEN_IN, PB_IN, APP_SPACE, generation(NOTE_IN, "Caption the note"));
  await run(GEN_ABOUT_OUT, PB_IN, APP_SPACE, generation(NOTE_OUT, SECRET));
  await run(
    GEN_PB_OUT,
    PB_OUT,
    ELSEWHERE,
    generation(NOTE_IN, "run elsewhere")
  );
  await run(AGENT_RUN, PB_IN, APP_SPACE, null, SESSION);
});

describe("GET /runs/:id — an app key reads a one-shot run's record, narrowed", () => {
  it("reads the record of a run about a thing in its space, the rest withheld", async () => {
    const res = await get(GEN_IN, pinned("playbook.read", "entity.*.read"));
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({
      id: GEN_IN,
      flowType: "playbook",
      executor: "generate",
      status: "proposed",
    });
    expect(res.body.playbookDetail.generation).toMatchObject({
      subjectId: NOTE_IN,
      prompt: { text: "Caption the note" },
      model: "anthropic/claude-haiku-5-5",
      outputTokens: 240,
      costUsd: 0.0031,
      cachedInputTokens: null,
    });
    expect(res.body.detail.status).toBe("withheld");
    // Only the record: no session, room, records or proposals.
    expect(res.body.activity).toBeUndefined();
    expect(res.body.playbookDetail.proposals).toBeUndefined();
  });

  it("a run about a thing outside its grant is not found: its prompt never leaves", async () => {
    const res = await get(
      GEN_ABOUT_OUT,
      pinned("playbook.read", "entity.*.read")
    );
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it("a key that cannot read the subject's kind gets none", async () => {
    const res = await get(GEN_IN, pinned("playbook.read"));
    expect(res.status).toBe(404);
  });

  it("a run of a playbook outside its grant is not found", async () => {
    const res = await get(GEN_PB_OUT, pinned("playbook.read", "entity.*.read"));
    expect(res.status).toBe(404);
  });

  it("a session run gives the app no turns and no session", async () => {
    const res = await get(AGENT_RUN, pinned("playbook.read", "entity.*.read"));
    expect(res.status).toBe(200);
    expect(res.body.playbookDetail).toEqual({ generation: null });
    expect(res.body.detail.status).toBe("withheld");
  });

  it("another flow's run is refused to the app, said, never an empty detail", async () => {
    const res = await get(
      GEN_IN,
      pinned("playbook.read", "entity.*.read"),
      "automation"
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("GRANT_DOOR_UNSUPPORTED");
  });

  it("an unfenced key still reads the whole detail", async () => {
    const res = await get(GEN_ABOUT_OUT, FULL);
    expect(res.status).toBe(200);
    expect(res.body.detail).toBeUndefined();
    expect(res.body.playbookDetail.generation.prompt.text).toBe(SECRET);
  });
});

describe("another member of the space never reads a one-shot run's record (review finding 1)", () => {
  it("the full detail: the run row is visible, its record is the private placeholder", async () => {
    const own = await get(GEN_IN, FULL);
    expect(own.body.playbookDetail.generation.prompt.text).toBe(
      "Caption the note"
    );
    const res = await get(GEN_IN, FULL, "playbook", MEMBER);
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ id: GEN_IN });
    expect(res.body.playbookDetail.generation).toBeUndefined();
    expect(res.body.playbookDetail.sessionPrivate).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("Caption the note");
  });

  it("an app key of the other member gets no record", async () => {
    const res = await get(
      GEN_IN,
      pinned("playbook.read", "entity.*.read"),
      "playbook",
      MEMBER
    );
    expect(res.status).toBe(200);
    expect(res.body.playbookDetail).toEqual({ generation: null });
    expect(JSON.stringify(res.body)).not.toContain("Caption the note");
  });

  it("the list: the subject lens drops another member's run and its row names no subject", async () => {
    const lens = `/runs?flowType=playbook&subjectEntityId=${NOTE_IN}`;
    const own = await request(lens, FULL, OWNER);
    expect(own.body.runs.map((r: { id: string }) => r.id)).toContain(GEN_IN);
    const theirs = await request(lens, FULL, MEMBER);
    expect(theirs.status).toBe(200);
    expect(theirs.body.runs.map((r: { id: string }) => r.id)).not.toContain(
      GEN_IN
    );
    // Unfiltered, the row is there (space-visible) but names no subject.
    const all = await request(`/runs?flowType=playbook`, FULL, MEMBER);
    const row = all.body.runs.find((r: { id: string }) => r.id === GEN_IN);
    expect(row).toBeDefined();
    expect(row.subjectEntityId).toBeNull();
    const mine = (
      await request(`/runs?flowType=playbook`, FULL, OWNER)
    ).body.runs.find((r: { id: string }) => r.id === GEN_IN);
    expect(mine.subjectEntityId).toBe(NOTE_IN);
  });
});
