/**
 * The session titler's selection and write, driven END TO END on PGlite.
 *
 * Real: `handleSessionTitler` → the three SQL candidate predicates → the
 * conditional `writeTitleIfUnchanged`. Only the IS is injected (`requestTitle`).
 * The point of running real SQL: the invariants here are all WHERE clauses —
 * "a human's title is never selected", "a rename racing the job wins" — and a
 * hand-built fake db would only prove the fake.
 *
 * NOT covered: cron/queue registration (queues-are-created tripwire) and true
 * cross-connection concurrency (PGlite is one connection — the race is staged
 * by renaming between the read and the write, inside the injected IS call).
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
  focusSessions,
  proposals,
  messages,
  playbooks,
  entities,
} from "@synap/database/schema";
import { handleSessionTitler } from "./session-titler.js";

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
  // `text[]` (focus_sessions.agent_ids) defaults to an empty ARRAY, not jsonb.
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
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** Insert a session; `ageMinutes` back-dates created_at (and closed_at when closed). */
async function session(opts: {
  title?: string | null;
  goal?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  playbookId?: string | null;
  origin?: string | null;
  ageMinutes?: number;
  outputs?: unknown[];
  summary?: string;
}): Promise<string> {
  const id = randomUUID();
  const status = opts.status ?? "active";
  await q(
    `insert into focus_sessions (id, user_id, title, goal, status, metadata, playbook_id,
       origin, expected_outputs, verification_report, created_at, closed_at)
     values ($1, 'user-1', $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb,
       now() - ($10::int * interval '1 minute'),
       case when $4 = 'closed' then now() - ($10::int * interval '1 minute') end)`,
    [
      id,
      opts.title ?? null,
      opts.goal ?? "Make relay follow the OS theme",
      status,
      JSON.stringify(opts.metadata ?? {}),
      opts.playbookId ?? null,
      opts.origin ?? null,
      JSON.stringify(opts.outputs ?? [{ label: "Theme toggle" }]),
      opts.summary ? JSON.stringify({ summary: opts.summary }) : null,
      opts.ageMinutes ?? 10,
    ]
  );
  return id;
}

/**
 * Push the row's last early attempt back past the cool-off, so the next tick
 * is allowed to ask again. Written as a real metadata write rather than fake
 * timers because the cool-off is a SQL predicate over a stored timestamp —
 * mocking the clock would leave the thing under test untouched.
 */
async function ageLastAttempt(id: string) {
  await q(
    `update focus_sessions
       set metadata = metadata || jsonb_build_object(
         'titleEarlyAttemptedAt', (now() - interval '2 days')::text)
     where id = $1`,
    [id]
  );
}

async function row(id: string) {
  const { rows } = await q<{
    title: string | null;
    metadata: Record<string, unknown>;
  }>(`select title, metadata from focus_sessions where id = $1`, [id]);
  return rows[0];
}

const asked: string[] = [];
function answering(title: string | null) {
  return vi.fn(async (p: { goal: string; phase: string }) => {
    asked.push(`${p.phase}:${p.goal}`);
    return { title, decider: "llm" as const, model: "cheap" };
  });
}

beforeAll(async () => {
  await import("@synap/database");
  await h.client!.exec(
    [focusSessions, proposals, messages, playbooks, entities]
      .map((t) => ddlFor(t as PgTable))
      .join("\n")
  );
});

beforeEach(async () => {
  asked.length = 0;
  await q(`delete from focus_sessions`);
});

