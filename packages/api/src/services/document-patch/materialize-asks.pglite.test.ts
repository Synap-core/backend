/**
 * The question a document holds, filed through the REAL slot door: the real
 * `materializeAskDefinitions` with its default session side (`ask-slots.ts`),
 * the real `updateFocusSession`, the real `expectedOutputWireSchema` and
 * `blockedReasonForAsk`, on PGlite. Stubbed: governance (granted), the session
 * room, realtime, block guidance and the notification write, as in
 * `ask-person.pglite.test.ts`.
 *
 * What it proves that the unit suite cannot: a definition WITHOUT `unblocks`
 * (the common one) is accepted and stored by the real door, the stored slot
 * carries the author's key, owner and `blockedReason`, and the reference
 * written points at the stored slot.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    notified: [] as Array<Record<string, unknown>>,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    recordSessionSpawn: async () => ({
      linked: false,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock(
  "../focus-sessions/ensure-session-channel.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    ensureSessionChannel: async () => null,
  })
);
vi.mock("../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../focus-sessions/block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: async () => undefined,
}));
// The REAL needs-you producer runs; only the notification write is recorded.
vi.mock("../../notifications/NotificationService.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    NotificationService: {
      ...(actual.NotificationService as object),
      create: async (input: Record<string, unknown>) => {
        h.notified.push(input);
        return "n-1";
      },
    },
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));
vi.mock("../focus-sessions/session-nudges.js", () => ({
  loadSessionNudges: async () => undefined,
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { ExpectedOutput } from "@synap/playbooks";

// `update-session` FIRST (see `ask-person.pglite.test.ts`).
await import("../focus-sessions/update-session.js");
const { materializeAskDefinitions } = await import("./materialize-asks.js");

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const CHOOSE = {
  mode: "choose",
  options: [{ label: "PostgreSQL", recommended: true }, { label: "SQLite" }],
};
const def = (props: Record<string, unknown>, prose = "Which database?") =>
  [
    ":::synap-ask",
    "```json",
    JSON.stringify(props),
    "```",
    "",
    prose,
    ":::",
  ].join("\n");
/** The common definition: no `unblocks`, no `blockedReason`. */
const DB = def({
  key: "which-database",
  label: "Which database?",
  ask: CHOOSE,
});

async function seedSession(status = "active"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, criteria, agent_ids, metadata, origin, created_at, updated_at, started_at)
     values ($1, $2, 'Plan', 'Plan', $3, '[]'::jsonb, '[]'::jsonb, $4, '{}'::jsonb, 'agent', now(), now(), now())`,
    [id, USER, status, `{${AGENT}}`]
  );
  return id;
}
const slotsOf = async (id: string): Promise<ExpectedOutput[]> =>
  (
    await q<{ expected_outputs: ExpectedOutput[] }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.expected_outputs;
const author = (sessionId: string) => ({
  userId: USER,
  agentUserId: AGENT,
  sessionId,
});

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table the generator cannot express is not read by these doors.
      }
    }
  }
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'a@x.test', 'Antoine', 'human'), ($2, 'bot@x.test', 'Claude', 'agent')`,
    [USER, AGENT]
  );
}, 120_000);

describe("materializeAskDefinitions through the real slot door", () => {
  it("a definition without `unblocks` is stored as the person's ask, and the reference points at it", async () => {
    const id = await seedSession();
    const r = await materializeAskDefinitions(
      [`# Plan\n\n${DB}\n`],
      author(id)
    );
    expect(r.changed).toBe(true);
    const slots = await slotsOf(id);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      kind: "ask",
      key: "which-database",
      label: "Which database?",
      owner: "human",
      blockedReason: "decision",
      ask: CHOOSE,
    });
    // The real door defaulted what the definition did not say.
    expect(typeof slots[0]!.unblocks).toBe("string");
    expect(r.texts[0]).toContain(`sessionId="${id}"`);
    expect(r.texts[0]).toContain(`slot="${slots[0]!.key}"`);
  });

  it("a stated `unblocks`, `why` and an act-mode ask are kept (physical blockedReason)", async () => {
    const id = await seedSession();
    await materializeAskDefinitions(
      [
        def(
          {
            key: "plug-it-in",
            label: "Plug it in",
            why: "The device is on the desk",
            unblocks: "The sync test run",
            ask: {
              mode: "act",
              prompt: "Plug the device in",
              doneLabel: "Done",
            },
          },
          "Plug it in."
        ),
      ],
      author(id)
    );
    expect((await slotsOf(id))[0]).toMatchObject({
      key: "plug-it-in",
      blockedReason: "physical",
      why: "The device is on the desk",
      unblocks: "The sync test run",
    });
  });

  it("the author's key is kept when it is not the label's slug (the real door honours a free key)", async () => {
    const id = await seedSession();
    const r = await materializeAskDefinitions(
      [def({ key: "db-choice", label: "Which database?", ask: CHOOSE })],
      author(id)
    );
    expect((await slotsOf(id))[0]).toMatchObject({ key: "db-choice" });
    expect(r.texts[0]).toContain(`slot="db-choice"`);
  });

  it("the same write sent again reuses the stored question: still ONE slot", async () => {
    const id = await seedSession();
    const first = await materializeAskDefinitions([DB], author(id));
    const again = await materializeAskDefinitions([DB], author(id));
    expect(again.texts).toEqual(first.texts);
    expect(await slotsOf(id)).toHaveLength(1);
  });

  it("a different ask under the stored key is refused by the real read", async () => {
    const id = await seedSession();
    await materializeAskDefinitions([DB], author(id));
    await expect(
      materializeAskDefinitions(
        [
          def({
            key: "which-database",
            label: "Which database?",
            ask: { mode: "confirm" },
          }),
        ],
        author(id)
      )
    ).rejects.toThrow(/different ask/);
    expect(await slotsOf(id)).toHaveLength(1);
  });

  it("an ended session, and a session of another person, are refused", async () => {
    const ended = await seedSession("closed");
    await expect(
      materializeAskDefinitions([DB], author(ended))
    ).rejects.toThrow(/has ended/);
    const mine = await seedSession();
    await expect(
      materializeAskDefinitions([DB], { ...author(mine), userId: randomUUID() })
    ).rejects.toThrow(/not one of yours/);
    expect(await slotsOf(ended)).toEqual([]);
    expect(await slotsOf(mine)).toEqual([]);
  });
});
