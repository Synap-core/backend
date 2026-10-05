/**
 * Slot keys reach STORAGE through the real write doors (A2).
 *
 * Reachability, not shape: each case writes through a real door against
 * PGlite and reads the stored `expected_outputs` back with raw SQL. The
 * session starts as a LEGACY row (slots inserted with no key), which is the
 * case that matters: its first write must freeze the very keys a reader
 * already derived (`projectSessionOutcomes`), or every outcome key a surface
 * cached would move.
 *
 * Real: `updateFocusSession` (addOutput / wholesale replace / completeOutput),
 * `updateExpectedOutputsLocked` (the lock every slot mutator writes through).
 * Stubbed, and why: the governance gate (`checkPermissionOrPropose`, grants
 * are not under test), the event / side-effect fan-out.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
  return {
    ...actual,
    db: drizzle(client, {
      schema: { focusSessions: actual.focusSessions as never },
    }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions } from "@synap/database";
import { projectSessionOutcomes } from "@synap-core/types/units";
import { updateFocusSession } from "../update-session.js";
import { updateExpectedOutputsLocked } from "../delegate-output.js";

const USER = "user-1";
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

async function seedLegacy(slots: unknown[]): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, criteria, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'Ship', 'active', $3::jsonb, '[]'::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [id, USER, JSON.stringify(slots)]
  );
  return id;
}

const stored = (id: string) =>
  q<{ expected_outputs: Array<Record<string, unknown>> }>(
    `select expected_outputs from focus_sessions where id = $1`,
    [id]
  ).then((r) => r.rows[0]!.expected_outputs);

const LEGACY = [
  { kind: "document", label: "Report" },
  { kind: "document", label: "Report" },
  { kind: "document", label: "Déjà vu" },
];

describe("slot keys reach storage through the write doors", () => {
  beforeAll(async () => {
    await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  }, 120_000);
  afterAll(async () => {
    await h.client?.close();
  });

  it("addOutput: the legacy slots are frozen at the keys a reader derived; the new one is minted", async () => {
    const id = await seedLegacy(LEGACY);
    const readBefore = projectSessionOutcomes({
      expectedOutputs: await stored(id),
      sessionTerminal: false,
    }).outcomes.map((o) => o.key);
    expect((await stored(id)).map((s) => s.key)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    const r = await updateFocusSession({
      sessionId: id,
      userId: USER,
      addOutput: { kind: "document", label: "Report" },
    });
    expect(r.status).toBe("updated");
    const after = (await stored(id)).map((s) => s.key);
    expect(after.slice(0, 3)).toEqual(readBefore);
    expect(after).toEqual(["report", "report-2", "deja-vu", "report-3"]);
  });

  it("a wholesale replace that rewords a sibling and drops another keeps every surviving key", async () => {
    const id = await seedLegacy([
      { kind: "document", label: "Intro", key: "intro" },
      // Stamped when these slots had other names — a key is identity, not
      // a slug of today's label, so re-deriving would MOVE it.
      { kind: "document", label: "Body", key: "main-text" },
      { kind: "document", label: "Outro", key: "closing" },
    ]);
    await updateFocusSession({
      sessionId: id,
      userId: USER,
      // The client knows nothing of keys: it drops "Intro" and adds "Appendix".
      expectedOutputs: [
        { kind: "document", label: "Body" },
        { kind: "document", label: "Outro" },
        { kind: "document", label: "Appendix" },
      ],
    });
    expect((await stored(id)).map((s) => [s.label, s.key])).toEqual([
      ["Body", "main-text"],
      ["Outro", "closing"],
      ["Appendix", "appendix"],
    ]);
  });

  it("completeOutput names the slot by its key — and records a CLAIM, not a verdict", async () => {
    const id = await seedLegacy([
      { kind: "document", label: "Spec", key: "spec" },
      { kind: "document", label: "Deck", key: "deck" },
    ]);
    const r = await updateFocusSession({
      sessionId: id,
      userId: USER,
      completeOutput: "deck",
    });
    expect(r.status).toBe("updated");
    expect(
      (await stored(id)).map((s) => [
        s.key,
        s.status ?? "pending",
        s.claimedDone ?? false,
      ])
    ).toEqual([
      ["spec", "pending", false],
      // No evidence anywhere: the claim waits for a verdict (A3).
      ["deck", "pending", true],
    ]);
    if (r.status === "updated") {
      expect(r.completeOutput?.result).toBe("claimed");
    }
  });

  it("a claim WITH evidence (its ref) is closed by the evidence verdict, with lineage", async () => {
    const id = await seedLegacy([
      {
        kind: "document",
        label: "Deck",
        key: "deck",
        ref: { url: "https://example.com/deck" },
      },
      { kind: "document", label: "Spec", key: "spec" },
    ]);
    const r = await updateFocusSession({
      sessionId: id,
      userId: USER,
      completeOutput: "Deck",
    });
    expect(r.status).toBe("updated");
    const [deck, spec] = await stored(id);
    expect(deck).toMatchObject({
      status: "done",
      claimedDone: true,
      satisfiedByEvidence: { kind: "ref", id: "https://example.com/deck" },
    });
    // A sibling nobody claimed is untouched, ref or not.
    expect(spec!.status ?? "pending").toBe("pending");
    if (r.status === "updated") {
      expect(r.completeOutput).toMatchObject({
        result: "completed",
        verified: 1,
      });
      // The reply carries the row AS VERIFIED, not the pre-verdict write.
      const replied = (
        r.session.expectedOutputs as Array<{ key?: string; status?: string }>
      ).find((o) => o.key === "deck");
      expect(replied?.status).toBe("done");
    }
  });

  it("a claim on a slot a CRITERION checks is never closed by evidence", async () => {
    const id = await seedLegacy([
      {
        kind: "document",
        label: "Deck",
        key: "deck",
        ref: { url: "https://example.com/d" },
      },
    ]);
    await q(`update focus_sessions set criteria = $2::jsonb where id = $1`, [
      id,
      JSON.stringify([
        {
          key: "deck",
          statement: "The deck convinces",
          check: { kind: "judge" },
        },
      ]),
    ]);
    await updateFocusSession({
      sessionId: id,
      userId: USER,
      completeOutput: "deck",
    });
    const [deck] = await stored(id);
    expect(deck).toMatchObject({ claimedDone: true });
    expect(deck!.status ?? "pending").toBe("pending");
  });

  it("the locked mutator (criterion escalation, block, delegate, return) keys what it writes", async () => {
    const id = await seedLegacy(LEGACY);
    const ok = await updateExpectedOutputsLocked(id, (current) => [
      ...current,
      { kind: "criterion", label: "Check: tests pass", owner: "human" },
    ]);
    expect(ok).toBe(true);
    expect((await stored(id)).map((s) => s.key)).toEqual([
      "report",
      "report-2",
      "deja-vu",
      "check-tests-pass",
    ]);
  });
});