describe("early phase — who is selected", () => {
  it("names an unnamed work session with a signal, and marks it generated", async () => {
    const id = await session({});
    const out = await handleSessionTitler({
      requestTitle: answering('"Relay theme follows system."'),
    });
    expect(out.early).toBe(1);
    const r = await row(id);
    // Re-sanitized by the pod: quotes and trailing punctuation gone.
    expect(r.title).toBe("Relay theme follows system");
    expect(r.metadata.titleSource).toBe("generated");
    expect(typeof r.metadata.titleGeneratedAt).toBe("string");
    expect(typeof r.metadata.titleEarlyAttemptedAt).toBe("string");
  });

  it("never selects a human or agent title — stored or legacy", async () => {
    const human = await session({
      title: "My name",
      metadata: { titleSource: "human" },
    });
    const agent = await session({
      title: "Agent name",
      metadata: { titleSource: "agent" },
    });
    // Legacy row: titled, no stored source ⇒ someone named it.
    const legacy = await session({ title: "Legacy name" });
    const requestTitle = answering("Replacement");
    await handleSessionTitler({ requestTitle });
    expect(requestTitle).not.toHaveBeenCalled();
    expect((await row(human)).title).toBe("My name");
    expect((await row(agent)).title).toBe("Agent name");
    expect((await row(legacy)).title).toBe("Legacy name");
  });

  it("skips playbook and automation runs, too-young sessions, and signal-less ones", async () => {
    await session({
      playbookId: randomUUID(),
      metadata: { titleSource: "derived" },
      title: "Run",
    });
    await session({ origin: "automation", metadata: { source: "automation" } });
    await session({ ageMinutes: 0 });
    await session({ outputs: [] });
    const requestTitle = answering("Replacement");
    await handleSessionTitler({ requestTitle });
    expect(requestTitle).not.toHaveBeenCalled();
  });

  it("generates for a write receipt but not for a capture room", async () => {
    await session({ goal: "receipt", metadata: { source: "agent-write" } });
    await session({ goal: "capture", metadata: { source: "intake:capture" } });
    await handleSessionTitler({ requestTitle: answering("Named") });
    expect(asked).toEqual(["early:receipt"]);
  });
});

describe("the conditional write — a rename always wins", () => {
  it("loses to a rename that lands while the IS is answering", async () => {
    const id = await session({});
    const requestTitle = vi.fn(async () => {
      // The person renames the session between the titler's read and write.
      await q(
        `update focus_sessions set title = 'Human rename',
           metadata = metadata || '{"titleSource":"human"}'::jsonb where id = $1`,
        [id]
      );
      return { title: "Generated", decider: "llm" as const };
    });
    const out = await handleSessionTitler({ requestTitle });
    expect(requestTitle).toHaveBeenCalledTimes(1);
    expect(out.early).toBe(0);
    const r = await row(id);
    expect(r.title).toBe("Human rename");
    expect(r.metadata.titleSource).toBe("human");
    expect(r.metadata.titleEarlyAttemptedAt).toBeUndefined();
  });

  it("loses to a rename that changed only the title (no source stamp)", async () => {
    const id = await session({
      title: "Derived",
      metadata: { titleSource: "derived" },
    });
    const requestTitle = vi.fn(async () => {
      await q(`update focus_sessions set title = 'Renamed' where id = $1`, [
        id,
      ]);
      return { title: "Generated", decider: "llm" as const };
    });
    await handleSessionTitler({ requestTitle });
    expect((await row(id)).title).toBe("Renamed");
  });
});

describe("failure and empty answers", () => {
  it("IS down ⇒ nothing stamped, derived name kept, retried next tick", async () => {
    const id = await session({
      title: "Derived",
      metadata: { titleSource: "derived" },
    });
    await handleSessionTitler({
      requestTitle: vi.fn(async () => {
        throw new Error("IS unreachable");
      }),
    });
    const r = await row(id);
    expect(r.title).toBe("Derived");
    expect(r.metadata.titleEarlyAttemptedAt).toBeUndefined();
    await handleSessionTitler({ requestTitle: answering("Works now") });
    expect((await row(id)).title).toBe("Works now");
  });

  it("an unusable answer is retried, then given up on — never asked for ever", async () => {
    // Live 2026-09-20: the titler had run and produced ZERO names pod-wide.
    // A rejected answer (an id, a link, nothing) stamped the row exactly like
    // a success, so the session stayed unnamed and no tick looked again. One
    // bad answer must not be permanent; neither must an endless model bill.
    const id = await session({
      title: "Derived",
      metadata: { titleSource: "derived" },
    });
    const junk = answering("3f2a9c1e-0b4d-4e5f-9a8b-7c6d5e4f3a2b");
    await handleSessionTitler({ requestTitle: junk });
    let r = await row(id);
    expect(r.title).toBe("Derived");
    expect(r.metadata.titleSource).toBe("derived");
    expect(r.metadata.titleEarlyAttempts).toBe(1);
    // The IS answered with a real string the POD refused — not an empty answer.
    expect(r.metadata.titleEarlyLastReason).toBe("unusable");

    // NOT on the very next tick: three attempts must not be three consecutive
    // ticks asking the same model about the same context.
    const tooSoon = answering("A real name now");
    await handleSessionTitler({ requestTitle: tooSoon });
    expect(tooSoon).not.toHaveBeenCalled();

    // ASKED AGAIN once the cool-off has passed — what the old code refused.
    await ageLastAttempt(id);
    const second = answering("A real name now");
    await handleSessionTitler({ requestTitle: second });
    expect(second).toHaveBeenCalled();
    r = await row(id);
    expect(r.title).toBe("A real name now");
    expect(r.metadata.titleSource).toBe("generated");
  });

  it("tells an EMPTY answer from a REFUSED one on the row", () => {
    // Two different failures with two different fixes: nothing came back at
    // all (a down model, a truncated stream) vs the pod rejecting what came
    // back (an id, a link). Folding them into one "no name" is what left the
    // live zero unexplainable.
    return (async () => {
      const id = await session({
        title: "Derived",
        metadata: { titleSource: "derived" },
      });
      await handleSessionTitler({ requestTitle: answering("") });
      expect((await row(id)).metadata.titleEarlyLastReason).toBe("empty");
    })();
  });

  it("stops asking after the attempt cap, keeping the derived name", async () => {
    const id = await session({
      title: "Derived",
      metadata: { titleSource: "derived" },
    });
    for (let i = 0; i < 3; i++) {
      await handleSessionTitler({ requestTitle: answering("") });
      await ageLastAttempt(id);
    }
    expect((await row(id)).metadata.titleEarlyAttempts).toBe(3);
    // Past the cool-off AND past the bound: the bound is what stops it.
    const afterCap = answering("Too late");
    await handleSessionTitler({ requestTitle: afterCap });
    expect(afterCap).not.toHaveBeenCalled();
    const r = await row(id);
    expect(r.title).toBe("Derived");
    expect(r.metadata.titleSource).toBe("derived");
  });
});

describe("close phase", () => {
  it("renames once from the closing summary, then never again", async () => {
    const id = await session({
      status: "closed",
      title: "Early name",
      metadata: { titleSource: "generated", titleEarlyAttemptedAt: "x" },
      summary: "Shipped the system theme toggle",
    });
    await handleSessionTitler({
      requestTitle: answering("System theme shipped"),
    });
    expect(asked).toEqual([`close:Make relay follow the OS theme`]);
    const r = await row(id);
    expect(r.title).toBe("System theme shipped");
    expect(typeof r.metadata.titleRetitledAtClose).toBe("string");
    asked.length = 0;
    await handleSessionTitler({ requestTitle: answering("Again") });
    expect(asked).toEqual([]);
  });

  it("never renames a closed session a person named", async () => {
    await session({
      status: "closed",
      title: "Mine",
      metadata: { titleSource: "human" },
      summary: "Done",
    });
    const requestTitle = answering("Theirs");
    await handleSessionTitler({ requestTitle });
    expect(requestTitle).not.toHaveBeenCalled();
  });
});

describe("backfill — derived names, no LLM", () => {
  it("names untitled runs and captures, leaves work sessions and titled rows alone", async () => {
    const run = await session({
      goal: "You are the CRM hygiene agent, running unattended. Review everything.",
      metadata: { source: "automation" },
      origin: "automation",
      outputs: [],
    });
    const capture = await session({
      goal: "Capture · https://www.example.com/a?b=c 3f2a9c1e-0b4d-4e5f-9a8b-7c6d5e4f3a2b",
      metadata: { source: "intake:capture" },
      outputs: [],
    });
    const work = await session({ outputs: [] });
    const titled = await session({
      title: "Kept",
      metadata: { source: "import" },
      outputs: [],
    });

    const out = await handleSessionTitler({ requestTitle: null });
    expect(out).toEqual({ backfilled: 2, early: 0, close: 0 });
    expect((await row(run)).metadata.titleSource).toBe("derived");
    const cap = await row(capture);
    // The goal already CARRIES the machine verb, so the derived name is the
    // content — not a byte-identical copy of the goal (12 live rows, 09-20).
    expect(cap.title).toBe("Link from example.com");
    expect(cap.metadata.titleSource).toBe("derived");
    expect((await row(work)).title).toBeNull();
    expect((await row(titled)).title).toBe("Kept");
  });
});
